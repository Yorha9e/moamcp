/** StateFold port (omkc-status/src/fold.test.ts) + batch-1a regressions + MCP assembly. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, describe } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { BoardStore } from '../src/core/store/board.js';
import { StateFold, type OmkcEvent } from '../src/modules/status/state.js';
import {
  createStatusController,
  createStatusModule,
} from '../src/modules/status/index.js';
import type { WireRecord, WireRef } from '../src/modules/status/watcher.js';

const ref: WireRef = { home: 'omkc', workDirHash: 'wd_test_1', sessionId: 'sess-1', agentId: 'main' };

function wire(type: string, fields: Record<string, unknown> = {}, time = 1000): WireRecord {
  return { type, time, ...fields };
}

function loopEvent(event: Record<string, unknown>, time = 1000): WireRecord {
  return wire('context.append_loop_event', { event }, time);
}

function omkc(type: string, payload: Record<string, unknown> = {}, ts = Date.now()): OmkcEvent {
  return { ts, sessionId: 'sess-1', agentId: 'main', type, payload };
}

async function waitFor(cond: () => boolean, ms = 5000, step = 20): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('waitFor timed out');
}

it('infers model from config.update / usage.record, tokens from update_token_count', () => {
  const fold = new StateFold();
  fold.applyWire(ref, wire('metadata', { protocol_version: '1.4', created_at: 900 }, 900));
  fold.applyWire(ref, wire('config.update', { modelAlias: 'kimi-code/k3' }));
  fold.applyWire(ref, wire('context.update_token_count', { tokenCount: 12345 }));
  fold.applyWire(ref, wire('usage.record', { model: 'kimi-code/k3', usage: { inputOther: 100, output: 10 } }));
  const [agent] = fold.snapshotAgents();
  expect(agent.home).toBe('omkc');
  expect(agent.model).toBe('kimi-code/k3');
  expect(agent.contextTokens).toBe(12345);
  expect(agent.usage).toEqual({ inputOther: 100, output: 10 });
  expect(agent.source).toBe('wire');
});

it('falls back to llm.request model when nothing else set it', () => {
  const fold = new StateFold();
  fold.applyWire(ref, wire('llm.request', { model: 'k3', modelAlias: 'kimi-code/k3' }));
  const [agent] = fold.snapshotAgents();
  expect(agent.model).toBe('kimi-code/k3');
});

it('infers busy from turn.prompt and idle from a terminal step.end', () => {
  const fold = new StateFold();
  fold.applyWire(ref, wire('turn.prompt', { input: [] }, 1000));
  expect(fold.snapshotAgents()[0].busy).toBe(true);
  // tool_use step.end: turn still running
  fold.applyWire(ref, loopEvent({ type: 'step.end', finishReason: 'tool_use' }, 1001));
  expect(fold.snapshotAgents()[0].busy).toBe(true);
  // terminal finish reason: idle
  fold.applyWire(ref, loopEvent({ type: 'step.end', finishReason: 'end_turn' }, 1002));
  const [agent] = fold.snapshotAgents();
  expect(agent.busy).toBe(false);
  expect(agent.lastFinishReason).toBe('end_turn');
});

it('turn.cancel marks idle with cancelled reason', () => {
  const fold = new StateFold();
  fold.applyWire(ref, wire('turn.prompt', { input: [] }));
  fold.applyWire(ref, wire('turn.cancel'));
  const [agent] = fold.snapshotAgents();
  expect(agent.busy).toBe(false);
  expect(agent.lastFinishReason).toBe('cancelled');
});

it('tracks last tool call and its isError from the tool result', () => {
  const fold = new StateFold();
  fold.applyWire(ref, loopEvent({ type: 'tool.call', name: 'Bash', description: 'Running: ls' }, 1000));
  fold.applyWire(ref, loopEvent({ type: 'tool.result', result: { output: 'x', isError: true } }, 1001));
  const [agent] = fold.snapshotAgents();
  expect(agent.lastToolCall?.name).toBe('Bash');
  expect(agent.lastToolCall?.description).toBe('Running: ls');
  expect(agent.lastToolCall?.isError).toBe(true);
});

it('discovers subagents from state.json agents table', () => {
  const fold = new StateFold();
  fold.applySessionState(
    { home: 'omkc', workDirHash: 'wd_test_1', sessionId: 'sess-1' },
    {
      title: 'demo',
      workDir: 'D:/demo',
      updatedAt: '2026-07-22T10:00:00.000Z',
      agents: {
        main: { type: 'main', parentAgentId: null },
        'agent-0': { type: 'sub', parentAgentId: 'main' },
      },
    },
  );
  const agents = fold.snapshotAgents();
  const main = agents.find((a) => a.agentId === 'main')!;
  const sub = agents.find((a) => a.agentId === 'agent-0')!;
  expect(main.kind).toBe('main');
  expect(sub.parentAgentId).toBe('main');
  expect(main.subagents.map((s) => s.subagentId)).toEqual(['agent-0']);
  expect(main.subagents[0].status).toBe('unknown');
  expect(fold.snapshotSessions()[0].title).toBe('demo');
});

it('updates subagent lifecycle from tasks/*.json', () => {
  const fold = new StateFold();
  fold.applySessionState(
    { home: 'omkc', workDirHash: 'wd_test_1', sessionId: 'sess-1' },
    { agents: { main: { type: 'main', parentAgentId: null }, 'agent-0': { type: 'sub', parentAgentId: 'main' } } },
  );
  fold.applyTask(
    { ...ref, taskId: 'agent-abc' },
    {
      taskId: 'agent-abc',
      kind: 'agent',
      agentId: 'agent-0',
      status: 'completed',
      description: 'explore: find files',
      subagentType: 'explore',
      startedAt: 1000,
      endedAt: 2000,
    },
  );
  const main = fold.snapshotAgents().find((a) => a.agentId === 'main')!;
  expect(main.subagents[0].status).toBe('completed');
  expect(main.subagents[0].name).toBe('explore');
  expect(main.subagents[0].description).toBe('explore: find files');
});

// ---------------------------------------------------------------- regressions

it('guards NaN timestamps from a bad updatedAt (finite lastSeen, sweepStale works, JSON has no null)', () => {
  const fold = new StateFold({ staleMs: 1000 });
  fold.applySessionState(
    { home: 'omkc', workDirHash: 'wd_test_1', sessionId: 'sess-1' },
    { updatedAt: 'not-a-date', agents: { main: { type: 'main' } } },
  );
  const [agent] = fold.snapshotAgents();
  expect(Number.isFinite(agent.lastSeen)).toBe(true);
  // without the guard, lastSeen would be NaN and the agent would never go stale
  fold.sweepStale(Date.now() + 2000);
  expect(fold.snapshotAgents()[0].stale).toBe(true);
  // NaN/Infinity would serialize as null in JSON output
  expect(JSON.stringify(fold.snapshotAgents())).not.toContain('"lastSeen":null');
});

it('guards Infinity timestamps from wire records ({time: 1e999})', () => {
  const fold = new StateFold({ staleMs: 1000 });
  fold.applyWire(ref, wire('turn.prompt', {}, 1e999));
  const [agent] = fold.snapshotAgents();
  expect(Number.isFinite(agent.lastSeen)).toBe(true);
  expect(agent.busy).toBe(true); // the record itself is still applied
  fold.sweepStale(Date.now() + 2000);
  expect(JSON.stringify(fold.snapshotAgents())).not.toContain('"lastSeen":null');
});

it('guards Infinity timestamps from task files (out-of-range endedAt)', () => {
  const fold = new StateFold({ staleMs: 1000 });
  fold.applySessionState(
    { home: 'omkc', workDirHash: 'wd_test_1', sessionId: 'sess-1' },
    { agents: { main: { type: 'main', parentAgentId: null } } },
  );
  fold.applyTask(
    { ...ref, taskId: 'agent-abc' },
    { taskId: 'agent-abc', kind: 'agent', agentId: 'agent-0', status: 'completed', endedAt: 1e999 },
  );
  const main = fold.snapshotAgents().find((a) => a.agentId === 'main')!;
  expect(Number.isFinite(main.subagents[0].ts)).toBe(true);
  expect(JSON.stringify(fold.snapshotAgents())).not.toContain('"ts":null');
});

it('deduplicates sessions across homes: one entry, stable home, no agent split', () => {
  const fold = new StateFold();
  for (let i = 0; i < 5; i++) {
    fold.applySessionState(
      { home: 'omkc', workDirHash: 'wd_x', sessionId: 's1' },
      { title: `t-omkc-${i}`, updatedAt: `2026-07-22T10:00:0${i}.000Z`, agents: { main: { type: 'main' } } },
    );
    fold.applySessionState(
      { home: 'kimi-code', workDirHash: 'wd_x', sessionId: 's1' },
      { title: `t-kimi-${i}`, updatedAt: `2026-07-22T11:00:0${i}.000Z`, agents: { main: { type: 'main' } } },
    );
  }
  const sessions = fold.snapshotSessions();
  expect(sessions).toHaveLength(1);
  // home: first writer (omkc) wins and never flips
  expect(sessions[0].home).toBe('omkc');
  // title: later writer overwrites; updatedAt: max of both
  expect(sessions[0].title).toBe('t-kimi-4');
  expect(sessions[0].updatedAt).toBe('2026-07-22T11:00:04.000Z');
  // agents keyed by sessionId+agentId only -> a single 'main', no split
  const mains = fold.snapshotAgents().filter((a) => a.agentId === 'main');
  expect(mains).toHaveLength(1);
  expect(mains[0].home).toBe('omkc');
});

it('snapshotAgents deep-copies usage so mutation cannot leak into the fold', () => {
  const fold = new StateFold();
  fold.applyWire(ref, wire('usage.record', { model: 'm', usage: { output: 1, input: { tokens: 5 } } }));
  const [snap] = fold.snapshotAgents();
  (snap.usage as { output: number }).output = 999;
  (snap.usage as { input: { tokens: number } }).input.tokens = 999;
  const [again] = fold.snapshotAgents();
  expect((again.usage as { output: number }).output).toBe(1);
  expect((again.usage as { input: { tokens: number } }).input.tokens).toBe(5);
});

// ------------------------------------------------------------- omkc overlay

it('omkc events override wire inference while fresh, wire resumes after the window', async () => {
  const fold = new StateFold({ omkcPriorityMs: 50 });
  fold.applyWire(ref, wire('usage.record', { model: 'wire-model', usage: { output: 1 } }));
  fold.applyOmkcEvent(omkc('agent.status.updated', { model: 'omkc-model', phase: 'tool' }));
  let [agent] = fold.snapshotAgents();
  expect(agent.model).toBe('omkc-model');
  expect(agent.phase).toBe('tool');
  expect(agent.source).toBe('omkc');
  // wire must not overwrite while omkc owns the agent
  fold.applyWire(ref, wire('usage.record', { model: 'wire-model-2', usage: { output: 2 } }));
  [agent] = fold.snapshotAgents();
  expect(agent.model).toBe('omkc-model');
  // after the priority window, wire inference owns the fields again
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      fold.applyWire(ref, wire('usage.record', { model: 'wire-model-3', usage: { output: 3 } }));
      const [a] = fold.snapshotAgents();
      expect(a.model).toBe('wire-model-3');
      resolve();
    }, 80);
  });
});

it('handles turn and structured subagent events', () => {
  const fold = new StateFold();
  fold.applyOmkcEvent(omkc('turn.started'));
  expect(fold.snapshotAgents()[0].busy).toBe(true);
  fold.applyOmkcEvent(omkc('turn.ended', { reason: 'completed' }));
  const main = fold.snapshotAgents()[0];
  expect(main.busy).toBe(false);
  expect(main.lastTurnReason).toBe('completed');
  fold.applyOmkcEvent(
    omkc('subagent.spawned', { subagentId: 'agent-9', subagentName: 'coder', description: 'fix bug' }),
  );
  fold.applyOmkcEvent(
    omkc('subagent.completed', { subagentId: 'agent-9', resultSummary: 'done', usage: { output: 5 } }),
  );
  const [a] = fold.snapshotAgents();
  expect(a.subagents[0].status).toBe('completed');
  expect(a.subagents[0].resultSummary).toBe('done');
  expect(a.subagents[0].name).toBe('coder');
});

it('routes subagent.* events to the parent when parentAgentId is present', () => {
  const fold = new StateFold();
  fold.applyOmkcEvent({
    ts: Date.now(),
    sessionId: 'sess-1',
    agentId: 'agent-9',
    type: 'subagent.spawned',
    payload: { subagentId: 'agent-9', parentAgentId: 'main' },
  });
  const agents = fold.snapshotAgents();
  const main = agents.find((a) => a.agentId === 'main')!;
  expect(main.subagents.length).toBe(1);
  expect(main.subagents[0].subagentId).toBe('agent-9');
});

// --------------------------------------------------------- stale heuristic

it('marks agents with no events for >staleMs as stale and keeps them', () => {
  const fold = new StateFold({ staleMs: 1000 });
  fold.applyWire(ref, wire('turn.prompt', {}, Date.now() - 10_000));
  fold.applyWire({ ...ref, agentId: 'agent-1' }, wire('turn.prompt', {}, Date.now()));
  fold.sweepStale();
  const agents = fold.snapshotAgents();
  expect(agents.find((a) => a.agentId === 'main')!.stale).toBe(true);
  expect(agents.find((a) => a.agentId === 'agent-1')!.stale).toBe(false);
  expect(fold.agentCount).toBe(2); // kept, not deleted
});

// ---------------------------------------------------- eviction (0.8.0)

describe('fold eviction (0.8.0)', () => {
  it('evicts agents idle beyond evictStaleMs, audits the count, and rebuilds on a new event', () => {
    const fold = new StateFold({ staleMs: 1000, evictStaleMs: 1000 });
    const now = Date.now();
    fold.applyWire(ref, wire('turn.prompt', {}, now - 5000)); // 'main' is 5s idle
    fold.applyWire({ ...ref, agentId: 'agent-1' }, wire('turn.prompt', {}, now));
    expect(fold.agentCount).toBe(2);
    fold.sweepStale(now);
    expect(fold.agentCount).toBe(1); // 'main' evicted, 'agent-1' kept
    expect(fold.evictedAgents).toBe(1);
    expect(fold.snapshotAgents().map((a) => a.agentId)).toEqual(['agent-1']);
    // a new event rebuilds the evicted agent from scratch (it came back alive)
    fold.applyWire(ref, wire('turn.prompt', {}, now));
    expect(fold.agentCount).toBe(2);
    const rebuilt = fold.snapshotAgents().find((a) => a.agentId === 'main')!;
    expect(rebuilt.busy).toBe(true);
    expect(rebuilt.firstSeen).toBe(now); // fresh entry, not the old firstSeen
    expect(fold.evictedAgents).toBe(1); // audit count stays cumulative
  });

  it('keeps agents idle longer than staleMs but shorter than evictStaleMs', () => {
    const fold = new StateFold({ staleMs: 100, evictStaleMs: 1000 });
    const now = Date.now();
    fold.applyWire(ref, wire('turn.prompt', {}, now - 500));
    fold.sweepStale(now);
    expect(fold.agentCount).toBe(1); // stale-marked but still folded
    expect(fold.snapshotAgents()[0].stale).toBe(true);
    expect(fold.evictedAgents).toBe(0);
  });

  it('evicts sessions idle beyond evictStaleMs (updatedAt-based) and audits the count', () => {
    const fold = new StateFold({ evictStaleMs: 1000 });
    const now = Date.now();
    fold.applySessionState(
      { home: 'omkc', workDirHash: 'wd_evict', sessionId: 's-old' },
      { updatedAt: new Date(now - 5000).toISOString(), agents: { main: { type: 'main' } } },
    );
    fold.applySessionState(
      { home: 'omkc', workDirHash: 'wd_evict', sessionId: 's-new' },
      { updatedAt: new Date(now).toISOString(), agents: { main: { type: 'main' } } },
    );
    expect(fold.sessionCount).toBe(2);
    fold.sweepStale(now);
    expect(fold.sessionCount).toBe(1);
    expect(fold.snapshotSessions().map((s) => s.sessionId)).toEqual(['s-new']);
    expect(fold.evictedSessions).toBe(1);
  });

  it('does not evict sessions with a missing/garbage updatedAt (finiteTime fallback)', () => {
    const fold = new StateFold({ evictStaleMs: 1000 });
    fold.applySessionState(
      { home: 'omkc', workDirHash: 'wd_evict', sessionId: 's-no-date' },
      { agents: { main: { type: 'main' } } }, // no updatedAt -> Date.now() fallback
    );
    // without the finiteTime guard, sessionSeen would be NaN and the
    // comparison `now - NaN > evictStaleMs` is always false — the session
    // would be immortal. The fallback makes it evictable but not immediately.
    fold.sweepStale(Date.now());
    expect(fold.sessionCount).toBe(1);
    expect(fold.evictedSessions).toBe(0);
  });

  it('eviction does not touch agents evicted-then-rebuilt inside the same sweep', () => {
    const fold = new StateFold({ staleMs: 1000, evictStaleMs: 1000 });
    const now = Date.now();
    fold.applyWire(ref, wire('turn.prompt', {}, now - 5000));
    fold.sweepStale(now);
    expect(fold.agentCount).toBe(0);
    // rebuild right after the sweep: the new lastSeen is fresh, so a second
    // sweep in the same instant must not evict it again
    fold.applyWire(ref, wire('turn.prompt', {}, now));
    fold.sweepStale(now);
    expect(fold.agentCount).toBe(1);
    expect(fold.evictedAgents).toBe(1); // counted once
  });

  it('sweepStale returns the per-tick eviction delta for gone frames (0.8.1)', () => {
    const fold = new StateFold({ staleMs: 1000, evictStaleMs: 1000 });
    const now = Date.now();
    fold.applyWire(ref, wire('turn.prompt', {}, now - 5000)); // 'sess-1/main' evictable
    fold.applySessionState(
      { home: 'omkc', workDirHash: 'wd_evict', sessionId: 's-old' },
      { updatedAt: new Date(now - 5000).toISOString(), agents: { main: { type: 'main' } } },
    );
    fold.applyWire({ ...ref, agentId: 'live' }, wire('turn.prompt', {}, now)); // kept
    const evicted = fold.sweepStale(now);
    // per-tick delta: both idle agents + their session, in fold insertion order
    expect(evicted.evictedAgents).toEqual([
      { sessionId: 'sess-1', agentId: 'main' },
      { sessionId: 's-old', agentId: 'main' },
    ]);
    expect(evicted.evictedSessions).toEqual([{ sessionId: 's-old' }]);
    // cumulative audit counters keep their existing semantics
    expect(fold.evictedAgents).toBe(2);
    expect(fold.evictedSessions).toBe(1);
    // an idle tick still returns empty lists, never null/undefined
    expect(fold.sweepStale(now)).toEqual({ evictedAgents: [], evictedSessions: [] });
  });
});

// ------------------------------------------------------------ MCP assembly

it('exposes moa_status_agents over MCP and reports explicit started state', async () => {
  const boardHome = await mkdtemp(join(tmpdir(), 'moamcp-status-assembly-'));
  const board = new BoardStore({ homeDir: boardHome, workspaceCwd: process.cwd(), waitCapMs: 200, pollIntervalMs: 15 });
  const controller = createStatusController();
  const server = createServer(undefined, undefined, board, undefined, createStatusModule(controller));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'status-assembly-test', version: '0.0.1' });
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    expect(listed.tools.some((t) => t.name === 'moa_status_agents')).toBe(true);
    const res = await client.callTool({ name: 'moa_status_agents', arguments: {} });
    const parsed = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
    expect(parsed).toHaveProperty('started');
    expect(parsed.started).toBe(false);
    expect(parsed.agents).toEqual([]); // not started: explicitly empty, never silent
    expect(parsed.agentsTruncated).toBe(0);
  } finally {
    await client.close();
    await server.close();
    await rm(boardHome, { recursive: true, force: true });
  }
});

it('serves live folded agents once the controller is started (watcher → fold → tool)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-status-live-'));
  try {
    for (const [sessionId, agentId, time, updatedAt] of [
      ['s1', 'main', 1, '2026-07-22T10:00:00.000Z'],
      ['s2', 'main', 2, '2026-07-22T11:00:00.000Z'],
    ] as const) {
      const agentPath = join(home, 'sessions', 'wd_x', sessionId, 'agents', agentId);
      await mkdir(agentPath, { recursive: true });
      await writeFile(join(agentPath, 'wire.jsonl'), `{"type":"turn.prompt","time":${time}}\n`);
      await writeFile(
        join(home, 'sessions', 'wd_x', sessionId, 'state.json'),
        JSON.stringify({ title: sessionId, updatedAt, agents: { main: { type: 'main' } } }),
      );
    }
    const controller = createStatusController({
      // Pin BOTH home env vars: a real ~/.kimi-code on the host must not leak
      // real agents into this test (resolveHomes would otherwise attach it).
      env: { OMKC_HOME: home, KIMI_CODE_HOME: `${home}.missing-kimi` } as NodeJS.ProcessEnv,
      scanIntervalMs: 50,
      pollIntervalMs: 20,
    });
    controller.start();
    const boardHome = await mkdtemp(join(tmpdir(), 'moamcp-status-live-board-'));
    const board = new BoardStore({ homeDir: boardHome, workspaceCwd: process.cwd(), waitCapMs: 200, pollIntervalMs: 15 });
    const server = createServer(undefined, undefined, board, undefined, createStatusModule(controller));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'status-live-test', version: '0.0.1' });
    await client.connect(clientTransport);
    try {
      await waitFor(() => controller.getFold().agentCount >= 2);
      const res = await client.callTool({ name: 'moa_status_agents', arguments: { limit: 10 } });
      const parsed = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
      expect(parsed.started).toBe(true);
      expect(parsed.agentCount).toBe(2);
      expect(parsed.agentsTruncated).toBe(2);
      expect(parsed.sessions).toHaveLength(2);
      expect(parsed.agents).toHaveLength(2);
      // sorted by lastSeen desc: s2/main (time 2) first
      expect(parsed.agents[0].sessionId).toBe('s2');
      // sessionId filter
      const filtered = await client.callTool({ name: 'moa_status_agents', arguments: { sessionId: 's1' } });
      const filteredParsed = JSON.parse((filtered.content as Array<{ type: string; text: string }>)[0].text);
      expect(filteredParsed.agents).toHaveLength(1);
      expect(filteredParsed.agents[0].sessionId).toBe('s1');
      // limit cap: one agent, but the truncated total is still reported
      const capped = await client.callTool({ name: 'moa_status_agents', arguments: { limit: 1 } });
      const cappedParsed = JSON.parse((capped.content as Array<{ type: string; text: string }>)[0].text);
      expect(cappedParsed.agents).toHaveLength(1);
      expect(cappedParsed.agents[0].sessionId).toBe('s2');
      expect(cappedParsed.agentsTruncated).toBe(2);
    } finally {
      await client.close();
      controller.stop();
      await server.close();
      await rm(boardHome, { recursive: true, force: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
