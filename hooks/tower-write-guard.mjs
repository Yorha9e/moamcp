#!/usr/bin/env node
/**
 * tower-write-guard.mjs — plugin-level PreToolUse hook for the tower workflow.
 *
 * Scope & intent (基准 TOWER_V1_IMPLEMENTATION_PLAN.md, B4 审查 F3 定位算法定稿):
 *   - This hook ONLY blocks one escape: writing OUTSIDE the tower's registered
 *     area — the repo root plus every registered worktree — while the target
 *     still lands in the sibling zone `dirname(repoRoot)`. Anything else is
 *     allowed (fail-open by design: the real write discipline comes from the
 *     tower profiles' tool whitelists and, on v1, the omkc policy).
 *   - PROFILE-AGNOSTIC: the stdin payload carries NO profile/agentId, so this
 *     is a pure path check that applies to every profile. It intercepts
 *     tower-worker AND tower-orchestrator/reviewer writes alike (误伤接受,
 *     风险台账 6 — disable the plugin to revoke).
 *   - MIRROR-LOCATION WINDOW (fail-open): mirror discovery covers exactly two
 *     candidates — the one-level reverseRepoRoot(stdin cwd) inference plus the
 *     cwd itself. When stdin cwd sits in a DEEP subdirectory of a worktree
 *     (e.g. `<repo>-worktrees/wt-1/a/b`) or equals the worktrees root, no
 *     mirror is located → fail-open. This is designed behavior (B4 审查 F2);
 *     the other three defense layers — profile tool whitelists, the omkc
 *     policy, and the review gate — still hold.
 *   - PLATFORM NOTE: only agent-core-v2 supports external plugin hooks; on v1
 *     (agent-core) the omkc tower-worker-write-guard policy is the fallback.
 *
 * stdin (JSON, snake_case): {hook_event_name, session_id, cwd, tool_name,
 * tool_input: {file_path, …}, tool_call_id}. `cwd` is the CLI START directory
 * — NOT the worker's worktree (the engine resolves relative tool paths against
 * the agent workDir; this hook only sees stdin cwd; 基准 B4 审查 F4).
 *
 * Contract:
 *   exit 0 = allow (also every abnormal case: no file_path, no mirror found,
 *            unparseable mirror, thrown exceptions, timeouts — fail-open).
 *   exit 2 = deny; the reason is written to stderr.
 *
 * Pure Node.js, zero dependencies, no imports from the project.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** Read + parse the whole stdin as JSON; never throws. */
async function readStdinJson() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw.length === 0) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/** Read + parse a mirror file; returns null on any failure (fail-open). */
async function readMirror(file) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** True when `child` is `parent` itself or lives under it (path-resolved).
 *  Windows paths are case-insensitive → lowercase both sides before the
 *  prefix comparison. The trailing separator guard keeps `/foo/bar2` from
 *  being misjudged as inside `/foo/bar`. */
function isWithin(parent, child) {
  const p = resolve(parent);
  const c = resolve(child);
  const sepLc = process.platform === 'win32' ? sep.toLowerCase() : sep;
  const pl = process.platform === 'win32' ? p.toLowerCase() : p;
  const cl = process.platform === 'win32' ? c.toLowerCase() : c;
  if (cl === pl) return true;
  const prefix = pl.endsWith(sep) ? pl : pl + sep;
  if (process.platform === 'win32') {
    return cl.startsWith(prefix.toLowerCase());
  }
  return cl.startsWith(prefix);
}

/**
 * Mirror candidate ①: reverse-engineer the repo root from the CLI start dir —
 * worker worktrees live at `<repoRoot>` 同级 `<repoName>-worktrees/<slot>`, so
 * when `dirname(cwd)`'s basename ends with `-worktrees`, strip exactly ONE
 * suffix to recover the repo name (a repo itself named `foo-worktrees` stays
 * correct — only one suffix is removed) and the repo root is the sibling
 * directory of the worktrees dir. Returns null when the layout does not match
 * (e.g. the CLI was started from the repo root itself).
 */
function reverseRepoRoot(cwd) {
  try {
    const worktreesDir = dirname(resolve(cwd));
    const dirBase = basename(worktreesDir);
    const suffix = '-worktrees';
    if (!dirBase.endsWith(suffix) || dirBase.length <= suffix.length) return null;
    const repoName = dirBase.slice(0, -suffix.length);
    return join(dirname(worktreesDir), repoName);
  } catch (_) {
    return null;
  }
}

/** All registered worktree paths from the mirror (worktrees ∪ agents[].worktree,
 *  null/empty entries filtered out). RELATIVE entries are resolved against the
 *  located `repoRoot` (absolute entries pass through unchanged) — plain
 *  resolve() would otherwise anchor them at the hook's process cwd (the plugin
 *  root) and misjudge a legit worktree write as a sibling-zone escape (B4 审查
 *  F3; store.ts syncGuardMirror 恒写绝对路径, this is defensive hardening). */
function registeredWorktrees(mirror, repoRoot) {
  const out = [];
  const base = typeof repoRoot === 'string' && repoRoot.length > 0 ? repoRoot : process.cwd();
  if (mirror && Array.isArray(mirror.worktrees)) {
    for (const w of mirror.worktrees) {
      if (typeof w === 'string' && w.length > 0) out.push(resolve(base, w));
    }
  }
  if (mirror && mirror.agents && typeof mirror.agents === 'object') {
    for (const key of Object.keys(mirror.agents)) {
      const entry = mirror.agents[key];
      if (entry && typeof entry === 'object' && typeof entry.worktree === 'string' && entry.worktree.length > 0) {
        out.push(resolve(base, entry.worktree));
      }
    }
  }
  return out;
}

async function main() {
  const input = await readStdinJson();
  if (input === null || typeof input !== 'object') return 0; // no payload → allow
  const toolInput = input.tool_input;
  const filePath = toolInput && typeof toolInput === 'object' ? toolInput.file_path : undefined;
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return 0; // step 1
  const cwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd();
  // Step 2: relative paths resolve against stdin cwd — NOT the agent workDir
  // (基准 B4 审查 F4: 引擎按 agent workDir 解析相对路径，hook 只有 stdin cwd).
  const target = resolve(cwd, filePath);

  // Step 3: locate the guard mirror. Candidate ① reverseRepoRoot(cwd); then
  // candidate ② the cwd itself. None found → allow.
  let repoRoot = null;
  let mirror = null;
  const candidateRoots = [];
  const rr = reverseRepoRoot(cwd);
  if (rr !== null) candidateRoots.push(rr);
  candidateRoots.push(resolve(cwd));
  for (const candidate of candidateRoots) {
    const mirrorFile = join(candidate, '.tower-guard.json');
    const parsed = await readMirror(mirrorFile);
    if (parsed !== null) {
      repoRoot = candidate;
      mirror = parsed;
      break;
    }
  }
  if (repoRoot === null || mirror === null) return 0; // no mirror → fail-open

  // Step 4: the decision.
  //   allow   → target inside the repo root, or inside any registered worktree
  //   deny    → target inside dirname(repoRoot) (the sibling zone) but NOT in
  //              the repo root nor any worktree — a sibling-directory escape
  //   else    → allow
  if (isWithin(repoRoot, target)) return 0;
  const worktrees = registeredWorktrees(mirror, repoRoot);
  for (const w of worktrees) {
    if (isWithin(w, target)) return 0;
  }
  const siblingZone = dirname(repoRoot);
  if (isWithin(siblingZone, target)) {
    process.stderr.write(
      `tower-write-guard: denied — ${target} escapes the tower's registered area ` +
        `(repo root ${repoRoot} + ${worktrees.length} worktree(s)) into the sibling zone ${siblingZone}. ` +
        `Use an absolute path inside your assigned worktree, or file a finding via moa_tower_finding.`,
    );
    return 2;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0), // any unexpected failure → fail-open (allow)
);
