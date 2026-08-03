/**
 * Shared-blackboard tests: BoardStore semantics (write/read/list/delete,
 * last-write-wins, tag filter, scope isolation, 32KB cap, persistence
 * round-trip, tombstones), wait long-poll (wake / since / timeout / closed),
 * per-scope write serialization under concurrency, task-scope archival via
 * moa_complete, and the five moa_board_* tools end-to-end over MCP.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BoardStore, BOARD_VALUE_MAX_BYTES, WORKSPACE_NAME_MAX_CHARS, workspaceIdForPath, type BoardEvent, type BoardScope } from '../src/core/store/board.js';
import { ProjectRegistry, newProjectId } from '../src/core/store/project-registry.js';
import { migrateWorkspaceToProject } from '../src/core/store/project-migration.js';
import { DebateHub } from '../src/modules/debate/state.js';
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

// ---- project aliasing + migration (mailbox task 2) ----

/** The project board file path for a projectId (mirrors BoardStore's naming). */
function projectBoardFile(projectId: string): string {
  return join(home, 'boards', `project-${projectId}.jsonl`);
}

it('an aliased workspace resolves to the project board: writes land in project-<id>.jsonl', async () => {
  const cwd = join(home, 'aliased-project');
  const registry = new ProjectRegistry({ homeDir: home });
  const projectId = await registry.createProject('alpha');
  await registry.addAlias(projectId, workspaceIdForPath(cwd));

  const b = new BoardStore({ homeDir: home, workspaceCwd: cwd, registry });
  await b.write('contract', 'v1', ['c'], 's1', 'workspace');
  expect((await b.read('contract', undefined, 'workspace'))[0]).toMatchObject({ key: 'contract', value: 'v1' });

  const files = await readdir(join(home, 'boards'));
  expect(files).toContain(`project-${projectId}.jsonl`);
  expect(files).toContain(`project-${projectId}.meta.json`);
  expect(files.some((f) => f.startsWith('ws-'))).toBe(false); // the unaliased file is never created

  // Records carry the canonical project scope key.
  const records = (await readFile(projectBoardFile(projectId), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ op: 'write', scope: `project:${projectId}`, key: 'contract' });

  // The sidecar lists the aliased cwd (array form, deduped).
  const meta = JSON.parse(await readFile(join(home, 'boards', `project-${projectId}.meta.json`), 'utf8'));
  expect(meta).toMatchObject({ projectId, cwds: [cwd] });
  expect(typeof meta.created_at).toBe('string');
});

it('refreshes the registry before scope resolution: first op of a fresh process lands in the project board', async () => {
  const cwd = join(home, 'stale-alias');
  // Process A (its own registry instance) creates the project and alias.
  const registryA = new ProjectRegistry({ homeDir: home });
  const projectId = await registryA.createProject();
  await registryA.addAlias(projectId, workspaceIdForPath(cwd));

  // Process B: a fresh BoardStore with its own (cold) registry projection —
  // regression for tip_21f72697 (the first write fell back to ws-<hash>.jsonl
  // while later reads resolved to project-<id>.jsonl).
  const b = new BoardStore({ homeDir: home, workspaceCwd: cwd });
  await b.write('stale/probe', 'v1', undefined, 's1', 'workspace');

  const projectRaw = await readFile(projectBoardFile(projectId), 'utf8');
  expect(projectRaw).toContain('stale/probe');
  const files = await readdir(join(home, 'boards'));
  expect(files.some((f) => f.startsWith('ws-'))).toBe(false);

  // Read path resolves identically: the fresh write is visible immediately.
  expect((await b.read('stale/probe', undefined, 'workspace'))[0]).toMatchObject({ key: 'stale/probe', value: 'v1' });
  await b.close();
});

it('project-scope events keep the workspace label and route on @board/project:<id>', async () => {
  const events: Array<{ scope: BoardScope; event: BoardEvent }> = [];
  const cwd = join(home, 'event-project');
  const registry = new ProjectRegistry({ homeDir: home });
  const projectId = await registry.createProject();
  await registry.addAlias(projectId, workspaceIdForPath(cwd));

  const b = new BoardStore({
    homeDir: home,
    workspaceCwd: cwd,
    registry,
    emit: (scope, event) => events.push({ scope, event }),
  });
  await b.write('k', 'v', undefined, 'a', 'workspace');
  expect(events).toHaveLength(1);
  expect(events[0].scope).toMatchObject({ kind: 'project', key: `project:${projectId}`, label: 'workspace', id: projectId });
  // The server routes non-task events on `@board/<scope.key>` — the synthetic channel follows the project key.
  expect(`@board/${events[0].scope.key}`).toBe(`@board/project:${projectId}`);
  expect(events[0].event).toMatchObject({ type: 'board_updated', scope: 'workspace', key: 'k' });
});

it('two aliased workspaces share one project board; the sidecar cwds dedupe', async () => {
  const cwdA = join(home, 'share-a');
  const cwdB = join(home, 'share-b');
  const registry = new ProjectRegistry({ homeDir: home });
  const projectId = await registry.createProject('shared');
  await registry.addAlias(projectId, workspaceIdForPath(cwdA));
  await registry.addAlias(projectId, workspaceIdForPath(cwdB));

  const b = new BoardStore({ homeDir: home, workspaceCwd: cwdA, registry });
  await b.write('from-a', 'A', undefined, 'a', 'workspace');
  await b.write('from-b', 'B', undefined, 'b', 'workspace', cwdB);
  // Either alias reads the same board.
  expect((await b.read('from-a', undefined, 'workspace', undefined, cwdB))[0].value).toBe('A');
  expect((await b.read('from-b', undefined, 'workspace', undefined, cwdA))[0].value).toBe('B');
  await b.write('from-a', 'A2', undefined, 'a', 'workspace'); // same cwd again: cwds stay deduped

  const jsonlFiles = (await readdir(join(home, 'boards'))).filter((f) => f.endsWith('.jsonl'));
  expect(jsonlFiles).toEqual([`project-${projectId}.jsonl`]); // one shared board, no ws-* files
  const meta = JSON.parse(await readFile(join(home, 'boards', `project-${projectId}.meta.json`), 'utf8'));
  expect([...meta.cwds].sort()).toEqual([cwdA, cwdB].sort());
});

it('unaliased workspaces are untouched by an unrelated registry entry (regression)', async () => {
  const cwdAliased = join(home, 'aliased');
  const cwdPlain = join(home, 'plain');
  const registry = new ProjectRegistry({ homeDir: home });
  const projectId = await registry.createProject();
  await registry.addAlias(projectId, workspaceIdForPath(cwdAliased));

  const b = new BoardStore({ homeDir: home, workspaceCwd: cwdPlain, registry });
  await b.write('k', 'v', undefined, 'a', 'workspace');
  const files = await readdir(join(home, 'boards'));
  expect(files).toContain(`ws-${workspaceIdForPath(cwdPlain)}.jsonl`);
  expect(files).toContain(`ws-${workspaceIdForPath(cwdPlain)}.meta.json`);
  expect(files.some((f) => f.startsWith('project-'))).toBe(false);
});

it('two BoardStore instances interleave writes on one project board with no torn lines', async () => {
  const cwdA = join(home, 'interleave-a');
  const cwdB = join(home, 'interleave-b');
  const registry = new ProjectRegistry({ homeDir: home });
  const projectId = await registry.createProject();
  await registry.addAlias(projectId, workspaceIdForPath(cwdA));
  await registry.addAlias(projectId, workspaceIdForPath(cwdB));

  const first = new BoardStore({ homeDir: home, workspaceCwd: cwdA, registry });
  const second = new BoardStore({ homeDir: home, workspaceCwd: cwdB, registry });
  const writes = Array.from({ length: 12 }, (_, i) =>
    i % 2 === 0
      ? first.write(`key-${i}`, `first-${i}`, undefined, 'first', 'workspace')
      : second.write(`key-${i}`, `second-${i}`, undefined, 'second', 'workspace'),
  );
  await Promise.all(writes);

  // Every line parses (no interleaved/torn appends) and both instances fold the same 12 keys.
  const lines = (await readFile(projectBoardFile(projectId), 'utf8')).trim().split('\n');
  expect(lines).toHaveLength(12);
  expect(lines.every((line) => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  })).toBe(true);
  expect(await first.list('workspace')).toHaveLength(12);
  expect(await second.list('workspace')).toHaveLength(12);
  expect((await first.read('key-7', undefined, 'workspace'))[0].value).toBe('second-7');
  await first.close();
  await second.close();
});

// ---- workspace → project migration ----

it('migration moves every record (tombstones included), rewrites scope, and archives the legacy files', async () => {
  const cwd = join(home, 'migrate-me');
  const hash = workspaceIdForPath(cwd);
  const b = store({ cwd });
  await b.write('keep', 'v1', ['x'], 'a', 'workspace');
  await b.write('scratch', 'tmp', undefined, 'a', 'workspace');
  await b.delete('scratch', 'a', 'workspace');
  await b.write('keep', 'v2', ['x'], 'a', 'workspace');

  const result = await migrateWorkspaceToProject(cwd, { homeDir: home, name: 'migrated' });
  expect(result.moved).toBe(4);
  expect(result.projectId).toMatch(/^p_[0-9a-f]{12}$/);
  const { projectId } = result;

  // Every record moved, order preserved, scope rewritten, tombstone intact.
  const moved = (await readFile(projectBoardFile(projectId), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  expect(moved).toHaveLength(4);
  expect(moved.every((r) => r.scope === `project:${projectId}`)).toBe(true);
  expect(moved.map((r) => r.op)).toEqual(['write', 'write', 'delete', 'write']);
  expect(moved[2]).toMatchObject({ op: 'delete', key: 'scratch' });
  expect(moved[2].value).toBeUndefined();

  // Legacy files archived (renamed, never deleted); alias registered.
  const files = await readdir(join(home, 'boards'));
  expect(files.some((f) => new RegExp(`^ws-${hash}\\.jsonl\\.migrated-\\d+$`).test(f))).toBe(true);
  expect(files.some((f) => new RegExp(`^ws-${hash}\\.meta\\.json\\.migrated-\\d+$`).test(f))).toBe(true);
  expect(files).not.toContain(`ws-${hash}.jsonl`);
  const registry = new ProjectRegistry({ homeDir: home });
  await registry.refreshIfStale();
  expect(registry.resolveCached(hash)).toBe(projectId);
  expect((await registry.listProjects())[0]).toMatchObject({ projectId, name: 'migrated', aliases: [hash] });

  // A fresh BoardStore folds the full history back through the workspace scope.
  // parseScope resolves before the fold refreshes the projection, so the first
  // op after an external alias change still sees the legacy scope (documented
  // one-op adoption lag); the second op resolves to the project board.
  const b2 = store({ cwd });
  await b2.list('workspace'); // refreshes the registry projection
  const live = await b2.read('keep', undefined, 'workspace');
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({ value: 'v2', tags: ['x'] }); // LWW over the moved history
  expect(await b2.read('scratch', undefined, 'workspace')).toEqual([]); // tombstone folded
});

it('migration is idempotent: a second run moves nothing and changes no files', async () => {
  const cwd = join(home, 'idem');
  const b = store({ cwd });
  await b.write('k', 'v', undefined, 'a', 'workspace');
  const first = await migrateWorkspaceToProject(cwd, { homeDir: home });
  const sizeBefore = (await stat(projectBoardFile(first.projectId))).size;
  const filesBefore = (await readdir(join(home, 'boards'))).sort();

  const second = await migrateWorkspaceToProject(cwd, { homeDir: home });
  expect(second).toEqual({ projectId: first.projectId, moved: 0 });
  expect((await stat(projectBoardFile(first.projectId))).size).toBe(sizeBefore);
  expect((await readdir(join(home, 'boards'))).sort()).toEqual(filesBefore);
});

it('migration rejects conflicting targets and unknown projectIds, leaving state untouched', async () => {
  const cwd = join(home, 'conflict');
  const hash = workspaceIdForPath(cwd);
  const b = store({ cwd });
  await b.write('k', 'v', undefined, 'a', 'workspace');

  const registry = new ProjectRegistry({ homeDir: home });
  const other = await registry.createProject('other');
  await registry.addAlias(other, hash);

  // Already aliased to `other`: a plain re-run is the idempotent no-op...
  await expect(migrateWorkspaceToProject(cwd, { homeDir: home })).resolves.toEqual({ projectId: other, moved: 0 });
  // ...but forcing a different target is a second-owner conflict.
  const fresh = await registry.createProject('fresh');
  await expect(migrateWorkspaceToProject(cwd, { homeDir: home, projectId: fresh })).rejects.toThrow(/already aliased/);
  // Bad/unknown targets fail fast on an UNALIASED workspace (no early return).
  const unaliased = join(home, 'conflict-unaliased');
  await expect(migrateWorkspaceToProject(unaliased, { homeDir: home, projectId: newProjectId() })).rejects.toThrow(/unknown projectId/);
  await expect(migrateWorkspaceToProject(unaliased, { homeDir: home, projectId: 'bogus' })).rejects.toThrow(/invalid projectId/);

  // The alias is still `other`'s and no project board file was created.
  await registry.refreshIfStale();
  expect(registry.resolveCached(hash)).toBe(other);
  const files = await readdir(join(home, 'boards'));
  expect(files.filter((f) => f.startsWith('project-') && f.endsWith('.jsonl'))).toEqual([]);
  // The legacy board is untouched (still migratable once `other` is out of the way).
  expect((await readFile(wsBoardFile(cwd), 'utf8')).trim().split('\n')).toHaveLength(1);
});

it('migrating a workspace with no board file aliases it with moved: 0', async () => {
  const cwd = join(home, 'empty-ws');
  const result = await migrateWorkspaceToProject(cwd, { homeDir: home });
  expect(result.moved).toBe(0);

  const b = store({ cwd });
  await b.list('workspace'); // adopt the alias (one-op lag, see above)
  await b.write('k', 'v', undefined, 'a', 'workspace');
  const files = await readdir(join(home, 'boards'));
  expect(files).toContain(`project-${result.projectId}.jsonl`);
  // No legacy board file is created (the lag op may recreate the ws meta
  // sidecar — that is the pre-existing workspace-registration behavior).
  expect(files.some((f) => f.startsWith('ws-') && f.endsWith('.jsonl'))).toBe(false);
});

// ---- workspace rename + release (mailbox task 5a/5c) ----

it('renameWorkspace writes, trims, and clears the sidecar name under the append lock', async () => {
  const cwd = join(home, 'rename-me');
  const b = store({ cwd });
  const info = await b.registerWorkspace(cwd);
  await b.write('k', 'v', undefined, 'a', 'workspace', cwd);

  // Set a name: sidecar gains `name`, cwd/created_at survive the RMW.
  const renamed = await b.renameWorkspace(info.id, '  My Space  ');
  expect(renamed).toMatchObject({ id: info.id, cwd, createdAt: info.createdAt, name: 'My Space' });
  const sidecar = JSON.parse(await readFile(join(home, 'boards', `ws-${info.id}.meta.json`), 'utf8'));
  expect(sidecar).toMatchObject({ id: info.id, cwd, created_at: info.createdAt, name: 'My Space' });
  expect((await b.listWorkspaces()).find((w) => w.id === info.id)?.name).toBe('My Space');

  // The board itself is untouched by the rename.
  expect(await b.read('k', undefined, 'workspace', undefined, cwd)).toHaveLength(1);

  // Empty (and whitespace-only) names clear the field again.
  const cleared = await b.renameWorkspace(info.id, '   ');
  expect(cleared.name).toBeUndefined();
  const clearedSidecar = JSON.parse(await readFile(join(home, 'boards', `ws-${info.id}.meta.json`), 'utf8'));
  expect(clearedSidecar).not.toHaveProperty('name');
  expect((await b.listWorkspaces()).find((w) => w.id === info.id)?.name).toBeUndefined();

  // Guards: unknown/malformed ids, non-string names, and the length cap.
  await expect(b.renameWorkspace('0'.repeat(16), 'x')).rejects.toThrow(/workspace not found/);
  await expect(b.renameWorkspace('not-an-id', 'x')).rejects.toThrow(/16-character workspace sidecar id/);
  await expect(b.renameWorkspace(info.id, 7)).rejects.toThrow(/name must be a string/);
  await expect(b.renameWorkspace(info.id, 'x'.repeat(WORKSPACE_NAME_MAX_CHARS + 1))).rejects.toThrow(/exceeds/);

  // Reopen: a fresh store sees the name (set one first).
  await b.renameWorkspace(info.id, 'Durable');
  const reopened = store({ cwd });
  expect((await reopened.listWorkspaces()).find((w) => w.id === info.id)?.name).toBe('Durable');

  // Concurrent renames from two stores serialize on the meta lock: the sidecar
  // stays valid JSON and carries exactly one of the two names.
  await Promise.all([b.renameWorkspace(info.id, 'first'), reopened.renameWorkspace(info.id, 'second')]);
  const finalSidecar = JSON.parse(await readFile(join(home, 'boards', `ws-${info.id}.meta.json`), 'utf8'));
  expect(['first', 'second']).toContain(finalSidecar.name);
  await b.close();
  await reopened.close();
});

it('releaseWorkspace archives files, drops the alias, and restarts the board empty', async () => {
  const cwd = join(home, 'release-me');
  const b = store({ cwd });
  const info = await b.registerWorkspace(cwd);
  await b.write('before/release', 'old', undefined, 'a', 'workspace', cwd);
  const projectId = await b.registry.createProject('owner');
  await b.registry.addAlias(projectId, info.id);

  const result = await b.releaseWorkspace(info.id);
  expect(result).toEqual({ ok: true, releasedAlias: true });

  // Alias is gone: the path resolves to a plain workspace scope again.
  await b.registry.refreshIfStale();
  expect(b.registry.resolveCached(info.id)).toBeUndefined();

  // Both files are archived (renamed, never deleted) with .released- stamps.
  const names = await readdir(join(home, 'boards'));
  expect(names).not.toContain(`ws-${info.id}.jsonl`);
  expect(names).not.toContain(`ws-${info.id}.meta.json`);
  expect(names.some((n) => n.startsWith(`ws-${info.id}.jsonl.released-`))).toBe(true);
  expect(names.some((n) => n.startsWith(`ws-${info.id}.meta.json.released-`))).toBe(true);
  const archived = await readFile(join(home, 'boards', names.find((n) => n.startsWith(`ws-${info.id}.jsonl.released-`)) as string), 'utf8');
  expect(archived).toContain('before/release');

  // The workspace vanished from the scan.
  expect(await b.listWorkspaces()).toEqual([]);

  // The next write to the directory starts from an empty board: a fresh
  // ws file + sidecar appear and only the new record is visible.
  await b.write('after/release', 'new', undefined, 'a', 'workspace', cwd);
  const afterNames = await readdir(join(home, 'boards'));
  expect(afterNames).toContain(`ws-${info.id}.jsonl`);
  expect(afterNames).toContain(`ws-${info.id}.meta.json`);
  const rows = await b.read(undefined, undefined, 'workspace', undefined, cwd);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ key: 'after/release', value: 'new' });
  expect((await b.listWorkspaces()).find((w) => w.id === info.id)?.name).toBeUndefined();

  // Releasing an unaliased workspace reports releasedAlias false; releasing
  // twice is a no-op the second time (nothing left to archive).
  const otherInfo = await b.registerWorkspace(join(home, 'release-unaliased'));
  expect(await b.releaseWorkspace(otherInfo.id)).toEqual({ ok: true, releasedAlias: false });
  expect(await b.releaseWorkspace(otherInfo.id)).toEqual({ ok: true, releasedAlias: false });
  await expect(b.releaseWorkspace('bad')).rejects.toThrow(/16-character workspace sidecar id/);
  await b.close();
});

it('migration records the migrated cwd in the project meta sidecar for browsing', async () => {
  const cwd = join(home, 'meta-migrate');
  const b = store({ cwd });
  await b.write('seed', 'v', undefined, 'a', 'workspace', cwd);
  const { projectId } = await migrateWorkspaceToProject(cwd, { homeDir: home, registry: b.registry });
  const meta = JSON.parse(await readFile(join(home, 'boards', `project-${projectId}.meta.json`), 'utf8'));
  expect(meta.projectId).toBe(projectId);
  expect(meta.cwds).toEqual([cwd]);

  // Idempotent re-run keeps the meta intact (repair path is a no-op).
  await migrateWorkspaceToProject(cwd, { homeDir: home, registry: b.registry, projectId });
  const metaAgain = JSON.parse(await readFile(join(home, 'boards', `project-${projectId}.meta.json`), 'utf8'));
  expect(metaAgain.cwds).toEqual([cwd]);
  await b.close();
});

// ---- project meta self-heal (legacy pre-task5 projects) ----

it('repairProjectMeta rebuilds a missing project meta from the migrated ws sidecar', async () => {
  const cwd = join(home, 'legacy-cwd');
  const hash = workspaceIdForPath(cwd);
  const registry = new ProjectRegistry({ homeDir: home });
  const projectId = await registry.createProject('legacy');
  const createdAt = (await registry.listProjects()).find((p) => p.projectId === projectId)!.createdAt;
  await registry.addAlias(projectId, hash);
  // A task-5 migration archives the live sidecar to ws-<hash>.meta.json.migrated-<ts>
  // and leaves the records in project-<id>.jsonl — but pre-task5 runs never
  // wrote the project meta, so browsing 404s until this repair.
  await mkdir(join(home, 'boards'), { recursive: true });
  await writeFile(
    join(home, 'boards', `ws-${hash}.meta.json.migrated-${Date.now()}`),
    JSON.stringify({ id: hash, cwd, created_at: new Date().toISOString() }, null, 2),
  );
  await writeFile(join(home, 'boards', `project-${projectId}.jsonl`), '');

  const b = new BoardStore({ homeDir: home, workspaceCwd: cwd, registry });
  expect(await b.repairProjectMeta(projectId)).toEqual([cwd]);
  const meta = JSON.parse(await readFile(join(home, 'boards', `project-${projectId}.meta.json`), 'utf8'));
  expect(meta).toEqual({ projectId, cwds: [cwd], created_at: createdAt });
  await b.close();
});

it('repairProjectMeta prefers live sidecars, skips invalid cwds, dedupes, and keeps collection order', async () => {
  const cwdA = join(home, 'legacy-live-a');
  const cwdB = join(home, 'legacy-migrated-b');
  const hashA = workspaceIdForPath(cwdA);
  const hashB = workspaceIdForPath(cwdB);
  const registry = new ProjectRegistry({ homeDir: home });
  const projectId = await registry.createProject();
  await registry.addAlias(projectId, hashA);
  await registry.addAlias(projectId, hashB);
  const boardsDir = join(home, 'boards');
  await mkdir(boardsDir, { recursive: true });
  // cwdA: live sidecar + an older migrated copy (deduped) + a corrupt copy (skipped).
  await writeFile(join(boardsDir, `ws-${hashA}.meta.json`), JSON.stringify({ id: hashA, cwd: cwdA, created_at: new Date().toISOString() }, null, 2));
  await writeFile(join(boardsDir, `ws-${hashA}.meta.json.migrated-1000`), JSON.stringify({ id: hashA, cwd: cwdA, created_at: new Date().toISOString() }, null, 2));
  await writeFile(join(boardsDir, `ws-${hashA}.meta.json.migrated-3000`), '{not json');
  // cwdB: a migrated copy with a relative cwd (skipped) plus a valid one.
  await writeFile(join(boardsDir, `ws-${hashB}.meta.json.migrated-2000`), JSON.stringify({ id: hashB, cwd: 'relative/project', created_at: new Date().toISOString() }, null, 2));
  await writeFile(join(boardsDir, `ws-${hashB}.meta.json.migrated-4000`), JSON.stringify({ id: hashB, cwd: cwdB, created_at: new Date().toISOString() }, null, 2));

  const b = new BoardStore({ homeDir: home, workspaceCwd: cwdA, registry });
  // listProjects returns aliases in sorted (lexicographic) order, and repair
  // collects cwds in that order; registration order is not preserved. Compute
  // the expected order from the actual sorted hashes instead of assuming
  // hashA < hashB (mkdtemp prefixes make that assumption flaky).
  const expectedCwds = [hashA, hashB].sort().map((h) => (h === hashA ? cwdA : cwdB));
  expect(await b.repairProjectMeta(projectId)).toEqual(expectedCwds);
  const meta = JSON.parse(await readFile(join(boardsDir, `project-${projectId}.meta.json`), 'utf8'));
  expect(meta.cwds).toEqual(expectedCwds);
  await b.close();
});

it('repairProjectMeta returns [] and writes nothing when no sidecar is recoverable', async () => {
  const cwd = join(home, 'no-sidecar');
  const hash = workspaceIdForPath(cwd);
  const registry = new ProjectRegistry({ homeDir: home });
  const projectId = await registry.createProject();
  await registry.addAlias(projectId, hash);
  const b = new BoardStore({ homeDir: home, workspaceCwd: cwd, registry });
  expect(await b.repairProjectMeta(projectId)).toEqual([]);
  await expect(readFile(join(home, 'boards', `project-${projectId}.meta.json`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await b.close();
});

it('repairProjectMeta returns [] for an unknown projectId without creating the boards dir', async () => {
  const b = store();
  expect(await b.repairProjectMeta(`p_${'0'.repeat(12)}`)).toEqual([]);
  expect(await b.repairProjectMeta('not-a-project-id')).toEqual([]);
  await expect(readdir(join(home, 'boards'))).rejects.toMatchObject({ code: 'ENOENT' });
  await b.close();
});

it('concurrent repairProjectMeta from two instances never tears the meta (append lock)', async () => {
  const cwd = join(home, 'concurrent-legacy');
  const hash = workspaceIdForPath(cwd);
  const registry = new ProjectRegistry({ homeDir: home });
  const projectId = await registry.createProject();
  await registry.addAlias(projectId, hash);
  await mkdir(join(home, 'boards'), { recursive: true });
  await writeFile(
    join(home, 'boards', `ws-${hash}.meta.json.migrated-${Date.now()}`),
    JSON.stringify({ id: hash, cwd, created_at: new Date().toISOString() }, null, 2),
  );

  // Separate registries per instance: each folds registry.jsonl on demand.
  const first = new BoardStore({ homeDir: home, workspaceCwd: cwd });
  const second = new BoardStore({ homeDir: home, workspaceCwd: cwd });
  const [cwds1, cwds2] = await Promise.all([
    first.repairProjectMeta(projectId),
    second.repairProjectMeta(projectId),
  ]);
  expect(cwds1).toEqual([cwd]);
  expect(cwds2).toEqual([cwd]);
  const meta = JSON.parse(await readFile(join(home, 'boards', `project-${projectId}.meta.json`), 'utf8'));
  expect(meta).toMatchObject({ projectId, cwds: [cwd] });
  expect(typeof meta.created_at).toBe('string');
  await first.close();
  await second.close();
});
