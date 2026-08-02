/**
 * Shared-blackboard tests: BoardStore semantics (write/read/list/delete,
 * last-write-wins, tag filter, scope isolation, 32KB cap, persistence
 * round-trip, tombstones), wait long-poll (wake / since / timeout / closed),
 * per-scope write serialization under concurrency, task-scope archival via
 * moa_complete, and the five moa_board_* tools end-to-end over MCP.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BoardStore, BOARD_VALUE_MAX_BYTES, type BoardEvent, type BoardScope } from '../src/board.js';
import { DebateHub } from '../src/state.js';
import { createServer } from '../src/server.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'moamcp-board-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function store(opts: { cwd?: string; waitCapMs?: number; emit?: (scope: BoardScope, event: BoardEvent) => void } = {}): BoardStore {
  return new BoardStore({
    homeDir: home,
    workspaceCwd: opts.cwd ?? home,
    waitCapMs: opts.waitCapMs ?? 400,
    ...(opts.emit ? { emit: opts.emit } : {}),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The workspace board file path for a given cwd (mirrors BoardStore's naming). */
function wsBoardFile(cwd: string): string {
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 16);
  return join(home, 'boards', `ws-${hash}.jsonl`);
}

// ---- state layer ----

it('write/read round-trip: last-write-wins per key, default author anonymous', async () => {
  const b = store();
  const w1 = await b.write('contract', 'v1: rest api', undefined, undefined, 'workspace');
  expect(w1.ok).toBe(true);
  const w2 = await b.write('contract', 'v2: grpc', undefined, undefined, 'workspace');
  expect(Date.parse(w2.ts)).toBeGreaterThan(Date.parse(w1.ts));

  const rows = await b.read('contract', undefined, 'workspace');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ key: 'contract', value: 'v2: grpc', author: 'anonymous', tags: [] });

  const custom = await b.write('authored', 'x', undefined, 'agent-a', 'workspace');
  expect(custom.ok).toBe(true);
  expect((await b.read('authored', undefined, 'workspace'))[0].author).toBe('agent-a');
});

it('list is a lightweight browse: bytes instead of values, newest first', async () => {
  const b = store();
  await b.write('k1', 'abc', undefined, 'a1', 'workspace');
  await b.write('k2', '€', ['money'], 'a2', 'workspace'); // € is 3 bytes in utf8
  const rows = await b.list('workspace');
  expect(rows).toHaveLength(2);
  expect(rows[0].key).toBe('k2'); // newest first
  expect(rows[0]).toMatchObject({ author: 'a2', tags: ['money'], bytes: 3 });
  expect(rows[1]).toMatchObject({ key: 'k1', bytes: 3 });
  expect(rows.every((r) => !('value' in r))).toBe(true);
});

it('read filters by tag and by key+tag; bare read returns every key latest, capped by limit', async () => {
  const b = store();
  await b.write('api', 'rest', ['contract', 'backend'], 'a', 'workspace');
  await b.write('db', 'postgres', ['backend'], 'a', 'workspace');
  await b.write('ui', 'tiles', ['frontend'], 'a', 'workspace');
  await b.write('api', 'grpc', ['contract', 'backend'], 'a', 'workspace'); // rewrite

  expect((await b.read(undefined, 'backend', 'workspace')).map((e) => e.key).sort()).toEqual(['api', 'db']);
  expect((await b.read(undefined, 'contract', 'workspace')).map((e) => e.value)).toEqual(['grpc']); // latest only
  expect((await b.read('api', 'frontend', 'workspace'))).toEqual([]); // key+tag intersection

  const all = await b.read(undefined, undefined, 'workspace');
  expect(all).toHaveLength(3);
  const capped = await b.read(undefined, undefined, 'workspace', 2);
  expect(capped).toHaveLength(2);
  expect(capped[0].key).toBe('api'); // newest first: the api rewrite was the last write
});

it('read strictly matches exact key, while readNamespace matches key namespace', async () => {
  const b = store();
  await b.write('x/', 'x slash', undefined, 'a', 'workspace');
  await b.write('x/child', 'x child', undefined, 'a', 'workspace');
  await b.write('x/child/grand', 'x grand', undefined, 'a', 'workspace');
  await b.write('xyz', 'unrelated xyz', undefined, 'a', 'workspace');
  await b.write('x_y', 'unrelated x_y', undefined, 'a', 'workspace');

  // Exact read for 'x' when 'x' does not exist -> returns []
  expect(await b.read('x', undefined, 'workspace')).toEqual([]);

  // Exact read for 'x' after writing exact 'x' -> returns ONLY 'x'
  await b.write('x', 'exact x', undefined, 'a', 'workspace');
  const exactX = await b.read('x', undefined, 'workspace');
  expect(exactX).toHaveLength(1);
  expect(exactX[0]).toMatchObject({ key: 'x', value: 'exact x' });

  // readNamespace for 'x' and 'x/' matches x, x/, x/child, x/child/grand, but not xyz or x_y
  const matchX = await b.readNamespace('x', undefined, 'workspace');
  expect(matchX.map((e) => e.key).sort()).toEqual(['x', 'x/', 'x/child', 'x/child/grand']);

  const matchXSlash = await b.readNamespace('x/', undefined, 'workspace');
  expect(matchXSlash.map((e) => e.key).sort()).toEqual(['x', 'x/', 'x/child', 'x/child/grand']);

  // Ensure filtering happens before limit: requesting limit 2 with namespace 'x' returns 2 of the x matches, ignoring xyz/x_y
  const cappedX = await b.readNamespace('x', undefined, 'workspace', 2);
  expect(cappedX).toHaveLength(2);
  expect(cappedX.every((e) => e.key.startsWith('x'))).toBe(true);
  expect(cappedX.some((e) => e.key === 'xyz')).toBe(false);
});

it('three-level scope isolation: same key, four independent boards', async () => {
  const b = store();
  await b.write('handoff', 'workspace copy', undefined, 'a', 'workspace');
  await b.write('handoff', 'global copy', undefined, 'a', 'global');
  await b.write('handoff', 'task-1 copy', undefined, 'a', 'task:t1');
  await b.write('handoff', 'task-2 copy', undefined, 'a', 'task:t2');
  expect((await b.read('handoff', undefined, 'workspace'))[0].value).toBe('workspace copy');
  expect((await b.read('handoff', undefined, 'global'))[0].value).toBe('global copy');
  expect((await b.read('handoff', undefined, 'task:t1'))[0].value).toBe('task-1 copy');
  expect((await b.read('handoff', undefined, 'task:t2'))[0].value).toBe('task-2 copy');
  expect(await b.read('handoff', undefined, 'task:other')).toEqual([]);
});

it('rejects invalid scopes, keys, and oversized values; 32KB is the inclusive bound', async () => {
  const b = store();
  await expect(b.write('k', 'v', undefined, undefined, 'bogus')).rejects.toThrow(/invalid scope/);
  await expect(b.write('k', 'v', undefined, undefined, 'task:')).rejects.toThrow(/invalid scope/);
  await expect(b.write('', 'v', undefined, undefined, 'workspace')).rejects.toThrow(/key/);
  await expect(b.write('k', 42 as never, undefined, undefined, 'workspace')).rejects.toThrow(/value must be a string/);
  await expect(b.write('k', 'x', 'nope' as never, undefined, 'workspace')).rejects.toThrow(/tags/);

  await expect(b.write('k', 'a'.repeat(BOARD_VALUE_MAX_BYTES), undefined, undefined, 'workspace')).resolves.toMatchObject({ ok: true });
  await expect(b.write('k', 'a'.repeat(BOARD_VALUE_MAX_BYTES + 1), undefined, undefined, 'workspace')).rejects.toThrow(/value too large/);
});

it('workspace persistence round-trip: a fresh instance folds the same board back', async () => {
  const cwd = join(home, 'project-x');
  const b1 = store({ cwd });
  await b1.write('module-auth', 'status: done\napi: grpc', ['handoff'], 'session-1', 'workspace');
  await b1.write('scratch', 'temporary', undefined, 'session-1', 'workspace');
  await b1.delete('scratch', 'session-1', 'workspace');
  await b1.write('global-note', 'cross-project', undefined, 'session-1', 'global');

  // New process, same home + same cwd → same boards, folded from disk.
  const b2 = store({ cwd });
  const handoff = await b2.read('module-auth', undefined, 'workspace');
  expect(handoff).toHaveLength(1);
  expect(handoff[0]).toMatchObject({ value: 'status: done\napi: grpc', author: 'session-1', tags: ['handoff'] });
  expect(await b2.read('scratch', undefined, 'workspace')).toEqual([]); // tombstone folded
  expect((await b2.read('global-note', undefined, 'global'))[0].value).toBe('cross-project');

  // A different cwd sees an empty workspace board (distinct hash), global shared.
  const b3 = store({ cwd: join(home, 'project-y') });
  expect(await b3.read('module-auth', undefined, 'workspace')).toEqual([]);
  expect((await b3.read('global-note', undefined, 'global'))[0].value).toBe('cross-project');
});

it('tombstone delete: hidden from read/list, record kept in the JSONL', async () => {
  const cwd = home;
  const b = store({ cwd });
  await b.write('dead', 'alive', undefined, 'a', 'workspace');
  await b.delete('dead', 'a', 'workspace');
  expect(await b.read('dead', undefined, 'workspace')).toEqual([]);
  expect(await b.list('workspace')).toEqual([]);

  const lines = (await readFile(wsBoardFile(cwd), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ op: 'write', key: 'dead', value: 'alive' });
  expect(lines[1]).toMatchObject({ op: 'delete', key: 'dead' });
  expect(lines[1].value).toBeUndefined();
});

it('write/delete emit board_updated events with scope, key, author, ts', async () => {
  const events: Array<{ scope: BoardScope; event: BoardEvent }> = [];
  const b = store({ emit: (scope, event) => events.push({ scope, event }) });
  await b.write('k', 'v', undefined, 'agent-x', 'workspace');
  await b.delete('k', 'agent-x', 'workspace');
  await b.write('t', 'v', undefined, 'agent-x', 'task:debate-1');
  expect(events).toHaveLength(3);
  expect(events[0].event).toMatchObject({ type: 'board_updated', op: 'write', scope: 'workspace', key: 'k', author: 'agent-x' });
  expect(events[0].scope.kind).toBe('workspace');
  expect(events[1].event).toMatchObject({ op: 'delete', scope: 'workspace', key: 'k' });
  expect(events[2].scope).toMatchObject({ kind: 'task', taskId: 'debate-1' });
  expect(events[2].event.scope).toBe('task:debate-1');
  expect(typeof events[0].event.ts).toBe('string');
});

// ---- wait long-poll ----

it('wait blocks until the write lands, then returns the entry', async () => {
  const b = store();
  let resolved = false;
  const pending = b.wait('module-auth', 'workspace').then((r) => {
    resolved = true;
    return r;
  });
  await sleep(50);
  expect(resolved).toBe(false); // still suspended: no value yet

  await b.write('module-auth', 'handoff notes', ['handoff'], 'a2', 'workspace');
  const out = await pending;
  expect(out).toMatchObject({ status: 'ready', entry: { key: 'module-auth', value: 'handoff notes' } });
});

it('wait with an existing value resolves immediately; since turns it into "wait for update"', async () => {
  const b = store();
  const w1 = await b.write('k', 'old', undefined, 'a', 'workspace');

  // No since → the current value satisfies the wait.
  expect(await b.wait('k', 'workspace')).toMatchObject({ status: 'ready', entry: { value: 'old' } });
  // since == current ts → strictly-newer required, so it suspends until the rewrite.
  let resolved = false;
  const pending = b.wait('k', 'workspace', undefined, w1.ts).then((r) => {
    resolved = true;
    return r;
  });
  await sleep(50);
  expect(resolved).toBe(false);
  await b.write('k', 'new', undefined, 'a', 'workspace');
  const out = await pending;
  expect(out).toMatchObject({ status: 'ready', entry: { value: 'new' } });
  // since far in the past → the current value is already newer.
  expect(await b.wait('k', 'workspace', undefined, new Date(0).toISOString())).toMatchObject({
    status: 'ready',
    entry: { value: 'new' },
  });
});

it('wait returns {status:"timeout", retry:true} at the cap; timeoutMs overrides it', async () => {
  const b = store({ waitCapMs: 300 });
  const t0 = Date.now();
  expect(await b.wait('never', 'workspace')).toEqual({ status: 'timeout', retry: true });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(280);

  const t1 = Date.now();
  expect(await b.wait('never', 'workspace', 100)).toEqual({ status: 'timeout', retry: true });
  expect(Date.now() - t1).toBeLessThan(280); // honored the override, not the 300ms cap
});

it('delete does not wake waiters (they asked for a value, not a change)', async () => {
  const b = store();
  await b.write('k', 'seed', undefined, 'a', 'workspace');
  let resolved = false;
  const pending = b.wait('k', 'workspace', undefined, (await b.read('k', undefined, 'workspace'))[0].ts).then((r) => {
    resolved = true;
    return r;
  });
  await sleep(30);
  await b.delete('k', 'a', 'workspace');
  await sleep(50);
  expect(resolved).toBe(false); // tombstone is not a value
  await b.write('k', 'reborn', undefined, 'b', 'workspace');
  expect(await pending).toMatchObject({ status: 'ready', entry: { value: 'reborn' } });
});

// ---- concurrency ----

it('concurrent writes on one scope serialize: nothing lost, queue order wins LWW', async () => {
  const cwd = home;
  const b = store({ cwd });
  const writes = Array.from({ length: 50 }, (_, i) => b.write('counter', `w-${i}`, undefined, `a${i}`, 'workspace'));
  const results = await Promise.all(writes);
  expect(results.every((r) => r.ok)).toBe(true);

  // Queue order follows call order, so the last enqueued write is the winner.
  const rows = await b.read('counter', undefined, 'workspace');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ value: 'w-49', author: 'a49' });

  // Every write hit the JSONL — no lost append under interleaving.
  const lines = (await readFile(wsBoardFile(cwd), 'utf8')).trim().split('\n');
  expect(lines).toHaveLength(50);

  // Distinct keys in parallel: all 50 land.
  await Promise.all(Array.from({ length: 50 }, (_, i) => b.write(`bulk-${i}`, 'v', undefined, 'a', 'workspace')));
  expect(await b.list('workspace')).toHaveLength(51);
});

// ---- task scope + archive ----

it('task scope archives as board.jsonl at moa_complete and wakes waiters with closed', async () => {
  const logsDir = join(home, 'logs');
  const board = store();
  const hub = new DebateHub({ logsDir, board });
  hub.init('board-arc', { agents: ['a', 'b'], debate: { rounds: 1 } });

  await board.write('note', 'v1', ['x'], 'a', 'task:board-arc');
  await board.write('note', 'v2', ['x'], 'b', 'task:board-arc');
  await board.delete('stale', 'a', 'task:board-arc');

  // A waiter parked on the task board is closed out by the archive.
  const waiting = board.wait('never-comes', 'task:board-arc');

  const done = await hub.complete('board-arc');
  expect(done.ok).toBe(true);
  expect(await waiting).toEqual({ status: 'closed' });

  const records = (await readFile(join(logsDir, 'board-arc', 'board.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  expect(records).toHaveLength(3);
  expect(records[0]).toMatchObject({ op: 'write', scope: 'task:board-arc', key: 'note', value: 'v1', author: 'a' });
  expect(records[1]).toMatchObject({ op: 'write', key: 'note', value: 'v2' });
  expect(records[2]).toMatchObject({ op: 'delete', key: 'stale' });
  // The original three layers are untouched.
  const result = JSON.parse(await readFile(join(logsDir, 'board-arc', 'result.json'), 'utf8'));
  expect(result).toMatchObject({ task_id: 'board-arc' });

  // The in-memory task scope is dropped after archival.
  expect(await board.list('task:board-arc')).toEqual([]);
});

it('a task that never used the board still gets an (empty) board.jsonl layer', async () => {
  const logsDir = join(home, 'logs');
  const hub = new DebateHub({ logsDir, board: store() });
  hub.init('board-empty', { agents: ['a'], debate: { rounds: 1 } });
  await hub.complete('board-empty');
  expect(await readFile(join(logsDir, 'board-empty', 'board.jsonl'), 'utf8')).toBe('');
});

// ---- MCP tool surface ----

it('the five moa_board_* tools work end-to-end over MCP, default scope workspace', async () => {
  const cwd = join(home, 'mcp-ws');
  const logsDir = join(home, 'logs');
  const board = new BoardStore({ homeDir: home, workspaceCwd: cwd, waitCapMs: 400 });
  const hub = new DebateHub({ logsDir, board });
  const server = createServer(hub, undefined, board);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'board-test', version: '0.0.1' });
  await client.connect(clientTransport);

  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    const res = await client.callTool({ name, arguments: args });
    return JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
  }

  try {
    // write (no scope → workspace) + read + list
    expect(await call('moa_board_write', { key: 'api-contract', value: '# API\ngrpc', tags: ['contract'], author: 'agent-1' }))
      .toMatchObject({ ok: true });
    const rows = await call('moa_board_read', { key: 'api-contract' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'api-contract', value: '# API\ngrpc', author: 'agent-1', tags: ['contract'] });
    expect(await call('moa_board_list', {})).toEqual([
      expect.objectContaining({ key: 'api-contract', bytes: 10 }), // '# API\ngrpc'
    ]);

    // wait: suspend, then a concurrent write wakes it.
    let woke = false;
    const pending = call('moa_board_wait', { key: 'handoff-done', timeoutMs: 2000 }).then((r) => {
      woke = true;
      return r;
    });
    await sleep(50);
    expect(woke).toBe(false);
    await call('moa_board_write', { key: 'handoff-done', value: 'auth module shipped', author: 'agent-2' });
    expect(await pending).toMatchObject({ status: 'ready', entry: { value: 'auth module shipped' } });

    // delete hides the key; workspace persistence landed on disk.
    expect(await call('moa_board_delete', { key: 'api-contract', author: 'agent-1' })).toMatchObject({ ok: true });
    expect(await call('moa_board_read', { key: 'api-contract' })).toEqual([]);
    const files = await readdir(join(home, 'boards'));
    expect(files.some((f) => f.startsWith('ws-') && f.endsWith('.jsonl'))).toBe(true);
    expect(files.some((f) => f.endsWith('.meta.json'))).toBe(true);

    // task scope via MCP + archival through moa_complete.
    await call('moa_init', { task_id: 'mcp-task', preset_config: { agents: ['a'], debate: { rounds: 1 } } });
    await call('moa_board_write', { key: 'round-1-note', value: 'watch the retry path', scope: 'task:mcp-task', author: 'a' });
    const done = await call('moa_complete', { task_id: 'mcp-task' });
    expect(done.ok).toBe(true);
    const boardLog = (await readFile(join(logsDir, 'mcp-task', 'board.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(boardLog).toHaveLength(1);
    expect(boardLog[0]).toMatchObject({ op: 'write', key: 'round-1-note', scope: 'task:mcp-task' });

    // errors surface as MCP errors.
    await expect(call('moa_board_write', { key: 'k', value: 'v', scope: 'nope' })).rejects.toThrow(/invalid scope/);
    await expect(call('moa_board_write', { key: 'k', value: 'a'.repeat(BOARD_VALUE_MAX_BYTES + 1) })).rejects.toThrow(/value too large/);
    await expect(call('moa_board_wait', { key: 'k', since: 'not-a-date' })).rejects.toThrow(/invalid since/);
  } finally {
    await client.close();
  }
});

it('isolates explicit workspace paths and registers an empty workspace on read/list', async () => {
  const cwdA = join(home, 'project-a');
  const cwdB = join(home, 'project-b');
  const emptyCwd = join(home, 'project-empty');
  const b = store({ cwd: cwdA });

  await b.write('same-key', 'project A', undefined, 'a', 'workspace', cwdA);
  await b.write('same-key', 'project B', undefined, 'b', 'workspace', cwdB);
  expect((await b.read('same-key', undefined, 'workspace', undefined, cwdA))[0].value).toBe('project A');
  expect((await b.read('same-key', undefined, 'workspace', undefined, cwdB))[0].value).toBe('project B');

  expect(await b.read('missing', undefined, 'workspace', undefined, emptyCwd)).toEqual([]);
  expect(await b.list('workspace', emptyCwd)).toEqual([]);
  const files = await readdir(join(home, 'boards'));
  const emptyId = createHash('sha1').update(emptyCwd).digest('hex').slice(0, 16);
  expect(files).toContain(`ws-${emptyId}.meta.json`);
});

it('scans workspace sidecars, skips corrupt and mismatched metadata, and resolves ids', async () => {
  const cwdA = join(home, 'scan-a');
  const cwdB = join(home, 'scan-b');
  const b = store();
  const a = await b.registerWorkspace(cwdA);
  const other = await b.registerWorkspace(cwdB);
  const invalidId = '0'.repeat(16);
  const badCwdId = 'f'.repeat(16);

  await writeFile(join(home, 'boards', `ws-${invalidId}.meta.json`), '{not json');
  await writeFile(
    join(home, 'boards', `ws-${badCwdId}.meta.json`),
    JSON.stringify({ id: badCwdId, cwd: 'relative/project' }),
  );
  // The filename hashes cwdA, but the embedded id is for cwdB.
  await writeFile(
    join(home, 'boards', `ws-${a.id}.meta.json`),
    JSON.stringify({ id: other.id, cwd: cwdA }),
  );
  // The filename hashes cwdB, but the embedded id is for cwdA.
  await writeFile(
    join(home, 'boards', `ws-${other.id}.meta.json`),
    JSON.stringify({ id: a.id, cwd: cwdB }),
  );

  expect(await b.listWorkspaces()).toEqual([]);

  const repairedA = await b.registerWorkspace(cwdA);
  const repairedB = await b.registerWorkspace(cwdB);
  expect(await b.scanWorkspaces()).toEqual([repairedA, repairedB].sort((x, y) => x.id.localeCompare(y.id)));
  const repeatedA = await b.registerWorkspace(cwdA);
  expect(repeatedA.createdAt).toBe(repairedA.createdAt);
  expect(await b.resolveWorkspace(a.id)).toBe(cwdA);
  expect(await b.resolveWorkspace(`ws-${other.id}`)).toBe(cwdB);
  expect(await b.resolveWorkspace('not-a-workspace-id')).toBeUndefined();
});

it('workspace info preserves createdAt and exposes board activity time', async () => {
  const cwd = join(home, 'workspace-info');
  const b = store();
  const first = await b.registerWorkspace(cwd);
  const repeated = await b.registerWorkspace(cwd);
  expect(repeated.createdAt).toBe(first.createdAt);
  const sidecar = JSON.parse(await readFile(join(home, 'boards', `ws-${first.id}.meta.json`), 'utf8'));
  expect(sidecar.created_at).toBe(first.createdAt);

  await b.write('activity', 'v', undefined, 'agent', 'workspace', cwd);
  const listed = (await b.listWorkspaces()).find((workspace) => workspace.id === first.id);
  expect(listed).toMatchObject({ id: first.id, cwd, createdAt: first.createdAt });
  expect(listed?.updatedAt).toEqual(expect.any(String));
});

it('two BoardStore instances refresh each other after peer appends', async () => {
  const cwd = join(home, 'shared-project');
  const first = new BoardStore({ homeDir: home, workspaceCwd: cwd });
  const second = new BoardStore({ homeDir: home, workspaceCwd: cwd });

  await first.write('from-first', 'one', undefined, 'first', 'workspace');
  expect((await second.read('from-first', undefined, 'workspace'))[0].value).toBe('one');
  await second.write('from-second', 'two', undefined, 'second', 'workspace');
  expect((await first.read('from-second', undefined, 'workspace'))[0].value).toBe('two');

  await first.close();
  await second.close();
});

it('persistent wait polls peer appends and wakes without a local event', async () => {
  const cwd = join(home, 'poll-project');
  const waiting = new BoardStore({ homeDir: home, workspaceCwd: cwd, waitCapMs: 500, pollIntervalMs: 15 });
  const writer = new BoardStore({ homeDir: home, workspaceCwd: cwd, waitCapMs: 500, pollIntervalMs: 15 });

  const pending = waiting.wait('from-peer', 'workspace', 400);
  await sleep(35);
  await writer.write('from-peer', 'external value', undefined, 'peer', 'workspace');
  expect(await pending).toMatchObject({ status: 'ready', entry: { value: 'external value', author: 'peer' } });

  await waiting.close();
  await writer.close();
});

it('keeps one poll timer per scope and cleans it on timeout and close', async () => {
  const cwd = join(home, 'timer-project');
  const b = new BoardStore({ homeDir: home, workspaceCwd: cwd, waitCapMs: 250, pollIntervalMs: 15 });
  const internals = b as unknown as {
    scopes: Map<string, { waiters: Set<unknown>; pollTimer?: unknown }>;
  };

  expect(await b.wait('times-out', 'workspace', 35)).toEqual({ status: 'timeout', retry: true });
  const state = [...internals.scopes.values()][0];
  expect(state.waiters.size).toBe(0);
  expect(state.pollTimer).toBeUndefined();

  const first = b.wait('first', 'workspace', 200);
  const second = b.wait('second', 'workspace', 200);
  await sleep(30);
  expect(state.waiters.size).toBe(2);
  const timer = state.pollTimer;
  expect(timer).toBeDefined();

  await b.write('first', 'ready', undefined, 'writer', 'workspace');
  expect(await first).toMatchObject({ status: 'ready', entry: { value: 'ready' } });
  await sleep(5);
  expect(state.pollTimer).toBe(timer); // the second waiter still owns the one timer

  await b.close();
  expect(await second).toEqual({ status: 'closed' });
  expect(state.waiters.size).toBe(0);
  expect(state.pollTimer).toBeUndefined();
});

it('mutate callback receives one commit timestamp shared by changed entries', async () => {
  const cwd = join(home, 'mutate-project');
  const b = store({ cwd });
  const commitTs = await b.mutate('workspace', (entries, ts) => {
    entries.set('alpha', { key: 'alpha', value: 'A', author: 'mutator', ts: 'ignored', tags: ['one'] });
    entries.set('beta', { key: 'beta', value: 'B', author: 'mutator', ts: 'ignored', tags: ['two'] });
    return ts;
  }, cwd);

  const alpha = (await b.read('alpha', undefined, 'workspace', undefined, cwd))[0];
  const beta = (await b.read('beta', undefined, 'workspace', undefined, cwd))[0];
  expect(commitTs).toMatch(/Z$/);
  expect(alpha.ts).toBe(commitTs);
  expect(beta.ts).toBe(commitTs);
  const records = (await readFile(wsBoardFile(cwd), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(new Set(records.map((record) => record.ts))).toEqual(new Set([commitTs]));
});
