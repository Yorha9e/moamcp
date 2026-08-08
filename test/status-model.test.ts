/**
 * status-model unit tests (0.9.0): tree building (main parent / orphan fill /
 * dedup / cycle guard / reparent), gone F4 semantics (re-root, orphan-leaf
 * cascade delete, out-of-order resurrection), session-gone, status derivation,
 * and the D2 drift protection (real functions vs the serialized source run in
 * a bare vm).
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import {
  activeAgentKeys,
  activeAgentKeysWithAncestors,
  agentKey,
  applySnapshot,
  deriveStatus,
  isActiveAgent,
  listDirectories,
  matchDebateSpecs,
  modelCounts,
  newModel,
  partitionSession,
  removeAgent,
  removeSession,
  sessionDirKey,
  STATUS_MODEL_JS,
  subtreeKeys,
  upsertAgent,
  type RawAgent,
  type StatusModel,
} from '../src/web/status-model.js';

/** Minimal agent fixture builder mirroring the fold's AgentState shape. */
function agent(sessionId: string, agentId: string, extra: Partial<RawAgent> = {}): RawAgent {
  return {
    sessionId,
    agentId,
    busy: false,
    stale: false,
    lastSeen: 0,
    firstSeen: 0,
    subagents: [],
    ...extra,
  };
}

function snapshot(sessions: unknown[], agents: RawAgent[]) {
  return { sessions, agents };
}

function childKeys(model: StatusModel, sessionId: string, agentId: string): string[] {
  const e = model.byKey[agentKey(sessionId, agentId)];
  return e ? e.children.slice() : [];
}

function roots(model: StatusModel, sessionId: string): string[] {
  return (model.roots[sessionId] || []).slice();
}

function rootIds(model: StatusModel, sessionId: string): string[] {
  return roots(model, sessionId).map((k) => model.byKey[k].agentId);
}

/** DFS flatten of a session's tree (visited-guarded, mirror of page render). */
function flatten(model: StatusModel, sessionId: string): string[] {
  const out: string[] = [];
  const visited: Record<string, boolean> = {};
  const stack: string[] = [];
  const rs = roots(model, sessionId) || [];
  for (let i = rs.length - 1; i >= 0; i--) stack.push(rs[i]);
  while (stack.length) {
    const key = stack.pop();
    if (visited[key]) continue;
    visited[key] = true;
    out.push(model.byKey[key].agentId);
    const children = model.byKey[key].children;
    for (let j = children.length - 1; j >= 0; j--) {
      if (!visited[children[j]]) stack.push(children[j]);
    }
  }
  return out;
}

describe('status-model: buildIndex / tree building', () => {
  it('links main parent + child via parentAgentId', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'main', { kind: 'main' }),
      agent('s1', 'sub1', { kind: 'sub', parentAgentId: 'main' }),
    ]));
    expect(roots(model, 's1')).toEqual([agentKey('s1', 'main')]);
    expect(childKeys(model, 's1', 'main')).toEqual([agentKey('s1', 'sub1')]);
    expect(childKeys(model, 's1', 'sub1')).toEqual([]);
    expect(flatten(model, 's1')).toEqual(['main', 'sub1']);
  });

  it('backfills orphan leaves from parent.subagents[] only when no independent entry exists', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'main', {
        subagents: [
          { subagentId: 'orphanA', status: 'running', ts: 10 },
          { subagentId: 'indepB', status: 'completed', ts: 20 },
        ],
      }),
      // indepB has its own entry -> NOT an orphan; orphanA has none -> orphan leaf.
      agent('s1', 'indepB', { kind: 'sub', parentAgentId: 'main', busy: true }),
    ]));
    // Orphan fill runs when the parent's frame lands (subagents-list order),
    // so orphanA precedes indepB (whose real entry arrives later and is then
    // promoted from its own orphan copy).
    expect(childKeys(model, 's1', 'main').sort()).toEqual([agentKey('s1', 'indepB'), agentKey('s1', 'orphanA')]);
    expect(model.byKey[agentKey('s1', 'orphanA')].orphan).toBe(true);
    expect(model.byKey[agentKey('s1', 'orphanA')].subStatus).toBe('running');
    expect(model.byKey[agentKey('s1', 'indepB')].orphan).toBe(false);
    expect(flatten(model, 's1').sort()).toEqual(['indepB', 'main', 'orphanA']);
  });

  it('dedupes an orphan leaf listed by two parents (single node, first wins)', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'p1', { subagents: [{ subagentId: 'x', status: 'running', ts: 1 }] }),
      agent('s1', 'p2', { subagents: [{ subagentId: 'x', status: 'completed', ts: 2 }] }),
    ]));
    expect(childKeys(model, 's1', 'p1')).toEqual([agentKey('s1', 'x')]);
    expect(childKeys(model, 's1', 'p2')).toEqual([]);
    // dedup by key across the whole model: exactly one node for s1:x
    const keys = Object.keys(model.byKey).filter((k) => k === agentKey('s1', 'x'));
    expect(keys.length).toBe(1);
  });

  it('promotes an orphan copy to a real entry when its own frame arrives', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'p', { subagents: [{ subagentId: 'y', status: 'running', ts: 1 }] }),
    ]));
    expect(model.byKey[agentKey('s1', 'y')].orphan).toBe(true);
    upsertAgent(model, agent('s1', 'y', { kind: 'sub', parentAgentId: 'p', busy: true }));
    const y = model.byKey[agentKey('s1', 'y')];
    expect(y.orphan).toBe(false);
    expect(y.parentKey).toBe(agentKey('s1', 'p'));
    // exactly one node, and the orphan copy is gone from the parent's children
    const keys = Object.keys(model.byKey).filter((k) => k === agentKey('s1', 'y'));
    expect(keys.length).toBe(1);
    expect(childKeys(model, 's1', 'p')).toEqual([agentKey('s1', 'y')]);
  });

  it('carries lastToolCall through snapshots and incremental frames (reviewer fix)', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'main', { lastToolCall: { name: 'read', ts: 5, isError: false } }),
    ]));
    expect(model.byKey[agentKey('s1', 'main')].lastToolCall).toEqual({ name: 'read', ts: 5, isError: false });
    // a frame without lastToolCall keeps the previous value (consistent with
    // model/kind/phase — the fold never clears it)
    upsertAgent(model, agent('s1', 'main', { busy: true }));
    expect(model.byKey[agentKey('s1', 'main')].lastToolCall).toEqual({ name: 'read', ts: 5, isError: false });
    // a frame with a new tool call replaces it
    upsertAgent(model, agent('s1', 'main', { lastToolCall: { name: 'write', ts: 9, isError: true } }));
    expect(model.byKey[agentKey('s1', 'main')].lastToolCall).toEqual({ name: 'write', ts: 9, isError: true });
    // orphan leaves never carry a tool call
    const model2 = newModel();
    applySnapshot(model2, snapshot([], [
      agent('s1', 'p', { subagents: [{ subagentId: 'leaf', status: 'running', ts: 1 }] }),
    ]));
    expect(model2.byKey[agentKey('s1', 'leaf')].lastToolCall).toBeUndefined();
  });

  it('breaks composite cycles without stack overflow (incremental guard blocks the closing link)', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'a', { parentAgentId: 'b' }),
      agent('s1', 'b', { parentAgentId: 'c' }),
      agent('s1', 'c', { parentAgentId: 'a' }), // would-be a->b->c->a cycle
    ]));
    // Incremental resolution yields a valid acyclic chain (b -> a -> c here,
    // order-dependent): every node has at most one parent and no parent chain
    // loops, and the visited-guarded flatten terminates without duplicates.
    const flat = flatten(model, 's1');
    expect(flat.length).toBe(3);
    expect(new Set(flat).size).toBe(3);
    for (const id of ['a', 'b', 'c']) {
      const e = model.byKey[agentKey('s1', id)];
      const seen: Record<string, boolean> = {};
      let cur = e.parentKey;
      let hops = 0;
      while (cur && hops < 16) {
        expect(seen[cur]).toBeUndefined(); // no cycle in any parent chain
        seen[cur] = true;
        cur = model.byKey[cur].parentKey;
        hops++;
      }
    }
  });

  it('handles a long chain iteratively (no recursion limit)', () => {
    const model = newModel();
    const agents: RawAgent[] = [];
    for (let i = 0; i < 5000; i++) {
      agents.push(agent('s1', `a${i}`, { parentAgentId: i === 0 ? undefined : `a${i - 1}` }));
    }
    applySnapshot(model, snapshot([], agents));
    expect(flatten(model, 's1').length).toBe(5000);
  });

  it('reparents a row when parentAgentId changes (same key, no duplicate)', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'p1'),
      agent('s1', 'p2'),
      agent('s1', 'child', { parentAgentId: 'p1' }),
    ]));
    expect(childKeys(model, 's1', 'p1')).toEqual([agentKey('s1', 'child')]);
    expect(childKeys(model, 's1', 'p2')).toEqual([]);
    // child reparents to p2
    upsertAgent(model, agent('s1', 'child', { parentAgentId: 'p2' }));
    expect(childKeys(model, 's1', 'p1')).toEqual([]);
    expect(childKeys(model, 's1', 'p2')).toEqual([agentKey('s1', 'child')]);
    expect(rootIds(model, 's1')).toEqual(['p1', 'p2']);
    const allKeys = Object.keys(model.byKey).filter((k) => k === agentKey('s1', 'child'));
    expect(allKeys.length).toBe(1);
  });

  it('keeps a child as a pending root when the parent frame arrives later, then adopts it', () => {
    const model = newModel();
    // child frame first: parent absent -> pending root (暂挂根)
    upsertAgent(model, agent('s1', 'child', { parentAgentId: 'main' }));
    expect(rootIds(model, 's1')).toEqual(['child']);
    expect(model.byKey[agentKey('s1', 'child')].pendingParent).toBe(agentKey('s1', 'main'));
    // parent frame later -> adoption
    upsertAgent(model, agent('s1', 'main', { kind: 'main' }));
    expect(rootIds(model, 's1')).toEqual(['main']);
    expect(childKeys(model, 's1', 'main')).toEqual([agentKey('s1', 'child')]);
    expect(model.byKey[agentKey('s1', 'child')].pendingParent).toBeUndefined();
  });
});

describe('status-model: gone F4 semantics', () => {
  it('gone(P) deletes P + its orphan leaves only; independent children re-root as pending', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'main', {
        subagents: [{ subagentId: 'orphan', status: 'running', ts: 1 }],
      }),
      agent('s1', 'child', { parentAgentId: 'main' }),
    ]));
    expect(flatten(model, 's1')).toEqual(['main', 'orphan', 'child']);
    const result = removeAgent(model, 's1', 'main');
    expect(result.removed.sort()).toEqual([agentKey('s1', 'main'), agentKey('s1', 'orphan')].sort());
    expect(model.byKey[agentKey('s1', 'main')]).toBeUndefined();
    expect(model.byKey[agentKey('s1', 'orphan')]).toBeUndefined();
    // independent child survives, re-rooted and pending under the dead parent
    expect(rootIds(model, 's1')).toEqual(['child']);
    const child = model.byKey[agentKey('s1', 'child')];
    expect(child.parentKey).toBeNull();
    expect(child.pendingParent).toBe(agentKey('s1', 'main'));
    expect(model.pending[agentKey('s1', 'main')]).toContain(agentKey('s1', 'child'));
  });

  it('out-of-order resurrection: dead parent frame returns and re-adopts the pending child', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'main'),
      agent('s1', 'child', { parentAgentId: 'main' }),
    ]));
    removeAgent(model, 's1', 'main');
    // a child frame arrives while the parent is still gone -> stays pending root
    upsertAgent(model, agent('s1', 'child', { parentAgentId: 'main', busy: true }));
    expect(rootIds(model, 's1')).toEqual(['child']);
    expect(model.byKey[agentKey('s1', 'child')].pendingParent).toBe(agentKey('s1', 'main'));
    // the parent comes back -> child re-attaches
    upsertAgent(model, agent('s1', 'main', { kind: 'main', busy: false }));
    expect(rootIds(model, 's1')).toEqual(['main']);
    expect(childKeys(model, 's1', 'main')).toEqual([agentKey('s1', 'child')]);
  });

  it('gone of an orphan leaf removes only that leaf', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'main', { subagents: [{ subagentId: 'leaf', status: 'running', ts: 1 }] }),
      agent('s1', 'child', { parentAgentId: 'main' }),
    ]));
    const result = removeAgent(model, 's1', 'leaf');
    expect(result.removed).toEqual([agentKey('s1', 'leaf')]);
    expect(model.byKey[agentKey('s1', 'leaf')]).toBeUndefined();
    expect(flatten(model, 's1')).toEqual(['main', 'child']);
  });

  it('gone of an unknown agent is a no-op', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [agent('s1', 'main')]));
    expect(removeAgent(model, 's1', 'nope').removed).toEqual([]);
    expect(flatten(model, 's1')).toEqual(['main']);
  });

  it('prunes the session group when its last agent is gone', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [agent('s1', 'only')]));
    expect(model.sessions['s1']).toBeDefined();
    removeAgent(model, 's1', 'only');
    expect(model.sessions['s1']).toBeUndefined();
    expect(model.sessionOrder).not.toContain('s1');
    expect(modelCounts(model)).toEqual({ agents: 0, sessions: 0 });
  });
});

describe('status-model: session-gone', () => {
  it('marks the group ended and retains live agent rows; a frame revives the group', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'main'),
      agent('s1', 'child', { parentAgentId: 'main' }),
    ]));
    const result = removeSession(model, 's1');
    expect(result.removed).toBe(false);
    expect(result.kept.length).toBe(2);
    expect(model.sessions['s1'].gone).toBe(true);
    // rows still in the model (仍在收帧的 agent 行保留)
    expect(modelCounts(model)).toEqual({ agents: 2, sessions: 1 });
    // next frame for the session revives the group (重挂)
    upsertAgent(model, agent('s1', 'main', { busy: true }));
    expect(model.sessions['s1'].gone).toBe(false);
  });

  it('removes an empty group entirely', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [agent('s1', 'only')]));
    removeAgent(model, 's1', 'only'); // prunes the row
    applySnapshot(model, snapshot([{ sessionId: 's1', title: 't' }], [])); // session row only
    const result = removeSession(model, 's1');
    expect(result.removed).toBe(true);
    expect(model.sessions['s1']).toBeUndefined();
    expect(model.sessionOrder).not.toContain('s1');
  });

  it('keeps an already-ended group ended until a live frame arrives', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [agent('s1', 'main')]));
    removeSession(model, 's1');
    removeSession(model, 's1'); // idempotent
    expect(model.sessions['s1'].gone).toBe(true);
    expect(modelCounts(model).agents).toBe(1);
  });
});

describe('status-model: status derivation', () => {
  it('stale overrides busy (E8)', () => {
    const st = deriveStatus(agent('s1', 'a', { busy: true, stale: true }) as never);
    expect(st).toEqual({ key: 'stale', tone: 'stale' });
  });

  it('falls back to busy/idle when phase is missing', () => {
    expect(deriveStatus(agent('s1', 'a', { busy: true }) as never)).toEqual({ key: 'busy', tone: 'busy' });
    expect(deriveStatus(agent('s1', 'a', { busy: false }) as never)).toEqual({ key: 'idle', tone: 'idle' });
  });

  it('maps known engine phases to tones and surfaces unknown phases raw', () => {
    expect(deriveStatus(agent('s1', 'a', { phase: 'thinking', busy: true }) as never)).toEqual({ key: 'busy', tone: 'busy' });
    expect(deriveStatus(agent('s1', 'a', { phase: 'done', busy: false }) as never)).toEqual({ key: 'completed', tone: 'done' });
    const unknown = deriveStatus(agent('s1', 'a', { phase: 'yodeling', busy: false }) as never);
    expect(unknown.key).toBe('idle');
    expect(unknown.tone).toBe('idle');
    expect(unknown.label).toBe('yodeling');
  });

  it('subagent enum: running/completed/failed/killed/suspended/unknown', () => {
    const sub = (s: string) => agent('s1', 'x', { orphan: true, subStatus: s }) as never;
    expect(deriveStatus(sub('running'))).toEqual({ key: 'running', tone: 'busy' });
    expect(deriveStatus(sub('started'))).toEqual({ key: 'running', tone: 'busy' });
    expect(deriveStatus(sub('spawned'))).toEqual({ key: 'running', tone: 'busy' });
    expect(deriveStatus(sub('completed'))).toEqual({ key: 'completed', tone: 'done' });
    expect(deriveStatus(sub('failed'))).toEqual({ key: 'failed', tone: 'err' });
    expect(deriveStatus(sub('killed'))).toEqual({ key: 'killed', tone: 'err' });
    expect(deriveStatus(sub('suspended'))).toEqual({ key: 'suspended', tone: 'warn' });
    expect(deriveStatus(sub('unknown'))).toEqual({ key: 'unknown', tone: 'idle' });
  });

  it('derives main-agent terminal display from lastTurnReason/lastFinishReason', () => {
    expect(deriveStatus(agent('s1', 'a', { busy: false, lastTurnReason: 'completed' }) as never)).toEqual({ key: 'completed', tone: 'done' });
    expect(deriveStatus(agent('s1', 'a', { busy: false, lastFinishReason: 'end_turn' }) as never)).toEqual({ key: 'completed', tone: 'done' });
    expect(deriveStatus(agent('s1', 'a', { busy: false, lastTurnReason: 'failed' }) as never)).toEqual({ key: 'failed', tone: 'err' });
    expect(deriveStatus(agent('s1', 'a', { busy: false, lastTurnReason: 'cancelled' }) as never)).toEqual({ key: 'suspended', tone: 'warn' });
  });
});

describe('status-model: active partition derivation (0.10.0)', () => {
  it('isActiveAgent: busy && !stale', () => {
    expect(isActiveAgent(agent('s1', 'a', { busy: true, stale: false }) as never)).toBe(true);
    expect(isActiveAgent(agent('s1', 'a', { busy: true }) as never)).toBe(true);
    expect(isActiveAgent(agent('s1', 'a', { busy: false, stale: false }) as never)).toBe(false);
    expect(isActiveAgent(agent('s1', 'a', { busy: false }) as never)).toBe(false);
  });

  it('isActiveAgent: stale overrides busy', () => {
    expect(isActiveAgent(agent('s1', 'a', { busy: true, stale: true }) as never)).toBe(false);
  });

  it('isActiveAgent: null / undefined are inactive', () => {
    expect(isActiveAgent(null)).toBe(false);
    expect(isActiveAgent(undefined)).toBe(false);
  });

  it('isActiveAgent: orphan leaves stay inactive even with subStatus=running (boundary ①)', () => {
    // fillOrphans synthesizes leaves with busy=false, so a running subagent leaf
    // never joins the active partition even though deriveStatus would display it
    // as busy — an intentional split between partition and display semantics.
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'main', { subagents: [{ subagentId: 'leaf', status: 'running', ts: 1 }] }),
    ]));
    const leaf = model.byKey[agentKey('s1', 'leaf')];
    expect(leaf.orphan).toBe(true);
    expect(leaf.busy).toBe(false);
    expect(isActiveAgent(leaf)).toBe(false);
  });
});

describe('status-model: sessionDirKey fallback chain', () => {
  it('prefers SessionRow.workDir over workDirHash', () => {
    const model = newModel();
    applySnapshot(model, snapshot([{ sessionId: 's1', workDir: '/repo/app', workDirHash: 'h1hashh1hash' }], []));
    expect(sessionDirKey(model, 's1')).toBe('/repo/app');
  });

  it('uses SessionRow.workDirHash raw when workDir is absent', () => {
    const model = newModel();
    applySnapshot(model, snapshot([{ sessionId: 's1', workDirHash: 'h1hashh1hash' }], []));
    expect(sessionDirKey(model, 's1')).toBe('h1hashh1hash');
  });

  it('falls back to an agent workDirHash with hash: prefix when the session row has none', () => {
    const model = newModel();
    applySnapshot(model, snapshot([{ sessionId: 's1' }], [agent('s1', 'main', { workDirHash: 'abc123hash' })]));
    expect(sessionDirKey(model, 's1')).toBe('hash:abc123hash');
  });

  it('falls back to an agent workDirHash when there is no session record at all', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [agent('s1', 'main', { workDirHash: 'abc123hash' })]));
    expect(sessionDirKey(model, 's1')).toBe('hash:abc123hash');
  });

  it('returns __unknown__ when nothing is available', () => {
    const model = newModel();
    applySnapshot(model, snapshot([{ sessionId: 's1' }], [agent('s1', 'main')]));
    expect(sessionDirKey(model, 's1')).toBe('__unknown__');
    expect(sessionDirKey(model, 'missing')).toBe('__unknown__');
  });
});

describe('status-model: partitionSession DFS', () => {
  it('partitions roots + children in DFS order, active/inactive each ordered', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'main', { busy: true }),
      agent('s1', 'sub1', { parentAgentId: 'main', busy: true }),
      agent('s1', 'sub2', { parentAgentId: 'main' }),
      agent('s1', 'lone'),
    ]));
    // roots = [main, lone]; DFS: main -> sub1 -> sub2 -> lone
    const part = partitionSession(model, 's1');
    expect(part.active).toEqual([agentKey('s1', 'main'), agentKey('s1', 'sub1')]);
    expect(part.inactive).toEqual([agentKey('s1', 'sub2'), agentKey('s1', 'lone')]);
  });

  it('keeps DFS order across nested levels (M1: inactive ancestors of a busy seed join the active side)', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'a', { busy: true }),
      agent('s1', 'b', { parentAgentId: 'a' }),
      agent('s1', 'c', { parentAgentId: 'b', busy: true }),
      agent('s1', 'd', { parentAgentId: 'b' }),
    ]));
    // seeds = a, c; c's parentKey chain (b -> a) is effectively active, so b
    // stays in the active zone (its own wire may be silent while c runs).
    // d (a leaf under b with no active descendant) stays inactive.
    const part = partitionSession(model, 's1');
    expect(part.active).toEqual([agentKey('s1', 'a'), agentKey('s1', 'b'), agentKey('s1', 'c')]);
    expect(part.inactive).toEqual([agentKey('s1', 'd')]);
    // effActive = seeds + ancestor closure (active-side membership)
    expect(part.effActive).toEqual({
      [agentKey('s1', 'a')]: true,
      [agentKey('s1', 'b')]: true,
      [agentKey('s1', 'c')]: true,
    });
    expect(part.effActive[agentKey('s1', 'd')]).toBeUndefined();
  });

  it('returns empty sides for a session with no roots', () => {
    const model = newModel();
    expect(partitionSession(model, 'nope')).toEqual({ active: [], inactive: [], effActive: {} });
    applySnapshot(model, snapshot([{ sessionId: 's1' }], []));
    expect(partitionSession(model, 's1')).toEqual({ active: [], inactive: [], effActive: {} });
  });

  it('keeps orphan leaves on the inactive side even when subStatus=running', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'main', { busy: true, subagents: [{ subagentId: 'leaf', status: 'running', ts: 1 }] }),
    ]));
    const part = partitionSession(model, 's1');
    expect(part.active).toEqual([agentKey('s1', 'main')]);
    expect(part.inactive).toEqual([agentKey('s1', 'leaf')]);
  });
});

describe('status-model: listDirectories grouping', () => {
  it('groups sessions by dirKey in sessionOrder, computing counts', () => {
    const model = newModel();
    applySnapshot(model, snapshot([
      { sessionId: 's1', workDir: '/repo/app', workDirHash: 'h1' },
      { sessionId: 's2', workDir: '/repo/app', workDirHash: 'h1' },
      { sessionId: 's3', workDir: '/other/lib', workDirHash: 'h2' },
    ], [
      agent('s1', 'main', { busy: true }),
      agent('s1', 'sub', { parentAgentId: 'main' }),
      agent('s2', 'lone'),
      agent('s3', 'busy1', { busy: true }),
      agent('s3', 'busy2', { busy: true }),
    ]));
    const dirs = listDirectories(model);
    expect(dirs).toHaveLength(2);
    const app = dirs.find((d) => d.dirKey === '/repo/app');
    expect(app).toBeDefined();
    expect(app!.label).toBe('/repo/app');
    expect(app!.sessionIds).toEqual(['s1', 's2']); // model.sessionOrder order
    expect(app!.activeAgents).toBe(1); // only s1:main
    expect(app!.hiddenSessions).toBe(1); // s2 has no active
    expect(app!.hasActive).toBe(true);
    const lib = dirs.find((d) => d.dirKey === '/other/lib');
    expect(lib!.sessionIds).toEqual(['s3']);
    expect(lib!.activeAgents).toBe(2);
    expect(lib!.hiddenSessions).toBe(0);
    expect(lib!.hasActive).toBe(true);
  });

  it('sorts dirs by hasActive desc, then activeAgents desc, then dirKey asc', () => {
    const model = newModel();
    applySnapshot(model, snapshot([
      { sessionId: 'z', workDir: '/z' },
      { sessionId: 'a', workDir: '/a' },
      { sessionId: 'b', workDir: '/b' },
      { sessionId: 'c', workDir: '/c' },
    ], [
      agent('z', 'z1'),
      agent('a', 'a1', { busy: true }),
      agent('b', 'b1', { busy: true }),
      agent('b', 'b2', { busy: true }),
      agent('c', 'c1', { busy: true }),
    ]));
    const dirs = listDirectories(model).map((d) => d.dirKey);
    // /b (2 active) first; /a and /c tie on hasActive+count -> dirKey asc; /z inactive last
    expect(dirs).toEqual(['/b', '/a', '/c', '/z']);
  });

  it('aggregates unknown sessions into one __unknown__ dir with label as-is', () => {
    const model = newModel();
    applySnapshot(model, snapshot([
      { sessionId: 'u1' },
      { sessionId: 'u2' },
    ], [
      agent('u1', 'a', { busy: true }),
      agent('u2', 'b'),
    ]));
    const dirs = listDirectories(model);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].dirKey).toBe('__unknown__');
    expect(dirs[0].label).toBe('__unknown__');
    expect(dirs[0].sessionIds).toEqual(['u1', 'u2']);
    expect(dirs[0].activeAgents).toBe(1);
    expect(dirs[0].hiddenSessions).toBe(1);
    expect(dirs[0].hasActive).toBe(true);
  });

  it('label fallback chain: session workDir -> agent workDir -> short hash -> dirKey as-is', () => {
    // level 1: SessionRow.workDir is the label (and the dirKey)
    const m1 = newModel();
    applySnapshot(m1, snapshot([{ sessionId: 's1', workDir: '/path/sess' }], [agent('s1', 'main')]));
    expect(listDirectories(m1)[0].label).toBe('/path/sess');

    // level 2: an agent workDir supplies the label when the session row has none
    // (the dirKey chain never uses agent workDir, so it stays __unknown__ here)
    const m2 = newModel();
    applySnapshot(m2, snapshot([{ sessionId: 's1' }], [agent('s1', 'main', { workDir: '/path/agent' })]));
    const d2 = listDirectories(m2)[0];
    expect(d2.dirKey).toBe('__unknown__');
    expect(d2.label).toBe('/path/agent');

    // level 3: a hash: dirKey shortens to the first 8 hash chars
    const m3 = newModel();
    applySnapshot(m3, snapshot([], [agent('s1', 'main', { workDirHash: '0123456789abcdef' })]));
    const d3 = listDirectories(m3)[0];
    expect(d3.dirKey).toBe('hash:0123456789abcdef');
    expect(d3.label).toBe('01234567');

    // level 4: __unknown__ stays as-is
    const m4 = newModel();
    applySnapshot(m4, snapshot([{ sessionId: 's1' }], [agent('s1', 'main')]));
    expect(listDirectories(m4)[0].label).toBe('__unknown__');
  });

  it('label shortens a bare SessionRow.workDirHash dirKey to 8 chars too', () => {
    // level 2 of the dir-key chain (session hash, no workDir, no agent workDir):
    // the label must follow the same "hash 前 8 位" rule as the 'hash:'-prefixed form.
    const model = newModel();
    applySnapshot(model, snapshot([{ sessionId: 's1', workDirHash: '0123456789abcdef' }], [agent('s1', 'main')]));
    const d = listDirectories(model)[0];
    expect(d.dirKey).toBe('0123456789abcdef');
    expect(d.label).toBe('01234567');
  });
});

describe('status-model: activeAgentKeys stable order', () => {
  it('orders cross-dir as dirs -> sessionIds -> DFS (no latest-first)', () => {
    const model = newModel();
    applySnapshot(model, snapshot([
      { sessionId: 's1', workDir: '/a' },
      { sessionId: 's2', workDir: '/b' },
      { sessionId: 's3', workDir: '/a' },
    ], [
      agent('s1', 'main', { busy: true }),
      agent('s1', 'sub', { parentAgentId: 'main', busy: true }),
      agent('s1', 'idle', { parentAgentId: 'main' }),
      agent('s2', 'b1', { busy: true }),
      agent('s3', 'a3', { busy: true }),
    ]));
    // dir /a (s1: main+sub active, s3: a3 active) has 2 active, dir /b (s2: b1) has 1
    expect(activeAgentKeys(model)).toEqual([
      agentKey('s1', 'main'),
      agentKey('s1', 'sub'),
      agentKey('s3', 'a3'),
      agentKey('s2', 'b1'),
    ]);
  });

  it('excludes inactive, stale and orphan-leaf agents', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'main', { busy: true, subagents: [{ subagentId: 'leaf', status: 'running', ts: 1 }] }),
      agent('s1', 'idle'),
      agent('s1', 'stale', { busy: true, stale: true }),
    ]));
    expect(activeAgentKeys(model)).toEqual([agentKey('s1', 'main')]);
  });
});

describe('status-model: activeAgentKeysWithAncestors (0.11.0)', () => {
  it('inserts each active leaf\'s ancestor chain before it without reordering the seeds', () => {
    const model = newModel();
    applySnapshot(model, snapshot([
      { sessionId: 's1', workDir: '/a' },
      { sessionId: 's2', workDir: '/b' },
    ], [
      agent('s1', 'root', { busy: false }),
      agent('s1', 'mid', { parentAgentId: 'root', busy: false }),
      agent('s1', 'leaf', { parentAgentId: 'mid', busy: true }),
      agent('s1', 'lone', { busy: true }),
      agent('s2', 'other', { busy: true }),
    ]));
    // M1: the active partition carries the ancestor closure, so root/mid (not
    // self-active, but ancestors of the busy leaf) are activeAgentKeys members.
    expect(activeAgentKeys(model)).toEqual([
      agentKey('s1', 'root'),
      agentKey('s1', 'mid'),
      agentKey('s1', 'leaf'),
      agentKey('s1', 'lone'),
      agentKey('s2', 'other'),
    ]);
    const got = activeAgentKeysWithAncestors(model);
    // leaf's chain (root -> mid) precedes it; lone and other keep their slots.
    expect(got.map((x) => x.key)).toEqual([
      agentKey('s1', 'root'),
      agentKey('s1', 'mid'),
      agentKey('s1', 'leaf'),
      agentKey('s1', 'lone'),
      agentKey('s2', 'other'),
    ]);
    const byKey: Record<string, boolean> = {};
    for (const x of got) byKey[x.key] = x.rollupActive;
    expect(byKey[agentKey('s1', 'root')]).toBe(true); // rollup, not self-active
    expect(byKey[agentKey('s1', 'mid')]).toBe(true);
    expect(byKey[agentKey('s1', 'leaf')]).toBe(false); // own active seed
    expect(byKey[agentKey('s1', 'lone')]).toBe(false);
    expect(byKey[agentKey('s2', 'other')]).toBe(false);
  });

  it('marks a busy ancestor as a seed (rollupActive=false) even when it is also an ancestor', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'root', { busy: true }), // self-active AND ancestor of leaf
      agent('s1', 'mid', { busy: false }),
      agent('s1', 'leaf', { parentAgentId: 'mid', busy: true }),
    ]));
    // roots: [root, mid]? mid has no parentAgentId -> its own root. DFS: root, mid, leaf.
    // active = [root, leaf]; leaf's chain = [mid, root].
    const got = activeAgentKeysWithAncestors(model);
    const byKey: Record<string, boolean> = {};
    for (const x of got) byKey[x.key] = x.rollupActive;
    // root was processed first as a seed -> stays rollupActive=false.
    expect(byKey[agentKey('s1', 'root')]).toBe(false);
    expect(byKey[agentKey('s1', 'mid')]).toBe(true);
    expect(byKey[agentKey('s1', 'leaf')]).toBe(false);
  });

  it('stops the ancestor walk at a missing parent and at a pending root', () => {
    // Broken chain: the parent's own parent entry vanished mid-chain (injected
    // behind the model's invariants — resolveAndAttach would never create it).
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'parent', { busy: false }),
      agent('s1', 'leaf', { parentAgentId: 'parent', busy: true }),
    ]));
    model.byKey[agentKey('s1', 'parent')].parentKey = agentKey('s1', 'ghost');
    const got = activeAgentKeysWithAncestors(model).map((x) => x.key);
    // Walk from leaf: parent exists (push), ghost missing -> stop. leaf stays.
    expect(got).toEqual([agentKey('s1', 'parent'), agentKey('s1', 'leaf')]);
    const flags: Record<string, boolean> = {};
    for (const x of activeAgentKeysWithAncestors(model)) flags[x.key] = x.rollupActive;
    expect(flags[agentKey('s1', 'parent')]).toBe(true);
    expect(flags[agentKey('s1', 'leaf')]).toBe(false);
    // Pending root: parent frame never arrived -> parentKey is null.
    const model2 = newModel();
    applySnapshot(model2, snapshot([], [
      agent('s1', 'leaf', { parentAgentId: 'ghost', busy: true }),
    ]));
    expect(activeAgentKeysWithAncestors(model2).map((x) => x.key)).toEqual([agentKey('s1', 'leaf')]);
  });

  it('visited-guards an injected parent cycle (no infinite loop, no duplicates)', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'a', { busy: false }),
      agent('s1', 'b', { parentAgentId: 'a', busy: false }),
      agent('s1', 'c', { parentAgentId: 'b', busy: true }),
    ]));
    // Inject a -> c, closing the a->b->c->a loop behind the model's invariants.
    model.byKey[agentKey('s1', 'a')].parentKey = agentKey('s1', 'c');
    const got = activeAgentKeysWithAncestors(model).map((x) => x.key);
    expect(got.length).toBeLessThanOrEqual(3);
    expect(new Set(got).size).toBe(got.length); // no duplicate emissions
    expect(got).toContain(agentKey('s1', 'c'));
  });
});

describe('status-model: ancestor active inheritance (M1)', () => {
  it('orchestrator with zero own activity stays in the active zone while its worker is busy (2 levels)', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'orchestrator', { kind: 'main' }), // own wire silent (blocked on the worker)
      agent('s1', 'worker', { parentAgentId: 'orchestrator', kind: 'sub', busy: true }),
    ]));
    const part = partitionSession(model, 's1');
    expect(part.active).toEqual([agentKey('s1', 'orchestrator'), agentKey('s1', 'worker')]);
    expect(part.inactive).toEqual([]);
    // activeAgentKeys carries the ancestor too (sticky section keeps the chain)
    expect(activeAgentKeys(model)).toEqual([agentKey('s1', 'orchestrator'), agentKey('s1', 'worker')]);
  });

  it('works for 3+ levels of nesting: the FULL ancestor chain is effective-active', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'root', { kind: 'main' }),
      agent('s1', 'mid', { parentAgentId: 'root', kind: 'sub' }),
      agent('s1', 'leaf', { parentAgentId: 'mid', kind: 'sub', busy: true }),
    ]));
    const part = partitionSession(model, 's1');
    expect(part.active).toEqual([
      agentKey('s1', 'root'),
      agentKey('s1', 'mid'),
      agentKey('s1', 'leaf'),
    ]);
    expect(part.inactive).toEqual([]);
    // 4 levels too: every ancestor (grandparent, great-grandparent) inherits
    const deep = newModel();
    applySnapshot(deep, snapshot([], [
      agent('d1', 'a0'),
      agent('d1', 'a1', { parentAgentId: 'a0' }),
      agent('d1', 'a2', { parentAgentId: 'a1' }),
      agent('d1', 'a3', { parentAgentId: 'a2', busy: true }),
    ]));
    const deepPart = partitionSession(deep, 'd1');
    expect(deepPart.active).toEqual([
      agentKey('d1', 'a0'),
      agentKey('d1', 'a1'),
      agentKey('d1', 'a2'),
      agentKey('d1', 'a3'),
    ]);
    expect(deepPart.inactive).toEqual([]);
  });

  it('keeps leaves and fully-inactive subtrees exactly as before', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'busyRoot', { busy: true }),
      agent('s1', 'idleLeaf', { parentAgentId: 'busyRoot' }), // leaf under a busy parent: no active descendant -> inactive
      agent('s1', 'quietRoot'), // fully-inactive subtree: nobody inherits anything
      agent('s1', 'quietChild', { parentAgentId: 'quietRoot' }),
      agent('s1', 'lone'),
    ]));
    const part = partitionSession(model, 's1');
    expect(part.active).toEqual([agentKey('s1', 'busyRoot')]);
    expect(part.inactive).toEqual([
      agentKey('s1', 'idleLeaf'),
      agentKey('s1', 'quietRoot'),
      agentKey('s1', 'quietChild'),
      agentKey('s1', 'lone'),
    ]);
    expect(part.effActive[agentKey('s1', 'busyRoot')]).toBe(true);
    expect(part.effActive[agentKey('s1', 'idleLeaf')]).toBeUndefined();
    expect(part.effActive[agentKey('s1', 'quietRoot')]).toBeUndefined();
  });

  it('a seed that is also an ancestor stays a seed; shared ancestors are marked once', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'root', { busy: true }), // self-active AND ancestor of both leaves
      agent('s1', 'mid', { parentAgentId: 'root' }), // inactive shared ancestor, pulled up once
      agent('s1', 'l1', { parentAgentId: 'mid', busy: true }),
      agent('s1', 'l2', { parentAgentId: 'mid', busy: true }),
    ]));
    const part = partitionSession(model, 's1');
    expect(part.active).toEqual([
      agentKey('s1', 'root'),
      agentKey('s1', 'mid'),
      agentKey('s1', 'l1'),
      agentKey('s1', 'l2'),
    ]);
    expect(part.inactive).toEqual([]);
    // rollup flags: root/l1/l2 self-active, mid is a rollup ancestor (badge)
    const byKey: Record<string, boolean> = {};
    for (const x of activeAgentKeysWithAncestors(model)) byKey[x.key] = x.rollupActive;
    expect(byKey[agentKey('s1', 'root')]).toBe(false);
    expect(byKey[agentKey('s1', 'l1')]).toBe(false);
    expect(byKey[agentKey('s1', 'l2')]).toBe(false);
    expect(byKey[agentKey('s1', 'mid')]).toBe(true);
  });

  it('stale busy agents are not seeds and are not pulled up without an active descendant', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'staleBusy', { busy: true, stale: true }),
      agent('s1', 'child', { parentAgentId: 'staleBusy' }),
    ]));
    const part = partitionSession(model, 's1');
    expect(part.active).toEqual([]);
    expect(part.inactive).toEqual([agentKey('s1', 'staleBusy'), agentKey('s1', 'child')]);
    // ...but an ACTIVE descendant still pulls the stale ancestor up (it has a
    // live subtree, so its zone must not be folded away)
    const model2 = newModel();
    applySnapshot(model2, snapshot([], [
      agent('s1', 'staleBusy', { busy: true, stale: true }),
      agent('s1', 'worker', { parentAgentId: 'staleBusy', busy: true }),
    ]));
    expect(partitionSession(model2, 's1').active).toEqual([
      agentKey('s1', 'staleBusy'),
      agentKey('s1', 'worker'),
    ]);
  });

  it('orphan leaves stay on the inactive side even under an effective-active parent', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'main', { busy: false, subagents: [{ subagentId: 'leaf', status: 'running', ts: 1 }] }),
      agent('s1', 'worker', { parentAgentId: 'main', kind: 'sub', busy: true }),
    ]));
    // main is pulled up by worker; the orphan leaf (busy=false, not a seed, not
    // an ancestor) stays inactive — its subStatus=running is display-only.
    const part = partitionSession(model, 's1');
    expect(part.active).toEqual([agentKey('s1', 'main'), agentKey('s1', 'worker')]);
    expect(part.inactive).toEqual([agentKey('s1', 'leaf')]);
  });

  it('visited-guards an injected parent cycle during the ancestor walk (no hang, no dupes)', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'a'),
      agent('s1', 'b', { parentAgentId: 'a' }),
      agent('s1', 'c', { parentAgentId: 'b', busy: true }),
    ]));
    model.byKey[agentKey('s1', 'a')].parentKey = agentKey('s1', 'c'); // inject a->c loop
    const part = partitionSession(model, 's1');
    expect(part.active.length).toBeLessThanOrEqual(3);
    expect(new Set(part.active).size).toBe(part.active.length);
    expect(part.active).toContain(agentKey('s1', 'c')); // the busy seed survives
  });

  it('listDirectories counts effectively-active ancestors in activeAgents (dir zone follows the partition)', () => {
    const model = newModel();
    applySnapshot(model, snapshot([{ sessionId: 's1', workDir: '/repo/app' }], [
      agent('s1', 'root', { kind: 'main' }),
      agent('s1', 'worker', { parentAgentId: 'root', busy: true }),
    ]));
    const dirs = listDirectories(model);
    expect(dirs[0].hasActive).toBe(true);
    expect(dirs[0].activeAgents).toBe(2); // root (ancestor) + worker (seed)
    expect(dirs[0].hiddenSessions).toBe(0);
  });
});

describe('status-model: subtreeKeys (0.11.0)', () => {
  it('returns a visited-guarded DFS key list including the root', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'a'),
      agent('s1', 'b', { parentAgentId: 'a' }),
      agent('s1', 'c', { parentAgentId: 'b' }),
      agent('s1', 'd', { parentAgentId: 'b' }),
      agent('s1', 'e'),
    ]));
    expect(subtreeKeys(model, agentKey('s1', 'a'))).toEqual([
      agentKey('s1', 'a'),
      agentKey('s1', 'b'),
      agentKey('s1', 'c'),
      agentKey('s1', 'd'),
    ]);
    expect(subtreeKeys(model, agentKey('s1', 'b'))).toEqual([
      agentKey('s1', 'b'),
      agentKey('s1', 'c'),
      agentKey('s1', 'd'),
    ]);
    expect(subtreeKeys(model, agentKey('s1', 'e'))).toEqual([agentKey('s1', 'e')]);
  });

  it('visited-guards an injected child cycle', () => {
    const model = newModel();
    applySnapshot(model, snapshot([], [
      agent('s1', 'a'),
      agent('s1', 'b', { parentAgentId: 'a' }),
    ]));
    model.byKey[agentKey('s1', 'b')].children.push(agentKey('s1', 'a'));
    expect(subtreeKeys(model, agentKey('s1', 'a'))).toEqual([agentKey('s1', 'a'), agentKey('s1', 'b')]);
  });
});

describe('status-model: workDirHash wiring', () => {
  it('carries workDirHash from snapshot sessions into SessionRow', () => {
    const model = newModel();
    applySnapshot(model, snapshot([{ sessionId: 's1', workDir: '/w', workDirHash: 'h1hashh1hash' }], []));
    expect(model.sessions['s1'].workDirHash).toBe('h1hashh1hash');
    expect(model.sessions['s1'].workDir).toBe('/w');
  });

  it('agent frames do not write the session row hash (fallback stays in sessionDirKey)', () => {
    const model = newModel();
    applySnapshot(model, snapshot([{ sessionId: 's1' }], []));
    expect(model.sessions['s1'].workDirHash).toBeUndefined();
    // The agent hash is a sessionDirKey fallback ('hash:' prefix), not a row write.
    upsertAgent(model, agent('s1', 'main', { workDirHash: 'backfillhash' }));
    expect(model.sessions['s1'].workDirHash).toBeUndefined();
    expect(sessionDirKey(model, 's1')).toBe('hash:backfillhash');
  });

  it('the session-record hash wins over agent-frame hashes', () => {
    const model = newModel();
    applySnapshot(model, snapshot([{ sessionId: 's1', workDirHash: 'original' }], [agent('s1', 'main', { workDirHash: 'other' })]));
    expect(model.sessions['s1'].workDirHash).toBe('original');
    // a later frame without the field never clears it either
    upsertAgent(model, agent('s1', 'main'));
    expect(model.sessions['s1'].workDirHash).toBe('original');
  });
});

describe('status-model: __proto__/constructor key defense (F3)', () => {
  it('a snapshot with sessionId="__proto__" builds without throwing and resolves its dir', () => {
    const model = newModel();
    expect(() =>
      applySnapshot(model, snapshot([
        { sessionId: '__proto__', title: 'P', workDir: '/wd/p', workDirHash: 'hp' },
        { sessionId: 'constructor', title: 'C', workDir: '/wd/c', workDirHash: 'hc' },
      ], [
        agent('__proto__', 'main', { kind: 'main', busy: true }),
        agent('constructor', 'main', { kind: 'main', busy: false }),
      ])),
    ).not.toThrow();
    // null-proto key tables: the rows are real own properties, not proto hits
    expect(Object.getPrototypeOf(model.sessions)).toBeNull();
    expect(Object.getPrototypeOf(model.roots)).toBeNull();
    expect(Object.getPrototypeOf(model.pending)).toBeNull();
    expect(Object.getPrototypeOf(model.dirCache)).toBeNull();
    expect(model.sessions['__proto__']?.title).toBe('P');
    expect(model.roots['__proto__']).toEqual([agentKey('__proto__', 'main')]);
    expect(modelCounts(model)).toEqual({ agents: 2, sessions: 2 });
    expect(sessionDirKey(model, '__proto__')).toBe('/wd/p');
    expect(listDirectories(model)[0]).toBeDefined();
  });

  it('workDirHash="__proto__" groups into its own dir without throwing', () => {
    const model = newModel();
    expect(() =>
      applySnapshot(model, snapshot([
        { sessionId: 's1', workDirHash: '__proto__' },
        { sessionId: 's2', workDirHash: 'normal' },
      ], [
        agent('s1', 'main', { kind: 'main', busy: true }),
        agent('s2', 'lone', { kind: 'main', busy: false }),
      ])),
    ).not.toThrow();
    const dirs = listDirectories(model);
    const keys = dirs.map((d) => d.dirKey);
    expect(keys).toContain('__proto__');
    expect(keys).toContain('normal');
    const proto = dirs.find((d) => d.dirKey === '__proto__')!;
    expect(proto.sessionIds).toEqual(['s1']);
    // the label follows the existing bare-hash shortening rule (first 8 chars),
    // so '__proto__' (9 chars) labels '__proto_' — the dirKey grouping is what
    // matters for the F3 defense
    expect(activeAgentKeys(model)).toEqual([agentKey('s1', 'main')]);
  });
});

describe('status-model: drift protection (D2)', () => {
  /** Load the serialized model source in a bare vm and return its API. */
  function vmModel() {
    const sandbox: Record<string, unknown> = { console };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(STATUS_MODEL_JS, sandbox, { timeout: 5000 });
    return (sandbox as { window: { __moaStatusModel: any } }).window.__moaStatusModel;
  }

  /** Deterministic op-script runner: apply ops through a model API, return JSON. */
  function runScript(api: any, ops: Array<Record<string, unknown>>): string {
    const model = api.newModel();
    for (const op of ops) {
      if (op.op === 'snapshot') api.applySnapshot(model, op.snap);
      else if (op.op === 'agent') api.upsertAgent(model, op.agent);
      else if (op.op === 'gone') api.removeAgent(model, op.sessionId, op.agentId);
      else if (op.op === 'session') api.removeSession(model, op.sessionId);
    }
    // Project the observable surface the page renders from (drop seq/ids drift).
    const groups = model.sessionOrder.map((sid: string) => {
      const row = model.sessions[sid];
      const flatten: Array<Record<string, unknown>> = [];
      const visited: Record<string, boolean> = {};
      const stack: string[] = [];
      const rs = model.roots[sid] || [];
      for (let i = rs.length - 1; i >= 0; i--) stack.push(rs[i]);
      while (stack.length) {
        const key = stack.pop();
        if (visited[key]) continue;
        visited[key] = true;
        const e = model.byKey[key];
        flatten.push({
          id: e.agentId,
          parent: e.parentKey ? model.byKey[e.parentKey].agentId : null,
          orphan: !!e.orphan,
          pending: !!e.pendingParent,
          status: api.deriveStatus(e),
          tool: e.lastToolCall && e.lastToolCall.name ? e.lastToolCall.name : null,
        });
        for (let j = (e.children || []).length - 1; j >= 0; j--) {
          if (!visited[e.children[j]]) stack.push(e.children[j]);
        }
      }
      return { sessionId: sid, gone: !!row.gone, agents: flatten };
    });
    // Project the 0.10.0 directory/partition derivations the page renders from
    // (dirKey chain, per-session partition, directory grouping, active partition)
    // plus the 0.11.0 ancestor closure and subtree enumerations.
    const dirKeys = model.sessionOrder.map((sid: string) => api.sessionDirKey(model, sid));
    const partitions = model.sessionOrder.map((sid: string) => {
      const part = api.partitionSession(model, sid);
      return { sessionId: sid, active: part.active, inactive: part.inactive };
    });
    return JSON.stringify({
      groups,
      counts: api.modelCounts(model),
      dirKeys,
      partitions,
      dirs: api.listDirectories(model),
      active: api.activeAgentKeys(model),
      activeWithAncestors: api.activeAgentKeysWithAncestors(model),
      subtree: model.sessionOrder.map((sid: string) =>
        (model.roots[sid] || []).map((rk: string) => api.subtreeKeys(model, rk)),
      ),
    });
  }

  const fullScript: Array<Record<string, unknown>> = [
    { op: 'snapshot', snap: snapshot([
      { sessionId: 's1', title: 'S', workDir: '/repo/app', workDirHash: 'h1hash1hash1' },
      { sessionId: 's2', workDir: '/repo/app' },
      { sessionId: 's5', workDir: '/repo/m1' }, // M1: ancestor-inheritance chain
    ], [
      agent('s1', 'main', { kind: 'main', busy: true, workDirHash: 'h1hash1hash1', lastToolCall: { name: 'read', ts: 5, isError: false }, subagents: [{ subagentId: 'leaf', status: 'running', ts: 5 }] }),
      agent('s1', 'child', { parentAgentId: 'main', phase: 'thinking', lastToolCall: { name: 'grep', ts: 3, isError: true } }),
      agent('s2', 'lone', { stale: true, workDirHash: 'h2hash2hash2' }),
      agent('s3', 'late-child', { parentAgentId: 'late-parent', workDirHash: 'h3hash3hash3' }),
      agent('s4', 'ghost', { busy: true }),
      agent('s5', 'root', { kind: 'main' }),
      agent('s5', 'mid', { parentAgentId: 'root', kind: 'sub' }),
      agent('s5', 'leaf', { parentAgentId: 'mid', kind: 'sub', busy: true }),
    ]) },
    { op: 'agent', agent: agent('s1', 'child', { parentAgentId: 'main', busy: false, lastTurnReason: 'completed' }) },
    { op: 'agent', agent: agent('s1', 'main', { parentAgentId: 'other', busy: false, lastFinishReason: 'end_turn', lastToolCall: { name: 'write', ts: 7, isError: false } }) },
    { op: 'agent', agent: agent('s3', 'late-parent', {}) },
    { op: 'gone', sessionId: 's1', agentId: 'main' },
    { op: 'gone', sessionId: 's1', agentId: 'leaf' },
    { op: 'session', sessionId: 's2' },
    { op: 'agent', agent: agent('s2', 'lone', { busy: true, stale: false }) },
    { op: 'gone', sessionId: 's3', agentId: 'late-parent' },
  ];

  it('serialized source reproduces the real functions for a full op script', () => {
    const real = runScript({ newModel, applySnapshot, upsertAgent, removeAgent, removeSession, deriveStatus, modelCounts, sessionDirKey, partitionSession, listDirectories, activeAgentKeys, activeAgentKeysWithAncestors, subtreeKeys }, fullScript);
    const fake = runScript(vmModel(), fullScript);
    expect(fake).toBe(real);
  });

  it('serialized source reproduces deriveStatus for every status input', () => {
    const fake = vmModel();
    const inputs = [
      agent('s1', 'a', { busy: true, stale: true }),
      agent('s1', 'a', { busy: true }),
      agent('s1', 'a', { busy: false }),
      agent('s1', 'a', { phase: 'tool', busy: true }),
      agent('s1', 'a', { phase: 'weird', busy: false }),
      agent('s1', 'a', { orphan: true, subStatus: 'killed' }),
      agent('s1', 'a', { busy: false, lastFinishReason: 'cancelled' }),
      agent('s1', 'a', { busy: false, lastTurnReason: 'completed' }),
    ];
    for (const input of inputs) {
      expect(JSON.parse(JSON.stringify(fake.deriveStatus(input)))).toEqual(
        JSON.parse(JSON.stringify(deriveStatus(input as never))),
      );
    }
  });

  it('serialized source stays self-contained (no module-scope leakage)', () => {
    // Evaluating the source must not throw in a context with no document/fetch.
    const sandbox: Record<string, unknown> = {};
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    expect(() => vm.runInContext(STATUS_MODEL_JS, sandbox, { timeout: 5000 })).not.toThrow();
    expect(sandbox.window.__moaStatusModel.agentKey('a', 'b')).toBe('a:b');
  });
});

describe('status-model: matchDebateSpecs (0.13.0)', () => {
  /** Build a model from a bare agent list (no session records needed). */
  function modelFrom(...raws: RawAgent[]): StatusModel {
    const m = newModel();
    applySnapshot(m, snapshot([], raws));
    return m;
  }

  /** Load the serialized model source in a bare vm and return its API. */
  function vmModel() {
    const sandbox: Record<string, unknown> = { console };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(STATUS_MODEL_JS, sandbox, { timeout: 5000 });
    return (sandbox as { window: { __moaStatusModel: any } }).window.__moaStatusModel;
  }

  it('rule 1: exact agentId match, any kind', () => {
    const m = modelFrom(
      agent('s1', 'main', { kind: 'main' }),
      agent('s1', 'debaterA', { kind: 'sub', parentAgentId: 'main' }),
    );
    const hits = matchDebateSpecs(m, [{ id: 'debaterA' }]);
    expect(hits['debaterA']).toEqual([agentKey('s1', 'debaterA')]);
  });

  it('rule 2: subagent type name equals the spec id (orphan + independent subs, one spec hits multiple same-type subs)', () => {
    const m = modelFrom(
      agent('s1', 'main', { subagents: [{ subagentId: 'res1', name: 'Researcher', status: 'running' }] }),
      agent('s2', 'other', { subagents: [{ subagentId: 'res2', name: 'Researcher', status: 'running' }] }),
      // Independent sub whose type name lives on its parent's subagents list.
      agent('s3', 'm3', { subagents: [{ subagentId: 'res3', name: 'Critic', status: 'running' }] }),
      agent('s3', 'res3', { kind: 'sub', parentAgentId: 'm3' }),
    );
    const hits = matchDebateSpecs(m, [{ id: 'Researcher' }]);
    expect(hits['Researcher'].slice().sort()).toEqual([agentKey('s1', 'res1'), agentKey('s2', 'res2')]);
    expect(matchDebateSpecs(m, [{ id: 'Critic' }])['Critic']).toEqual([agentKey('s3', 'res3')]);
  });

  it('rule 3: subagent type name equals the spec tag', () => {
    const m = modelFrom(
      agent('s1', 'main', { subagents: [{ subagentId: 'r1', name: 'Researcher', status: 'completed' }] }),
    );
    const hits = matchDebateSpecs(m, [{ id: 'spec-a', tag: 'Researcher' }]);
    expect(hits['spec-a']).toEqual([agentKey('s1', 'r1')]);
  });

  it('rule 4: sub model equals the tag only when the tag looks like a model id (contains /)', () => {
    const m = modelFrom(
      agent('s1', 'main', { kind: 'main' }),
      agent('s1', 'r1', { kind: 'sub', parentAgentId: 'main', model: 'anthropic/claude-3-5-sonnet' }),
    );
    expect(matchDebateSpecs(m, [{ id: 'a', tag: 'anthropic/claude-3-5-sonnet' }])['a']).toEqual([agentKey('s1', 'r1')]);
    // No slash -> rule 4 must not fire.
    expect(matchDebateSpecs(m, [{ id: 'b', tag: 'anthropic' }])['b']).toEqual([]);
  });

  it('no hit yields an empty array for the spec', () => {
    const m = modelFrom(agent('s1', 'main', { kind: 'main' }));
    const hits = matchDebateSpecs(m, [{ id: 'nope' }, { id: 'also', tag: 'x' }]);
    expect(hits['nope']).toEqual([]);
    expect(hits['also']).toEqual([]);
  });

  it('multiple specs can hit the same sub (rule 1 + rule 3, deduped per spec)', () => {
    const m = modelFrom(
      agent('s1', 'main', { subagents: [{ subagentId: 'debaterA', name: 'debaterA', status: 'running' }] }),
      agent('s1', 'debaterA', { kind: 'sub', parentAgentId: 'main' }),
    );
    // Rule 1 (agentId) and rule 2/3 (type name) both resolve to the same key.
    const hits = matchDebateSpecs(m, [{ id: 'debaterA' }, { id: 'z', tag: 'debaterA' }]);
    expect(hits['debaterA']).toEqual([agentKey('s1', 'debaterA')]);
    expect(hits['z']).toEqual([agentKey('s1', 'debaterA')]);
  });

  it("kind 'main' entries are not matched by rules 2-4", () => {
    // The main entry itself appears as a subagent with type name 'Researcher'
    // and carries a slash-y model: rules 2 and 4 both target the same MAIN
    // key and must skip it (rule 1 has no agentId match here).
    const m = modelFrom(
      agent('s1', 'main', {
        kind: 'main',
        model: 'anthropic/claude-3-5-sonnet',
        subagents: [{ subagentId: 'main', name: 'Researcher', status: 'running' }],
      }),
    );
    const hits = matchDebateSpecs(m, [{ id: 'Researcher' }, { id: 'y', tag: 'anthropic/claude-3-5-sonnet' }]);
    expect(hits['Researcher']).toEqual([]);
    expect(hits['y']).toEqual([]);
  });

  it('specs with a missing/empty id are skipped', () => {
    const m = modelFrom(agent('s1', 'main', { kind: 'main' }));
    const hits = matchDebateSpecs(m, [{ id: '' }, { id: 'ok' }]);
    expect(hits['ok']).toEqual([]);
    expect(hits['']).toBeUndefined();
  });

  it('F4: orphan subName backfills the name index when the parent no longer declares it', () => {
    // The orphan leaf is created from the parent's subagents[] declaration;
    // after the parent frame drops the id, only the leaf's own subName can
    // resolve the type name — the backfill must match it.
    const m = modelFrom(
      agent('s1', 'main', { subagents: [{ subagentId: 'r1', name: 'Researcher', status: 'running' }] }),
    );
    upsertAgent(m, agent('s1', 'main', { subagents: [] }));
    expect(m.byKey[agentKey('s1', 'r1')]?.orphan).toBe(true);
    const hits = matchDebateSpecs(m, [{ id: 'Researcher' }]);
    expect(hits['Researcher']).toEqual([agentKey('s1', 'r1')]);
  });

  it('F4: a parent-declared name wins over the orphan subName backfill', () => {
    // Parent declares 'Declared'; force the orphan leaf to carry a different
    // (older) subName. The parent declaration must keep priority — the
    // backfill never overrides an existing nameOf entry.
    const m = modelFrom(
      agent('s1', 'main', { subagents: [{ subagentId: 'r1', name: 'Declared', status: 'running' }] }),
    );
    const orphan = m.byKey[agentKey('s1', 'r1')];
    expect(orphan?.orphan).toBe(true);
    orphan!.subName = 'Stale';
    expect(matchDebateSpecs(m, [{ id: 'Declared' }])['Declared']).toEqual([agentKey('s1', 'r1')]);
    expect(matchDebateSpecs(m, [{ id: 'Stale' }])['Stale']).toEqual([]);
  });

  it('serialized source reproduces matchDebateSpecs hits (drift)', () => {
    const m = modelFrom(
      agent('s1', 'main', { subagents: [{ subagentId: 'res1', name: 'Researcher', status: 'running' }] }),
      agent('s1', 'res1', { kind: 'sub', parentAgentId: 'main', model: 'anthropic/claude-3-5-sonnet', busy: true }),
    );
    const specs = [{ id: 'Researcher' }, { id: 'x', tag: 'anthropic/claude-3-5-sonnet' }, { id: 'miss' }];
    const real = matchDebateSpecs(m, specs);
    const fake = vmModel().matchDebateSpecs(m, specs);
    expect(JSON.parse(JSON.stringify(fake))).toEqual(JSON.parse(JSON.stringify(real)));
  });
});
