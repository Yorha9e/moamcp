/**
 * Tower identity cross-validation (B2) — 基准 decision 2 + B2-1/B2-2/B2-7/B2-9.
 *
 * The MCP transport cannot authenticate a caller: the tower tools take the
 * caller's self-reported engine agent id and cross-validate it against the
 * status fold (纪律辅助, not a security boundary). Three checks:
 *
 *   ① existence: the agent id has an entry in the status fold
 *      (`StateFold.findAgentById` — multiple hits across sessions pick the
 *      newest `lastSeen`, B1-10). Boot's `towerAgentId` goes through this same
 *      ① check.
 *   ② dual-channel parent-child (B2-1): the worker must be a child of the
 *      tower. The wire channel compares `worker.parentAgentId` to the tower's
 *      agent id; the omkc channel checks the tower's fold entry `subagents`
 *      list. Pure-omkc sessions never carry `parentAgentId` (applyOmkcEvent
 *      does not set it — empirically confirmed), so the omkc channel is the
 *      only signal there.
 *
 *      确认胜出 (confirmation wins): EITHER channel confirming is enough for
 *      `verified` — even when the other channel still carries denying data
 *      (e.g. after a tower restart the wire channel can hold the OLD parent
 *      record while the omkc channel already lists the worker under the NEW
 *      tower entry). A `mismatch` is counted only when at least one channel
 *      has data that denies AND no channel confirms. When neither channel has
 *      data the verdict is `missing` — never counted toward failedCount.
 *   ③ soft workdir check (B2-2): the fold's `SessionInfo.workDir` is the
 *      parent session's cwd acting as a proxy for the worker's own cwd (omkc
 *      subagent events are folded under the parent's session id), NOT the
 *      worker's own cwd — hence deliberately SOFT: a mismatch only flips
 *      verified:false and never counts toward failedCount/blocked. Paths are
 *      compared after `path.resolve` + Windows case normalization
 *      (toLowerCase). B5 re-tightens once dogfood confirms the observed
 *      shapes.
 *
 * 缺失 ≠ 不匹配 (decision 2): missing data (no fold entry, no parentAgentId,
 * no subagents, no session workDir) → `missing: true`, verified:false — the
 * verifier NEVER counts a missing verdict toward failedCount and never blocks
 * on it; the caller re-verifies lazily (register re-run / status read, B2-9).
 * Data present but wrong (② mismatch) → `mismatch: true` — the caller
 * increments failedCount and blocks after IDENTITY_BLOCK_THRESHOLD consecutive
 * mismatches. ③ mismatches are soft and never count.
 */

import { resolve } from 'node:path';

import type { AgentState, SessionInfo, StateFold } from '../status/state.js';

/** Consecutive ② mismatches that flip a roster entry to blocked. */
export const IDENTITY_BLOCK_THRESHOLD = 3;

/** The fold surface identity checks need; `StateFold` satisfies it structurally. */
export interface IdentityFoldView {
  findAgentById(agentId: string): AgentState | undefined;
  snapshotSessions(): SessionInfo[];
}

/**
 * Undefined fold (reuse mode / controller not started) → every check reports
 * missing: the tower degrades to verified:false without ever blocking (fold
 * 滞后/空降级, 风险台账 4).
 */
export function foldView(fold: StateFold | undefined): IdentityFoldView | undefined {
  if (fold === undefined) return undefined;
  return {
    findAgentById: (agentId) => fold.findAgentById(agentId),
    snapshotSessions: () => fold.snapshotSessions(),
  };
}

/** ① — fold entry lookup (multiple hits resolved by the fold, newest lastSeen). */
export function findFoldAgent(
  fold: IdentityFoldView | undefined,
  agentId: string,
): AgentState | undefined {
  return fold?.findAgentById(agentId);
}

export interface ParentChildResult {
  readonly ok: boolean;
  /** true when no channel had data to decide (fields/entries missing). */
  readonly missing: boolean;
  /** which channel decided ('wire' | 'omkc' | 'none'). */
  readonly channel: 'wire' | 'omkc' | 'none';
  readonly reason: string;
}

export interface WorkdirResult {
  readonly ok: boolean;
  /** true when the session/workDir data is absent — never counted. */
  readonly missing: boolean;
  readonly reason: string;
}

export interface IdentityVerdict {
  /** true only when every check had data and passed (① ∧ ② ∧ ③, tower: ① only). */
  readonly verified: boolean;
  /** missing data — never counted toward failedCount/blocked. */
  readonly missing: boolean;
  /** hard mismatch (② data present but wrong) — counts toward failedCount. */
  readonly mismatch: boolean;
  /** soft mismatch (③ workdir) — verified:false only, never counted. */
  readonly soft: boolean;
  readonly reason: string;
  readonly parentChild: ParentChildResult;
  readonly workdir: WorkdirResult;
}

/**
 * ② — dual-channel parent-child check. 确认胜出: EITHER channel confirming is
 * enough for `ok` — even if the other channel carries stale denying data (the
 * tower-restart case: wire still shows the old parent record while omkc
 * already lists the worker under the new tower entry). A channel that HAS
 * data but does NOT confirm counts as a mismatch only when NO channel
 * confirms; only when no channel has data is the verdict `missing`.
 */
export function checkParentChild(
  fold: IdentityFoldView | undefined,
  towerAgentId: string,
  workerAgentId: string,
): ParentChildResult {
  const worker = fold?.findAgentById(workerAgentId);
  const tower = fold?.findAgentById(towerAgentId);
  // wire channel: worker.parentAgentId == towerAgentId.
  const parent = worker?.parentAgentId;
  const wireOk = typeof parent === 'string' && parent.length > 0 && parent === towerAgentId;
  const wireDenies = typeof parent === 'string' && parent.length > 0 && parent !== towerAgentId;
  // omkc channel: the tower's fold entry lists the worker as a subagent.
  const subagents = tower?.subagents ?? [];
  const omkcOk = subagents.some((s) => s.subagentId === workerAgentId);
  const omkcDenies = subagents.length > 0 && !omkcOk;

  if (wireOk || omkcOk) {
    return { ok: true, missing: false, channel: wireOk ? 'wire' : 'omkc', reason: 'ok' };
  }
  if (wireDenies || omkcDenies) {
    return {
      ok: false,
      missing: false,
      channel: wireDenies ? 'wire' : 'omkc',
      reason: `parent-child mismatch on ${wireDenies ? 'wire' : 'omkc'} channel`,
    };
  }
  return {
    ok: false,
    missing: true,
    channel: 'none',
    reason: 'no parent-child data in the fold (parentAgentId absent and tower subagents unknown)',
  };
}

/**
 * ③ — soft workdir check. The session's workDir is the parent session cwd
 * acting as a proxy (see header), so the acceptable anchors are the tower
 * workspace (repoRoot — where the parent session runs) and, for workers, the
 * worktree path (where the worker's own session would run in wire mode).
 * Paths are compared after `path.resolve` + Windows case normalization.
 */
export function checkWorkdirSoft(
  fold: IdentityFoldView | undefined,
  workerAgentId: string,
  repoRoot: string,
  worktree?: string,
): WorkdirResult {
  const worker = fold?.findAgentById(workerAgentId);
  if (worker === undefined) {
    return { ok: false, missing: true, reason: 'fold-entry-missing' };
  }
  const session = fold?.snapshotSessions().find((s) => s.sessionId === worker.sessionId);
  if (
    session === undefined ||
    typeof session.workDir !== 'string' ||
    session.workDir.trim().length === 0
  ) {
    return { ok: false, missing: true, reason: 'session-workdir-missing' };
  }
  const normalize = (p: string): string => resolve(p).toLowerCase();
  const actual = normalize(session.workDir);
  const candidates = [normalize(repoRoot)];
  if (worktree !== undefined) candidates.push(normalize(worktree));
  if (candidates.includes(actual)) return { ok: true, missing: false, reason: 'ok' };
  return {
    ok: false,
    missing: false,
    reason: `session workDir ${JSON.stringify(session.workDir)} is neither the tower workspace nor the worker worktree`,
  };
}

/** ①-only verdict for the boot-registered tower entry (the tower is the root — ②③ don't apply). */
export function evaluateTowerIdentity(
  fold: IdentityFoldView | undefined,
  towerAgentId: string,
): IdentityVerdict {
  if (findFoldAgent(fold, towerAgentId) === undefined) {
    return {
      verified: false,
      missing: true,
      mismatch: false,
      soft: false,
      reason: 'fold-entry-missing (tower)',
      parentChild: { ok: false, missing: true, channel: 'none', reason: 'n/a — tower is the root (① only)' },
      workdir: { ok: false, missing: true, reason: 'n/a — tower is the root (① only)' },
    };
  }
  return {
    verified: true,
    missing: false,
    mismatch: false,
    soft: false,
    reason: 'ok',
    parentChild: { ok: true, missing: false, channel: 'none', reason: 'n/a — tower is the root (① only)' },
    workdir: { ok: true, missing: false, reason: 'n/a — tower is the root (① only)' },
  };
}

/** Full ①②③ verdict for a spawned worker/reviewer entry. */
export function evaluateIdentity(
  fold: IdentityFoldView | undefined,
  workerAgentId: string,
  towerAgentId: string,
  repoRoot: string,
  worktree?: string,
): IdentityVerdict {
  const reasons: string[] = [];
  let missing = false;
  let mismatch = false;
  let soft = false;

  if (findFoldAgent(fold, workerAgentId) === undefined) {
    missing = true;
    reasons.push('fold-entry-missing');
  }
  const pc = checkParentChild(fold, towerAgentId, workerAgentId);
  if (!pc.ok) {
    if (pc.missing) {
      missing = true;
      reasons.push('parent-child-missing');
    } else {
      mismatch = true;
      reasons.push(pc.reason);
    }
  }
  const wd = checkWorkdirSoft(fold, workerAgentId, repoRoot, worktree);
  if (!wd.ok) {
    if (wd.missing) {
      missing = true;
      reasons.push('workdir-missing');
    } else {
      soft = true;
      reasons.push(wd.reason);
    }
  }

  const verified = !missing && !mismatch && !soft;
  return {
    verified,
    missing,
    mismatch,
    soft,
    reason: verified ? 'ok' : reasons.join('; '),
    parentChild: pc,
    workdir: wd,
  };
}
