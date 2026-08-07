/**
 * Directed handoffs (mailbox task 3): HandoffStore over BoardStore plus the
 * moa_handoff_* MCP surface. Covers the send → inbox → read → consume →
 * archive chain, the pending-only state machine, cross-workspace delivery
 * (two BoardStore instances sharing one home, like two sessions), user-global
 * targeting, outbox scans, state filtering, reopen persistence, concurrency,
 * the minimal direct `project:<id>` BoardStore scope, and handoff v2
 * (0.12.0): toAgent/fromAgent addressing, agent:<toAgent> tags, inbox agent
 * filtering, shape validation, and v1 compatibility.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BoardStore, workspaceIdForPath } from '../src/core/store/board.js';
import {
  HandoffCorruptError,
  HandoffNotFoundError,
  HandoffStateError,
  HandoffStore,
  HandoffValidationError,
} from '../src/modules/handoff/handoff.js';
import { createServer } from '../src/server.js';

let home: string;
let wsA: string;
let wsB: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'moamcp-handoff-'));
  wsA = await mkdtemp(join(home, 'project-a-'));
  wsB = await mkdtemp(join(home, 'project-b-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function makeBoard(workspaceCwd: string = wsA): BoardStore {
  return new BoardStore({ homeDir: home, workspaceCwd, waitCapMs: 200, pollIntervalMs: 15 });
}

function stores() {
  const board = makeBoard();
  return { board, handoffs: new HandoffStore(board) };
}

/** Register a project and alias the workspace path to it (task 2 plumbing). */
async function aliasProject(board: BoardStore, workspace: string, name?: string): Promise<string> {
  const projectId = await board.registry.createProject(name);
  await board.registry.addAlias(projectId, workspaceIdForPath(workspace));
  return projectId;
}

const projectFile = (projectId: string) => join(home, 'boards', `project-${projectId}.jsonl`);

async function jsonlLines(file: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(file, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function mcpClient(board: BoardStore) {
  const server = createServer(undefined, undefined, board);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'handoff-test', version: '0.0.1' });
  await client.connect(clientTransport);
  return { client, close: () => client.close() };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  return JSON.parse((response.content as Array<{ type: string; text: string }>)[0].text);
}

// ---- storage shape ----

it('send writes the documented JSON schema into the target project board, sender scope untouched', async () => {
  const { board, handoffs } = stores();
  const projB = await aliasProject(board, wsB, 'project-b');

  const handoff = await handoffs.send(
    { toProject: projB, title: 'Fix the parser', summary: 'Left recursion breaks LL(k).', context: 'See notes/parser.md', author: 'agent-a' },
    wsA,
  );

  expect(handoff.id).toMatch(/^ho_[0-9a-f]{12}$/);
  expect(handoff).toMatchObject({
    v: 1,
    title: 'Fix the parser',
    summary: 'Left recursion breaks LL(k).',
    context: 'See notes/parser.md',
    fromProject: `ws:${workspaceIdForPath(wsA)}`,
    toProject: projB,
    state: 'pending',
    consumedAt: null,
    author: 'agent-a',
  });
  expect(handoff.createdAt).toBe(handoff.updatedAt);

  // Landed under handoff/<id> in the TARGET project's board file, with the
  // documented field order and namespaced board tags.
  const rows = await board.read(`handoff/${handoff.id}`, undefined, `project:${projB}`, 1);
  expect(rows).toHaveLength(1);
  expect(rows[0].tags).toEqual(['handoff', 'handoff:state:pending']);
  const lines = await jsonlLines(projectFile(projB));
  const write = lines.find((record) => record.op === 'write')!;
  expect(write.scope).toBe(`project:${projB}`);
  expect(write.key).toBe(`handoff/${handoff.id}`);
  expect(Object.keys(JSON.parse(write.value as string))).toEqual([
    'v', 'id', 'title', 'summary', 'context', 'fromProject', 'toProject',
    'state', 'createdAt', 'updatedAt', 'consumedAt', 'author',
  ]);

  // Nothing was written to the sender's own workspace board.
  expect(await board.list('workspace', wsA)).toEqual([]);
});

it('full chain: send → target inbox → read → consume, and archive on a sibling', async () => {
  const { board, handoffs } = stores();
  const projB = await aliasProject(board, wsB, 'project-b');

  const h1 = await handoffs.send({ toProject: projB, title: 'One', summary: 's1', context: 'ctx-1', author: 'agent-a' }, wsA);
  const h2 = await handoffs.send({ toProject: projB, title: 'Two', summary: 's2' }, wsA);

  // Inbox (through the recipient workspace path): summaries without context.
  const inbox = await handoffs.inbox(wsB);
  expect(inbox.map((row) => row.id).sort()).toEqual([h1.id, h2.id].sort());
  for (const row of inbox) expect(row).not.toHaveProperty('context');

  // Read returns the full entry, context included.
  const full = await handoffs.read(h1.id, wsB);
  expect(full).toMatchObject({ id: h1.id, context: 'ctx-1', state: 'pending' });

  // Consume: terminal state, consumedAt recorded, actor on the board entry.
  const before = full!.updatedAt;
  const consumed = await handoffs.consume(h1.id, wsB, 'agent-b');
  expect(consumed).toMatchObject({ id: h1.id, state: 'consumed', author: 'agent-a' });
  expect(consumed.consumedAt).toEqual(expect.any(String));
  expect(Date.parse(consumed.updatedAt)).toBeGreaterThan(Date.parse(before));
  const boardRow = (await board.read(`handoff/${h1.id}`, undefined, `project:${projB}`, 1))[0];
  expect(boardRow.author).toBe('agent-b');
  expect(boardRow.tags).toEqual(['handoff', 'handoff:state:consumed']);

  // Archive the sibling (also terminal, content preserved).
  const archived = await handoffs.archive(h2.id, wsB, 'agent-b');
  expect(archived).toMatchObject({ id: h2.id, state: 'archived', consumedAt: null });
  expect((await handoffs.read(h2.id, wsB))!.summary).toBe('s2');
});

it('state machine: only pending → consumed | archived is legal; unknown ids are not found', async () => {
  const { board, handoffs } = stores();
  const projB = await aliasProject(board, wsB);
  const a = await handoffs.send({ toProject: projB, title: 'A', summary: 'a' }, wsA);
  const b = await handoffs.send({ toProject: projB, title: 'B', summary: 'b' }, wsA);

  await handoffs.consume(a.id, wsB);
  await expect(handoffs.consume(a.id, wsB)).rejects.toBeInstanceOf(HandoffStateError);
  await expect(handoffs.consume(a.id, wsB)).rejects.toThrow(/consumed → consumed/);
  await expect(handoffs.archive(a.id, wsB)).rejects.toThrow(/consumed → archived/);

  await handoffs.archive(b.id, wsB);
  await expect(handoffs.consume(b.id, wsB)).rejects.toThrow(/archived → consumed/);
  await expect(handoffs.archive(b.id, wsB)).rejects.toThrow(/archived → archived/);

  await expect(handoffs.consume('ho_deadbeef0000', wsB)).rejects.toBeInstanceOf(HandoffNotFoundError);
  await expect(handoffs.archive('ho_deadbeef0000', wsB)).rejects.toBeInstanceOf(HandoffNotFoundError);
});

it('cross-workspace end-to-end: two BoardStore instances (two sessions) exchange handoffs', async () => {
  const boardA = makeBoard(wsA);
  const boardB = makeBoard(wsB);
  const handoffsA = new HandoffStore(boardA);
  const handoffsB = new HandoffStore(boardB);
  const projA = await aliasProject(boardA, wsA, 'alpha');
  const projB = await aliasProject(boardA, wsB, 'beta');

  const aToB = await handoffsA.send({ toProject: projB, title: 'From A', summary: 'for B', author: 'session-a' }, wsA);
  const bToA = await handoffsB.send({ toProject: projA, title: 'From B', summary: 'for A', author: 'session-b' }, wsB);

  // Each session sees exactly its own inbox (file-size invalidation picks up
  // the peer's append across instances).
  const inboxB = await handoffsB.inbox(wsB);
  const inboxA = await handoffsA.inbox(wsA);
  expect(inboxB.map((row) => row.id)).toEqual([aToB.id]);
  expect(inboxB[0]).toMatchObject({ fromProject: projA, toProject: projB });
  expect(inboxA.map((row) => row.id)).toEqual([bToA.id]);
  expect(inboxA[0]).toMatchObject({ fromProject: projB, toProject: projA });

  // Consume across instances: B consumes A's handoff; A's outbox sees it.
  const consumed = await handoffsB.consume(aToB.id, wsB, 'session-b');
  expect(consumed.state).toBe('consumed');
  const outboxA = await handoffsA.outbox(wsA);
  expect(outboxA.map((row) => row.id)).toEqual([aToB.id]);
  expect(outboxA[0].state).toBe('consumed');
  // B's outbox lists its own send (bToA), and nothing from A.
  const outboxB = await handoffsB.outbox(wsB);
  expect(outboxB.map((row) => row.id)).toEqual([bToA.id]);

  await boardA.close();
  await boardB.close();
});

it('reopen: handoffs survive BoardStore close/reopen with states intact', async () => {
  const first = stores();
  const projB = await aliasProject(first.board, wsB);
  const h1 = await first.handoffs.send({ toProject: projB, title: 'Durable', summary: 'one', context: 'ctx' }, wsA);
  const h2 = await first.handoffs.send({ toProject: projB, title: 'Durable', summary: 'two' }, wsA);
  await first.handoffs.consume(h1.id, wsB);
  await first.board.close();

  const second = makeBoard();
  const handoffs2 = new HandoffStore(second);
  const inbox = await handoffs2.inbox(wsB);
  expect(inbox.map((row) => row.id).sort()).toEqual([h1.id, h2.id].sort());
  const reread = await handoffs2.read(h1.id, wsB);
  expect(reread).toMatchObject({ state: 'consumed', context: 'ctx' });
  expect(reread!.consumedAt).toEqual(expect.any(String));

  // Mutations after reopen persist as well (third open verifies).
  await handoffs2.archive(h2.id, wsB);
  await second.close();

  const third = new HandoffStore(makeBoard());
  const states = new Map((await third.inbox(wsB, { state: ['consumed', 'archived'] })).map((row) => [row.id, row.state]));
  expect(states.get(h1.id)).toBe('consumed');
  expect(states.get(h2.id)).toBe('archived');
});

it('user-global target lands in the global board handoff namespace', async () => {
  const { board, handoffs } = stores();
  const handoff = await handoffs.send(
    { toProject: 'user-global', title: 'Broadcast', summary: 'for any project', author: 'agent-a' },
    wsA,
  );
  expect(handoff.toProject).toBe('user-global');
  expect(handoff.fromProject).toBe(`ws:${workspaceIdForPath(wsA)}`);

  // Visible through the user-global inbox, invisible to workspace inboxes.
  const globalInbox = await handoffs.inbox('user-global');
  expect(globalInbox.map((row) => row.id)).toEqual([handoff.id]);
  expect(await handoffs.inbox(wsA)).toEqual([]);
  expect(await handoffs.inbox(wsB)).toEqual([]);

  // Stored in global.jsonl under the handoff/ namespace.
  const rows = await board.read(`handoff/${handoff.id}`, undefined, 'global', 1);
  expect(rows).toHaveLength(1);

  // Read/consume work through the user-global designator too.
  expect((await handoffs.read(handoff.id, 'user-global'))!.title).toBe('Broadcast');
  expect((await handoffs.consume(handoff.id, 'user-global')).state).toBe('consumed');
});

it('outbox lists handoffs sent from a workspace across every target scope', async () => {
  const { board, handoffs } = stores();
  const projA = await aliasProject(board, wsA, 'alpha');
  const projB = await aliasProject(board, wsB, 'beta');

  const toB = await handoffs.send({ toProject: projB, title: 't1', summary: 's1' }, wsA);
  const toSelf = await handoffs.send({ toProject: projA, title: 't2', summary: 's2' }, wsA);
  const toGlobal = await handoffs.send({ toProject: 'user-global', title: 't3', summary: 's3' }, wsA);
  const byOther = await handoffs.send({ toProject: projB, title: 't4', summary: 's4' }, wsB); // from B, not A

  const outbox = await handoffs.outbox(wsA);
  expect(new Set(outbox.map((row) => row.id))).toEqual(new Set([toB.id, toSelf.id, toGlobal.id]));
  expect(outbox.find((row) => row.id === toB.id)!.toProject).toBe(projB);
  expect(outbox.find((row) => row.id === toSelf.id)!.toProject).toBe(projA);
  expect(outbox.find((row) => row.id === toGlobal.id)!.toProject).toBe('user-global');
  expect(outbox.map((row) => row.id)).not.toContain(byOther.id);

  // State visibility mirrors inbox: archived hidden by default, filterable in.
  await handoffs.consume(toB.id, projB);
  await handoffs.archive(toSelf.id, projA);
  const defaultOutbox = await handoffs.outbox(wsA);
  expect(new Set(defaultOutbox.map((row) => row.id))).toEqual(new Set([toB.id, toGlobal.id]));
  const archived = await handoffs.outbox(wsA, { state: 'archived' });
  expect(archived.map((row) => row.id)).toEqual([toSelf.id]);
});

it('outbox keeps entries sent before the workspace was aliased (ws:<hash> identity)', async () => {
  const { board, handoffs } = stores();
  const projB = await aliasProject(board, wsB);

  // Sent while wsA is unaliased: fromProject = ws:<hash>.
  const early = await handoffs.send({ toProject: projB, title: 'early', summary: 'pre-alias' }, wsA);
  expect(early.fromProject).toBe(`ws:${workspaceIdForPath(wsA)}`);

  // Aliasing wsA afterwards must not orphan the earlier outbox entries.
  const projA = await aliasProject(board, wsA, 'alpha');
  const late = await handoffs.send({ toProject: projB, title: 'late', summary: 'post-alias' }, wsA);
  expect(late.fromProject).toBe(projA);

  const outbox = await handoffs.outbox(wsA);
  expect(new Set(outbox.map((row) => row.id))).toEqual(new Set([early.id, late.id]));
});

it('inbox state filter: defaults hide archived; explicit states (single or array) select exactly', async () => {
  const { board, handoffs } = stores();
  const projB = await aliasProject(board, wsB);
  const pending = await handoffs.send({ toProject: projB, title: 'p', summary: 'stays pending' }, wsA);
  const consumed = await handoffs.send({ toProject: projB, title: 'c', summary: 'gets consumed' }, wsA);
  const archived = await handoffs.send({ toProject: projB, title: 'a', summary: 'gets archived' }, wsA);
  await handoffs.consume(consumed.id, wsB);
  await handoffs.archive(archived.id, wsB);

  expect(new Set((await handoffs.inbox(wsB)).map((row) => row.id))).toEqual(new Set([pending.id, consumed.id]));
  expect((await handoffs.inbox(wsB, { state: 'pending' })).map((row) => row.id)).toEqual([pending.id]);
  expect((await handoffs.inbox(wsB, { state: 'consumed' })).map((row) => row.id)).toEqual([consumed.id]);
  expect((await handoffs.inbox(wsB, { state: 'archived' })).map((row) => row.id)).toEqual([archived.id]);
  expect(new Set((await handoffs.inbox(wsB, { state: ['pending', 'consumed'] })).map((row) => row.id)))
    .toEqual(new Set([pending.id, consumed.id]));
  expect((await handoffs.inbox(wsB, { limit: 1 })).length).toBe(1);

  // read is state-agnostic: archived rows remain readable.
  expect((await handoffs.read(archived.id, wsB))!.state).toBe('archived');
});

it('send validation: toProject shape, required fields, immutable fields, workspace rule', async () => {
  const { handoffs } = stores();
  await expect(handoffs.send({ toProject: 'nope', title: 't', summary: 's' }, wsA)).rejects.toBeInstanceOf(HandoffValidationError);
  await expect(handoffs.send({ toProject: `ws:${workspaceIdForPath(wsB)}`, title: 't', summary: 's' }, wsA)).rejects.toThrow(/toProject/);
  await expect(handoffs.send({ toProject: 'user-global', title: '', summary: 's' }, wsA)).rejects.toThrow(/title/);
  await expect(handoffs.send({ toProject: 'user-global', title: 't', summary: 's' }, 'relative/path')).rejects.toThrow(/absolute/);
  await expect(
    handoffs.send({ toProject: 'user-global', title: 't', summary: 's', state: 'consumed' } as never, wsA),
  ).rejects.toThrow(/state cannot be supplied/);
  await expect(
    handoffs.send({ toProject: 'user-global', title: 't', summary: 's', fromProject: 'p_000000000000' } as never, wsA),
  ).rejects.toThrow(/fromProject cannot be supplied/);

  // Oversized payload fails closed on the handoff value cap (96KB, measured on
  // the JSON-encoded entry; pure-ASCII payload keeps byte counts exact): a
  // 97KB summary fits comfortably, a 98305-byte one is over the cap.
  await expect(
    handoffs.send({ toProject: 'user-global', title: 't', summary: 'z'.repeat(97000) }, wsA),
  ).resolves.toMatchObject({ state: 'pending' });
  await expect(
    handoffs.send({ toProject: 'user-global', title: 't', summary: 'z'.repeat(98305) }, wsA),
  ).rejects.toThrow(/98304/);

  // Unknown ids read as undefined (null over MCP), not an error.
  expect(await handoffs.read('ho_deadbeef0000', 'user-global')).toBeUndefined();
});

it('concurrent senders from two instances never tear lines or lose entries', async () => {
  const boardA = makeBoard(wsA);
  const boardB = makeBoard(wsB);
  const handoffsA = new HandoffStore(boardA);
  const handoffsB = new HandoffStore(boardB);
  const projB = await aliasProject(boardA, wsB);

  await Promise.all([
    ...[0, 1, 2].map((i) => handoffsA.send({ toProject: projB, title: `a${i}`, summary: 'from A' }, wsA)),
    ...[0, 1, 2].map((i) => handoffsB.send({ toProject: projB, title: `b${i}`, summary: 'from B' }, wsB)),
  ]);

  // Every line of the shared project file is a well-formed record.
  for (const line of await jsonlLines(projectFile(projB))) {
    expect(line.op).toBe('write');
    expect(typeof line.value).toBe('string');
  }
  const fresh = new HandoffStore(makeBoard());
  expect(await fresh.inbox(wsB)).toHaveLength(6);
  await boardA.close();
  await boardB.close();
});

it('corrupt handoff payloads fail closed with HandoffCorruptError', async () => {
  const { board, handoffs } = stores();
  const projB = await aliasProject(board, wsB);
  await board.write('handoff/ho_deadbeef0001', '{not json', [], 'vandal', `project:${projB}`);
  await expect(handoffs.inbox(wsB)).rejects.toBeInstanceOf(HandoffCorruptError);
  await expect(handoffs.read('ho_deadbeef0001', wsB)).rejects.toThrow(/corrupt handoff/);
});

// ---- handoff v2: agent-level addressing (0.12.0) ----

it('v2 send: toAgent/fromAgent round-trip, agent:<toAgent> tag, v2 field order', async () => {
  const { board, handoffs } = stores();
  const projB = await aliasProject(board, wsB, 'project-b');
  const toAgent = 'claude-code:session-b:sub-1';
  const fromAgent = 'kimi:session-a:arch-1';

  const handoff = await handoffs.send(
    { toProject: projB, title: 'V2', summary: 'agent addressed', context: 'ctx', toAgent, fromAgent, author: 'agent-a' },
    wsA,
  );

  expect(handoff).toMatchObject({ v: 2, toAgent, fromAgent, toProject: projB, state: 'pending', context: 'ctx' });

  // The entry carries the agent delivery tag alongside the base handoff tags.
  const rows = await board.read(`handoff/${handoff.id}`, undefined, `project:${projB}`, 1);
  expect(rows[0].tags).toEqual(['handoff', 'handoff:state:pending', `agent:${toAgent}`]);

  // On-disk field order: the two v2 address keys slot in after toProject.
  const lines = await jsonlLines(projectFile(projB));
  const write = lines.find((record) => record.op === 'write')!;
  expect(Object.keys(JSON.parse(write.value as string))).toEqual([
    'v', 'id', 'title', 'summary', 'context', 'fromProject', 'toProject',
    'fromAgent', 'toAgent', 'state', 'createdAt', 'updatedAt', 'consumedAt', 'author',
  ]);

  // read and consume round-trips preserve the agent fields.
  expect(await handoffs.read(handoff.id, wsB)).toMatchObject({ v: 2, toAgent, fromAgent });
  const consumed = await handoffs.consume(handoff.id, wsB, 'agent-b');
  expect(consumed).toMatchObject({ v: 2, toAgent, fromAgent, state: 'consumed' });
});

it('v2 inbox: agent filter is an exact toAgent match; v1 entries never match', async () => {
  const { handoffs } = stores();
  const projB = await aliasProject(handoffs.board, wsB, 'project-b');
  const a1 = 'claude-code:sess-b:sub-1';
  const a2 = 'claude-code:sess-b:sub-2';
  const fromAgent = 'kimi:sess-a:main';

  const for1 = await handoffs.send({ toProject: projB, title: 'for 1', summary: 's', toAgent: a1, fromAgent }, wsA);
  const for2 = await handoffs.send({ toProject: projB, title: 'for 2', summary: 's', toAgent: a2, fromAgent }, wsA);
  const unaddressed = await handoffs.send({ toProject: projB, title: 'v1', summary: 's' }, wsA); // v1, no toAgent

  expect((await handoffs.inbox(wsB, { agent: a1 })).map((row) => row.id)).toEqual([for1.id]);
  expect((await handoffs.inbox(wsB, { agent: a2 })).map((row) => row.id)).toEqual([for2.id]);

  // v1 entries carry no toAgent, so they never match an agent filter, yet
  // still show up in the unfiltered inbox alongside v2 rows.
  expect((await handoffs.inbox(wsB, { agent: a1 })).map((row) => row.id)).not.toContain(unaddressed.id);
  expect(new Set((await handoffs.inbox(wsB)).map((row) => row.id))).toEqual(new Set([for1.id, for2.id, unaddressed.id]));

  // Unknown/misspelled address: empty inbox, not an error (no-registry compromise).
  expect(await handoffs.inbox(wsB, { agent: 'claude-code:sess-b:nobody' })).toEqual([]);
  // Non-string agent filter is rejected.
  await expect(handoffs.inbox(wsB, { agent: 42 } as never)).rejects.toBeInstanceOf(HandoffValidationError);
});

it('v2 shape validation: malformed agent addresses are rejected with HANDOFF_INVALID', async () => {
  const { handoffs } = stores();
  const badAddresses = [
    'not-an-address',             // no colons
    'kimi:only-two',              // missing agentId segment
    ':sess:agent',                // empty label
    'KIMI:sess:agent',            // label must be [a-z0-9-]+
    'claude-code:sess:ag ent',    // whitespace in agentId
    'kimi:sess a:agent',          // whitespace in sessionId
    'kimi:sess:agent:extra',      // too many segments
  ];
  for (const bad of badAddresses) {
    await expect(handoffs.send({ toProject: 'user-global', title: 't', summary: 's', toAgent: bad }, wsA))
      .rejects.toBeInstanceOf(HandoffValidationError);
    await expect(handoffs.send({ toProject: 'user-global', title: 't', summary: 's', fromAgent: bad }, wsA))
      .rejects.toThrow(/agent address shape/);
  }
  // v1 sends (no agent fields) remain unaffected.
  const plain = await handoffs.send({ toProject: 'user-global', title: 't', summary: 's' }, wsA);
  expect(plain.v).toBe(1);
});

it('v1 compat: sending without agent fields stays v1; v2 rows read alongside v1', async () => {
  const { handoffs } = stores();
  const projB = await aliasProject(handoffs.board, wsB, 'project-b');
  const v1 = await handoffs.send({ toProject: projB, title: 'v1', summary: 's' }, wsA);
  expect(v1.v).toBe(1);
  expect(v1).not.toHaveProperty('toAgent');
  expect(v1).not.toHaveProperty('fromAgent');

  const v2 = await handoffs.send(
    { toProject: projB, title: 'v2', summary: 's', toAgent: 'claude-code:s:b', fromAgent: 'kimi:s:a' },
    wsA,
  );
  expect(v2.v).toBe(2);

  // Both decode through the same inbox, each with its own schema.
  const inbox = await handoffs.inbox(wsB);
  const byId = new Map(inbox.map((row) => [row.id, row]));
  expect(byId.get(v1.id)).toMatchObject({ v: 1 });
  expect(byId.get(v1.id)).not.toHaveProperty('toAgent');
  expect(byId.get(v2.id)).toMatchObject({ v: 2, toAgent: 'claude-code:s:b', fromAgent: 'kimi:s:a' });

  // A persisted v1 entry with no agent fields still round-trips through
  // consume/archive without gaining any v2 fields.
  const archived = await handoffs.archive(v1.id, wsB);
  expect(archived).toMatchObject({ v: 1, state: 'archived' });
  expect(archived).not.toHaveProperty('toAgent');
  expect(archived).not.toHaveProperty('fromAgent');
});

it('v2 address shape: uuid sessionId and hyphenated agentId are legal; padded/tabbed/multi-colon shapes are not', async () => {
  const { board, handoffs } = stores();
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const h = await handoffs.send(
    { toProject: 'user-global', title: 't', summary: 's', toAgent: `claude-code:${uuid}:my-agent-7`, fromAgent: 'kimi:abc-123:main' },
    wsA,
  );
  expect(h).toMatchObject({ v: 2, toAgent: `claude-code:${uuid}:my-agent-7`, fromAgent: 'kimi:abc-123:main' });
  const rows = await board.read(`handoff/${h.id}`, undefined, 'global', 1);
  expect(rows[0].tags).toEqual(['handoff', 'handoff:state:pending', `agent:claude-code:${uuid}:my-agent-7`]);

  const bad = [
    'kimi:sess:agent ',
    ' kimi:sess:agent',
    'kimi:sess:agent\t',
    'kimi:sess\t:agent',
    'kimi:a:b:c',
    'kimi::sess:agent',
    'kimi:sess::agent',
    'kimi:sess:agent:',
    ':sess:agent',
    'kimi::agent',
    'kimi:sess:',
    'kimi:only-two',
    'not-an-address',
    'KIMI:sess:agent',
  ];
  for (const b of bad) {
    await expect(handoffs.send({ toProject: 'user-global', title: 't', summary: 's', toAgent: b }, wsA))
      .rejects.toBeInstanceOf(HandoffValidationError);
  }
});

it('v2: fromAgent-only stays v2 without a delivery tag; toAgent-only carries the agent tag', async () => {
  const { board, handoffs } = stores();
  const fromOnly = await handoffs.send(
    { toProject: 'user-global', title: 't', summary: 's', fromAgent: 'kimi:s:a' },
    wsA,
  );
  expect(fromOnly.v).toBe(2);
  const fromRows = await board.read(`handoff/${fromOnly.id}`, undefined, 'global', 1);
  expect(fromRows[0].tags).toEqual(['handoff', 'handoff:state:pending']);

  const toOnly = await handoffs.send(
    { toProject: 'user-global', title: 't', summary: 's', toAgent: 'codex:s:b' },
    wsA,
  );
  expect(toOnly.v).toBe(2);
  const toRows = await board.read(`handoff/${toOnly.id}`, undefined, 'global', 1);
  expect(toRows[0].tags).toEqual(['handoff', 'handoff:state:pending', 'agent:codex:s:b']);
});

it('v2 inbox: agent filter is exact and case-sensitive; whitespace-padded addresses never match', async () => {
  const { handoffs } = stores();
  const projB = await aliasProject(handoffs.board, wsB, 'project-b');
  const toAgent = 'claude-code:Sess-B:Sub-1';
  const sent = await handoffs.send({ toProject: projB, title: 't', summary: 's', toAgent, fromAgent: 'kimi:s:a' }, wsA);
  expect((await handoffs.inbox(wsB, { agent: toAgent })).map((r) => r.id)).toEqual([sent.id]);
  expect(await handoffs.inbox(wsB, { agent: toAgent.toLowerCase() })).toEqual([]);
  expect(await handoffs.inbox(wsB, { agent: ` ${toAgent}` })).toEqual([]);
  expect(await handoffs.inbox(wsB, { agent: `${toAgent} ` })).toEqual([]);
});

// ---- BoardStore minimal extension: direct project:<id> scope ----

it('board.write accepts a direct project:<id> scope without a cwd sidecar entry', async () => {
  const board = makeBoard();
  const projB = await aliasProject(board, wsB);

  await board.write('probe', 'v', [], 'tester', `project:${projB}`);
  const lines = await jsonlLines(projectFile(projB));
  expect(lines[0]).toMatchObject({ op: 'write', scope: `project:${projB}`, key: 'probe', value: 'v' });

  // No directory was involved, so the project sidecar must not appear...
  await expect(readFile(join(home, 'boards', `project-${projB}.meta.json`), 'utf8')).rejects.toThrow();

  // ...while an aliased workspace touch afterwards still records its cwd.
  await board.write('probe2', 'v2', [], 'tester', 'workspace', wsB);
  const meta = JSON.parse(await readFile(join(home, 'boards', `project-${projB}.meta.json`), 'utf8'));
  expect(meta.cwds).toEqual([wsB]);

  await expect(board.write('x', 'v', [], 'a', 'project:not-a-project')).rejects.toThrow(/p_<12 hex chars>/);
});

// ---- MCP surface ----

it('MCP: registers the five moa_handoff_* tools (recall-free) and leaves tip/board tools untouched', async () => {
  const { board } = stores();
  const { client, close } = await mcpClient(board);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      'moa_handoff_send', 'moa_handoff_inbox', 'moa_handoff_read', 'moa_handoff_consume', 'moa_handoff_archive',
    ]) {
      expect(names).toContain(expected);
    }
    // Regression: the pre-existing tool surface is intact.
    for (const expected of [
      'moa_tip_create', 'moa_tip_read', 'moa_tip_list', 'moa_tip_update', 'moa_tip_archive',
      'moa_board_write', 'moa_board_read', 'moa_board_list', 'moa_board_wait', 'moa_board_delete',
      'moa_status',
    ]) {
      expect(names).toContain(expected);
    }
    for (const tool of tools.filter((entry) => entry.name.startsWith('moa_handoff_'))) {
      expect(tool.description.toLowerCase()).toContain('recall');
      expect((tool.inputSchema as any).properties.workspace).toBeDefined();
      expect((tool.inputSchema as any).required).toContain('workspace');
    }
  } finally {
    await close();
  }
});

it('MCP end-to-end: send → inbox → read → consume → archive across workspaces, illegal transition errors', async () => {
  const { board } = stores();
  const projB = await aliasProject(board, wsB, 'project-b');
  const { client, close } = await mcpClient(board);
  try {
    const sent = await call(client, 'moa_handoff_send', {
      workspace: wsA,
      toProject: projB,
      title: 'Ship it',
      summary: 'Everything is green.',
      context: 'Ran the suite twice.',
      author: 'session-a',
    });
    expect(sent).toMatchObject({ toProject: projB, state: 'pending', fromProject: `ws:${workspaceIdForPath(wsA)}` });

    const inbox = await call(client, 'moa_handoff_inbox', { workspace: wsB });
    expect(inbox.map((row: any) => row.id)).toEqual([sent.id]);

    const full = await call(client, 'moa_handoff_read', { workspace: wsB, id: sent.id });
    expect(full).toMatchObject({ id: sent.id, context: 'Ran the suite twice.' });

    const consumed = await call(client, 'moa_handoff_consume', { workspace: wsB, id: sent.id, actor: 'session-b' });
    expect(consumed).toMatchObject({ state: 'consumed' });

    await expect(call(client, 'moa_handoff_consume', { workspace: wsB, id: sent.id }))
      .rejects.toThrow(/illegal handoff state transition/);

    // Archive path on a fresh handoff; unknown ids read as null over MCP.
    const second = await call(client, 'moa_handoff_send', { workspace: wsA, toProject: projB, title: 'Later', summary: 'Not needed.' });
    const archived = await call(client, 'moa_handoff_archive', { workspace: wsB, id: second.id });
    expect(archived).toMatchObject({ state: 'archived' });
    expect(await call(client, 'moa_handoff_read', { workspace: wsB, id: 'ho_deadbeef0000' })).toBeNull();

    // Default inbox now shows only the consumed row (archived hidden).
    const after = await call(client, 'moa_handoff_inbox', { workspace: wsB });
    expect(after.map((row: any) => row.id)).toEqual([sent.id]);

    // Tool-level validation surfaces as MCP errors too.
    await expect(call(client, 'moa_handoff_send', { workspace: wsA, toProject: 'bogus', title: 't', summary: 's' }))
      .rejects.toThrow(/toProject/);
  } finally {
    await close();
  }
});

it('MCP v2: send with toAgent/fromAgent and inbox agent filtering work over the tool surface', async () => {
  const { board } = stores();
  const projB = await aliasProject(board, wsB, 'project-b');
  const { client, close } = await mcpClient(board);
  try {
    const toAgent = 'claude-code:sess-b:sub-9';
    const fromAgent = 'kimi:sess-a:main';
    const sent = await call(client, 'moa_handoff_send', {
      workspace: wsA,
      toProject: projB,
      title: 'V2 over MCP',
      summary: 's',
      toAgent,
      fromAgent,
    });
    expect(sent).toMatchObject({ v: 2, toAgent, fromAgent });

    // Self-reported address filter returns exactly the addressed rows.
    const filtered = await call(client, 'moa_handoff_inbox', { workspace: wsB, agent: toAgent });
    expect(filtered.map((row: any) => row.id)).toEqual([sent.id]);

    // A different (or misspelled) address returns an empty inbox, no error.
    expect(await call(client, 'moa_handoff_inbox', { workspace: wsB, agent: 'claude-code:sess-b:other' })).toEqual([]);

    // Malformed addresses are rejected by the send tool.
    await expect(
      call(client, 'moa_handoff_send', { workspace: wsA, toProject: projB, title: 't', summary: 's', toAgent: 'nope' }),
    ).rejects.toThrow(/agent address shape/);
  } finally {
    await close();
  }
});
