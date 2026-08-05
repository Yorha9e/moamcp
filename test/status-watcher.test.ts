/** WireWatcher port (omkc-status/src/watcher.test.ts) + batch-1a regressions. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveHomes,
  WireWatcher,
  type SessionState,
  type TaskFile,
  type WireRecord,
  type WireRef,
} from '../src/modules/status/watcher.js';

async function waitFor(cond: () => boolean, ms = 5000, step = 20): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('waitFor timed out');
}

describe('WireWatcher', () => {
  let root: string;
  let sessionPath: string;
  let mainWire: string;
  let records: { ref: WireRef; record: WireRecord | null }[];
  let states: SessionState[];
  let tasks: TaskFile[];
  let watcher: WireWatcher;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'moamcp-status-watch-'));
    sessionPath = path.join(root, 'wd_test_abc', 'session_1');
    const agentPath = path.join(sessionPath, 'agents', 'main');
    fs.mkdirSync(agentPath, { recursive: true });
    mainWire = path.join(agentPath, 'wire.jsonl');
    fs.writeFileSync(
      mainWire,
      '{"type":"metadata","protocol_version":"1.4","created_at":1}\n' +
        '{"type":"turn.prompt","input":[],"time":2}\n',
    );
    fs.writeFileSync(
      path.join(sessionPath, 'state.json'),
      JSON.stringify({
        title: 't',
        updatedAt: '2026-07-22T10:00:00.000Z',
        agents: { main: { type: 'main', parentAgentId: null } },
      }),
    );
    records = [];
    states = [];
    tasks = [];
    watcher = new WireWatcher({
      home: 'omkc',
      root,
      scanIntervalMs: 50,
      pollIntervalMs: 20,
      onRecord: (ref, _raw, record) => records.push({ ref, record }),
      onSessionState: (_ref, state) => states.push(state),
      onTask: (_ref, task) => tasks.push(task),
    });
    watcher.start();
  });

  afterAll(() => {
    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('tails existing wire.jsonl and reads state.json', async () => {
    await waitFor(() => records.length >= 2 && states.length >= 1);
    expect(records[0].record?.type).toBe('metadata');
    expect(records[1].record?.type).toBe('turn.prompt');
    expect(records[0].ref.agentId).toBe('main');
    expect(records[0].ref.sessionId).toBe('session_1');
    expect(records[0].ref.workDirHash).toBe('wd_test_abc');
    expect(states[0].title).toBe('t');
  });

  it('picks up appended lines', async () => {
    fs.appendFileSync(mainWire, '{"type":"turn.cancel","time":3}\n');
    await waitFor(() => records.some((r) => r.record?.type === 'turn.cancel'));
  });

  it('buffers a partial trailing line until it completes', async () => {
    fs.appendFileSync(mainWire, '{"type":"usage.rec');
    await new Promise((r) => setTimeout(r, 200));
    expect(records.some((r) => r.record?.type === 'usage.record')).toBe(false);
    fs.appendFileSync(mainWire, 'ord","model":"m","usage":{"output":1},"time":4}\n');
    await waitFor(() => records.some((r) => r.record?.type === 'usage.record'));
  });

  it('re-reads from the start after a truncate', async () => {
    const before = records.length;
    fs.writeFileSync(mainWire, '{"type":"metadata","protocol_version":"1.4","created_at":10}\n');
    await waitFor(() => records.length > before);
    const last = records[records.length - 1];
    expect(last.record?.type).toBe('metadata');
    expect((last.record as { created_at?: number }).created_at).toBe(10);
  });

  it('discovers agent directories and task files appearing at runtime', async () => {
    const subPath = path.join(sessionPath, 'agents', 'agent-0');
    fs.mkdirSync(path.join(subPath, 'tasks'), { recursive: true });
    fs.writeFileSync(
      path.join(subPath, 'wire.jsonl'),
      '{"type":"metadata","protocol_version":"1.4","created_at":20}\n',
    );
    fs.writeFileSync(
      path.join(subPath, 'tasks', 'agent-x.json'),
      JSON.stringify({ taskId: 'agent-x', kind: 'agent', agentId: 'agent-0', status: 'running' }),
    );
    await waitFor(
      () =>
        records.some((r) => r.ref.agentId === 'agent-0' && r.record?.type === 'metadata') &&
        tasks.some((t) => t.taskId === 'agent-x'),
    );
    const task = tasks.find((t) => t.taskId === 'agent-x')!;
    expect(task.status).toBe('running');
  });

  it('re-reads state.json on change', async () => {
    const before = states.length;
    // mtime granularity can hide fast successive writes; bump it explicitly
    const stateFile = path.join(sessionPath, 'state.json');
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        title: 't2',
        updatedAt: '2026-07-22T11:00:00.000Z',
        agents: {
          main: { type: 'main', parentAgentId: null },
          'agent-0': { type: 'sub', parentAgentId: 'main' },
        },
      }),
    );
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(stateFile, future, future);
    await waitFor(() => states.length > before);
    expect(states[states.length - 1].title).toBe('t2');
    expect(Object.keys(states[states.length - 1].agents ?? {}).length).toBe(2);
  });

  it('start() twice is idempotent: no second timer set, still fully functional', async () => {
    watcher.start(); // must be a no-op
    expect((watcher as unknown as { started: boolean }).started).toBe(true);
    // still works after the redundant start
    fs.appendFileSync(mainWire, '{"type":"turn.steer","input":[],"time":5}\n');
    await waitFor(() => records.some((r) => r.record?.type === 'turn.steer'));
  });

  it('stop() silences every callback (no records, state, or tasks afterwards)', async () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'moamcp-status-stop-'));
    const sessionPath2 = path.join(root2, 'wd_x', 's1');
    const agentPath2 = path.join(sessionPath2, 'agents', 'main');
    fs.mkdirSync(agentPath2, { recursive: true });
    fs.writeFileSync(path.join(agentPath2, 'wire.jsonl'), '{"type":"metadata","time":1}\n');
    fs.writeFileSync(
      path.join(sessionPath2, 'state.json'),
      JSON.stringify({ title: 't', agents: { main: { type: 'main' } } }),
    );
    const records2: WireRecord[] = [];
    const states2: SessionState[] = [];
    const w2 = new WireWatcher({
      home: 'omkc',
      root: root2,
      scanIntervalMs: 30,
      pollIntervalMs: 15,
      onRecord: (_ref, _raw, record) => records2.push(record!),
      onSessionState: (_ref, state) => states2.push(state),
    });
    w2.start();
    try {
      await waitFor(() => records2.length >= 1 && states2.length >= 1);
      w2.stop();
      expect((w2 as unknown as { started: boolean }).started).toBe(false);
      const after = records2.length;
      fs.appendFileSync(path.join(agentPath2, 'wire.jsonl'), '{"type":"turn.prompt","time":2}\n');
      fs.writeFileSync(
        path.join(sessionPath2, 'state.json'),
        JSON.stringify({ title: 'changed', agents: { main: { type: 'main' } } }),
      );
      await new Promise((r) => setTimeout(r, 250));
      expect(records2.length).toBe(after);
      expect(states2.length).toBe(1);
    } finally {
      w2.stop();
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });

  it('stop() then start() resumes tailing from the saved offset', async () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'moamcp-status-restart-'));
    const sessionPath2 = path.join(root2, 'wd_x', 's1');
    const agentPath2 = path.join(sessionPath2, 'agents', 'main');
    fs.mkdirSync(agentPath2, { recursive: true });
    const wire2 = path.join(agentPath2, 'wire.jsonl');
    fs.writeFileSync(wire2, '{"type":"metadata","time":1}\n');
    const records2: WireRecord[] = [];
    const w2 = new WireWatcher({
      home: 'omkc',
      root: root2,
      scanIntervalMs: 30,
      pollIntervalMs: 15,
      onRecord: (_ref, _raw, record) => records2.push(record!),
    });
    try {
      w2.start();
      await waitFor(() => records2.length >= 1);
      w2.stop();
      // restart resumes from the tail offset kept across stop()
      w2.start();
      fs.appendFileSync(wire2, '{"type":"turn.cancel","time":2}\n');
      await waitFor(() => records2.some((r) => r.type === 'turn.cancel'));
    } finally {
      w2.stop();
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });

  it('evicts tails and progress.agents after an agent directory is deleted', async () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'moamcp-status-evict-'));
    const sessionPath2 = path.join(root2, 'wd_x', 's1');
    const mainPath2 = path.join(sessionPath2, 'agents', 'main');
    const subPath2 = path.join(sessionPath2, 'agents', 'sub');
    fs.mkdirSync(mainPath2, { recursive: true });
    fs.mkdirSync(subPath2, { recursive: true });
    fs.writeFileSync(path.join(mainPath2, 'wire.jsonl'), '{"type":"metadata","time":1}\n');
    fs.writeFileSync(path.join(subPath2, 'wire.jsonl'), '{"type":"metadata","time":1}\n');
    const w2 = new WireWatcher({
      home: 'omkc',
      root: root2,
      scanIntervalMs: 50,
      pollIntervalMs: 20,
      onRecord: () => {},
    });
    w2.start();
    try {
      await waitFor(() => w2.tailCount >= 2);
      expect(w2.getProgress().agents).toBe(2);
      fs.rmSync(subPath2, { recursive: true, force: true });
      await waitFor(() => w2.tailCount === 1);
      const progress = w2.getProgress();
      expect(progress.agents).toBe(1);
      expect(progress.sessions).toBe(1);
    } finally {
      w2.stop();
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });

  it('re-reads state.json on a same-mtime rewrite with a different size', async () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'moamcp-status-size-'));
    const sessionPath2 = path.join(root2, 'wd_x', 's1');
    const agentPath2 = path.join(sessionPath2, 'agents', 'main');
    fs.mkdirSync(agentPath2, { recursive: true });
    fs.writeFileSync(path.join(agentPath2, 'wire.jsonl'), '{"type":"metadata","time":1}\n');
    const stateFile2 = path.join(sessionPath2, 'state.json');
    // Pin an explicit mtime so the rewrite can be forced into the same window.
    const fixed = new Date('2026-01-01T00:00:00.000Z');
    fs.writeFileSync(
      stateFile2,
      JSON.stringify({ title: 'v1', updatedAt: '2026-01-01T00:00:00.000Z', agents: { main: { type: 'main' } } }),
    );
    fs.utimesSync(stateFile2, fixed, fixed);
    const first = fs.statSync(stateFile2);
    const states2: SessionState[] = [];
    const w2 = new WireWatcher({
      home: 'omkc',
      root: root2,
      scanIntervalMs: 50,
      pollIntervalMs: 20,
      onRecord: () => {},
      onSessionState: (_ref, state) => states2.push(state),
    });
    w2.start();
    try {
      await waitFor(() => states2.length >= 1);
      // Rewrite with a different size, then restore the exact same mtime:
      // only the size component of the dual key can trigger the re-read.
      fs.writeFileSync(
        stateFile2,
        JSON.stringify({ title: 'v2-longer', updatedAt: '2026-01-01T00:00:00.000Z', agents: { main: { type: 'main' } } }),
      );
      fs.utimesSync(stateFile2, fixed, fixed);
      const second = fs.statSync(stateFile2);
      expect(second.mtimeMs).toBe(first.mtimeMs);
      expect(second.size).not.toBe(first.size);
      await waitFor(() => states2.length >= 2);
      expect(states2[states2.length - 1].title).toBe('v2-longer');
    } finally {
      w2.stop();
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });

  it('A2: passes the wire file mtime as fallbackTs for no-time records', async () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'moamcp-status-mtime-'));
    const sessionPath2 = path.join(root2, 'wd_x', 's1');
    const agentPath2 = path.join(sessionPath2, 'agents', 'main');
    fs.mkdirSync(agentPath2, { recursive: true });
    const wireFile2 = path.join(agentPath2, 'wire.jsonl');
    // No `time` field on the record — the seed must come from the file mtime.
    fs.writeFileSync(wireFile2, '{"type":"metadata","protocol_version":"1.4"}\n');
    const pinned = new Date(Date.now() - 3600_000);
    fs.utimesSync(wireFile2, pinned, pinned);
    const fallbacks: number[] = [];
    const w2 = new WireWatcher({
      home: 'omkc',
      root: root2,
      scanIntervalMs: 40,
      pollIntervalMs: 15,
      onRecord: (_ref, _raw, _record, fallbackTs) => {
        if (fallbackTs !== undefined) fallbacks.push(fallbackTs);
      },
    });
    w2.start();
    try {
      await waitFor(() => fallbacks.length >= 1);
      expect(Math.abs(fallbacks[0] - pinned.getTime())).toBeLessThan(10_000);
    } finally {
      w2.stop();
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });

  it('A3: invalidateSessionState forces a state.json re-read without a file change', async () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'moamcp-status-inval-'));
    const sessionPath2 = path.join(root2, 'wd_x', 's1');
    const agentPath2 = path.join(sessionPath2, 'agents', 'main');
    fs.mkdirSync(agentPath2, { recursive: true });
    fs.writeFileSync(path.join(agentPath2, 'wire.jsonl'), '{"type":"metadata","time":1}\n');
    const stateFile2 = path.join(sessionPath2, 'state.json');
    fs.writeFileSync(stateFile2, JSON.stringify({ title: 'v1', agents: { main: { type: 'main' } } }));
    const states2: SessionState[] = [];
    const w2 = new WireWatcher({
      home: 'omkc',
      root: root2,
      scanIntervalMs: 30,
      pollIntervalMs: 15,
      onRecord: () => {},
      onSessionState: (_ref, state) => states2.push(state),
    });
    w2.start();
    try {
      await waitFor(() => states2.length >= 1);
      const before = states2.length;
      // Same mtime + size: without the invalidation the dual key would block
      // any re-read. This is exactly the A3 self-heal trigger for an evicted
      // session row (controller calls it on new wire/task activity).
      w2.invalidateSessionState({ workDirHash: 'wd_x', sessionId: 's1' });
      await waitFor(() => states2.length > before);
    } finally {
      w2.stop();
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });
});

describe('dual home watching', () => {
  it('merges wires from two homes and stamps each with its home label', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'moamcp-status-dualhome-'));
    const homes = [
      { label: 'omkc' as const, dir: path.join(base, '.omkc') },
      { label: 'kimi-code' as const, dir: path.join(base, '.kimi-code') },
    ];
    const records: { ref: WireRef; record: WireRecord | null }[] = [];
    const watchers: WireWatcher[] = [];
    try {
      for (const h of homes) {
        const agentPath = path.join(h.dir, 'sessions', 'wd_x', `session_${h.label}`, 'agents', 'main');
        fs.mkdirSync(agentPath, { recursive: true });
        fs.writeFileSync(
          path.join(agentPath, 'wire.jsonl'),
          `{"type":"usage.record","model":"m-${h.label}","usage":{"output":1},"time":1}\n`,
        );
        const w = new WireWatcher({
          home: h.label,
          root: path.join(h.dir, 'sessions'),
          scanIntervalMs: 50,
          pollIntervalMs: 20,
          onRecord: (ref, _raw, record) => records.push({ ref, record }),
        });
        w.start();
        watchers.push(w);
      }
      await waitFor(() => records.length >= 2);
      const byHome = new Map(records.map((r) => [r.ref.home, r]));
      expect(byHome.size).toBe(2);
      expect(byHome.get('omkc')?.ref.sessionId).toBe('session_omkc');
      expect(byHome.get('kimi-code')?.ref.sessionId).toBe('session_kimi-code');
      expect((byHome.get('omkc')?.record as { model?: string }).model).toBe('m-omkc');
      expect((byHome.get('kimi-code')?.record as { model?: string }).model).toBe('m-kimi-code');
    } finally {
      for (const w of watchers) w.stop();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('resolveHomes', () => {
  it('orders omkc first and dedupes a shared KIMI_CODE_HOME', () => {
    const both = resolveHomes({ OMKC_HOME: '/a/omkc', KIMI_CODE_HOME: '/b/kimi' } as NodeJS.ProcessEnv);
    expect(both).toEqual([
      { label: 'omkc', home: '/a/omkc' },
      { label: 'kimi-code', home: '/b/kimi' },
    ]);
    // omkc honors KIMI_CODE_HOME too: same path -> omkc label wins, one entry
    const shared = resolveHomes({ KIMI_CODE_HOME: '/shared' } as NodeJS.ProcessEnv);
    expect(shared.length).toBe(1);
    expect(shared[0].label).toBe('omkc');
    expect(shared[0].home).toBe('/shared');
  });
});
