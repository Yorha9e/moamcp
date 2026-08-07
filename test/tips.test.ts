/** Project Tip CRUD, validation, filtering, persistence, and MCP surface. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BoardStore } from '../src/core/store/board.js';
import {
  PROJECT_TIP_STATUSES,
  TipCorruptError,
  TipNotFoundError,
  TipStore,
  type ProjectTip,
} from '../src/modules/tips/tips.js';
import { createServer } from '../src/server.js';

let home: string;
let workspaceA: string;
let workspaceB: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'moamcp-tips-'));
  workspaceA = await mkdtemp(join(home, 'project-a-'));
  workspaceB = await mkdtemp(join(home, 'project-b-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function stores() {
  const board = new BoardStore({ homeDir: home, workspaceCwd: workspaceA, waitCapMs: 200, pollIntervalMs: 15 });
  return { board, tips: new TipStore(board) };
}

async function mcpClient(board: BoardStore) {
  const server = createServer(undefined, undefined, board);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'tips-test', version: '0.0.1' });
  await client.connect(clientTransport);
  return { client, close: () => client.close() };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  return JSON.parse((response.content as Array<{ type: string; text: string }>)[0].text);
}

it('creates a typed tip with generated id, bounded context, namespaced tags, and atomic timestamps', async () => {
  const { board, tips } = stores();
  const tip = await tips.create({
    title: 'Add a control-plane view',
    summary: 'Expose project memory without duplicating BoardStore.',
    context: 'The board is the authority.',
    status: 'exploring',
    module: 'moa/frontend',
    tags: ['frontend', 'memory'],
    documentRefs: [{ path: 'design/TIPS_DESIGN.md', section: '展示界面裁定' }],
    author: 'agent-a',
  }, workspaceA);

  expect(tip.id).toMatch(/^tip_[0-9a-f-]{36}$/);
  expect(PROJECT_TIP_STATUSES).toHaveLength(7);
  const row = (await board.read(`tips/${tip.id}`, undefined, 'workspace', 1, workspaceA))[0];
  expect(row).toBeDefined();
  expect(row!.ts).toBe(tip.updatedAt);
  expect(row!.tags).toEqual([
    'tip',
    'tip:status:exploring',
    'tip:module:moa/frontend',
    'tip:tag:frontend',
    'tip:tag:memory',
  ]);
});

it('deduplicates string arrays and complete document refs without mutating input', async () => {
  const { tips } = stores();
  const tags = ['alpha', 'beta', 'alpha'];
  const sourceRefs = ['issue/1', 'issue/2', 'issue/1'];
  const relatedTipIds = ['tip_one', 'tip_two', 'tip_one'];
  const relatedProjects = ['project-a', 'project-b', 'project-a'];
  const documentRefs = [
    { path: 'docs/tip.md', section: 'one' },
    { path: 'docs/tip.md', section: 'one' },
    { path: 'docs/tip.md', section: 'two' },
  ];
  const before = JSON.stringify({ tags, sourceRefs, relatedTipIds, relatedProjects, documentRefs });

  const tip = await tips.create({
    title: 'Deduplicate fields',
    summary: 'Keep stable first-seen order.',
    tags,
    sourceRefs,
    relatedTipIds,
    relatedProjects,
    documentRefs,
  }, workspaceA);

  expect(JSON.stringify({ tags, sourceRefs, relatedTipIds, relatedProjects, documentRefs })).toBe(before);
  expect(tip.tags).toEqual(['alpha', 'beta']);
  expect(tip.sourceRefs).toEqual(['issue/1', 'issue/2']);
  expect(tip.relatedTipIds).toEqual(['tip_one', 'tip_two']);
  expect(tip.relatedProjects).toEqual(['project-a', 'project-b']);
  expect(tip.documentRefs).toEqual([
    { path: 'docs/tip.md', section: 'one' },
    { path: 'docs/tip.md', section: 'two' },
  ]);
});

it('isolates multiple explicit workspaces and reopens persisted tips', async () => {
  const first = stores();
  const a = await first.tips.create({ title: 'A', summary: 'project A' }, workspaceA);
  await first.tips.create({ title: 'B', summary: 'project B' }, workspaceB);
  expect(await first.tips.read(a.id, workspaceB)).toBeUndefined();

  const reopened = new TipStore(new BoardStore({ homeDir: home, workspaceCwd: workspaceB, pollIntervalMs: 15 }));
  expect((await reopened.list(workspaceA))[0]).toMatchObject({ id: a.id, title: 'A', summary: 'project A' });
  expect((await reopened.list(workspaceB))[0]).toMatchObject({ title: 'B', summary: 'project B' });
});

it('updates with actor metadata while preserving Tip.author and returns lightweight summaries', async () => {
  const { board, tips } = stores();
  const created = await tips.create({
    title: 'Keep this title',
    summary: 'Keep this summary',
    context: 'clear me',
    module: 'module-a',
    tags: ['one'],
    nextAction: 'inspect docs',
    documentRefs: [{ path: 'docs/tip.md', section: 'Details' }],
    sourceRefs: ['issue/1'],
    relatedTipIds: ['tip_related'],
    relatedProjects: ['project-b'],
    author: 'author-a',
  }, workspaceA);
  const updated = await tips.update(
    created.id,
    { module: null, context: null, tags: null, title: 'New title', actor: 'agent-updater' },
    workspaceA,
  );
  expect(updated).toMatchObject({ id: created.id, title: 'New title', summary: created.summary, author: 'author-a' });
  expect(updated.context).toBeUndefined();
  expect(updated.module).toBeUndefined();
  expect(updated.tags).toBeUndefined();
  expect(updated.nextAction).toBe('inspect docs');
  expect((await board.read(`tips/${created.id}`, undefined, 'workspace', 1, workspaceA))[0]).toMatchObject({
    author: 'agent-updater',
  });

  const archived = await tips.archive(created.id, workspaceA, 'agent-archiver');
  expect(archived).toMatchObject({ id: created.id, title: 'New title', status: 'archived', author: 'author-a' });
  expect(archived.summary).toBe(updated.summary);
  expect((await board.read(`tips/${created.id}`, undefined, 'workspace', 1, workspaceA))[0]).toMatchObject({
    author: 'agent-archiver',
  });
  expect(await tips.list({}, workspaceA)).toEqual([]);
  const summary = (await tips.list({ includeArchived: true }, workspaceA))[0];
  expect(summary).toMatchObject({ id: created.id, title: 'New title', status: 'archived', author: 'author-a' });
  for (const field of ['context', 'documentRefs', 'sourceRefs', 'relatedTipIds', 'relatedProjects']) {
    expect(summary).not.toHaveProperty(field);
  }
});

it('filters by status/module/tag and distinguishes missing from corrupt data', async () => {
  const { board, tips } = stores();
  const active = await tips.create({ title: 'Active', summary: 's', status: 'planned', module: 'auth', tags: ['important'] }, workspaceA);
  await tips.create({ title: 'Other', summary: 's', status: 'deferred', module: 'ui', tags: ['later'] }, workspaceA);
  expect((await tips.list({ status: 'planned', module: 'auth', tag: 'important' }, workspaceA)).map((t) => t.id)).toEqual([active.id]);
  expect(await tips.read('tip_missing', workspaceA)).toBeUndefined();
  await board.write('tips/bad', '{not json', ['tip'], 'raw', 'workspace', workspaceA);
  await expect(tips.read('bad', workspaceA)).rejects.toBeInstanceOf(TipCorruptError);
  await expect(tips.update('missing', { title: 'x' }, workspaceA)).rejects.toBeInstanceOf(TipNotFoundError);
});

it('rejects relative workspace, invalid statuses, required clears, immutable fields, and size limits', async () => {
  const { tips } = stores();
  await expect(tips.create({ title: 'x', summary: 'y' }, 'relative/path')).rejects.toThrow(/absolute/);
  await expect(tips.create({ title: 'x', summary: 'y', status: 'unknown' as never }, workspaceA)).rejects.toThrow(/status/);
  const tip = await tips.create({ title: 'x', summary: 'y' }, workspaceA);
  await expect(tips.update(tip.id, { title: null as never }, workspaceA)).rejects.toThrow(/title/);
  await expect(tips.update(tip.id, { id: 'tip_other' }, workspaceA)).rejects.toThrow(/cannot be changed/);
  await expect(tips.update(tip.id, { createdAt: '2020-01-01T00:00:00.000Z' }, workspaceA)).rejects.toThrow(/cannot be changed/);
  await expect(tips.update(tip.id, { creator: 'x' }, workspaceA)).rejects.toThrow(/cannot be changed/);
  await expect(tips.update(tip.id, { author: 'changed' } as never, workspaceA)).rejects.toThrow(/author cannot be changed/);
  // context is capped at 32768 RAW UTF-8 bytes: 32768 passes, 32769 rejects.
  const bigContext = await tips.create({ title: 'x', summary: 'y', context: 'x'.repeat(32768) }, workspaceA);
  expect(bigContext.context).toBe('x'.repeat(32768));
  await expect(tips.create({ title: 'x', summary: 'y', context: 'x'.repeat(32769) }, workspaceA)).rejects.toThrow(/context/);
  // The whole tip value is capped at 48KB (49152 bytes) measured AFTER JSON
  // encoding; pure-ASCII payload avoids JSON escape inflation, so the byte
  // counts above stay exact.
  await expect(tips.create({ title: 'x', summary: 'z'.repeat(48000) }, workspaceA)).resolves.toMatchObject({ id: expect.any(String) });
  await expect(tips.create({ title: 'x', summary: 'z'.repeat(49152) }, workspaceA)).rejects.toThrow(/tip value exceeds/);
});

it('registers exactly five tip tools and wires required workspace through MCP', async () => {
  const { board } = stores();
  const { client, close } = await mcpClient(board);
  try {
    const listed = await client.listTools();
    const tipTools = listed.tools.filter((tool) => tool.name.startsWith('moa_tip_'));
    expect(tipTools.map((tool) => tool.name)).toEqual([
      'moa_tip_create',
      'moa_tip_read',
      'moa_tip_list',
      'moa_tip_update',
      'moa_tip_archive',
    ]);
    expect(tipTools).toHaveLength(5);
    const createSchema = tipTools.find((tool) => tool.name === 'moa_tip_create')!.inputSchema as any;
    expect(createSchema.required).toEqual(['workspace', 'title', 'summary']);
    expect(createSchema.properties.status.enum).toEqual([...PROJECT_TIP_STATUSES]);
    const updateSchema = tipTools.find((tool) => tool.name === 'moa_tip_update')!.inputSchema as any;
    expect(updateSchema.properties.context.type).toEqual(['string', 'null']);
    expect(updateSchema.properties.documentRefs.type).toEqual(['array', 'null']);
    expect(updateSchema.properties.actor.type).toBe('string');
    expect(updateSchema.properties.author).toBeUndefined();
    const archiveSchema = tipTools.find((tool) => tool.name === 'moa_tip_archive')!.inputSchema as any;
    expect(archiveSchema.properties.actor.type).toBe('string');

    const created = await call(client, 'moa_tip_create', {
      workspace: workspaceA,
      title: 'MCP',
      summary: 'wired',
      author: 'mcp-creator',
    });
    expect(created).toMatchObject({ title: 'MCP', summary: 'wired', status: 'captured', author: 'mcp-creator' });
    expect(await call(client, 'moa_tip_read', { workspace: workspaceA, id: created.id })).toMatchObject({ id: created.id });
    expect(await call(client, 'moa_tip_list', { workspace: workspaceA })).toHaveLength(1);
    expect(await call(client, 'moa_tip_update', {
      workspace: workspaceA,
      id: created.id,
      context: null,
      status: 'planned',
      actor: 'mcp-updater',
    })).toMatchObject({ status: 'planned', author: 'mcp-creator' });
    expect(await call(client, 'moa_tip_archive', {
      workspace: workspaceA,
      id: created.id,
      actor: 'mcp-archiver',
    })).toMatchObject({ status: 'archived', author: 'mcp-creator' });
    expect((await board.read(`tips/${created.id}`, undefined, 'workspace', 1, workspaceA))[0]).toMatchObject({
      author: 'mcp-archiver',
    });
    expect(await call(client, 'moa_tip_list', { workspace: workspaceA })).toEqual([]);
  } finally {
    await close();
  }
});

it('does not leave temporary fixtures outside the test home', async () => {
  await mkdir(join(home, 'empty'), { recursive: true });
  await writeFile(join(home, 'empty', 'sentinel.txt'), 'ok');
  expect(await readFile(join(home, 'empty', 'sentinel.txt'), 'utf8')).toBe('ok');
});

it('is not disturbed by child keys when reading a non-existent tip id', async () => {
  const { board, tips } = stores();
  // Write a key that has tip_123 as a prefix (a child key)
  await board.write('tips/tip_123/sub', 'not JSON tip structure', [], 'test', 'workspace', workspaceA);

  // Reading 'tip_123' must return undefined (not corrupt error or child key)
  const result = await tips.read('tip_123', workspaceA);
  expect(result).toBeUndefined();
});
