/**
 * `tower` domain (protocol) — `TowerStore`, the code-enforced half of the
 * tower protocol (ported from kimi-code `pr-2633-tower`
 * `protocol/store.ts`, board-化 per 基准 TOWER_V1_IMPLEMENTATION_PLAN.md).
 *
 * Every comms artifact (state doc, mission doc, inbox message, finding,
 * review, activity-log line) is produced HERE, never by an agent writing
 * board keys by hand. That is what makes the protocol invariants actual
 * invariants: key naming, content shape, recipient validity, review rounds,
 * the merge gate, and the exact activity-log format are not subject to model
 * discipline.
 *
 * State lives in the shared BoardStore workspace scope under
 * `tower/<repoKey>/…` (附录 A row 5 deviation: `state` holds the ordered
 * mission **ids**; each mission is a single `mission/<id>` document — board
 * 96KB ceiling + lower read-modify-write contention). All reads/writes pass
 * `workspace = repoRoot` EXPLICITLY (B1-1 scope anchoring — never the server's
 * workspaceCwd fallback), so two BoardStore instances with different
 * workspaceCwd still share one tower namespace when given the same repoRoot.
 *
 * The 18 official-protocol invariants (附录 A) are each marked below by row
 * number; rows marked **偏差** in the appendix carry an inline comment stating
 * the deliberate change.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import picomatch from 'picomatch';

import { BOARD_VALUE_MAX_BYTES, type BoardEntry, type BoardStore } from '../../core/store/board.js';
import { DEFAULT_WAIT_CAP_MS } from '../../core/constants.js';
import * as git from './git.js';
import {
  evaluateIdentity,
  evaluateTowerIdentity,
  type IdentityFoldView,
  type IdentityVerdict,
} from './identity.js';
import {
  BROADCAST_NAME,
  DELEGATOR_NAME,
  TOWER_NAME,
  dateDash,
  normalizeTowerRoot,
  slugify,
  targetSlug,
  towerKeys,
  worktreesRoot,
  worktreePath,
  type TowerKeys,
} from './paths.js';
import type {
  TowerFindingSeverity,
  TowerFindingType,
  TowerInboxItem,
  TowerMission,
  TowerMissionKind,
  TowerMissionStatus,
  TowerRepoDoc,
  TowerReviewInfo,
  TowerRosterEntry,
  TowerState,
} from './types.js';

export class TowerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TowerProtocolError';
  }
}

export interface TowerInitResult {
  readonly base: string;
  readonly created: boolean;
  /** True when the tower was already booted and only the repo doc's CI command
   *  was updated (B2-4 idempotent re-boot channel). */
  readonly updated?: boolean;
}

export interface TowerPlanInput {
  readonly title: string;
  readonly scope: readonly string[];
  readonly tasks?: readonly string[];
  readonly deps?: readonly string[];
  /** Defaults to `build`. `survey` missions are read-only and reserve no scope. */
  readonly kind?: TowerMissionKind;
}

export interface TowerSendInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly scope?: string;
  readonly action?: string;
  readonly consentRef?: string;
}

export interface TowerFindingInput {
  readonly type: TowerFindingType;
  readonly title: string;
  readonly severity?: TowerFindingSeverity;
  readonly summary: string;
  readonly location?: string;
  readonly details: string;
  readonly suggestedFix: string;
}

export interface TowerReviewInput {
  readonly target: string;
  readonly status: string;
  readonly merge: string;
  readonly findings: string;
  readonly checks?: readonly string[];
  readonly decision: string;
}

export interface TowerMissionPatch {
  readonly status?: TowerMissionStatus;
  readonly note?: string;
  readonly blocker?: string;
  readonly clearBlockers?: boolean;
  readonly taskDone?: string;
  /** Tower-only: assign the roster agent that owns this mission. */
  readonly owner?: string;
  /** Tower-only: replace the mission's scope globs (logged; widens the merge gate). */
  readonly scope?: readonly string[];
}

const FINDING_TYPES: readonly TowerFindingType[] = ['bug', 'improve', 'vuln', 'idea'];
const STATUS_EMOJI: Record<TowerMissionStatus, string> = {
  planned: '🟡',
  active: '🔵',
  completed: '🟢',
  blocked: '🔴',
  paused: '⏸️',
  merged: '✅',
};

/** Guard mirror file name at the repo root (B2-6 final shape: `agents` keeps
 *  NAME keys with `{name, worktree, agentId: string|null}` entries; spawn
 *  writes pending entries agentId:null, register fills the agentId and
 *  rewrites; teardown deletes — 附录 A row 17). */
export const GUARD_MIRROR_FILE = '.tower-guard.json';
/** The tower's board value ceiling: messages must fit with frontmatter (row 13). */
export const TOWER_BODY_MAX_BYTES = BOARD_VALUE_MAX_BYTES;

// ---------------------------------------------------------------------------
// B2 CI constants — exec + log truncation (B2-5: tail 200 lines + single-line
// truncation + ≤64KB total, double protection).
// ---------------------------------------------------------------------------

/** CI exec timeout: 10 minutes, deliberately above git's 60s. */
const CI_TIMEOUT_MS = 10 * 60 * 1000;
/** Stored CI log: last 200 lines. */
const CI_LOG_MAX_LINES = 200;
/** Stored CI log: each line truncated to this many chars. */
const CI_LOG_LINE_MAX_CHARS = 1000;
/** Stored CI log: total ≤64KB (with the line cap this is always satisfiable —
 *  the two caps are independent, hence "双保险"). */
const CI_LOG_MAX_BYTES = 64 * 1024;
/** Raw output collection cap before truncation (prevents memory blowup on a
 *  chatty 10-minute CI; the stored log is exactly capped by truncateCiLog). */
const CI_OUTPUT_CAP_BYTES = 2 * 1024 * 1024;

/** M1 tower wait (moa_tower_wait): inbox poll cadence. Inbox keys are random
 *  UUIDs — there is no fixed board key to wait on, so kind=inbox polls the
 *  caller's inbox at this interval (the board wait's "poll fallback" path);
 *  kind=ci, kind=mission and kind=deps use the board's event-based key wait. */
const WAIT_INBOX_POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * M1 tower wait: the safety cap one wait call may block for — the same
 * `MOAMCP_WAIT_CAP_MS` env the server feeds to BoardStore (server.ts ~line
 * 113), falling back to DEFAULT_WAIT_CAP_MS (25min). A per-call `timeoutMs`
 * is clamped to this cap.
 */
export function towerWaitCapMs(): number {
  const env = Number(process.env.MOAMCP_WAIT_CAP_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_WAIT_CAP_MS;
}

/**
 * M1 async CI — in-process per-worktree serialization. TowerStore instances
 * are constructed per tool call (storeFor), so the chain MUST live at module
 * level to survive across calls (单塔台单会话 assumption, 风险台账 9/11: no
 * cross-process mutex; a multi-tower v2 must add one). A run's COMPLETION
 * only starts after the previous run for the same worktree finished, so
 * concurrent moa_tower_ci calls can never overlap on one worktree. Entries
 * are pruned once their tail settles (see chainCiRun) — the map only ever
 * holds in-flight (unswept) runs.
 */
const ciRunChains = new Map<string, Promise<unknown>>();

/** Number of worktrees with an in-flight CI chain in this process — test/
 *  diagnostics observability (0 = no CI run pending; entries are pruned on
 *  settle). */
export function ciRunChainCount(): number {
  return ciRunChains.size;
}

function chainCiRun<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = ciRunChains.get(key) ?? Promise.resolve();
  const completion = previous.then(task);
  // The chain tail swallows rejections so a failed run never poisons the next
  // one.
  const tail = completion.then(() => undefined, () => undefined);
  ciRunChains.set(key, tail);
  // Prune once the tail settles — but only if the map still holds THIS tail:
  // a newer run chained onto the same worktree meanwhile must not be evicted
  // (its own entry is the one that should be pruned when IT settles).
  void tail.then(() => {
    if (ciRunChains.get(key) === tail) ciRunChains.delete(key);
  });
  return completion;
}

/** B2 progress: single LWW key per mission, value kept ≤80KB (headroom under
 *  the 96KB board ceiling — "留 96KB 内余量"). */
const PROGRESS_MAX_BYTES = 80 * 1024;

/** One `ci/<branchSlug>` result record (B2). `commit` is the branch tip at
 *  execution time; the merge gate requires `commit == current tip`. */
export interface TowerCiResult {
  readonly branch: string;
  readonly commit: string;
  /** null when the run was skipped (dirty worktree) or killed (timeout). */
  readonly exitCode: number | null;
  /** true when the worktree was dirty at run time — no command executed. */
  readonly dirty: boolean;
  /** Board key of the truncated run log (missing for dirty-skipped runs). */
  readonly logRef?: string;
  /** Set when the log write failed — the ci record still lands (B2-5). */
  readonly logError?: string;
  readonly ranAt: string;
  /** M1 async CI: correlation token returned by `startCi` / `moa_tower_ci`;
   *  additive — the merge gate's record shape is unchanged. */
  readonly runId?: string;
}

/**
 * M1 async CI — the immediate response of `startCi` / `moa_tower_ci`. The
 * `ci/<branchSlug>` record that lands later is the source of truth (the merge
 * gate reads it); `runId` correlates the started call with that record/log.
 * `moa_tower_wait(wait={kind:'ci', branch})` is the intended way to await it.
 */
export interface TowerCiStarted {
  readonly runId: string;
  readonly startedAt: string;
  /** 'dirty' when the worktree was dirty — no process spawned, a dirty-failed
   *  record was written synchronously (the tool reports it as an error). */
  readonly status: 'started' | 'dirty';
  /** Present for dirty runs: the synchronously written failed record. */
  readonly record?: TowerCiResult;
}

/**
 * B2-5 log truncation, double protection: keep the last 200 lines, truncate
 * every line to CI_LOG_LINE_MAX_CHARS, then keep the total within
 * CI_LOG_MAX_BYTES (tail wins). The line cap guarantees the byte cap is always
 * satisfiable, so the two caps are independent.
 */
export function truncateCiLog(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .slice(-CI_LOG_MAX_LINES)
    .map((line) =>
      line.length > CI_LOG_LINE_MAX_CHARS
        ? `${line.slice(0, CI_LOG_LINE_MAX_CHARS)} …[truncated]`
        : line,
    );
  let text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') > CI_LOG_MAX_BYTES) {
    const parts = text.split('\n');
    const kept: string[] = [];
    let bytes = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(parts[i]!, 'utf8');
      const separator = kept.length > 0 ? 1 : 0;
      if (bytes + lineBytes + separator > CI_LOG_MAX_BYTES) break;
      kept.unshift(parts[i]!);
      bytes += lineBytes + separator;
    }
    text = kept.join('\n');
  }
  return text;
}

/** A spawned CI process handle. `done` resolves when the process exits (or
 *  fails to spawn / is killed by the timeout). */
export interface CiProcessHandle {
  readonly done: Promise<{ readonly exitCode: number | null; readonly output: string }>;
}

/**
 * Spawn the CI command in a worktree (B2): Windows `cmd /c`, POSIX `sh -c`,
 * environment inherited, `windowsHide: true`, 10-minute timeout, output
 * collected with a hard cap (tail kept) so a chatty run cannot balloon
 * memory. The process starts immediately; `done` resolves with the exit code
 * (null when killed by the timeout or spawn failed).
 *
 * M1 async CI: `startCi` spawns via this handle and lets `done` resolve in a
 * DETACHED completion handler, so the tool call returns right away while the
 * process keeps running.
 */
export function spawnCiCommand(cwd: string, command: string): CiProcessHandle {
  const isWindows = process.platform === 'win32';
  const child = spawn(isWindows ? 'cmd' : '/bin/sh', isWindows ? ['/c', command] : ['-c', command], {
    cwd,
    windowsHide: true,
    env: process.env, // env 继承
  });
  let out = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, CI_TIMEOUT_MS);
  const append = (chunk: Buffer): void => {
    out += chunk.toString('utf8');
    if (Buffer.byteLength(out, 'utf8') > CI_OUTPUT_CAP_BYTES) {
      out = out.slice(out.length - CI_OUTPUT_CAP_BYTES); // tail keeps the newest
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const done = new Promise<{ readonly exitCode: number | null; readonly output: string }>((resolve) => {
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: `${out}\n[ci spawn failed: ${error.message}]`.trim() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const suffix = timedOut ? `\n[ci timed out after ${CI_TIMEOUT_MS}ms — process killed]` : '';
      resolve({ exitCode: timedOut ? null : code, output: `${out}${suffix}` });
    });
  });
  return { done };
}

/**
 * Blocking wrapper over `spawnCiCommand` — resolves with the exit code/output
 * when the process exits. Kept for direct store callers that want the
 * synchronous contract (e.g. tower-tools tests); the tool path uses the
 * detached `startCi`.
 */
export function execCiCommand(
  cwd: string,
  command: string,
): Promise<{ readonly exitCode: number | null; readonly output: string }> {
  return spawnCiCommand(cwd, command).done;
}

/** Keep the newest lines of `text` within `maxBytes` (tail wins; used by the
 *  progress LWW value so it never grows past the board ceiling). */
export function truncateTail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const parts = text.split('\n');
  const kept: string[] = [];
  let bytes = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(parts[i]!, 'utf8');
    const separator = kept.length > 0 ? 1 : 0;
    if (bytes + lineBytes + separator > maxBytes) break;
    kept.unshift(parts[i]!);
    bytes += lineBytes + separator;
  }
  if (kept.length === 0) {
    // even the newest line is over budget — hard-slice it.
    let last = parts[parts.length - 1] ?? '';
    while (Buffer.byteLength(last, 'utf8') > maxBytes) last = last.slice(0, Math.floor(last.length / 2));
    return last;
  }
  return kept.join('\n');
}

// ---------------------------------------------------------------------------
// Minimal YAML-frontmatter codec (port of official protocol/frontmatter.ts).
// The store is the only writer, so values are guaranteed single-line.
// ---------------------------------------------------------------------------

const FENCE = '---';

/**
 * Unlink root-level symlinks/junctions inside `dir`, never their targets.
 * Dirent.isSymbolicLink() is true for Windows directory junctions; unlink
 * removes only the reparse point. Teardown calls this before git's recursive
 * worktree removal because git for Windows FOLLOWS junctions and would delete
 * the target's contents (observed 3× in dogfood: a junctioned node_modules got
 * the main checkout's own node_modules gutted by `git worktree remove`).
 */
async function unlinkRootLinks(dir: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    try {
      await unlink(join(dir, entry.name));
      removed.push(entry.name);
    } catch {
      // best-effort: a stubborn link must not fail the teardown
    }
  }
  return removed;
}

function renderFrontmatter(fields: Readonly<Record<string, string>>): string {
  const lines = [FENCE];
  for (const [key, value] of Object.entries(fields)) {
    if (/[\r\n]/.test(value)) {
      throw new Error(`frontmatter value for "${key}" must be single-line`);
    }
    lines.push(`${key}: ${value}`);
  }
  lines.push(FENCE);
  return lines.join('\n');
}

function parseFrontmatter(text: string): {
  readonly fields: Record<string, string>;
  readonly body: string;
} {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) return { fields: {}, body: text };
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (close === -1) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    fields[key] = line.slice(separator + 1).trim();
  }
  return { fields, body: lines.slice(close + 1).join('\n').trim() };
}

// ---------------------------------------------------------------------------
// Fold helpers — the mutate mutator receives the live `entries` Map; every
// read inside a transaction MUST go through these (calling board methods
// inside a mutate would deadlock on the same per-scope queue).
// ---------------------------------------------------------------------------

function boardEntry(key: string, value: string, author: string, ts: string, tags?: string[]): BoardEntry {
  return { key, value, author, ts, tags: tags ?? [] };
}

function stateFromEntries(keys: TowerKeys, entries: Map<string, BoardEntry>): TowerState {
  const row = entries.get(keys.state());
  if (row === undefined) {
    throw new TowerProtocolError('tower is not booted in this repository — run moa_tower_boot first');
  }
  return JSON.parse(row.value) as TowerState;
}

function missionFromEntries(keys: TowerKeys, entries: Map<string, BoardEntry>, id: string): TowerMission {
  const row = entries.get(keys.mission(id));
  if (row === undefined) throw new TowerProtocolError(`unknown mission "${id}"`);
  return JSON.parse(row.value) as TowerMission;
}

function missionsFromEntries(keys: TowerKeys, entries: Map<string, BoardEntry>, state: TowerState): TowerMission[] {
  const missions: TowerMission[] = [];
  for (const id of state.missions) missions.push(missionFromEntries(keys, entries, id));
  return missions;
}

export class TowerStore {
  /** Normalized absolute path of the main checkout (the tower workspace root). */
  readonly repoRoot: string;
  private readonly board: BoardStore;
  private readonly keys: TowerKeys;

  constructor(repoRoot: string, board: BoardStore) {
    // B1-1 scope anchoring: repoRoot is normalized here and passed as the
    // EXPLICIT workspace on every BoardStore call below — the server's
    // workspaceCwd is never used as a fallback (a worker session cwd is its
    // worktree; falling back would silently split the namespace).
    this.repoRoot = normalizeTowerRoot(repoRoot);
    this.board = board;
    this.keys = towerKeys(this.repoRoot);
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /** True once `boot` has written the state document. */
  async isInitialized(): Promise<boolean> {
    const rows = await this.board.read(this.keys.state(), undefined, 'workspace', 1, this.repoRoot);
    return rows.length > 0;
  }

  /**
   * Boot the tower workspace (official `init`): state document + namespace
   * identity doc + tower roster entry.
   *
   * 附录 A row 1: must be inside a git repository — `isInsideRepo` check.
   * 附录 A row 2: needs ≥1 commit — `hasAnyCommit` check.
   * 附录 A row 3: boot 幂等 — a repeated boot while booted reports an error
   *   (per the plan landing); teardown clears the namespace so boot works again.
   *   **B2-4 exception**: re-boot with a `ci_command` is the idempotent CI
   *   configuration channel — it updates the `…/repo` doc instead of erroring.
   *   **B2R-2**: that re-boot channel is caller-verified — the passed
   *   `towerAgentId` must equal the boot-registered tower roster entry's
   *   agentId, so no arbitrary MCP caller can implant a ciCommand.
   * 附录 A row 4 (**偏差**): official writes `.tower/` to `.git/info/exclude`;
   *   we are exempt — no `.tower/` directory is ever created inside the repo
   *   (state lives in the board under `<home>/boards`, worktrees live in a
   *   sibling `<repoName>-worktrees/`), so there is nothing to exclude.
   *   **B2-12**: boot appends `.tower-guard.json` to `.git/info/exclude`
   *   (idempotent — never duplicated) so the guard mirror file at the repo
   *   root never shows up as untracked in the main checkout.
   */
  async boot(
    towerAgentId: string,
    opts: {
      readonly base?: string;
      readonly mode?: TowerState['mode'];
      /** B2-4: CI command; also the idempotent re-boot channel (repo doc update). */
      readonly ciCommand?: string;
      /** M1: optional delegator roster entry {name:'delegator', kind:'delegator',
       *  agentId} — the delegation channel (may only moa_tower_send → tower).
       *  Registered at fresh boot only; the ci re-boot channel ignores it. */
      readonly delegatorAgentId?: string;
    } = {},
  ): Promise<TowerInitResult> {
    if (!(await git.isInsideRepo(this.repoRoot))) {
      throw new TowerProtocolError(
        'tower needs a git repository (the tower root is not inside one)',
      );
    }
    if (!(await git.hasAnyCommit(this.repoRoot))) {
      throw new TowerProtocolError(
        'the repository has no commits yet — create an initial commit first',
      );
    }
    if (await this.isInitialized()) {
      if (opts.ciCommand !== undefined && opts.ciCommand.trim().length > 0) {
        // B2-4: idempotent CI configuration — re-boot with ci_command updates
        // the repo doc instead of the row-3 "already booted" error.
        //
        // B2R-2: this re-boot channel is caller-verified — the passed
        // tower_agent_id must equal the boot-registered roster entry's agentId
        // (name 'tower'). Otherwise ANY MCP caller could rewrite the repo
        // doc's ciCommand, which moa_tower_ci later executes with the server's
        // full environment in the worktree (command injection). A missing or
        // mismatched id is a TowerProtocolError → runTool maps it to isError.
        const state = await this.load();
        const towerEntry = this.findAgent(state, TOWER_NAME);
        if (towerEntry === undefined || towerEntry.agentId !== towerAgentId) {
          throw new TowerProtocolError(
            `tower_agent_id ${JSON.stringify(towerAgentId)} does not match the booted tower's registered agent id — only the booted tower may reconfigure the CI command`,
          );
        }
        const repoDoc = await this.updateCiCommand(opts.ciCommand.trim());
        await this.appendLog(TOWER_NAME, 'ci.configure', { command: opts.ciCommand.trim() });
        return { base: repoDoc.base, created: false, updated: true };
      }
      // Row 3 (plan landing): repeated boot is a deterministic error, not a
      // silent reset; teardown 后可重 boot.
      throw new TowerProtocolError(
        'tower is already booted in this repository — teardown first (or reuse the existing workspace)',
      );
    }
    if (typeof towerAgentId !== 'string' || towerAgentId.trim().length === 0) {
      throw new TowerProtocolError('towerAgentId is required — pass the orchestrator agent id');
    }
    const base =
      opts.base !== undefined && opts.base.trim().length > 0
        ? opts.base
        : await git.currentBranch(this.repoRoot);
    const mode = opts.mode ?? 'branch';
    if (mode !== 'branch') {
      throw new TowerProtocolError(
        `tower mode "${mode}" is not supported — v1 runs branch mode (pr is reserved for a future gh-backed mode)`,
      );
    }
    const createdAt = new Date().toISOString();
    // Row 7 (决策 1): the tower is the boot-registered orchestrator — its
    // roster entry (reserved name `tower`, kind `tower`) is created here so
    // resolveCallerName can map the orchestrator's agent id to caller 'tower'.
    const state: TowerState = {
      version: 1,
      base,
      mode,
      createdAt,
      roster: {
        agents: [
          { name: TOWER_NAME, agentId: towerAgentId, kind: 'tower', spawnedAt: createdAt },
          ...(opts.delegatorAgentId !== undefined && opts.delegatorAgentId.trim().length > 0
            ? [{ name: DELEGATOR_NAME, agentId: opts.delegatorAgentId.trim(), kind: 'delegator' as const, spawnedAt: createdAt }]
            : []),
        ],
      },
      missions: [],
    };
    const repoDoc: TowerRepoDoc = {
      repoRoot: this.repoRoot,
      worktreesRoot: worktreesRoot(this.repoRoot),
      base,
      mode,
      createdAt,
      bootedAt: createdAt,
      ...(opts.ciCommand !== undefined && opts.ciCommand.trim().length > 0
        ? { ciCommand: opts.ciCommand.trim() }
        : {}),
    };
    // B2-12 (附录 A row 4 deviation): exclude the guard mirror from the main
    // checkout's git status. Written BEFORE the state mutate so a failure here
    // never leaves a booted-but-mirror-exposed half state.
    await this.addGuardExclude();
    await this.board.mutate(
      'workspace',
      (entries, ts) => {
        entries.set(this.keys.state(), boardEntry(this.keys.state(), JSON.stringify(state), TOWER_NAME, ts));
        entries.set(this.keys.repo(), boardEntry(this.keys.repo(), JSON.stringify(repoDoc), TOWER_NAME, ts));
      },
      this.repoRoot,
    );
    await this.appendLog(TOWER_NAME, 'boot', {
      base,
      mode,
      ci: opts.ciCommand !== undefined && opts.ciCommand.trim().length > 0 ? 'configured' : undefined,
      delegator:
        opts.delegatorAgentId !== undefined && opts.delegatorAgentId.trim().length > 0 ? 'registered' : undefined,
    });
    return { base, created: true };
  }

  /**
   * B2-12 (附录 A row 4 deviation): append `.tower-guard.json` to the repo's
   * `.git/info/exclude` — idempotent, never duplicated. The guard mirror file
   * lives at the repo root, so without the exclude the main checkout's
   * `git status` would always show it as untracked.
   */
  private async addGuardExclude(): Promise<void> {
    const rawGitDir = await git.tryGit(this.repoRoot, ['rev-parse', '--git-dir']);
    const gitDir = rawGitDir === null ? '.git' : rawGitDir;
    const gitDirAbs = isAbsolute(gitDir) ? gitDir : join(this.repoRoot, gitDir);
    const excludeFile = join(gitDirAbs, 'info', 'exclude');
    await mkdir(dirname(excludeFile), { recursive: true });
    let content = '';
    try {
      content = await readFile(excludeFile, 'utf8');
    } catch {
      content = ''; // no exclude file yet — fine
    }
    if (content.split(/\r?\n/).some((line) => line.trim() === GUARD_MIRROR_FILE)) return;
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    await writeFile(excludeFile, `${content}${prefix}${GUARD_MIRROR_FILE}\n`, 'utf8');
  }

  /**
   * B2-4: idempotently set the repo doc's CI command (re-boot channel). A
   * no-op when the command is unchanged.
   */
  async updateCiCommand(ciCommand: string): Promise<TowerRepoDoc> {
    return this.board.mutate<TowerRepoDoc>(
      'workspace',
      (entries, ts) => {
        const row = entries.get(this.keys.repo());
        if (row === undefined) {
          throw new TowerProtocolError(
            'tower is not booted in this repository — run moa_tower_boot first',
          );
        }
        const doc = JSON.parse(row.value) as TowerRepoDoc;
        if (doc.ciCommand === ciCommand) return doc; // idempotent: no-op rewrite
        const next: TowerRepoDoc = { ...doc, ciCommand };
        entries.set(this.keys.repo(), boardEntry(this.keys.repo(), JSON.stringify(next), TOWER_NAME, ts));
        return next;
      },
      this.repoRoot,
    );
  }

  async load(): Promise<TowerState> {
    const rows = await this.board.read(this.keys.state(), undefined, 'workspace', 1, this.repoRoot);
    if (rows.length === 0) {
      throw new TowerProtocolError(
        'tower is not booted in this repository — run moa_tower_boot first',
      );
    }
    const state = JSON.parse(rows[0]!.value) as TowerState;
    if (state.version !== 1) {
      throw new TowerProtocolError(`unsupported tower state version: ${String(state.version)}`);
    }
    return state;
  }

  /** The namespace identity doc (`…/repo`), or undefined when not booted. */
  async loadRepoDoc(): Promise<TowerRepoDoc | undefined> {
    const rows = await this.board.read(this.keys.repo(), undefined, 'workspace', 1, this.repoRoot);
    return rows.length > 0 ? (JSON.parse(rows[0]!.value) as TowerRepoDoc) : undefined;
  }

  /** Resolve the state's mission ids to full mission documents (in plan order). */
  async loadMissions(state: TowerState): Promise<TowerMission[]> {
    if (state.missions.length === 0) return [];
    const entries = await this.board.readNamespace(
      this.keys.prefix('mission'),
      undefined,
      'workspace',
      1000,
      this.repoRoot,
    );
    const byId = new Map(entries.map((row) => [row.key.slice(row.key.lastIndexOf('/') + 1), row]));
    const missions: TowerMission[] = [];
    for (const id of state.missions) {
      const row = byId.get(id);
      if (row === undefined) {
        throw new TowerProtocolError(
          `mission ${id} document is missing from the board — tower state is inconsistent`,
        );
      }
      missions.push(JSON.parse(row.value) as TowerMission);
    }
    return missions;
  }

  // ---------------------------------------------------------------------
  // Activity log — the ONLY writer of activity-log lines. One board key per
  // line (`log/<ts>-<rand>`), appended after the mutation it records.
  // ---------------------------------------------------------------------

  async appendLog(
    actor: string,
    action: string,
    details: Readonly<Record<string, string | number | undefined>> = {},
    ref?: string,
  ): Promise<void> {
    const kv = Object.entries(details)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    const parts = [new Date().toISOString(), actor, action];
    if (kv.length > 0) parts.push(kv);
    if (ref !== undefined) parts.push(`ref=${ref}`);
    const line = parts.join(' ');
    // Row 18 spirit: log keys are `<ts>-<rand>` (基准 decision 7) — the random
    // suffix prevents same-millisecond LWW collisions on the board.
    const key = this.keys.log(Date.now(), randomUUID().slice(0, 8));
    await this.board.mutate(
      'workspace',
      (entries, ts) => {
        entries.set(key, boardEntry(key, line, actor, ts, ['log']));
      },
      this.repoRoot,
    );
  }

  /** The last `lines` activity-log lines, oldest→newest (official semantics). */
  async recentLog(lines: number): Promise<readonly string[]> {
    const entries = await this.board.readNamespace(
      this.keys.prefix('log'),
      undefined,
      'workspace',
      1000,
      this.repoRoot,
    );
    const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
    return sorted.slice(-Math.max(1, lines)).map((row) => row.value);
  }

  // ---------------------------------------------------------------------
  // Roster / caller identity
  // ---------------------------------------------------------------------

  /**
   * Map an engine agent id to its tower caller name.
   *
   * 附录 A row 7 (**偏差**, 决策 1): official maps `'main' → 'tower'` and
   * requires every other id to be in the roster. Here the tower is the
   * boot-registered orchestrator: the roster entry created by `boot` resolves
   * to `'tower'`; a literal `'tower'` caller name requires boot to have
   * happened; `'main'` is rejected outright (main is never the tower).
   */
  resolveCallerName(state: TowerState, agentId: string): string {
    if (agentId === 'main') {
      throw new TowerProtocolError(
        '"main" is not the control tower — the tower is the boot-registered orchestrator (moa_tower_boot with tower_agent_id first)',
      );
    }
    if (agentId === TOWER_NAME) {
      // The literal caller name 'tower' is only valid once boot registered the
      // tower entry (i.e. callerName 'tower' 必须已 boot).
      if (state.roster.agents.some((agent) => agent.name === TOWER_NAME)) return TOWER_NAME;
      throw new TowerProtocolError(
        'tower is not booted — only the booted tower and spawned workers/reviewers may use tower tools',
      );
    }
    const entry = state.roster.agents.find((agent) => agent.agentId === agentId);
    if (entry === undefined) {
      throw new TowerProtocolError(
        `agent "${agentId}" is not a tower participant — only the booted tower and spawned workers/reviewers can use tower tools`,
      );
    }
    return entry.name;
  }

  findAgent(state: TowerState, name: string): TowerRosterEntry | undefined {
    return state.roster.agents.find((agent) => agent.name === name);
  }

  /** Alias of `findAgent` (official kept both spellings). */
  findByName(state: TowerState, name: string): TowerRosterEntry | undefined {
    return this.findAgent(state, name);
  }

  /**
   * Shared roster-name collision judgment (B1R-1), read-only over `state`:
   * rejects an exact duplicate, a slug collision with an existing roster
   * member, or a reserved slug ("tower" / "all" / "delegator"). Throws the
   * canonical TowerProtocolError naming the conflicting object.
   *
   * B1R-1: review keys embed `slugify(name)` (`review/<targetSlug>/<slug>-r<n>`),
   * so names that normalize to the SAME slug ("Reviewer A" vs "reviewer-a")
   * would silently LWW-overwrite each other's review doc on the same
   * target+round and bypass the merge gate. Registration therefore rejects any
   * name whose slug collides with an existing roster member or with the
   * reserved tower/broadcast/delegator names — the error names the
   * conflicting object.
   *
   * Single source of truth: `registerAgent` runs it inside its board mutate
   * (defense in depth against concurrent spawns) AND the spawn tool runs it
   * as a preflight BEFORE any side effect (worktree creation, mission
   * activation) so a collision never leaves a half-spawned intermediate state.
   */
  assertNameAvailable(state: TowerState, name: string): void {
    if (this.findAgent(state, name) !== undefined) {
      throw new TowerProtocolError(`tower agent name "${name}" is already registered`);
    }
    const slug = slugify(name, 30);
    for (const agent of state.roster.agents) {
      if (slugify(agent.name, 30) === slug) {
        throw new TowerProtocolError(
          `tower agent name "${name}" collides with roster name "${agent.name}" — both normalize to review slug "${slug}"; choose a distinct name`,
        );
      }
    }
    // M1: 'delegator' is boot-reserved (the delegator channel entry) — a
    // spawned worker/reviewer must never squat on the name/slug.
    if (
      slug === slugify(TOWER_NAME, 30) ||
      slug === slugify(BROADCAST_NAME, 30) ||
      slug === slugify(DELEGATOR_NAME, 30)
    ) {
      const reserved =
        slug === slugify(TOWER_NAME, 30)
          ? TOWER_NAME
          : slug === slugify(BROADCAST_NAME, 30)
            ? BROADCAST_NAME
            : DELEGATOR_NAME;
      throw new TowerProtocolError(
        `tower agent name "${name}" collides with reserved name "${reserved}" — review slug "${slug}" is reserved; choose a distinct name`,
      );
    }
  }

  /**
   * Register a spawned agent's roster entry (two-stage spawn: agentId is '' —
   * pending — until moa_tower_register fills it).
   * 附录 A row 6: roster names are unique — a duplicate name is an error.
   * The collision judgment is `assertNameAvailable` (shared with the spawn
   * tool's zero-side-effect preflight); kept here for defense in depth.
   */
  async registerAgent(entry: TowerRosterEntry): Promise<void> {
    await this.board.mutate(
      'workspace',
      (entries, ts) => {
        const state = stateFromEntries(this.keys, entries);
        this.assertNameAvailable(state, entry.name);
        state.roster.agents.push(entry);
        entries.set(
          this.keys.state(),
          boardEntry(this.keys.state(), JSON.stringify(state), TOWER_NAME, ts),
        );
      },
      this.repoRoot,
    );
  }

  /**
   * B1 basic enrollment for the register tool: fill the real engine agent id
   * into a pending roster entry (and any missing mission/review fields).
   * Overwrite is allowed (resume/re-register) — this is the B2-9 lazy
   * re-verify trigger, so B2 identity checks run through
   * `verifyAgentIdentity` (called by the register tool and the status tool).
   */
  async updateRosterAgentId(
    name: string,
    agentId: string,
    extra: { readonly missionId?: string; readonly reviewTarget?: string; readonly worktree?: string; readonly branch?: string } = {},
  ): Promise<TowerRosterEntry> {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      throw new TowerProtocolError('agent_id is required for moa_tower_register');
    }
    const updated = await this.board.mutate<TowerRosterEntry>(
      'workspace',
      (entries, ts) => {
        const state = stateFromEntries(this.keys, entries);
        const agent = state.roster.agents.find((candidate) => candidate.name === name);
        if (agent === undefined) {
          throw new TowerProtocolError(
            `no roster entry named "${name}" — spawn the agent with moa_tower_spawn first`,
          );
        }
        const next: TowerRosterEntry = {
          ...agent,
          agentId,
          ...(extra.missionId !== undefined ? { missionId: extra.missionId } : {}),
          ...(extra.reviewTarget !== undefined ? { reviewTarget: extra.reviewTarget } : {}),
          ...(extra.worktree !== undefined ? { worktree: extra.worktree } : {}),
          ...(extra.branch !== undefined ? { branch: extra.branch } : {}),
        };
        const index = state.roster.agents.findIndex((candidate) => candidate.name === name);
        state.roster.agents[index] = next;
        entries.set(
          this.keys.state(),
          boardEntry(this.keys.state(), JSON.stringify(state), TOWER_NAME, ts),
        );
        return next;
      },
      this.repoRoot,
    );
    return updated;
  }

  /**
   * B2 identity cross-validation for one roster entry (基准 decision 2):
   * ① fold entry exists; ② dual-channel parent-child; ③ soft workdir check
   * (see identity.ts). Persists verified/verifiedAt/failedCount onto the
   * roster entry inside one mutate; skips the write when nothing changed
   * (cheap enough for the status-read lazy re-verify, B2-9).
   *
   * 缺失 ≠ 不匹配: a missing verdict never increments failedCount and never
   * blocks. A ② mismatch increments failedCount (consecutive, reset on any
   * verified:true); blocked is derived as failedCount ≥ IDENTITY_BLOCK_THRESHOLD.
   * ③ soft mismatches only flip verified:false.
   */
  async verifyAgentIdentity(
    name: string,
    fold: IdentityFoldView | undefined,
    towerAgentId: string,
  ): Promise<{ readonly entry: TowerRosterEntry; readonly verdict: IdentityVerdict }> {
    const outcome = await this.board.mutate<{
      entry: TowerRosterEntry;
      verdict: IdentityVerdict;
    }>(
      'workspace',
      (entries, ts) => {
        const state = stateFromEntries(this.keys, entries);
        const index = state.roster.agents.findIndex((candidate) => candidate.name === name);
        if (index === -1) {
          throw new TowerProtocolError(
            `no roster entry named "${name}" — spawn the agent with moa_tower_spawn first`,
          );
        }
        const agent = state.roster.agents[index]!;
        const verdict =
          agent.name === TOWER_NAME
            ? evaluateTowerIdentity(fold, agent.agentId)
            : evaluateIdentity(
                fold,
                agent.agentId,
                towerAgentId,
                this.repoRoot,
                agent.worktree !== undefined ? worktreePath(this.repoRoot, agent.worktree) : undefined,
              );
        // missing → counter unchanged; verified → reset; mismatch → +1.
        const failedCount = verdict.mismatch
          ? (agent.failedCount ?? 0) + 1
          : verdict.verified
            ? 0
            : (agent.failedCount ?? 0);
        const now = new Date().toISOString();
        const next: TowerRosterEntry = {
          ...agent,
          verified: verdict.verified,
          ...(verdict.verified ? { verifiedAt: now } : agent.verifiedAt !== undefined ? { verifiedAt: agent.verifiedAt } : {}),
          failedCount,
        };
        const unchanged =
          next.verified === agent.verified &&
          (next.verifiedAt ?? null) === (agent.verifiedAt ?? null) &&
          (next.failedCount ?? 0) === (agent.failedCount ?? 0);
        if (!unchanged) {
          state.roster.agents[index] = next;
          entries.set(
            this.keys.state(),
            boardEntry(this.keys.state(), JSON.stringify(state), TOWER_NAME, ts),
          );
        }
        return { entry: next, verdict };
      },
      this.repoRoot,
    );
    return outcome;
  }

  // ---------------------------------------------------------------------
  // Guard mirror (B2-6 定稿): `agents` keeps NAME keys (B1 contract) with
  // `{name, worktree, agentId: string|null}` entries — spawn writes pending
  // entries (agentId:null, name-addressable), register fills the agentId and
  // rewrites; teardown deletes the file (row 17). `worktrees: string[]` stays
  // for the B3 hook allowlist; the omkc policy scans the agents map by
  // agentId (a pending null never matches any real agentId → fail-open
  // window, 基准 decision 4). Atomic tmp+rename; the tmp name carries
  // pid+random (B2-8) so concurrent writers never share a tmp file.
  // ---------------------------------------------------------------------

  /** Rebuild `<repoRoot>/.tower-guard.json` from state + missions (atomic tmp+rename). */
  async syncGuardMirror(): Promise<void> {
    const state = await this.load();
    const missions = await this.loadMissions(state);
    const agents: Record<string, unknown> = {};
    for (const agent of state.roster.agents) {
      if (agent.name === TOWER_NAME) continue; // the tower itself is not guarded
      agents[agent.name] = {
        name: agent.name,
        worktree: agent.worktree !== undefined ? worktreePath(this.repoRoot, agent.worktree) : null,
        agentId: agent.agentId === '' ? null : agent.agentId,
      };
    }
    const worktrees: string[] = [];
    for (const mission of missions) {
      if (mission.status === 'merged') continue;
      if (mission.worktree.length > 0) worktrees.push(worktreePath(this.repoRoot, mission.worktree));
    }
    const doc = {
      version: 1,
      repoRoot: this.repoRoot,
      updatedAt: new Date().toISOString(),
      agents,
      worktrees,
    };
    const file = join(this.repoRoot, GUARD_MIRROR_FILE);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  }

  /** Remove the guard mirror file (row 17: "我们额外删 guard 镜像文件"). */
  async deleteGuardMirror(): Promise<void> {
    try {
      await rm(join(this.repoRoot, GUARD_MIRROR_FILE), { force: true });
    } catch {
      // best-effort: a locked file must not fail the teardown
    }
  }

  // ---------------------------------------------------------------------
  // CI (B2 + M1 async) — `moa_tower_ci` runs the repo doc's ci_command in
  // the mission's worktree and records `ci/<branchSlug>`; the merge gate
  // reads it back (store.ts merge step 7b). M1: the tool spawns the process
  // and returns immediately with {runId, startedAt, status:'started'}; the
  // record that lands when the process exits is the SOURCE OF TRUTH, and
  // `moa_tower_wait(wait={kind:'ci', branch})` is the intended way to await
  // it. Runs are serialized per worktree (module-level chain — 单塔台单会话
  // assumption, 风险台账 9/11: no cross-process mutex; a multi-tower v2 must
  // add one).
  // ---------------------------------------------------------------------

  /** Shared CI preflight: the branch must belong to a mission whose worktree
   *  exists. Returns the absolute worktree path (both the blocking `runCi`
   *  and the async `startCi` use it; `moa_tower_wait(kind='ci')` uses it for
   *  the branch-tip comparison). */
  private async ciContext(branch: string): Promise<{ absPath: string }> {
    const state = await this.load();
    const missions = await this.loadMissions(state);
    const mission = missions.find((m) => m.branch === branch);
    if (mission === undefined) {
      throw new TowerProtocolError(`no tower mission owns branch "${branch}"`);
    }
    const absPath = worktreePath(this.repoRoot, mission.worktree);
    try {
      await access(absPath);
    } catch {
      throw new TowerProtocolError(
        `worktree ${mission.worktree} does not exist — spawn the mission (moa_tower_spawn) before running CI`,
      );
    }
    return { absPath };
  }

  /** Write one `ci/<branchSlug>` record + activity-log line (single writer —
   *  shared by the dirty path, the blocking `runCi`, and the async completion
   *  handler, so the record shape is identical everywhere). */
  private async persistCiRecord(branch: string, record: TowerCiResult): Promise<TowerCiResult> {
    await this.board.mutate(
      'workspace',
      (entries, ts) => {
        entries.set(
          this.keys.ci(branch),
          boardEntry(this.keys.ci(branch), JSON.stringify(record), TOWER_NAME, ts, ['ci']),
        );
      },
      this.repoRoot,
    );
    await this.appendLog(TOWER_NAME, 'ci.run', {
      branch,
      exit_code: record.exitCode === null ? undefined : record.exitCode,
      dirty: record.dirty ? 'yes' : undefined,
      commit: record.commit.slice(0, 7),
      ...(record.runId !== undefined ? { run_id: record.runId } : {}),
    });
    return record;
  }

  /** Execute one CI run to completion and persist its record + log. Never
   *  rejects: spawn/exec failures and log-write failures are written INTO the
   *  record (`exitCode:null` / `logError`), so the detached completion handler
   *  cannot produce an unhandled rejection. */
  private async completeCiRun(
    branch: string,
    ciCommand: string,
    ctx: { readonly absPath: string; readonly tip: string; readonly ranAt: string; readonly runId: string },
  ): Promise<TowerCiResult> {
    let exitCode: number | null = null;
    let logRef: string | undefined;
    let logError: string | undefined;
    const outcome = await execCiCommand(ctx.absPath, ciCommand);
    exitCode = outcome.exitCode;
    const truncated = truncateCiLog(outcome.output);
    try {
      const logKey = this.keys.ciLog(branch, Date.now(), randomUUID().slice(0, 8));
      await this.board.mutate(
        'workspace',
        (entries, ts) => {
          entries.set(logKey, boardEntry(logKey, truncated, TOWER_NAME, ts, ['ci-log']));
        },
        this.repoRoot,
      );
      logRef = logKey;
    } catch (error) {
      // B2-5: logRef 写失败仍落 ci 记录并注 log_error.
      logError = error instanceof Error ? error.message : String(error);
    }
    const record: TowerCiResult = {
      branch,
      commit: ctx.tip,
      exitCode,
      dirty: false,
      logRef,
      logError,
      ranAt: ctx.ranAt,
      runId: ctx.runId,
    };
    // M2 CI artifact self-clean (option (b), see cleanCiArtifacts): the run
    // itself dirties the worktree (npm install → package-lock.json, vitest →
    // dist/) — revert those known CI-generated paths so the NEXT ci/teardown/
    // merge sees a clean tree. Runs even on a failed command: CI artifacts are
    // CI artifacts regardless of the outcome, and the record is written after,
    // so the exitCode/dirty verdict is unaffected.
    await git.cleanCiArtifacts(ctx.absPath);
    return this.persistCiRecord(branch, record);
  }

  /**
   * Blocking CI run — kept for direct store callers that want the synchronous
   * contract (e.g. tower-tools tests; the tool itself uses the async
   * `startCi`). Runs to completion, persists the record, returns it. Runs are
   * serialized against in-flight async runs on the same worktree.
   *
   * Dirty-tree interception (B2-3): a dirty worktree is checked BEFORE any
   * execution; the run is recorded as failed (exitCode null, dirty true) and
   * the caller reports an error telling the tower to commit first. The merge
   * gate requires a clean (dirty:false, exitCode:0) record.
   */
  async runCi(branch: string, ciCommand: string): Promise<TowerCiResult> {
    const { absPath } = await this.ciContext(branch);
    // M2 CI artifact self-clean BEFORE the dirty check (option (b), see
    // cleanCiArtifacts): leftovers of a previous run (rebuilt dist/, touched
    // package-lock.json) must not block THIS run. The dirty check itself is
    // unchanged — real uncommitted edits anywhere else still intercept.
    await git.cleanCiArtifacts(absPath);
    const dirty = await git.isWorktreeDirty(absPath);
    // Branch tips are repo-global refs — resolve from the main checkout (a
    // worktree slot may be a plain dir in tests / between spawns).
    const tip = await git.branchTip(this.repoRoot, branch);
    const ranAt = new Date().toISOString();
    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    if (dirty) {
      const record: TowerCiResult = { branch, commit: tip, exitCode: null, dirty: true, ranAt, runId };
      return this.persistCiRecord(branch, record);
    }
    return this.runChainedCi(absPath, () => this.completeCiRun(branch, ciCommand, { absPath, tip, ranAt, runId }));
  }

  /**
   * M1 async CI: validate + dirty-check, then SPAWN the CI process and return
   * immediately with `{runId, startedAt, status:'started'}`. The completion
   * handler (detached — after the tool call has returned) writes the usual
   * `ci/<branchSlug>` record + per-run log key when the process exits; errors
   * are caught and written into the record/log, never unhandled. The landing
   * record is the source of truth — `moa_tower_wait(kind='ci')` is the
   * intended way to await it.
   *
   * A dirty worktree (B2-3) never spawns: a dirty-failed record is written
   * synchronously and the caller reports it as an error (status:'dirty').
   */
  async startCi(branch: string, ciCommand: string): Promise<TowerCiStarted> {
    const { absPath } = await this.ciContext(branch);
    // M2 CI artifact self-clean BEFORE the dirty check (option (b), see
    // cleanCiArtifacts): leftovers of a previous run (rebuilt dist/, touched
    // package-lock.json) must not block THIS run. The dirty check itself is
    // unchanged — real uncommitted edits anywhere else still intercept.
    await git.cleanCiArtifacts(absPath);
    const dirty = await git.isWorktreeDirty(absPath);
    const tip = await git.branchTip(this.repoRoot, branch);
    const startedAt = new Date().toISOString();
    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    if (dirty) {
      const record: TowerCiResult = { branch, commit: tip, exitCode: null, dirty: true, ranAt: startedAt, runId };
      await this.persistCiRecord(branch, record);
      return { runId, startedAt, status: 'dirty', record };
    }
    // Serialized per worktree: the completion of this run chains after any
    // in-flight run on the same worktree (module-level — see chainCiRun).
    const completion = this.runChainedCi(absPath, () =>
      this.completeCiRun(branch, ciCommand, { absPath, tip, ranAt: startedAt, runId }),
    );
    // Detached: the tool call has already returned; never leave an unhandled
    // rejection (completeCiRun already catches exec/log failures, this is the
    // last-resort net for board-persist failures).
    void completion.catch((error) => {
      void this.appendLog(TOWER_NAME, 'ci.run-error', {
        branch,
        run_id: runId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    });
    return { runId, startedAt, status: 'started' };
  }

  /** Chain one CI completion after in-flight runs on the same worktree. */
  private runChainedCi<T>(absPath: string, task: () => Promise<T>): Promise<T> {
    return chainCiRun(absPath, task);
  }

  /** The latest `ci/<branchSlug>` result record, or undefined when none ran. */
  async loadCiResult(branch: string): Promise<TowerCiResult | undefined> {
    const rows = await this.board.read(this.keys.ci(branch), undefined, 'workspace', 1, this.repoRoot);
    if (rows.length === 0) return undefined;
    return JSON.parse(rows[0]!.value) as TowerCiResult;
  }

  // ---------------------------------------------------------------------
  // Wait (M1) — the tower long-poll primitive behind `moa_tower_wait`.
  // Modeled on moa_board_wait / moa_wait_turn: event/emit-based wakeup for
  // fixed keys (ci record, mission doc — via BoardStore.wait, which also
  // polls persistent scopes), poll fallback for the random-UUID inbox keys.
  // Every kind returns {status:'ok', ...payload} on wake or
  // {status:'timeout', retry:true} at the cap (timeoutMs clamped to the
  // MOAMCP_WAIT_CAP_MS safety cap — see towerWaitCapMs).
  // ---------------------------------------------------------------------

  /** Validate + clamp a per-call timeoutMs against the wait safety cap. */
  private waitTimeout(timeoutMs?: number): number {
    if (timeoutMs === undefined || timeoutMs === null) return towerWaitCapMs();
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TowerProtocolError('timeoutMs must be a positive number');
    }
    return Math.min(timeoutMs, towerWaitCapMs());
  }

  /**
   * Wait kind=ci: block until the `ci/<branchSlug>` record exists AND its
   * `commit` matches the branch's CURRENT tip. The tip is re-resolved from
   * git on every check (the wait call itself rev-parses the branch in the
   * mission worktree), so a stale record from an older tip NEVER satisfies
   * the wait. Event-based: BoardStore.wait on the exact ci key wakes us when
   * a new record lands (its persistent poller covers cross-process writers);
   * the loop re-checks record + tip on every wake.
   */
  async waitForCi(branch: string, timeoutMs?: number): Promise<{ status: 'ok'; record: TowerCiResult } | { status: 'timeout'; retry: true }> {
    // Validates the branch belongs to a mission with an existing worktree.
    await this.ciContext(branch);
    const effectiveTimeout = this.waitTimeout(timeoutMs);
    const deadline = Date.now() + effectiveTimeout;
    // `since` = the ts of the record seen at the last check, so a re-write of
    // the SAME (stale) record does not count as progress.
    let since: string | undefined;
    for (;;) {
      const rows = await this.board.read(this.keys.ci(branch), undefined, 'workspace', 1, this.repoRoot);
      // The wait call itself rev-parses the branch tip (repo-global ref — the
      // mission worktree/repo share one git dir) to compare against the record.
      const tip = await git.branchTip(this.repoRoot, branch);
      if (rows.length > 0) {
        const record = JSON.parse(rows[0]!.value) as TowerCiResult;
        if (record.commit === tip) return { status: 'ok', record };
        since = rows[0]!.ts;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'timeout', retry: true };
      const wake = await this.board.wait(this.keys.ci(branch), 'workspace', remaining, since, this.repoRoot);
      if (wake.status !== 'ready') continue; // chunk timeout / closed → re-check the deadline
    }
  }

  /**
   * Wait kind=inbox: block until the caller's tower inbox has at least one
   * message (the same message set `moa_tower_inbox` would return). Inbox keys
   * are random UUIDs — there is no fixed key to wait on, so this polls
   * `readInbox` at WAIT_INBOX_POLL_MS (the poll-fallback path).
   */
  async waitForInbox(
    callerName: string,
    timeoutMs?: number,
  ): Promise<{ status: 'ok'; messages: readonly TowerInboxItem[] } | { status: 'timeout'; retry: true }> {
    const effectiveTimeout = this.waitTimeout(timeoutMs);
    const deadline = Date.now() + effectiveTimeout;
    for (;;) {
      const messages = await this.readInbox(callerName, 1000);
      if (messages.length > 0) return { status: 'ok', messages };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'timeout', retry: true };
      await sleep(Math.min(WAIT_INBOX_POLL_MS, remaining));
    }
  }

  /**
   * Wait kind=mission: block until the mission doc's `status` field changes
   * from what it was at call time (baseline captured first, then compared).
   * Event-based: BoardStore.wait on the exact mission key with `since` =
   * baseline ts wakes us on the next mission write; a write that leaves the
   * status unchanged (e.g. a note) loops with the new ts. A board 'closed'
   * result (the task scope was archived/closed out from under the waiter) is
   * surfaced distinctly as {status:'closed'} — it is NOT a retryable timeout.
   */
  async waitForMission(
    id: string,
    timeoutMs?: number,
  ): Promise<
    | { status: 'ok'; mission: TowerMission }
    | { status: 'timeout'; retry: true }
    | { status: 'closed' }
  > {
    const baselineRows = await this.board.read(this.keys.mission(id), undefined, 'workspace', 1, this.repoRoot);
    if (baselineRows.length === 0) {
      throw new TowerProtocolError(`unknown mission "${id}" — known missions require moa_tower_plan first`);
    }
    const baselineStatus = (JSON.parse(baselineRows[0]!.value) as TowerMission).status;
    const effectiveTimeout = this.waitTimeout(timeoutMs);
    const deadline = Date.now() + effectiveTimeout;
    let since = baselineRows[0]!.ts;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'timeout', retry: true };
      const wake = await this.board.wait(this.keys.mission(id), 'workspace', remaining, since, this.repoRoot);
      // 'closed' is terminal and distinct from a timeout; any other non-ready
      // result (a board-internal cap chunk) just loops to the deadline like
      // waitForCi does.
      if (wake.status === 'closed') return { status: 'closed' };
      if (wake.status !== 'ready') continue;
      const mission = JSON.parse(wake.entry.value) as TowerMission;
      if (mission.status !== baselineStatus) return { status: 'ok', mission };
      since = wake.entry.ts;
    }
  }

  /**
   * Wait kind=deps: block until EVERY mission id in `mission(mission_id).deps`
   * has status 'merged' (dependency-driven parallel dispatch — all missions go
   * out at once, dependents park here and wake when their deps land). The full
   * deps set is evaluated first: if every dep is already merged at call time
   * the wait returns immediately (an empty deps list is vacuously satisfied).
   * While any dep is unmerged we wait on THAT dep's exact mission-doc key via
   * the event-based BoardStore.wait path, with a `since` cursor on the doc ts
   * observed at the last evaluation — a successful moa_tower_merge ALWAYS
   * writes the dep mission doc (status → 'merged', see saveMissionStatus), and
   * that write is exactly what wakes us. Every wake re-evaluates the FULL deps
   * set and only resolves when all are merged. A board 'closed' result is
   * surfaced distinctly as {status:'closed'} — it is NOT a retryable timeout.
   */
  async waitForDeps(
    missionId: string,
    timeoutMs?: number,
  ): Promise<
    | { status: 'ok'; deps: ReadonlyArray<{ readonly id: string; readonly status: TowerMissionStatus }> }
    | { status: 'timeout'; retry: true }
    | { status: 'closed' }
  > {
    // The target mission must exist (consistent with waitForMission's
    // unknown-id handling).
    const missionRows = await this.board.read(this.keys.mission(missionId), undefined, 'workspace', 1, this.repoRoot);
    if (missionRows.length === 0) {
      throw new TowerProtocolError(`unknown mission "${missionId}" — known missions require moa_tower_plan first`);
    }
    const mission = JSON.parse(missionRows[0]!.value) as TowerMission;
    const effectiveTimeout = this.waitTimeout(timeoutMs);
    const deadline = Date.now() + effectiveTimeout;
    for (;;) {
      // Evaluate the FULL deps set from the board on every pass. A dep id with
      // no mission document is corruption — deps are validated at plan time
      // (附录 A row 9) and mission docs are never deleted, so it is an error at
      // call time rather than something a wait could ever satisfy.
      const deps: Array<{ readonly id: string; readonly status: TowerMissionStatus }> = [];
      const seenTs = new Map<string, string>();
      for (const dep of mission.deps) {
        const rows = await this.board.read(this.keys.mission(dep), undefined, 'workspace', 1, this.repoRoot);
        if (rows.length === 0) {
          throw new TowerProtocolError(
            `mission "${missionId}" lists dep "${dep}" but no mission document exists — tower state is inconsistent (deps are validated at plan time)`,
          );
        }
        seenTs.set(dep, rows[0]!.ts);
        deps.push({ id: dep, status: (JSON.parse(rows[0]!.value) as TowerMission).status });
      }
      if (deps.every((dep) => dep.status === 'merged')) return { status: 'ok', deps };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'timeout', retry: true };
      // Park on the FIRST unmerged dep's mission-doc key (with `since` = the ts
      // seen above, so a re-write of the SAME doc state cannot falsely satisfy
      // the wait). Merges of other deps are irrelevant while this one is still
      // unmerged — the loop re-evaluates everything on every wake.
      const target = deps.find((dep) => dep.status !== 'merged')!;
      const wake = await this.board.wait(this.keys.mission(target.id), 'workspace', remaining, seenTs.get(target.id), this.repoRoot);
      // 'closed' is terminal and distinct from a timeout; any other non-ready
      // result (a board-internal cap chunk) just loops to the deadline.
      if (wake.status === 'closed') return { status: 'closed' };
      if (wake.status !== 'ready') continue;
      // Woken by a dep-mission write — loop and re-evaluate the full set.
    }
  }

  // ---------------------------------------------------------------------
  // Missions
  // ---------------------------------------------------------------------

  /**
   * Split a tower goal into missions. Each mission gets an id, a branch, and
   * a worktree slot; scopes must be pairwise disjoint and deps must reference
   * known mission ids.
   *
   * 附录 A row 8 (**偏差**, B1-8): official branches are `feat/<slug(title)>`;
   * we use `feat/M<n>-<slug(title)>` so two plans with the same title cannot
   * collide on one branch (official merges by branch and could attach a
   * mission to the wrong branch). Worktree slots stay `wt-<n>` (physical
   * layout: sibling `<repoName>-worktrees/wt-<n>`, 基准 decision 8).
   * 附录 A row 9: deps must be known (already planned or in this batch).
   * 附录 A row 10: scope overlap check, verbatim (three-chained stem replace,
   *  order fixed; empty stem = whole repo; conflict = prefix relation).
   */
  async plan(input: readonly TowerPlanInput[]): Promise<readonly TowerMission[]> {
    if (input.length === 0) {
      throw new TowerProtocolError('TowerPlan needs at least one mission');
    }
    const missions = await this.board.mutate<TowerMission[]>(
      'workspace',
      (entries, ts) => {
        const state = stateFromEntries(this.keys, entries);
        const existing = missionsFromEntries(this.keys, entries, state);
        const startIndex = state.missions.length;
        const planned: TowerMission[] = input.map((item, index) => {
          const n = startIndex + index + 1;
          const slug = slugify(item.title, 40);
          return {
            id: `M${n}`,
            title: item.title,
            slug,
            kind: item.kind ?? 'build',
            scope: [...item.scope],
            // Row 8 deviation (B1-8): id-prefixed branch — 防同标题撞分支.
            branch: `feat/M${n}-${slug}`,
            worktree: `wt-${n}`,
            deps: item.deps ?? [],
            status: 'planned',
            tasks: (item.tasks ?? []).map((text) => ({ text, done: false })),
            notes: [],
            blockers: [],
          };
        });
        // Row 9: mission ids referenced by deps must exist.
        const knownIds = new Set([...state.missions, ...planned.map((m) => m.id)]);
        for (const mission of planned) {
          for (const dep of mission.deps) {
            if (!knownIds.has(dep)) {
              throw new TowerProtocolError(
                `mission ${mission.id} depends on unknown mission "${dep}"`,
              );
            }
          }
        }
        // Row 10: merged missions are history, not reservations.
        this.assertScopesDisjoint([
          ...existing.filter((m) => m.status !== 'merged'),
          ...planned,
        ]);
        state.missions.push(...planned.map((m) => m.id));
        entries.set(
          this.keys.state(),
          boardEntry(this.keys.state(), JSON.stringify(state), TOWER_NAME, ts),
        );
        for (const mission of planned) {
          entries.set(
            this.keys.mission(mission.id),
            boardEntry(this.keys.mission(mission.id), JSON.stringify(mission), TOWER_NAME, ts),
          );
        }
        return planned;
      },
      this.repoRoot,
    );
    // B1-3 (item 10): a mutate persist failure rolls back memory but already
    // written records are not undone — verify the batch landed on the board.
    await this.verifyMissionsOnDisk(missions.map((m) => m.id));
    await this.appendLog(TOWER_NAME, 'plan', { missions: missions.map((m) => m.id).join(',') });
    return missions;
  }

  /** Post-plan persist verification (item 10 fallback for partial persistence). */
  private async verifyMissionsOnDisk(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const rows = await this.board.read(this.keys.mission(id), undefined, 'workspace', 1, this.repoRoot);
      if (rows.length === 0) {
        throw new TowerProtocolError(
          `plan persisted incompletely: mission ${id} is not on the board — tower state is inconsistent; re-run plan (the append-only JSONL keeps the audit trail)`,
        );
      }
    }
  }

  /**
   * Conservative overlap check over the scopes that reserve write access —
   * i.e. `build` missions only. Survey scopes are informational and reserve
   * nothing, so they never conflict. Two build scopes conflict when one is a
   * path prefix of the other after stripping trailing `**` / `*` wildcards.
   * 附录 A row 10: verbatim port — the three-chained replace order is
   * `/\*\*?$/ → ''`, then `/\*$/ → ''`, then `/\/+$/ → ''`, and must NOT be
   * reordered (each strip feeds the next).
   */
  private assertScopesDisjoint(missions: readonly TowerMission[]): void {
    const scopes: Array<{ readonly id: string; readonly raw: string; readonly stem: string }> = [];
    for (const mission of missions) {
      if (mission.kind === 'survey') continue;
      for (const raw of mission.scope) {
        const stem = raw.replace(/\/\*\*?$/, '').replace(/\*$/, '').replace(/\/+$/, '');
        if (stem.length === 0) {
          throw new TowerProtocolError(
            `mission ${mission.id} scope "${raw}" covers the whole repo — narrow it down`,
          );
        }
        scopes.push({ id: mission.id, raw, stem });
      }
    }
    for (let i = 0; i < scopes.length; i++) {
      for (let j = i + 1; j < scopes.length; j++) {
        const a = scopes[i]!;
        const b = scopes[j]!;
        if (a.id === b.id) continue;
        if (a.stem === b.stem || a.stem.startsWith(`${b.stem}/`) || b.stem.startsWith(`${a.stem}/`)) {
          throw new TowerProtocolError(
            `mission scopes overlap: ${a.id} ("${a.raw}") vs ${b.id} ("${b.raw}") — split the shared files into exactly one mission`,
          );
        }
      }
    }
  }

  /**
   * Patch one mission. 附录 A row 11: only the tower or the owning worker may
   * update a mission. 附录 A row 12: owner/scope are tower-only (scope changes
   * re-run the disjoint check and are logged), a blocker sets status blocked,
   * task_done must match an open task, no-op patches are suppressed, and a
   * pure task tick does not touch the activity log.
   */
  async updateMission(
    callerName: string,
    id: string,
    patch: TowerMissionPatch,
    options: { readonly silent?: boolean } = {},
  ): Promise<TowerMission> {
    const outcome = await this.board.mutate<{ mission: TowerMission; wrote: boolean }>(
      'workspace',
      (entries, ts) => {
        const state = stateFromEntries(this.keys, entries);
        const mission = missionFromEntries(this.keys, entries, id);
        // Row 11: only tower / owning worker.
        if (callerName !== TOWER_NAME) {
          const caller = this.findAgent(state, callerName);
          if (caller?.kind !== 'worker' || caller.missionId !== id) {
            throw new TowerProtocolError(
              `agent "${callerName}" does not own mission ${id} — workers update only their own mission file`,
            );
          }
        }
        // Row 12: no-op patches neither render nor log.
        const isNoOp =
          patch.status === mission.status &&
          patch.note === undefined &&
          patch.blocker === undefined &&
          patch.clearBlockers === undefined &&
          patch.taskDone === undefined &&
          patch.owner === undefined &&
          patch.scope === undefined;
        if (isNoOp) return { mission, wrote: false };

        if (patch.owner !== undefined) {
          if (callerName !== TOWER_NAME) {
            throw new TowerProtocolError(
              `agent "${callerName}" cannot assign mission ownership — only the tower sets owner`,
            );
          }
          mission.owner = patch.owner;
        }
        if (patch.scope !== undefined) {
          if (callerName !== TOWER_NAME) {
            throw new TowerProtocolError(
              `agent "${callerName}" cannot change mission scope — only the tower widens a scope, and every change is logged`,
            );
          }
          const others = missionsFromEntries(this.keys, entries, state).filter(
            (m) => m.id !== id && m.status !== 'merged',
          );
          this.assertScopesDisjoint([...others, { ...mission, scope: [...patch.scope] }]);
          mission.scope = [...patch.scope];
        }
        if (patch.status !== undefined) mission.status = patch.status;
        if (patch.note !== undefined) mission.notes.push(patch.note);
        if (patch.blocker !== undefined) {
          mission.blockers.push(patch.blocker);
          mission.status = 'blocked';
        }
        if (patch.clearBlockers === true) mission.blockers = [];
        if (patch.taskDone !== undefined) {
          const task = mission.tasks.find((t) => !t.done && t.text.includes(patch.taskDone!));
          if (task === undefined) {
            throw new TowerProtocolError(
              `mission ${id} has no open task matching "${patch.taskDone}"`,
            );
          }
          task.done = true;
        }
        entries.set(
          this.keys.mission(id),
          boardEntry(this.keys.mission(id), JSON.stringify(mission), callerName, ts),
        );
        return { mission, wrote: true };
      },
      this.repoRoot,
    );
    // Row 12: task ticks alone are not log-worthy; `silent` (spawn bookkeeping)
    // suppresses the line too.
    const taskTickOnly =
      patch.taskDone !== undefined &&
      patch.status === undefined &&
      patch.note === undefined &&
      patch.blocker === undefined &&
      patch.clearBlockers === undefined &&
      patch.owner === undefined &&
      patch.scope === undefined;
    if (outcome.wrote && !taskTickOnly && options.silent !== true) {
      await this.appendLog(callerName, 'mission.update', {
        id,
        status: patch.status,
        note: patch.note !== undefined ? 'added' : undefined,
        blocker: patch.blocker !== undefined ? 'added' : undefined,
        owner: patch.owner,
        scope: patch.scope?.join(','),
      });
    }
    return outcome.mission;
  }

  /** Board key of one mission document (for activity-log ref lines). */
  missionRef(id: string): string {
    return this.keys.mission(id);
  }

  /** Human-readable mission view (replaces the official generated `missions/*.md`). */
  missionView(mission: TowerMission): string {
    return [
      `# Mission ${mission.id}: ${mission.title}${mission.kind === 'survey' ? ' 🔍 (read-only survey)' : ''}`,
      '',
      '| Branch | Worktree | Status | Scope | Owner |',
      '| ------ | -------- | ------ | ----- | ----- |',
      `| ${mission.branch} | ${mission.worktree} | ${STATUS_EMOJI[mission.status]} ${mission.status} | ${mission.scope.join(', ')} | ${mission.owner ?? '—'} |`,
      '',
      '## Tasks',
      ...(mission.tasks.length > 0
        ? mission.tasks.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`)
        : ['- [ ] (no tasks recorded)']),
      '',
      '## Dependencies',
      mission.deps.length > 0 ? mission.deps.join(', ') : '(none)',
      '',
      '## Blockers',
      ...(mission.blockers.length > 0 ? mission.blockers.map((b) => `- ${b}`) : ['- (none)']),
      '',
      '## Notes',
      ...(mission.notes.length > 0 ? mission.notes.map((n) => `- ${n}`) : ['- (none)']),
      '',
    ].join('\n');
  }

  // ---------------------------------------------------------------------
  // Progress (B2) — one LWW key `progress/<missionId>` per mission; the owner
  // worker (or the tower) appends a dated line. The value keeps the TAIL
  // within PROGRESS_MAX_BYTES (headroom under the 96KB board ceiling). The
  // write-frequency throttle is the profile's cron discipline (B4) — no code
  // rate limit here.
  // ---------------------------------------------------------------------

  /**
   * Post one progress note (row-11 ownership: only the tower or the mission's
   * owning worker). Single key LWW; the accumulated value is truncated to the
   * newest lines fitting in PROGRESS_MAX_BYTES.
   */
  async updateProgress(
    callerName: string,
    missionId: string,
    note: string,
  ): Promise<{ readonly key: string; readonly bytes: number }> {
    const trimmed = note.trim();
    if (trimmed.length === 0) {
      throw new TowerProtocolError('progress note must not be empty');
    }
    const state = await this.load();
    if (callerName !== TOWER_NAME) {
      const caller = this.findAgent(state, callerName);
      if (caller?.kind !== 'worker' || caller.missionId !== missionId) {
        throw new TowerProtocolError(
          `agent "${callerName}" does not own mission ${missionId} — only the tower or the owning worker posts progress`,
        );
      }
    }
    const missions = await this.loadMissions(state);
    if (!missions.some((m) => m.id === missionId)) {
      throw new TowerProtocolError(
        `unknown mission "${missionId}" — known missions: ${state.missions.join(', ') || '(none planned yet)'}`,
      );
    }
    const key = this.keys.progress(missionId);
    const line = `[${new Date().toISOString()}] ${callerName}: ${trimmed}`;
    const result = await this.board.mutate<{ key: string; bytes: number }>(
      'workspace',
      (entries, ts) => {
        const existing = entries.get(key);
        const value =
          existing === undefined ? line : truncateTail(`${existing.value}\n${line}`, PROGRESS_MAX_BYTES);
        entries.set(key, boardEntry(key, value, callerName, ts, ['progress']));
        return { key, bytes: Buffer.byteLength(value, 'utf8') };
      },
      this.repoRoot,
    );
    return result;
  }

  // ---------------------------------------------------------------------
  // Inbox
  // ---------------------------------------------------------------------

  /**
   * Deliver an inbox message. 附录 A row 13 (**偏差**): recipients must be
   * `tower`, `all`, or a roster agent; self-send is forbidden. Official had no
   * body cap; the board ceiling is 96KB, so an oversized body errors with a
   * split hint. 附录 A row 18 (**偏差**): the message key is a random UUID —
   * date-based names would collide under the board's same-key LWW.
   */
  async send(callerName: string, input: TowerSendInput): Promise<string> {
    const state = await this.load();
    const to = input.to.trim();
    if (
      to !== TOWER_NAME &&
      to !== BROADCAST_NAME &&
      this.findAgent(state, to) === undefined
    ) {
      const known = [TOWER_NAME, BROADCAST_NAME, ...state.roster.agents.map((a) => a.name)];
      throw new TowerProtocolError(
        `unknown recipient "${to}" — address a roster agent, ${TOWER_NAME}, or ${BROADCAST_NAME} (known: ${known.join(', ')})`,
      );
    }
    if (to === callerName) {
      throw new TowerProtocolError('cannot send an inbox message to yourself');
    }
    const sentAt = new Date().toISOString();
    const frontmatter = renderFrontmatter({
      type: 'inbox',
      message_id: randomUUID(),
      from: callerName,
      to,
      subject: input.subject,
      sent_at: sentAt,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.consentRef !== undefined ? { consent_ref: input.consentRef } : {}),
    });
    const content = `${frontmatter}\n\n${input.body.trim()}\n`;
    // Row 13 deviation: board ceiling — pre-check and tell the caller to split.
    const bodyBytes = Buffer.byteLength(input.body, 'utf8');
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (bodyBytes > BOARD_VALUE_MAX_BYTES || contentBytes > BOARD_VALUE_MAX_BYTES) {
      throw new TowerProtocolError(
        `message body too large: ${bodyBytes} bytes > ${BOARD_VALUE_MAX_BYTES} (board ceiling) — split it into multiple messages`,
      );
    }
    const rel = this.keys.inbox(randomUUID());
    await this.board.mutate(
      'workspace',
      (entries, ts) => {
        entries.set(rel, boardEntry(rel, content, callerName, ts, ['inbox']));
      },
      this.repoRoot,
    );
    await this.appendLog(callerName, 'inbox.send', { to, subject: slugify(input.subject) }, rel);
    return rel;
  }

  /** Newest-first messages addressed to `callerName` or broadcast. The tower sees everything. */
  async readInbox(callerName: string, limit: number): Promise<readonly TowerInboxItem[]> {
    const entries = await this.board.readNamespace(
      this.keys.prefix('inbox'),
      undefined,
      'workspace',
      1000,
      this.repoRoot,
    );
    const items: TowerInboxItem[] = [];
    for (const row of entries) {
      const { fields, body } = parseFrontmatter(row.value);
      if (fields['type'] !== 'inbox') continue;
      const to = fields['to'] ?? '';
      if (callerName !== TOWER_NAME && to !== callerName && to !== BROADCAST_NAME) continue;
      items.push({
        file: row.key,
        from: fields['from'] ?? 'unknown',
        to,
        subject: fields['subject'] ?? '',
        sentAt: fields['sent_at'] ?? '',
        scope: fields['scope'],
        action: fields['action'],
        consentRef: fields['consent_ref'],
        body,
      });
    }
    items.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    // Reads are not actions — the activity log records what participants DID,
    // not what they looked at. No inbox.read line here.
    return items.slice(0, Math.max(1, limit));
  }

  // ---------------------------------------------------------------------
  // Findings
  // ---------------------------------------------------------------------

  /**
   * File a structured finding. 附录 A row 14: type must be one of
   * bug | improve | vuln | idea. 附录 A row 18 (**偏差**): key is a random
   * UUID, not a date-based file name.
   */
  async fileFinding(callerName: string, input: TowerFindingInput): Promise<string> {
    if (!FINDING_TYPES.includes(input.type)) {
      throw new TowerProtocolError(
        `finding type must be one of ${FINDING_TYPES.join(' | ')}`,
      );
    }
    const state = await this.load();
    const caller = this.findAgent(state, callerName);
    const mission =
      caller?.missionId !== undefined
        ? (await this.loadMissions(state)).find((m) => m.id === caller.missionId)
        : undefined;

    const lines = [
      `# Finding: ${input.title}`,
      '',
      `**Date**: ${dateDash().replaceAll('-', '')}`,
      `**Agent**: ${callerName}`,
      `**Type**: ${input.type}`,
      `**Severity**: ${input.severity ?? 'medium'}`,
      `**Mission**: ${mission === undefined ? '(none)' : `${mission.id} — ${mission.title}`}`,
      '',
      '---',
      '',
      '## Summary',
      input.summary.trim(),
      '',
      '## Location',
      (input.location ?? '(not specified)').trim(),
      '',
      '## Details',
      input.details.trim(),
      '',
      '## Suggested Fix / Action',
      input.suggestedFix.trim(),
      '',
      '## Why Not Fixed Directly',
      mission === undefined
        ? 'This finding is outside the reporting agent’s assignment. Assigning to the control tower for routing.'
        : `This finding is outside the scope of mission ${mission.id} (${mission.scope.join(', ')}). Fixing it directly would violate scope isolation. Assigning to the control tower for routing.`,
      '',
      '---',
      '',
      `*Filed by tower agent ${callerName}*`,
      '',
    ];
    const rel = this.keys.finding(randomUUID());
    const content = lines.join('\n');
    await this.board.mutate(
      'workspace',
      (entries, ts) => {
        entries.set(rel, boardEntry(rel, content, callerName, ts, ['finding', input.type]));
      },
      this.repoRoot,
    );
    await this.appendLog(
      callerName,
      'finding.file',
      { type: input.type, slug: slugify(input.title) },
      rel,
    );
    return rel;
  }

  /**
   * B4: enumerate every filed finding (newest first) for the panel's
   * `GET /api/tower/findings` route. Findings are plain markdown — `fileFinding`
   * renders `**Field**: value` lines (no YAML frontmatter), so the fields are
   * extracted from those lines; the title is pulled from the `# Finding:`
   * heading. Board keys are random UUIDs (row 18 deviation) — ordering is by
   * date, newest first, then key for a stable tiebreak.
   */
  async listFindings(): Promise<
    ReadonlyArray<{
      file: string;
      date: string;
      agent: string;
      type: string;
      severity: string;
      mission: string;
      title: string;
    }>
  > {
    const entries = await this.board.readNamespace(
      this.keys.prefix('finding'),
      undefined,
      'workspace',
      1000,
      this.repoRoot,
    );
    const findings: Array<{
      file: string;
      date: string;
      agent: string;
      type: string;
      severity: string;
      mission: string;
      title: string;
    }> = [];
    for (const row of entries) {
      const field = (name: string): string => {
        const match = new RegExp(`^\\*\\*${name}\\*\\*:\\s*(.+)$`, 'm').exec(row.value);
        return match === null ? '' : match[1]!.trim();
      };
      const titleMatch = /^#\s+Finding:\s*(.+)$/m.exec(row.value);
      findings.push({
        file: row.key,
        date: field('Date'),
        agent: field('Agent') || 'unknown',
        type: field('Type'),
        severity: field('Severity') || 'medium',
        mission: field('Mission') || '(none)',
        title: titleMatch !== null ? titleMatch[1]!.trim() : '(untitled)',
      });
    }
    findings.sort((a, b) => b.date.localeCompare(a.date) || a.file.localeCompare(b.file));
    return findings;
  }

  // ---------------------------------------------------------------------
  // Reviews
  // ---------------------------------------------------------------------

  /**
   * Submit a review verdict. 附录 A row 15: only an assigned reviewer (or the
   * tower) may review a branch; status must match `/^(clean|p[12]-\d+items)$/`;
   * merge verdict ∈ merge | fix-then-merge | hold; the round is the reviewer's
   * own history + 1. `reviewedCommit` is the branch tip at submission time —
   * **implementation moved to the controller/tool layer** (B1-6: the tool
   * runs `git rev-parse <branch>` itself and passes it in; the LLM never
   * self-reports it).
   */
  async submitReview(
    callerName: string,
    input: TowerReviewInput,
    reviewedCommit: string,
  ): Promise<string> {
    const state = await this.load();
    if (callerName !== TOWER_NAME) {
      const caller = this.findAgent(state, callerName);
      if (caller?.kind !== 'reviewer' || caller.reviewTarget !== input.target) {
        throw new TowerProtocolError(
          `agent "${callerName}" is not an assigned reviewer for "${input.target}"`,
        );
      }
    }
    if (!/^(clean|p[12]-\d+items)$/.test(input.status)) {
      throw new TowerProtocolError(
        `review status must be clean | p1-Nitems | p2-Nitems, got "${input.status}"`,
      );
    }
    if (!['merge', 'fix-then-merge', 'hold'].includes(input.merge)) {
      throw new TowerProtocolError(
        `review merge verdict must be merge | fix-then-merge | hold, got "${input.merge}"`,
      );
    }
    if (typeof reviewedCommit !== 'string' || reviewedCommit.trim().length === 0) {
      throw new TowerProtocolError(
        'reviewedCommit could not be resolved — the branch must exist before a review is submitted',
      );
    }
    const existing = await this.reviewsFor(input.target);
    const round = existing.filter((r) => r.reviewer === callerName).length + 1;

    const frontmatter = renderFrontmatter({
      date: dateDash(),
      reviewer: callerName,
      target: input.target,
      round: String(round),
      status: input.status,
      merge: input.merge,
      reviewed_commit: reviewedCommit,
    });
    const checks = (input.checks ?? []).map((c) => `- [x] ${c}`).join('\n');
    const content = [
      frontmatter,
      '',
      '## Findings',
      '',
      input.findings.trim(),
      '',
      '## Checks',
      checks.length > 0 ? checks : '- [x] (reviewer reported no formal checks)',
      '',
      '## Decision',
      input.decision.trim(),
      '',
    ].join('\n');

    const rel = this.keys.review(
      targetSlug(input.target),
      slugify(callerName, 30),
      round,
    );
    await this.board.mutate(
      'workspace',
      (entries, ts) => {
        // B1R-1: the review key is deterministic (`target/slug-r<round>`) — a
        // second write to an existing key would LWW-silently replace the prior
        // verdict. If the key is already present, this round was already
        // submitted (or a slug collision slipped through): fail loudly and
        // point at the legitimate next step instead of overwriting.
        if (entries.has(rel)) {
          throw new TowerProtocolError(
            `review ${rel} already exists — round ${String(round)} for "${input.target}" was already submitted; submit the next round (or register the reviewer under a distinct name)`,
          );
        }
        entries.set(rel, boardEntry(rel, content, callerName, ts, ['review']));
      },
      this.repoRoot,
    );
    await this.appendLog(
      callerName,
      'review.write',
      { target: input.target, round, verdict: input.status, reviewed: reviewedCommit.slice(0, 7) },
      rel,
    );
    return rel;
  }

  /** All reviews for a target branch, sorted by round ascending. */
  async reviewsFor(target: string): Promise<readonly TowerReviewInfo[]> {
    const prefix = `${this.keys.ns}/review/${targetSlug(target)}/`;
    const entries = await this.board.readNamespace(prefix, undefined, 'workspace', 1000, this.repoRoot);
    const reviews: TowerReviewInfo[] = [];
    for (const row of entries) {
      const { fields } = parseFrontmatter(row.value);
      const round = Number.parseInt(fields['round'] ?? '', 10);
      if (Number.isNaN(round)) continue;
      reviews.push({
        reviewer: fields['reviewer'] ?? 'unknown',
        target: fields['target'] ?? target,
        round,
        status: fields['status'] ?? '',
        merge: fields['merge'] ?? '',
        reviewedCommit: fields['reviewed_commit'] ?? '',
        date: fields['date'] ?? '',
        file: row.key,
      });
    }
    reviews.sort((a, b) => a.round - b.round);
    return reviews;
  }

  /** The highest-round reviews of a branch (B1-12: the merge gate's "latest"). */
  async latestReviewRound(target: string): Promise<readonly TowerReviewInfo[]> {
    const reviews = await this.reviewsFor(target);
    if (reviews.length === 0) return [];
    const maxRound = Math.max(...reviews.map((r) => r.round));
    return reviews.filter((r) => r.round === maxRound);
  }

  /**
   * B4: per-mission review-gate summary — the SHARED implementation behind the
   * status tool's `review_gate` rows and the `/api/tower/missions` route's
   * per-mission `review_gate` field (one source, no drift). Semantics match
   * the status tool verbatim: no reviews → `{review:'none'}`; otherwise the
   * highest round's reviewers/status and a sync verdict comparing each
   * review's `reviewedCommit` against the live branch tip.
   */
  async reviewGateForMission(mission: { id: string; branch: string }): Promise<Record<string, unknown>> {
    const latestReviews = await this.latestReviewRound(mission.branch);
    if (latestReviews.length === 0) {
      return { branch: mission.branch, mission: mission.id, review: 'none' };
    }
    const tip = (await git.branchExists(this.repoRoot, mission.branch))
      ? await git.branchTip(this.repoRoot, mission.branch)
      : undefined;
    return {
      branch: mission.branch,
      mission: mission.id,
      round: latestReviews[0]!.round,
      reviewers: latestReviews.map((r) => r.reviewer).join(', '),
      status: latestReviews.map((r) => `${r.reviewer}=${r.status}`).join(', '),
      sync:
        tip === undefined
          ? 'branch-not-created'
          : latestReviews.every((r) => r.reviewedCommit === tip)
            ? 'reviewed-commit-matches-tip'
            : `stale — tip moved to ${tip.slice(0, 7)}, re-review required`,
    };
  }

  // ---------------------------------------------------------------------
  // Merge — the hard gate. The tower LLM decides WHEN to call this; the gate
  // itself decides WHETHER it happens.
  // ---------------------------------------------------------------------

  /**
   * 附录 A row 16: the eight-step gate, order preserved verbatim —
   * branch 属主 → deps-unmerged → survey zero-diff noop (**before** the review
   * checks) → no-review → not-clean → tip-moved → out-of-scope (picomatch) →
   * [B2 CI hard gate when a ci_command is configured] → mergeNoFf →
   * conflictsWith. Every blocked step appends a `merge.blocked` activity-log
   * line with the step reason.
   *
   * B1-12 deviation: "latest review clean" means EVERY review in the highest
   * round is clean (round desc + date desc — the official readdir-order
   * `latestReview` had a same-round bypass hole: two reviewers of one round,
   * newest file wins regardless of the other reviewer's verdict).
   *
   * B2 (marked at the insertion point): the CI gate runs AFTER out-of-scope.
   * When a ci_command is configured on the repo doc it is a HARD gate — a
   * `ci/<branchSlug>` record with commit == current tip && exitCode == 0 &&
   * !dirty is required, and a red run blocks with `reason=ci-failed`. When no
   * ci_command is configured the step is skipped and logs
   * `reason=ci-not-configured` (B2-11).
   */
  async merge(branch: string): Promise<{
    readonly mergeCommit: string;
    readonly conflictsWith: ReadonlyArray<{ readonly branch: string; readonly files: readonly string[] }>;
    /** True when a read-only survey closed without a git merge. */
    readonly noop?: boolean;
  }> {
    const state = await this.load();
    const missions = await this.loadMissions(state);
    // Step 1 — branch 属主: the branch must belong to a tower mission.
    const mission = missions.find((m) => m.branch === branch);
    if (mission === undefined) {
      throw new TowerProtocolError(`no tower mission owns branch "${branch}"`);
    }
    // A blocked merge is a decision with a reason — it belongs in the
    // activity log just as much as a successful one.
    const block = async (reason: string, message: string): Promise<TowerProtocolError> => {
      await this.appendLog(TOWER_NAME, 'merge.blocked', { branch, reason });
      return new TowerProtocolError(message);
    };

    // Step 2 — deps-unmerged.
    const unmergedDeps = mission.deps.filter((dep) => {
      const depMission = missions.find((m) => m.id === dep);
      return depMission !== undefined && depMission.status !== 'merged';
    });
    if (unmergedDeps.length > 0) {
      throw await block(
        'deps-unmerged',
        `merge blocked: dependencies not merged yet (${unmergedDeps.join(', ')}) — merge in Dependency Flow order`,
      );
    }

    // Step 3 — survey zero-diff noop, BEFORE the review checks (row 16).
    // Survey missions are read-only: a clean (zero-diff) branch closes with a
    // noop merge — no review, no git ceremony.
    if (mission.kind === 'survey') {
      const changed = await git.diffNameOnly(this.repoRoot, state.base, branch);
      if (changed.length > 0) {
        throw await block(
          'read-only-survey',
          `merge blocked: survey mission ${mission.id} is read-only but ${branch} has ${String(changed.length)} changed file(s): ${changed.slice(0, 5).join(', ')} — investigate the worker; if the changes are worth keeping, move them onto a build mission's branch`,
        );
      }
      await this.saveMissionStatus(mission, 'merged');
      const tip = await git.branchTip(this.repoRoot, state.base);
      await this.appendLog(TOWER_NAME, 'merge.noop', { branch, kind: 'survey' });
      return { mergeCommit: tip, conflictsWith: [], noop: true };
    }

    // Step 4 — no-review.
    const reviews = await this.reviewsFor(branch);
    if (reviews.length === 0) {
      throw await block(
        'no-review',
        `merge blocked: ${branch} has no review — assign a reviewer first`,
      );
    }
    // Step 5 — not-clean (B1-12: highest round, ALL clean).
    const maxRound = Math.max(...reviews.map((r) => r.round));
    const latest = reviews.filter((r) => r.round === maxRound);
    const dirty = latest.find((r) => r.status !== 'clean');
    if (dirty !== undefined) {
      throw await block(
        'not-clean',
        `merge blocked: latest review round ${String(maxRound)} is not fully clean ("${dirty.status}" by ${dirty.reviewer}; round = ${latest.map((r) => `${r.reviewer}=${r.status}`).join(', ')}) — a clean review round at the current tip is required`,
      );
    }
    // Step 6 — tip-moved: every clean review of the highest round must match
    // the current branch tip.
    const tip = await git.branchTip(this.repoRoot, branch);
    const moved = latest.find((r) => r.reviewedCommit !== tip);
    if (moved !== undefined) {
      throw await block(
        'tip-moved',
        `merge blocked: ${branch} moved since the clean review (reviewed ${moved.reviewedCommit.slice(0, 7)}, tip ${tip.slice(0, 7)}) — re-review required`,
      );
    }

    // Step 7 — out-of-scope: every file the branch changed must fall inside
    // the mission's declared scope globs (picomatch semantics — `**` crosses
    // directories). A legitimate expansion goes through a tower scope update
    // first, which is logged.
    const changed = await git.diffNameOnly(this.repoRoot, state.base, branch);
    const outOfScope = changed.filter(
      (file) => !mission.scope.some((glob) => picomatch.isMatch(file, glob)),
    );
    if (outOfScope.length > 0) {
      throw await block(
        'out-of-scope',
        `merge blocked: ${branch} changed files outside mission ${mission.id} scope (${mission.scope.join(', ')}): ${outOfScope.join(', ')} — the tower must widen the mission scope (TowerMission scope patch) or revert those changes`,
      );
    }

    // Step 7b — CI green (B2 hard gate, only when a ci_command is configured
    // on the repo doc, B2-4). Requires a recorded run with commit == current
    // tip && exitCode == 0 && !dirty. All git IO and board reads happen
    // OUTSIDE any mutate transaction (reviewedCommit precedent) — the state
    // was loaded at the top and `tip` came from step 6's `git rev-parse`.
    const repoDoc = await this.loadRepoDoc();
    const ciCommand = repoDoc?.ciCommand?.trim();
    if (ciCommand !== undefined && ciCommand.length > 0) {
      const ci = await this.loadCiResult(branch);
      const tipMatch = ci !== undefined && ci.commit === tip;
      const green = ci !== undefined && ci.exitCode === 0 && ci.dirty !== true;
      if (!tipMatch || !green) {
        const detail =
          ci === undefined
            ? 'no CI run recorded'
            : `recorded commit ${ci.commit.slice(0, 7)}${ci.commit !== tip ? ` ≠ tip ${tip.slice(0, 7)}` : ''}, exitCode ${String(ci.exitCode)}, dirty ${String(ci.dirty)}`;
        throw await block(
          'ci-failed',
          `merge blocked: CI is not green for ${branch} (${detail}) — run moa_tower_ci on the clean current tip`,
        );
      }
    } else {
      await this.appendLog(TOWER_NAME, 'merge.ci-skip', { branch, reason: 'ci-not-configured' });
    }

    // Step 8 — mergeNoFf + conflictsWith.
    const mergeCommit = await git.mergeNoFf(this.repoRoot, branch);
    await this.saveMissionStatus(mission, 'merged');

    // Informational: unmerged branches that touched the same files now likely
    // conflict with the new base. The tower tells them to rebase — their tip
    // moves, and the reviewed_commit gate then forces a re-review.
    const changedSet = new Set(changed);
    const conflictsWith: Array<{ readonly branch: string; readonly files: readonly string[] }> = [];
    for (const other of missions) {
      if (other.branch === branch || other.status === 'merged') continue;
      // Planned missions may have no branch yet (never spawned) — nothing to conflict with.
      if (!(await git.branchExists(this.repoRoot, other.branch))) continue;
      const otherChanged = await git.diffNameOnly(this.repoRoot, state.base, other.branch);
      const overlap = otherChanged.filter((file) => changedSet.has(file));
      if (overlap.length > 0) {
        conflictsWith.push({ branch: other.branch, files: overlap });
      }
    }

    await this.appendLog(TOWER_NAME, 'merge', {
      branch,
      base: state.base,
      merge_commit: mergeCommit.slice(0, 7),
    });
    return { mergeCommit, conflictsWith };
  }

  /** Mark one mission merged (state doc + mission doc in one transaction). */
  private async saveMissionStatus(mission: TowerMission, status: TowerMissionStatus): Promise<void> {
    await this.board.mutate(
      'workspace',
      (entries, ts) => {
        const current = missionFromEntries(this.keys, entries, mission.id);
        current.status = status;
        entries.set(
          this.keys.mission(mission.id),
          boardEntry(this.keys.mission(mission.id), JSON.stringify(current), TOWER_NAME, ts),
        );
      },
      this.repoRoot,
    );
  }

  // ---------------------------------------------------------------------
  // Worktrees / teardown
  // ---------------------------------------------------------------------

  /**
   * Create the physical worktree for a mission slot. The physical layout is
   * `<repoRoot>` 同级 `<repoName>-worktrees/<slot>` (基准 decision 8) — never
   * inside the repo (row 4: no `.tower/` tree).
   */
  async addWorktree(worktree: string, branch: string, base: string): Promise<string> {
    const absPath = worktreePath(this.repoRoot, worktree);
    await git.worktreeAdd(this.repoRoot, absPath, branch, base);
    await this.appendLog(TOWER_NAME, 'worktree.add', { worktree, branch, base });
    return worktree;
  }

  /**
   * Tear the tower down. 附录 A row 17: worktrees with uncommitted changes are
   * kept unless `force`; official keeps state on disk — we additionally delete
   * the guard mirror file, and (row 3 landing) clear the live board namespace
   * so a fresh boot is possible. The append-only board JSONL remains the audit
   * trail either way (documented deviation: official kept `.tower/comms/`).
   *
   * M2 teardown-consistency fix (dogfood evidence: teardown reported `kept`
   * yet STILL deleted the guard mirror and cleared the namespace, leaving a
   * dead "tower is not booted" board — a retry was impossible). Lifecycle is
   * now: worktree removal FIRST (junction guard preserved); the boot state
   * (guard mirror + live namespace) is torn down ONLY when every mission
   * worktree was removed (or none exist). If ANY worktree was kept (dirty, no
   * force) or failed to remove, the report lists each outcome truthfully
   * (`removed <slot>` / `kept <slot> (<reason>)` /
   * `failed to remove <slot>: <err>`) and the tower STAYS BOOTED
   * (`torn_down:false`) so the caller can fix and retry (with or without
   * force). A planned-but-never-spawned mission has no physical worktree —
   * nothing is kept and nothing failed, so it counts as removed.
   */
  async teardown(options: { readonly force?: boolean } = {}): Promise<{
    readonly torn_down: boolean;
    readonly report: readonly string[];
  }> {
    const state = await this.load();
    const missions = await this.loadMissions(state);
    const report: string[] = [];
    let tornDown = true;
    for (const mission of missions) {
      const absPath = worktreePath(this.repoRoot, mission.worktree);
      // A mission may be planned-but-never-spawned (or its worktree already
      // removed): no physical tree exists — nothing to keep, nothing failed.
      try {
        await access(absPath);
      } catch {
        report.push(`removed ${mission.worktree} (no worktree found)`);
        continue;
      }
      if (await git.isWorktreeDirty(absPath)) {
        if (options.force !== true) {
          report.push(`kept ${mission.worktree} (uncommitted changes — rerun with force to remove)`);
          tornDown = false;
          continue;
        }
      }
      try {
        // Junction guard: drop root-level links (e.g. a junctioned
        // node_modules) before git's recursive removal — git for Windows
        // follows them and would delete the TARGET's contents.
        const unlinked = await unlinkRootLinks(absPath);
        if (unlinked.length > 0) {
          report.push(`unlinked junctions in ${mission.worktree}: ${unlinked.join(', ')}`);
        }
        await git.worktreeRemove(this.repoRoot, absPath, options.force === true);
        report.push(`removed ${mission.worktree}`);
        await this.appendLog(TOWER_NAME, 'worktree.remove', { worktree: mission.worktree });
      } catch (error) {
        report.push(
          `failed to remove ${mission.worktree}: ${error instanceof Error ? error.message : String(error)}`,
        );
        tornDown = false;
      }
    }
    if (!tornDown) {
      // M2: keep the boot state intact so the caller can fix the kept/failed
      // worktrees and re-run teardown (with or without force). A tool that
      // reports `kept` must not destroy the ability to retry.
      await this.appendLog(TOWER_NAME, 'teardown.partial', {
        kept: report.filter((line) => line.startsWith('kept ')).length,
        failed: report.filter((line) => line.startsWith('failed to remove ')).length,
        force: options.force === true ? 'yes' : undefined,
      });
      return { torn_down: false, report };
    }
    // Row 17 deviation: we additionally delete the guard mirror file.
    await this.deleteGuardMirror();
    await this.appendLog(TOWER_NAME, 'teardown', {
      force: options.force === true ? 'yes' : undefined,
    });
    // Row 3: clearing the live namespace makes re-boot well-defined. The JSONL
    // audit trail is preserved by the board's append-only design.
    await this.board.mutate(
      'workspace',
      (entries, _ts) => {
        for (const key of [...entries.keys()]) {
          if (key === this.keys.ns || key.startsWith(`${this.keys.ns}/`)) entries.delete(key);
        }
      },
      this.repoRoot,
    );
    return { torn_down: true, report };
  }

  /** Every log line mentioning `merge.blocked` (status/route convenience). */
  async blockedMergeLog(): Promise<readonly string[]> {
    const entries = await this.board.readNamespace(
      this.keys.prefix('log'),
      undefined,
      'workspace',
      1000,
      this.repoRoot,
    );
    return [...entries]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((row) => row.value)
      .filter((line) => line.includes('merge.blocked'));
  }
}
