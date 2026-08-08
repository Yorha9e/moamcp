/**
 * B4 write-guard hook tests — the plugin PreToolUse hook is a standalone
 * zero-dependency Node script, so we spawn it exactly like the plugin runner
 * does (`node ./hooks/tower-write-guard.mjs`, cwd = plugin root) and feed the
 * stdin envelope, asserting the exit-code contract:
 *
 *   0 = allow (including every fail-open case: no file_path, no mirror,
 *       unparseable mirror, no matching mirror candidate)
 *   2 = deny — target escapes the tower's registered area (repo root +
 *       registered worktrees) into the sibling zone `dirname(repoRoot)`; the
 *       reason is written to stderr.
 *
 * All paths are created as plain temp directories (no real git needed — the
 * hook only does path math against the mirror file).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
});

function runHook(payload: Record<string, unknown>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['./hooks/tower-write-guard.mjs'], { cwd: PLUGIN_ROOT });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Same spawn contract, but raw stdin bytes (malformed JSON / empty input). */
function runHookRaw(raw: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['./hooks/tower-write-guard.mjs'], { cwd: PLUGIN_ROOT });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stderr }));
    child.stdin.end(raw);
  });
}

function mirrorAt(repoRoot: string, mirror: unknown): Promise<void> {
  return writeFile(join(repoRoot, '.tower-guard.json'), JSON.stringify(mirror));
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-hook-'));
  homes.push(home);
  return home;
}

it('allow: no mirror anywhere → exit 0 (fail-open)', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  const { code } = await runHook({ cwd: repoRoot, tool_name: 'Write', tool_input: { file_path: join(repoRoot, 'x.ts') } });
  expect(code).toBe(0);
});

it('allow: no file_path in the envelope → exit 0', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await mirrorAt(repoRoot, { worktrees: [], agents: {} });
  const { code } = await runHook({ cwd: repoRoot, tool_name: 'Edit', tool_input: { old_string: 'a' } });
  expect(code).toBe(0);
});

it('allow: unparseable mirror file → exit 0 (fail-open)', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await writeFile(join(repoRoot, '.tower-guard.json'), 'not json {{{');
  const { code } = await runHook({ cwd: repoRoot, tool_input: { file_path: join(home, 'evil.ts') } });
  expect(code).toBe(0);
});

it('allow: target inside the repo root (mirror found at stdin cwd)', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(join(repoRoot, 'src'), { recursive: true });
  await mirrorAt(repoRoot, { worktrees: [], agents: {} });
  const { code } = await runHook({ cwd: repoRoot, tool_input: { file_path: join(repoRoot, 'src', 'x.ts') } });
  expect(code).toBe(0);
});

it('allow: relative file_path resolves against stdin cwd (not the agent workDir)', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(join(repoRoot, 'src'), { recursive: true });
  await mirrorAt(repoRoot, { worktrees: [], agents: {} });
  const { code } = await runHook({ cwd: repoRoot, tool_input: { file_path: 'src/x.ts' } });
  expect(code).toBe(0);
});

it('deny: sibling-directory escape (absolute + relative forms) → exit 2 with a reason', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await mirrorAt(repoRoot, { worktrees: [], agents: {} });

  const abs = await runHook({ cwd: repoRoot, tool_input: { file_path: join(home, 'evil.ts') } });
  expect(abs.code).toBe(2);
  expect(abs.stderr).toContain('denied');

  const rel = await runHook({ cwd: repoRoot, tool_input: { file_path: '../evil.ts' } });
  expect(rel.code).toBe(2);
  expect(rel.stderr).toContain('denied');
});

it('allow: target inside a registered worktree via reverseRepoRoot (candidate ①)', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  const worktree = join(home, 'repo-worktrees', 'wt-1');
  await mkdir(worktree, { recursive: true });
  await mirrorAt(repoRoot, { worktrees: [worktree], agents: {} });
  // The CLI starts inside the worktree — dirname(cwd) basename ends with
  // '-worktrees' → the mirror is located at the reverse-engineered repo root.
  const { code } = await runHook({ cwd: worktree, tool_input: { file_path: join(worktree, 'lib', 'a.ts') } });
  expect(code).toBe(0);
});

it('deny: sibling escape still denied when worktrees are registered', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  const worktree = join(home, 'repo-worktrees', 'wt-1');
  await mkdir(worktree, { recursive: true });
  await mirrorAt(repoRoot, { worktrees: [worktree], agents: { w1: { name: 'w1', worktree, agentId: 'agent-w1' } } });
  const { code } = await runHook({ cwd: worktree, tool_input: { file_path: join(home, 'outside.ts') } });
  expect(code).toBe(2);
});

it('allow: agents[].worktree entries are honored alongside worktrees[]', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  const worktree = join(home, 'repo-worktrees', 'wt-2');
  await mkdir(worktree, { recursive: true });
  await mirrorAt(repoRoot, {
    worktrees: [],
    agents: { w2: { name: 'w2', worktree, agentId: null } },
  });
  const { code } = await runHook({ cwd: worktree, tool_input: { file_path: join(worktree, 'x.ts') } });
  expect(code).toBe(0);
});

it('edge: a repo itself named *-worktrees strips exactly ONE suffix', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'foo-worktrees');
  await mkdir(repoRoot, { recursive: true });
  const worktree = join(home, 'foo-worktrees-worktrees', 'wt-1');
  await mkdir(worktree, { recursive: true });
  await mirrorAt(repoRoot, { worktrees: [worktree], agents: {} });
  const { code } = await runHook({ cwd: worktree, tool_input: { file_path: join(worktree, 'x.ts') } });
  expect(code).toBe(0);
});

it('deny: trailing-separator prefix guard (sibling name extends the repo name)', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  // Sibling directory whose name starts with the repo name: `repo-evil` must
  // NOT be treated as inside `repo` (the trailing-separator prefix rule).
  const sibling = join(home, 'repo-evil');
  await mkdir(sibling, { recursive: true });
  await mirrorAt(repoRoot, { worktrees: [], agents: {} });
  const { code } = await runHook({ cwd: repoRoot, tool_input: { file_path: join(sibling, 'x.ts') } });
  expect(code).toBe(2);
});

it('win32: path comparison is case-insensitive', async () => {
  if (process.platform !== 'win32') return;
  const home = await makeHome();
  const repoRoot = join(home, 'Repo');
  await mkdir(repoRoot, { recursive: true });
  await mirrorAt(repoRoot, { worktrees: [], agents: {} });
  // Uppercase variant of the repo path must still be judged INSIDE the repo.
  const upper = join(home, 'REPO', 'src', 'x.ts');
  const { code } = await runHook({ cwd: repoRoot, tool_input: { file_path: upper } });
  expect(code).toBe(0);
});

it('fail-open: stdin cwd in a deep worktree subdirectory → no mirror located → exit 0 (F2)', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  const deepCwd = join(home, 'repo-worktrees', 'wt-1', 'a', 'b');
  await mkdir(deepCwd, { recursive: true });
  await mirrorAt(repoRoot, { worktrees: [], agents: {} });
  // Mirror exists at <home>/repo but reverseRepoRoot(deepCwd) misses it
  // (dirname basename is not '-worktrees') and cwd itself has no mirror →
  // fail-open even for a sibling-zone write.
  const { code } = await runHook({ cwd: deepCwd, tool_input: { file_path: join(home, 'evil.ts') } });
  expect(code).toBe(0);
});

it('fail-open: stdin cwd equals the worktrees root → no mirror located → exit 0 (F2)', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  const worktreesRoot = join(home, 'repo-worktrees');
  await mkdir(worktreesRoot, { recursive: true });
  await mirrorAt(repoRoot, { worktrees: [], agents: {} });
  const { code } = await runHook({ cwd: worktreesRoot, tool_input: { file_path: join(home, 'evil.ts') } });
  expect(code).toBe(0);
});

it('fail-open: malformed JSON stdin → exit 0 (F2)', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await mirrorAt(repoRoot, { worktrees: [], agents: {} });
  const { code } = await runHookRaw('{ not valid json !!!');
  expect(code).toBe(0);
});

it('fail-open: empty stdin → exit 0 (F2)', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await mirrorAt(repoRoot, { worktrees: [], agents: {} });
  const { code } = await runHookRaw('');
  expect(code).toBe(0);
});

it('allow: relative worktree entries resolve against the located repoRoot (F3)', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  // Slot-name entry: resolves to <repoRoot>/wt-1 — relative to the located
  // repoRoot, NOT to the hook's process cwd (the plugin root).
  const worktree = join(repoRoot, 'wt-1');
  await mkdir(worktree, { recursive: true });
  await mirrorAt(repoRoot, { worktrees: ['wt-1'], agents: {} });
  const { code } = await runHook({ cwd: repoRoot, tool_input: { file_path: join(worktree, 'x.ts') } });
  expect(code).toBe(0);
});

it('allow: relative entry pointing at the sibling worktree is not misjudged as an escape (F3)', async () => {
  const home = await makeHome();
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  const siblingWorktree = join(home, 'repo-worktrees', 'wt-1');
  await mkdir(siblingWorktree, { recursive: true });
  // Pre-fix this was denied (exit 2): isWithin() resolved the relative entry
  // against the hook process cwd, so a legit worktree write looked like a
  // sibling-zone escape. Post-fix it resolves against repoRoot.
  await mirrorAt(repoRoot, { worktrees: ['../repo-worktrees/wt-1'], agents: {} });
  const { code } = await runHook({ cwd: repoRoot, tool_input: { file_path: join(siblingWorktree, 'lib', 'a.ts') } });
  expect(code).toBe(0);
});
