/**
 * Tower identity cross-validation (B2) — pure check functions over a MOCK
 * fold plus persistence behavior through a real TowerStore/BoardStore (state
 * doc seeded directly — no git needed).
 *
 * Coverage contract (基准 B2 list): ① fold entry existence (multiple hits →
 * newest lastSeen), ② dual-channel parent-child (wire parentAgentId vs omkc
 * tower subagents), 缺失≠不匹配 (missing never counts toward failedCount,
 * never blocks), hard mismatch accumulates → blocked at 3, ③ soft workdir
 * mismatch (verified:false only, never counts), 滞后补验 (lazy re-verify on a
 * later call persists verified:true), fold 空降级 (undefined fold → verified:
 * false, never blocked).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BoardStore } from '../src/core/store/board.js';
import type { AgentState, SessionInfo } from '../src/modules/status/state.js';
import {
  IDENTITY_BLOCK_THRESHOLD,
  checkParentChild,
  checkWorkdirSoft,
  evaluateIdentity,
  evaluateTowerIdentity,
  findFoldAgent,
  type IdentityFoldView,
} from '../src/modules/tower/identity.js';
import { TOWER_NAME, towerKeys } from '../src/modules/tower/paths.js';
import { TowerStore } from '../src/modules/tower/store.js';
import type { TowerRosterEntry, TowerState } from '../src/modules/tower/types.js';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// mock fold helpers
// ---------------------------------------------------------------------------

function makeAgent(partial: Partial<AgentState> & { agentId: string; sessionId: string }): AgentState {
  return {
    busy: false,
    subagents: [],
    lastSeen: 100,
    firstSeen: 100,
    source: 'wire',
    omkcTs: 0,
    stale: false,
    ...partial,
  };
}

/** Mock IdentityFoldView: findAgentById mimics StateFold (newest lastSeen wins). */
function mockFold(agents: AgentState[], sessions: SessionInfo[] = []): IdentityFoldView {
  return {
    findAgentById: (agentId) => {
      const hits = agents.filter((a) => a.agentId === agentId);
      if (hits.length === 0) return undefined;
      hits.sort((a, b) => b.lastSeen - a.lastSeen);
      return { ...hits[0]!, subagents: [...hits[0]!.subagents] };
    },
    snapshotSessions: () => sessions.map((s) => ({ ...s })),
  };
}

/** One roster entry helper. */
function rosterEntry(name: string, agentId: string, extra: Partial<TowerRosterEntry> = {}): TowerRosterEntry {
  return {
    name,
    agentId,
    kind: 'worker',
    spawnedAt: new Date().toISOString(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// store fixture — real BoardStore + hand-seeded state (no git, no boot)
// ---------------------------------------------------------------------------

interface IdentityFixture {
  store: TowerStore;
  board: BoardStore;
  repoRoot: string;
  towerAgentId: string;
}

async function makeFixture(agents: TowerRosterEntry[] = []): Promise<IdentityFixture> {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-identity-'));
  homes.push(home);
  const board = new BoardStore({ homeDir: home, workspaceCwd: join(home, 'cwd'), waitCapMs: 200, pollIntervalMs: 15 });
  const repoRoot = join(home, 'repo');
  const store = new TowerStore(repoRoot, board);
  const keys = towerKeys(repoRoot);
  const towerAgentId = 'agent-tower';
  const state: TowerState = {
    version: 1,
    base: 'main',
    mode: 'branch',
    createdAt: new Date().toISOString(),
    roster: {
      agents: [
        { name: TOWER_NAME, agentId: towerAgentId, kind: 'tower', spawnedAt: new Date().toISOString() },
        ...agents,
      ],
    },
    missions: [],
  };
  await board.mutate(
    'workspace',
    (entries, ts) => {
      entries.set(keys.state(), { key: keys.state(), value: JSON.stringify(state), author: TOWER_NAME, ts, tags: [] });
    },
    repoRoot,
  );
  return { store, board, repoRoot, towerAgentId };
}

// ---------------------------------------------------------------------------
// ② dual-channel parent-child (pure)
// ---------------------------------------------------------------------------

it('② wire channel: worker.parentAgentId == towerAgentId confirms', () => {
  const fold = mockFold([
    makeAgent({ sessionId: 's1', agentId: 'agent-w1', parentAgentId: 'agent-tower' }),
  ]);
  const result = checkParentChild(fold, 'agent-tower', 'agent-w1');
  expect(result.ok).toBe(true);
  expect(result.missing).toBe(false);
  expect(result.channel).toBe('wire');
});

it('② omkc channel: tower fold entry lists the worker as a subagent (pure omkc — no parentAgentId)', () => {
  const fold = mockFold([
    makeAgent({ sessionId: 's0', agentId: 'agent-tower', subagents: [{ subagentId: 'agent-w1', status: 'started', ts: 1 }] }),
    // parentAgentId is null/undefined in pure-omkc mode (applyOmkcEvent never sets it).
    makeAgent({ sessionId: 's0', agentId: 'agent-w1', parentAgentId: null }),
  ]);
  const result = checkParentChild(fold, 'agent-tower', 'agent-w1');
  expect(result.ok).toBe(true);
  expect(result.missing).toBe(false);
  expect(result.channel).toBe('omkc');
});

it('② no data → missing (never a mismatch)', () => {
  // Worker entry exists but no parentAgentId; tower entry exists but no subagents.
  const fold = mockFold([
    makeAgent({ sessionId: 's0', agentId: 'agent-tower' }),
    makeAgent({ sessionId: 's1', agentId: 'agent-w1' }),
  ]);
  const result = checkParentChild(fold, 'agent-tower', 'agent-w1');
  expect(result.ok).toBe(false);
  expect(result.missing).toBe(true);
});

it('② wire data present but wrong → mismatch (counts)', () => {
  const fold = mockFold([
    makeAgent({ sessionId: 's1', agentId: 'agent-w1', parentAgentId: 'agent-other' }),
  ]);
  const result = checkParentChild(fold, 'agent-tower', 'agent-w1');
  expect(result.ok).toBe(false);
  expect(result.missing).toBe(false);
  expect(result.reason).toMatch(/mismatch on wire channel/);
});

it('② omkc denies when the tower has subagents but not this worker', () => {
  const fold = mockFold([
    makeAgent({ sessionId: 's0', agentId: 'agent-tower', subagents: [{ subagentId: 'agent-x', status: 'started', ts: 1 }] }),
    makeAgent({ sessionId: 's1', agentId: 'agent-w1' }),
  ]);
  const result = checkParentChild(fold, 'agent-tower', 'agent-w1');
  expect(result.ok).toBe(false);
  expect(result.missing).toBe(false);
  expect(result.reason).toMatch(/mismatch on omkc channel/);
});

it('② either channel confirming wins (wire denies + omkc confirms → ok)', () => {
  const fold = mockFold([
    makeAgent({ sessionId: 's0', agentId: 'agent-tower', subagents: [{ subagentId: 'agent-w1', status: 'started', ts: 1 }] }),
    // stale wire record from an old parent — omkc is fresh and confirms.
    makeAgent({ sessionId: 's1', agentId: 'agent-w1', parentAgentId: 'agent-other' }),
  ]);
  const result = checkParentChild(fold, 'agent-tower', 'agent-w1');
  expect(result.ok).toBe(true);
  expect(result.missing).toBe(false);
  expect(result.channel).toBe('omkc');
});

// ---------------------------------------------------------------------------
// ① + ③ pure checks
// ---------------------------------------------------------------------------

it('① findAgentById picks the NEWEST lastSeen among multiple hits (B1-10)', () => {
  const fold = mockFold([
    makeAgent({ sessionId: 'old', agentId: 'agent-w1', lastSeen: 10 }),
    makeAgent({ sessionId: 'new', agentId: 'agent-w1', lastSeen: 500 }),
  ]);
  const found = findFoldAgent(fold, 'agent-w1');
  expect(found?.sessionId).toBe('new');
  // evaluateTowerIdentity for the tower with a fold entry → verified.
  const towerFold = mockFold([makeAgent({ sessionId: 's0', agentId: 'agent-tower', lastSeen: 10 })]);
  expect(evaluateTowerIdentity(towerFold, 'agent-tower').verified).toBe(true);
  expect(evaluateTowerIdentity(towerFold, 'agent-tower').reason).toBe('ok');
  // Missing tower entry → ① missing.
  const missing = evaluateTowerIdentity(mockFold([]), 'agent-tower');
  expect(missing.verified).toBe(false);
  expect(missing.missing).toBe(true);
  expect(missing.mismatch).toBe(false);
});

it('③ soft: workdir compared with resolve + Windows case normalization; missing session → missing', () => {
  // Workdir matches repoRoot (parent-session cwd proxy).
  const repoRoot = 'C:/work/repo';
  const foldMatch = mockFold(
    [makeAgent({ sessionId: 's1', agentId: 'agent-w1' })],
    [{ workDirHash: 'h', sessionId: 's1', workDir: 'c:\\work\\repo' }], // case differs — still matches
  );
  expect(checkWorkdirSoft(foldMatch, 'agent-w1', repoRoot, 'C:/work/repo-worktrees/wt-1').ok).toBe(true);
  // Worktree anchor matches for a worker (wire mode: worker session cwd = worktree).
  const foldWorktree = mockFold(
    [makeAgent({ sessionId: 's1', agentId: 'agent-w1' })],
    [{ workDirHash: 'h', sessionId: 's1', workDir: 'C:/work/repo-worktrees/wt-1' }],
  );
  expect(checkWorkdirSoft(foldWorktree, 'agent-w1', repoRoot, 'C:/work/repo-worktrees/wt-1').ok).toBe(true);
  // Nowhere near the workspace → soft mismatch (ok:false, missing:false).
  const foldMismatch = mockFold(
    [makeAgent({ sessionId: 's1', agentId: 'agent-w1' })],
    [{ workDirHash: 'h', sessionId: 's1', workDir: 'D:/elsewhere' }],
  );
  const soft = checkWorkdirSoft(foldMismatch, 'agent-w1', repoRoot, 'C:/work/repo-worktrees/wt-1');
  expect(soft.ok).toBe(false);
  expect(soft.missing).toBe(false);
  // No session row → missing.
  const foldNoSession = mockFold([makeAgent({ sessionId: 's1', agentId: 'agent-w1' })], []);
  expect(checkWorkdirSoft(foldNoSession, 'agent-w1', repoRoot).missing).toBe(true);
});

// ---------------------------------------------------------------------------
// persistence through TowerStore.verifyAgentIdentity
// ---------------------------------------------------------------------------

it('缺失 ≠ 不匹配: missing data never increments failedCount and never blocks (5 re-verifies)', async () => {
  const { store, towerAgentId } = await makeFixture([rosterEntry('w1', 'agent-w1', { missionId: 'M1', worktree: 'wt-1' })]);
  const emptyFold = mockFold([]); // fold hasn't seen anything yet
  for (let i = 0; i < 5; i++) {
    const outcome = await store.verifyAgentIdentity('w1', emptyFold, towerAgentId);
    expect(outcome.verdict.verified).toBe(false);
    expect(outcome.verdict.missing).toBe(true);
    expect(outcome.verdict.mismatch).toBe(false);
    expect(outcome.entry.failedCount).toBe(0);
    expect((outcome.entry.failedCount ?? 0) >= IDENTITY_BLOCK_THRESHOLD).toBe(false);
  }
  const state = await store.load();
  const w1 = state.roster.agents.find((a) => a.name === 'w1')!;
  expect(w1.failedCount).toBe(0);
  expect(w1.verified).toBe(false);
});

it('不匹配累计: ② wire mismatch increments failedCount and blocks at 3; fixing the fold resets', async () => {
  const { store, towerAgentId } = await makeFixture([rosterEntry('w1', 'agent-w1', { missionId: 'M1', worktree: 'wt-1' })]);
  const wrongFold = mockFold([
    makeAgent({ sessionId: 's1', agentId: 'agent-w1', parentAgentId: 'agent-other' }),
  ]);
  for (let i = 1; i <= 3; i++) {
    const outcome = await store.verifyAgentIdentity('w1', wrongFold, towerAgentId);
    expect(outcome.verdict.mismatch).toBe(true);
    expect(outcome.entry.failedCount).toBe(i);
    expect(outcome.entry.verified).toBe(false);
    expect((outcome.entry.failedCount ?? 0) >= IDENTITY_BLOCK_THRESHOLD).toBe(i >= 3);
  }
  const state = await store.load();
  expect(state.roster.agents.find((a) => a.name === 'w1')!.failedCount).toBe(3);
  // The fold catches up (wire parent matches now) → verified:true, counter reset.
  const goodFold = mockFold([
    makeAgent({ sessionId: 's1', agentId: 'agent-w1', parentAgentId: 'agent-tower' }),
    makeAgent({ sessionId: 's0', agentId: 'agent-tower' }),
  ], [{ workDirHash: 'h', sessionId: 's1', workDir: store.repoRoot }]);
  const outcome = await store.verifyAgentIdentity('w1', goodFold, towerAgentId);
  expect(outcome.verdict.verified).toBe(true);
  expect(outcome.entry.failedCount).toBe(0);
  expect(outcome.entry.verifiedAt).toEqual(expect.any(String));
});

it('③ soft mismatch never counts: verified:false but failedCount stays 0 across re-verifies', async () => {
  const { store, towerAgentId } = await makeFixture([rosterEntry('w1', 'agent-w1', { missionId: 'M1', worktree: 'wt-1' })]);
  const softFold = mockFold(
    [
      makeAgent({ sessionId: 's1', agentId: 'agent-w1', parentAgentId: 'agent-tower' }),
      makeAgent({ sessionId: 's0', agentId: 'agent-tower' }),
    ],
    [{ workDirHash: 'h', sessionId: 's1', workDir: 'D:/elsewhere' }],
  );
  for (let i = 0; i < 6; i++) {
    const outcome = await store.verifyAgentIdentity('w1', softFold, towerAgentId);
    expect(outcome.verdict.verified).toBe(false);
    expect(outcome.verdict.soft).toBe(true);
    expect(outcome.verdict.mismatch).toBe(false);
    expect(outcome.entry.failedCount).toBe(0);
    expect((outcome.entry.failedCount ?? 0) >= IDENTITY_BLOCK_THRESHOLD).toBe(false);
  }
});

it('滞后补验 (B2-9): a later verification with a caught-up fold persists verified:true + verifiedAt', async () => {
  const { store, towerAgentId } = await makeFixture([rosterEntry('w1', 'agent-w1', { missionId: 'M1', worktree: 'wt-1' })]);
  const emptyFold = mockFold([]);
  const first = await store.verifyAgentIdentity('w1', emptyFold, towerAgentId);
  expect(first.entry.verified).toBe(false);
  expect(first.entry.verifiedAt).toBeUndefined();
  // Fold lags, then catches up (worker + tower entries + session workdir).
  const caughtUp = mockFold(
    [
      makeAgent({ sessionId: 's1', agentId: 'agent-w1', parentAgentId: 'agent-tower' }),
      makeAgent({ sessionId: 's0', agentId: 'agent-tower' }),
    ],
    [{ workDirHash: 'h', sessionId: 's1', workDir: store.repoRoot }],
  );
  const second = await store.verifyAgentIdentity('w1', caughtUp, towerAgentId);
  expect(second.verdict.verified).toBe(true);
  expect(second.entry.verified).toBe(true);
  expect(second.entry.verifiedAt).toEqual(expect.any(String));
  const state = await store.load();
  expect(state.roster.agents.find((a) => a.name === 'w1')).toMatchObject({ verified: true, failedCount: 0 });
});

it('fold 空降级: undefined fold → every check missing, verified:false, never blocked', async () => {
  const { store, towerAgentId } = await makeFixture([rosterEntry('w1', 'agent-w1', { missionId: 'M1', worktree: 'wt-1' })]);
  const outcome = await store.verifyAgentIdentity('w1', undefined, towerAgentId);
  expect(outcome.verdict.verified).toBe(false);
  expect(outcome.verdict.missing).toBe(true);
  expect(outcome.verdict.mismatch).toBe(false);
  expect(outcome.entry.failedCount).toBe(0);
  // The tower entry degrades the same way (① only).
  const towerOutcome = await store.verifyAgentIdentity(TOWER_NAME, undefined, towerAgentId);
  expect(towerOutcome.verdict.verified).toBe(false);
  expect(towerOutcome.verdict.missing).toBe(true);
});

it('tower ①: a fold entry for the booted towerAgentId verifies the tower', async () => {
  const { store, towerAgentId } = await makeFixture();
  const fold = mockFold([makeAgent({ sessionId: 's0', agentId: towerAgentId })]);
  const outcome = await store.verifyAgentIdentity(TOWER_NAME, fold, towerAgentId);
  expect(outcome.verdict.verified).toBe(true);
  expect(outcome.entry.verified).toBe(true);
  expect(outcome.entry.failedCount).toBe(0);
});

it('evaluateIdentity summary: full-pass verdict reports ok', () => {
  const fold = mockFold(
    [
      makeAgent({ sessionId: 's1', agentId: 'agent-w1', parentAgentId: 'agent-tower' }),
      makeAgent({ sessionId: 's0', agentId: 'agent-tower' }),
    ],
    [{ workDirHash: 'h', sessionId: 's1', workDir: 'C:/repo' }],
  );
  const verdict = evaluateIdentity(fold, 'agent-w1', 'agent-tower', 'C:/repo', 'C:/repo-worktrees/wt-1');
  expect(verdict.verified).toBe(true);
  expect(verdict.reason).toBe('ok');
});
