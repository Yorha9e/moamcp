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
  agentKey,
  applySnapshot,
  deriveStatus,
  modelCounts,
  newModel,
  removeAgent,
  removeSession,
  STATUS_MODEL_JS,
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
        });
        for (let j = (e.children || []).length - 1; j >= 0; j--) {
          if (!visited[e.children[j]]) stack.push(e.children[j]);
        }
      }
      return { sessionId: sid, gone: !!row.gone, agents: flatten };
    });
    return JSON.stringify({ groups, counts: api.modelCounts(model) });
  }

  const fullScript: Array<Record<string, unknown>> = [
    { op: 'snapshot', snap: snapshot([{ sessionId: 's1', title: 'S' }], [
      agent('s1', 'main', { kind: 'main', busy: true, subagents: [{ subagentId: 'leaf', status: 'running', ts: 5 }] }),
      agent('s1', 'child', { parentAgentId: 'main', phase: 'thinking' }),
      agent('s2', 'lone', { stale: true }),
    ]) },
    { op: 'agent', agent: agent('s1', 'child', { parentAgentId: 'main', busy: false, lastTurnReason: 'completed' }) },
    { op: 'agent', agent: agent('s1', 'main', { parentAgentId: 'other', busy: false, lastFinishReason: 'end_turn' }) },
    { op: 'agent', agent: agent('s3', 'late-child', { parentAgentId: 'late-parent' }) },
    { op: 'agent', agent: agent('s3', 'late-parent', {}) },
    { op: 'gone', sessionId: 's1', agentId: 'main' },
    { op: 'gone', sessionId: 's1', agentId: 'leaf' },
    { op: 'session', sessionId: 's2' },
    { op: 'agent', agent: agent('s2', 'lone', { busy: true }) },
    { op: 'gone', sessionId: 's3', agentId: 'late-parent' },
  ];

  it('serialized source reproduces the real functions for a full op script', () => {
    const real = runScript({ newModel, applySnapshot, upsertAgent, removeAgent, removeSession, deriveStatus, modelCounts }, fullScript);
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
