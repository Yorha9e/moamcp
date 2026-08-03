import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, get } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceAgentConfigService } from '../src/modules/agentconfig/agent-config.js';
import { resetDiskVersionCache } from '../src/core/bus/disk-version.js';
import { BoardStore, workspaceIdForPath } from '../src/core/store/board.js';
import { VERSION } from '../src/core/bus/registry.js';
import { migrateWorkspaceToProject } from '../src/core/store/project-migration.js';
import { ControlPlane } from '../src/adapters/control-plane.js';
import { Bus } from '../src/core/bus/bus.js';
import { createServer } from '../src/server.js';
import { TipStore } from '../src/modules/tips/tips.js';
import { HandoffStore } from '../src/modules/handoff/handoff.js';

let home: string;
let workspaceA: string;
let workspaceB: string;
let busCwd: string;
let bus: Bus;
let board: BoardStore;
let tips: TipStore;
let port: number;

const json = (value: unknown): string => JSON.stringify(value);

/** package.json version is the single source of truth for the build version. */
const pkgVersion = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

async function request(path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { response, body };
}

function subscribe(taskId: string): Promise<{ events: any[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = get(`http://127.0.0.1:${port}/subscribe?task_id=${encodeURIComponent(taskId)}`, (res) => {
      const events: any[] = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = frame.split('\n').find((item) => item.startsWith('data: '));
          if (line) events.push(JSON.parse(line.slice(6)));
        }
      });
      resolve({ events, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

const sleep = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'moamcp-control-plane-'));
  workspaceA = await mkdtemp(join(home, 'project-a-'));
  workspaceB = await mkdtemp(join(home, 'project-b-'));
  busCwd = await mkdtemp(join(home, 'bus-cwd-'));
  bus = new Bus({ port: 0, cwd: busCwd, instancesDir: join(home, 'instances'), logsDir: join(home, 'logs') });
  port = await bus.start();
  board = new BoardStore({
    homeDir: home,
    workspaceCwd: workspaceA,
    emit: (scope, event) => bus.publish(scope.kind === 'task' ? scope.taskId : `@board/${scope.key}`, event),
  });
  tips = new TipStore(board);
  bus.mountControlPlane(board, tips);
  await board.registerWorkspace(workspaceA);
  await board.registerWorkspace(workspaceB);
});

afterEach(async () => {
  await board.close();
  await bus.stop();
  await rm(home, { recursive: true, force: true });
});

describe('control plane HTTP surface', () => {
  it('serves the shared four-item app header on Debate and Control Plane', async () => {
    const page = await request('/control-plane');
    expect(page.response.status).toBe(200);
    expect(page.response.headers.get('content-type')).toContain('text/html');
    expect(page.body).toContain('Workspace Control Plane');
    expect(page.body).toContain("new EventSource('/subscribe?task_id=' + encodeURIComponent(channel)");
    expect(page.body).toContain('textContent');
    expect(page.body).toContain('document.createElement');
    expect(page.body).not.toContain('innerHTML');

    const card = await fetch(`http://127.0.0.1:${port}/`);
    const cardHtml = await card.text();
    const controlHtml = page.body as string;
    const links = [
      ['debateNav', '/', 'MOA Debate'],
      ['memoryNav', '/control-plane?section=memory', 'Workspace Memory'],
      ['runsNav', '/control-plane?section=runs', 'MoA Runs'],
      ['systemNav', '/control-plane?section=system', 'System Health'],
    ];
    for (const [id, href, label] of links) {
      const anchor = `id="${id}"`;
      expect(cardHtml).toContain(anchor);
      expect(controlHtml).toContain(anchor);
      expect(cardHtml).toContain(`href="${href}"`);
      expect(controlHtml).toContain(`href="${href}"`);
      expect(cardHtml).toContain(label);
      expect(controlHtml).toContain(label);
    }
    expect(cardHtml).toContain('<span class="brand-title" data-i18n="app.brand">MOA Workspace</span>');
    expect(controlHtml).toContain('<span class="brand-title" data-i18n="app.brand">MOA Workspace</span>');
    expect(cardHtml).toMatch(/id="debateNav" class="active" aria-current="page"/);
    expect(controlHtml).toMatch(/id="memoryNav" class="active" aria-current="page"/);
    expect(cardHtml).toContain('<div class="shell">');
    expect(cardHtml).toContain('<div class="debate-context" aria-label="Current debate context" data-i18n-aria="debate.context">');
    expect(cardHtml.indexOf('class="app-header"')).toBeLessThan(cardHtml.indexOf('class="debate-context"'));
    expect(cardHtml.indexOf('class="debate-context"')).toBeLessThan(cardHtml.indexOf('id="taskId"'));
  });

  it('exposes the build version in the header and on /api/system', async () => {
    const page = await request('/control-plane');
    expect(page.body).toContain('id="appVersion"');
    expect(page.body).toContain('data-i18n="system.version"');
    const system = await request('/api/system');
    expect(system.response.status).toBe(200);
    // The endpoint reports the same VERSION the whole backend uses (the
    // package.json-derived registry.ts pattern). Under vitest source
    // resolution VERSION falls back to '0.0.0' — the known dist-relative
    // createRequire characteristic, deliberately untouched — so the literal
    // package.json match is asserted only when resolution actually ran; the
    // esbuild bundle resolves it to the real version (verified against dist).
    expect(system.body.version).toBe(VERSION);
    if (VERSION !== '0.0.0') expect(VERSION).toBe(pkgVersion);
  });

  it('reports the installed disk version on /api/system (BUS_VERSION_RESTART.md task A)', async () => {
    // Inject a fake "newer build on disk" via the documented test hook and
    // make the endpoint report it as diskVersion (running VERSION untouched).
    const dir = await mkdtemp(join(tmpdir(), 'moamcp-cp-diskver-'));
    const pkg = join(dir, 'package.json');
    await writeFile(pkg, JSON.stringify({ version: '99.0.0' }));
    process.env.MOAMCP_PACKAGE_JSON = pkg;
    resetDiskVersionCache();
    try {
      const system = await request('/api/system');
      expect(system.response.status).toBe(200);
      expect(system.body.version).toBe(VERSION);
      expect(system.body.diskVersion).toBe('99.0.0');
    } finally {
      delete process.env.MOAMCP_PACKAGE_JSON;
      resetDiskVersionCache();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('routes management sections through the URL while preserving other query parameters', async () => {
    const page = await request('/control-plane?section=runs&workspace=0123456789abcdef');
    const html = page.body as string;

    expect(html).toContain("var requestedSection = new URLSearchParams(location.search).get('section')");
    expect(html).toContain('switchSection(requestedSection)');
    expect(html).toContain("if (['memory', 'runs', 'system'].indexOf(section) < 0) section = 'memory'");
    expect(html).toContain("updateSectionLocation(section)");
    expect(html).toContain("replaceLocationParam('workspace', id)");
    expect(html).toContain("replaceLocationParam('section', section)");
    expect(html).toContain("next.searchParams.set(name, value)");
    expect(html).toContain('event.preventDefault()');
    expect(html).toContain("nav.setAttribute('aria-current', 'page')");
    expect(html).toContain("nav.removeAttribute('aria-current')");
    expect(html).toContain("document.getElementById(name + 'Section').hidden = !current");
  });

  it('serves the three read-only management areas with safe lifecycle contracts', async () => {
    const page = await request('/control-plane');
    const html = page.body as string;

    for (const label of ['Workspace Memory', 'MoA Runs', 'System Health', 'Project Tips', 'Shared Board', 'Live &amp; Recent', 'Archives']) {
      expect(html).toContain(label);
    }
    for (const endpoint of ['/api/tasks?', '/api/tasks/', '/api/archives', '/api/system', '/archive?']) {
      expect(html).toContain(endpoint);
    }

    // Legacy /archive returns raw JSON/JSONL text and is deliberately not passed through api().
    expect(html).toContain('function fetchText(url)');
    expect(html).toContain('fetchText(url).then(function (raw)');
    expect(html).toContain('return response.text().then(function (raw)');
    expect(html).toContain("if (file.slice(-5) === '.json')");
    expect(html).toContain('detail.textContent = shown');

    // Section and subview changes tear down every owned SSE/timer resource.
    expect(html).toContain("var activeSection = 'memory'");
    expect(html).toContain("var activeRunsView = 'live'");
    expect(html).toContain('function closeSectionResources()');
    expect(html).toContain('clearInterval(runsPollTimer)');
    expect(html).toContain('clearInterval(systemPollTimer)');
    expect(html).toContain('closeBoardSubscription()');
    expect(html).toContain("activeSection !== 'memory' || activeView !== 'board'");

    expect(html).toContain('Bus listener entries do not represent every Kimi Session or MCP process');
    expect(html).toContain('in-memory event projection of the owner Bus');
    expect(html).toContain("url.hostname === '127.0.0.1'");
    expect(html).toContain("url.hostname === 'localhost'");
    expect(html).toContain('url.port === location.port');
    expect(html).not.toContain('Force Close');
    expect(html).not.toContain('Kill');
    expect(html).not.toContain('Reconnect');
    expect(html).not.toContain('insertAdjacent' + 'HTML');
  });

  it('serves the Agent/Profile editor contract without unsafe DOM or polling shortcuts', async () => {
    const page = await request('/control-plane');
    const html = page.body as string;
    for (const anchor of ['agentsTab', 'agentsView', 'agentList', 'agentMarkdown', 'agentForm', 'typeBindingsList', 'slotBindingsList', 'agentRawToml', 'agentLoadLatest', 'agentReloadBanner', 'Multiple Sessions', '/reload']) {
      expect(html).toContain(anchor);
    }
    for (const endpoint of ['/api/agent-config', '/api/agent-config/agents/', '/api/agent-config/bindings', '/api/agent-config/local-toml']) {
      expect(html).toContain(endpoint);
    }
    expect(html).toContain('error.currentHash');
    expect(html).toContain('loadAgentDetail');
    expect(html).toContain('loadAgentRaw');
    expect(html).toContain('document.createElement');
    expect(html).toContain('textContent');
    expect(html).not.toContain('window.prompt');
    expect(html).not.toContain('inner' + 'HTML');
  });

  it('lists sidecars by recent board activity and isolates workspace ids', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const idB = workspaceIdForPath(workspaceB);
    const created = await request('/api/tips', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, title: 'A only', summary: 'project A' }),
    });
    expect(created.response.status).toBe(200);

    const workspaces = await request('/api/workspaces');
    expect(workspaces.response.status).toBe(200);
    expect(workspaces.body.workspaces.map((item: any) => item.id)).toEqual([idA, idB]);
    expect(workspaces.body.workspaces[0]).toMatchObject({ id: idA, cwd: workspaceA, createdAt: expect.any(String) });
    expect(workspaces.body.workspaces[0]).toHaveProperty('updatedAt');

    const onlyA = await request(`/api/tips?workspace=${idA}`);
    const onlyB = await request(`/api/tips?workspace=${idB}`);
    expect(onlyA.body.tips).toHaveLength(1);
    expect(onlyA.body.tips[0]).toMatchObject({ title: 'A only' });
    expect(onlyB.body.tips).toEqual([]);

    const pathAttempt = await request(`/api/tips?workspace=${encodeURIComponent(workspaceA)}`);
    expect(pathAttempt.response.status).toBe(400);
    const unknownWorkspace = await request(`/api/tips?workspace=${'0'.repeat(16)}`);
    expect(unknownWorkspace.response.status).toBe(404);
  });

  it('manages Agent Markdown, standard bindings, raw local.toml, and workspace isolation', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const idB = workspaceIdForPath(workspaceB);
    const content = '---\nname: critic\ndescription: Finds risks\nslot: fast\n---\n\nReview the proposal and identify risks.\n';
    const created = await request('/api/agent-config/agents/critic', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, content, expectedHash: null }),
    });
    expect(created.response.status).toBe(200);
    expect(created.body.agent).toMatchObject({ name: 'critic', content, hash: expect.any(String) });

    const summary = await request(`/api/agent-config?workspace=${idA}`);
    expect(summary.response.status).toBe(200);
    expect(summary.body).toMatchObject({ workspace: idA, agents: [{ name: 'critic', valid: true }] });
    expect(summary.body.localToml).toMatchObject({ exists: false, hash: null });

    const detail = await request(`/api/agent-config/agents/critic?workspace=${idA}`);
    expect(detail.response.status).toBe(200);
    expect(detail.body.agent).toMatchObject({ name: 'critic', prompt: 'Review the proposal and identify risks.' });

    const conflict = await request('/api/agent-config/agents/critic', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, content: content.replace('risk', 'issue'), expectedHash: '0'.repeat(64) }),
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.currentHash).toBe(created.body.agent.hash);

    const raw = '[subagent.critic]\n# keep this comment\nmodel = "old/model"\nthinking_effort = "low"\n';
    const rawSaved = await request('/api/agent-config/local-toml', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, content: raw, expectedHash: null }),
    });
    expect(rawSaved.response.status).toBe(200);
    expect(rawSaved.body.localToml.content).toBe(raw);

    const binding = await request('/api/agent-config/bindings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, changes: [{ section: 'subagent', name: 'critic', binding: { model: 'new/model' } }], expectedHash: rawSaved.body.localToml.hash }),
    });
    expect(binding.response.status).toBe(200);
    expect(binding.body.content).toContain('model = "new/model"');
    expect(binding.body.hash).not.toBe(rawSaved.body.localToml.hash);

    const rawRead = await request(`/api/agent-config/local-toml?workspace=${idA}`);
    expect(rawRead.body.localToml.content).toContain('# keep this comment');
    expect(rawRead.body.localToml.content).toContain('model = "new/model"');
    const afterBinding = await request(`/api/agent-config?workspace=${idA}`);
    expect(afterBinding.body.bindings.types[0]).toMatchObject({ section: 'subagent', name: 'critic', binding: { model: 'new/model' }, layout: 'standard' });

    const onlyB = await request(`/api/agent-config?workspace=${idB}`);
    expect(onlyB.response.status).toBe(200);
    expect(onlyB.body.agents).toEqual([]);
    expect(onlyB.body.localToml.exists).toBe(false);

    const pathBody = await request('/api/agent-config/agents/other', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, cwd: workspaceA, content, expectedHash: null }),
    });
    expect(pathBody.response.status).toBe(400);
    const wrongOrigin = await request('/api/agent-config/agents/other', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: json({ workspace: idA, content, expectedHash: null }),
    });
    expect(wrongOrigin.response.status).toBe(403);
    const missingContentType = await request('/api/agent-config/agents/other', {
      method: 'PUT',
      body: json({ workspace: idA, content, expectedHash: null }),
    });
    expect(missingContentType.response.status).toBe(415);

    const deleted = await request('/api/agent-config/agents/critic', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, expectedHash: (await request(`/api/agent-config/agents/critic?workspace=${idA}`)).body.agent.hash }),
    });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.agent.deleted).toBe(true);
  });

  it('does not touch the Agent filesystem for non-Agent routes and only reads it on Agent routes', async () => {
    const fsCalls: string[] = [];
    const fakeFs = {
      readdir: async () => { fsCalls.push('readdir'); return []; },
      lstat: async () => { fsCalls.push('lstat'); return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }; },
      realpath: async (path: string) => { fsCalls.push('realpath'); return path; },
      readFile: async () => { fsCalls.push('readFile'); return ''; },
      mkdir: async () => { fsCalls.push('mkdir'); return undefined; },
      unlink: async () => { fsCalls.push('unlink'); },
      writeFileAtomic: async () => { fsCalls.push('writeFileAtomic'); },
    } as any;
    const injected = new WorkspaceAgentConfigService(fakeFs);
    expect(fsCalls).toEqual([]);
    const idA = workspaceIdForPath(workspaceA);
    const control = new ControlPlane(board, tips, injected);
    control.mountRuntime({
      listRuns: () => [], readRun: () => undefined, cardUrl: (taskId) => '/tasks/' + taskId,
      listArchives: async () => [], systemInfo: async () => ({} as any),
    });
    const httpServer = createHttpServer((req, res) => { void control.handle(req, res); });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const directPort = (httpServer.address() as { port: number }).port;
    try {
      const nonAgentRoutes = [
        `/api/workspaces`, `/api/tips?workspace=${idA}`, `/api/board?scope=workspace&workspace=${idA}`,
        `/api/tasks`, `/api/archives`, `/api/system`,
      ];
      for (const path of nonAgentRoutes) expect((await fetch(`http://127.0.0.1:${directPort}${path}`)).status).toBe(200);
      expect(fsCalls).toEqual([]);
      const agent = await fetch(`http://127.0.0.1:${directPort}/api/agent-config?workspace=${idA}`);
      expect(agent.status).toBe(403);
      expect(fsCalls.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('returns 405 for unsupported methods, 400 for validation, and enforces the body cap', async () => {
    const idA = workspaceIdForPath(workspaceA);
    expect((await request('/api/workspaces', { method: 'POST' })).response.status).toBe(405);
    expect((await request('/api/tips', { method: 'GET' })).response.status).toBe(400);
    expect((await request(`/api/tips/no-such-tip?workspace=${idA}`)).response.status).toBe(404);
    expect((await request(`/api/board?scope=task%3Asecret&workspace=${idA}`)).response.status).toBe(400);
    expect((await request('/api/tips', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, title: 'x', summary: 'y', context: 'z'.repeat(70 * 1024) }),
    })).response.status).toBe(413);
  });

  it('supports Tip create/read/edit/archive through TipStore and preserves actor metadata', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const created = await request('/api/tips', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({
        workspace: idA,
        title: 'Control plane Tip',
        summary: 'Manage it from the browser',
        status: 'exploring',
        context: 'stored once',
        module: 'frontend',
        tags: ['ui', 'ui'],
        documentRefs: [{ path: 'docs/tips.md', section: 'P2' }],
      }),
    });
    expect(created.response.status).toBe(200);
    expect(created.body).toMatchObject({ status: 'exploring', tags: ['ui'] });

    const read = await request(`/api/tips/${created.body.id}?workspace=${idA}`);
    expect(read.body).toMatchObject({ id: created.body.id, context: 'stored once', documentRefs: [{ path: 'docs/tips.md' }] });

    const updated = await request(`/api/tips/${created.body.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, title: 'Edited', status: 'planned', tags: ['ready'], actor: 'web-editor' }),
    });
    expect(updated.response.status).toBe(200);
    expect(updated.body).toMatchObject({ title: 'Edited', status: 'planned', summary: 'Manage it from the browser' });
    expect((await board.read(`tips/${created.body.id}`, undefined, 'workspace', 1, workspaceA))[0]).toMatchObject({ author: 'web-editor' });

    const archived = await request(`/api/tips/${created.body.id}/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, actor: 'web-archiver' }),
    });
    expect(archived.response.status).toBe(200);
    expect(archived.body.status).toBe('archived');
    expect((await request(`/api/tips?workspace=${idA}`)).body.tips).toEqual([]);
    expect((await request(`/api/tips?workspace=${idA}&includeArchived=true`)).body.tips[0]).toMatchObject({ status: 'archived' });
    expect((await board.read(`tips/${created.body.id}`, undefined, 'workspace', 1, workspaceA))[0]).toMatchObject({ author: 'web-archiver' });

    const crossWorkspace = await request(`/api/tips/${created.body.id}?workspace=${workspaceIdForPath(workspaceB)}`);
    expect(crossWorkspace.response.status).toBe(404);
  });

  it('preserves existing author/tags when omitted in Board POST, normalizes empty author, and allows explicit clearing of tags', async () => {
    const idA = workspaceIdForPath(workspaceA);

    // 1. Create entry with author and tags
    const created = await request('/api/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'workspace', workspace: idA, key: 'test/preserve', value: 'v1', author: 'alice', tags: ['tag1', 'tag2'] }),
    });
    expect(created.response.status).toBe(200);
    expect(created.body.entry).toMatchObject({ author: 'alice', tags: ['tag1', 'tag2'] });

    // 2. Update with omitted author and tags -> preserves existing author and tags
    const updatedOmitted = await request('/api/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'workspace', workspace: idA, key: 'test/preserve', value: 'v2' }),
    });
    expect(updatedOmitted.response.status).toBe(200);
    expect(updatedOmitted.body.entry).toMatchObject({ author: 'alice', tags: ['tag1', 'tag2'] });

    // Verify stored state
    const readStored = await request(`/api/board?scope=workspace&workspace=${idA}&key=test%2Fpreserve`);
    expect(readStored.body.entries[0]).toMatchObject({ author: 'alice', tags: ['tag1', 'tag2'], value: 'v2' });

    // 3. Explicit tags=[] clears tags while omitted author preserves 'alice'
    const clearTags = await request('/api/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'workspace', workspace: idA, key: 'test/preserve', value: 'v3', tags: [] }),
    });
    expect(clearTags.response.status).toBe(200);
    expect(clearTags.body.entry).toMatchObject({ author: 'alice', tags: [] });

    // 4. Explicit author='' normalizes to 'anonymous' while omitted tags preserves empty tags
    const emptyAuthor = await request('/api/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'workspace', workspace: idA, key: 'test/preserve', value: 'v4', author: '' }),
    });
    expect(emptyAuthor.response.status).toBe(200);
    expect(emptyAuthor.body.entry).toMatchObject({ author: 'anonymous', tags: [] });

    // 5. New entry with omitted author and tags defaults to anonymous and []
    const newOmitted = await request('/api/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'workspace', workspace: idA, key: 'test/new', value: 'vnew' }),
    });
    expect(newOmitted.response.status).toBe(200);
    expect(newOmitted.body.entry).toMatchObject({ author: 'anonymous', tags: [] });
  });

  it('creates, updates, reads, and tombstones workspace/global Board entries with isolated SSE invalidation', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const idB = workspaceIdForPath(workspaceB);
    const channel = `@board/workspace:${idA}`;
    const subscription = await subscribe(channel);

    const created = await request('/api/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'workspace', workspace: idA, key: 'raw/contract', value: 'v1', tags: ['contract'], author: 'agent-a' }),
    });
    expect(created.response.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, entry: { key: 'raw/contract', value: 'v1', tags: ['contract'], author: 'agent-a', ts: expect.any(String) } });

    const updated = await request('/api/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'workspace', workspace: idA, key: 'raw/contract', value: 'v2' }),
    });
    expect(updated.body.entry.ts).not.toBe(created.body.entry.ts);
    expect((await request(`/api/board?scope=workspace&workspace=${idA}&key=raw%2Fcontract`)).body.entries[0]).toMatchObject({ value: 'v2' });
    expect((await request(`/api/board?scope=workspace&workspace=${idB}&key=raw%2Fcontract`)).body.entries).toEqual([]);

    const global = await request('/api/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'global', key: 'raw/contract', value: 'global copy', author: 'agent-g' }),
    });
    expect(global.response.status).toBe(200);
    expect((await request('/api/board?scope=global&key=raw%2Fcontract')).body.entries[0]).toMatchObject({ value: 'global copy' });

    const deleted = await request('/api/board', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'workspace', workspace: idA, key: 'raw/contract' }),
    });
    expect(deleted.body).toEqual({ ok: true, ts: expect.any(String) });
    expect((await request(`/api/board?scope=workspace&workspace=${idA}&key=raw%2Fcontract`)).body.entries).toEqual([]);
    const idempotent = await request('/api/board', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'workspace', workspace: idA, key: 'raw/contract' }),
    });
    expect(idempotent.body).toEqual({ ok: true, ts: null });

    await sleep();
    subscription.close();
    const boardEvents = subscription.events.filter((event) => event.type === 'board_updated');
    expect(boardEvents.map((event) => event.op)).toEqual(['write', 'write', 'delete']);
    // Bus preserves BoardStore's commit timestamp rather than replacing it at fan-out time.
    expect(boardEvents.map((event) => event.ts)).toEqual([created.body.entry.ts, updated.body.entry.ts, deleted.body.ts]);

    bus.publish('ordinary-task', { type: 'task_initialized' });
    const tasks = await request('/tasks');
    expect(tasks.body.tasks).toContain('ordinary-task');
    expect(tasks.body.tasks).not.toContain(channel);

    const server = createServer(undefined, bus, board, tips);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'control-plane-status-test', version: '0.0.1' });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: 'moa_status', arguments: {} });
      const status = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      expect(status).toMatchObject({ control_plane_url: `http://127.0.0.1:${port}/control-plane` });
    } finally {
      await client.close();
    }
  });

  it('applies expectedTs preconditions atomically for Board upsert and delete', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const post = (body: Record<string, unknown>) => request('/api/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'workspace', workspace: idA, key: 'cas/key', ...body }),
    });

    const created = await post({ value: 'created', expectedTs: null });
    expect(created.response.status).toBe(200);
    const firstTs = created.body.entry.ts;

    const createConflict = await post({ value: 'duplicate', expectedTs: null });
    expect(createConflict.response.status).toBe(409);
    expect(createConflict.body).toMatchObject({ error: expect.any(String), currentTs: firstTs });

    const staleUpdate = await post({ value: 'stale', expectedTs: 'not-the-current-ts' });
    expect(staleUpdate.response.status).toBe(409);
    expect(staleUpdate.body.currentTs).toBe(firstTs);

    const updated = await post({ value: 'updated', expectedTs: firstTs });
    expect(updated.response.status).toBe(200);
    const secondTs = updated.body.entry.ts;

    const staleDelete = await request('/api/board', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'workspace', workspace: idA, key: 'cas/key', expectedTs: firstTs }),
    });
    expect(staleDelete.response.status).toBe(409);
    expect(staleDelete.body.currentTs).toBe(secondTs);

    const deleted = await request('/api/board', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'workspace', workspace: idA, key: 'cas/key', expectedTs: secondTs }),
    });
    expect(deleted.body).toEqual({ ok: true, ts: expect.any(String) });

    const missingConflict = await post({ value: 'wrong version', expectedTs: secondTs });
    expect(missingConflict.response.status).toBe(409);
    expect(missingConflict.body).not.toHaveProperty('currentTs');
    expect((await post({ value: 'recreated', expectedTs: null })).response.status).toBe(200);
  });

  it('strictly validates Board mutation transport, scope, workspace, fields, and size caps', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const valid = { scope: 'workspace', workspace: idA, key: 'guard/key', value: 'ok' };
    const boardPost = (body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) => request('/api/board', {
      method: 'POST', headers, body,
    });

    expect((await boardPost(json(valid), { 'content-type': 'text/plain' })).response.status).toBe(415);
    expect((await boardPost(json(valid), { 'content-type': 'application/json', origin: 'http://attacker.example' })).response.status).toBe(403);
    expect((await boardPost('{nope')).response.status).toBe(400);
    expect((await boardPost(json({ ...valid, value: 'x'.repeat(70 * 1024) }))).response.status).toBe(413);
    expect((await boardPost(json({ ...valid, value: 'x'.repeat(33 * 1024) }))).response.status).toBe(400);

    expect((await boardPost(json({ ...valid, scope: 'task:secret' }))).response.status).toBe(400);
    expect((await boardPost(json({ ...valid, cwd: workspaceA }))).response.status).toBe(400);
    expect((await boardPost(json({ ...valid, path: workspaceA }))).response.status).toBe(400);
    expect((await boardPost(json({ ...valid, workspace: workspaceA }))).response.status).toBe(400);
    expect((await boardPost(json({ ...valid, workspace: '0'.repeat(16) }))).response.status).toBe(404);
    expect((await request(`/api/board?scope=workspace&workspace=${idA}&cwd=${encodeURIComponent(workspaceA)}`)).response.status).toBe(400);

    for (const patch of [{ key: 1 }, { value: 1 }, { tags: 'tag' }, { tags: [1] }, { author: null }, { expectedTs: 1 }]) {
      expect((await boardPost(json({ ...valid, ...patch }))).response.status).toBe(400);
    }
    expect((await request('/api/board', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'global', key: 'guard/key', value: 'not allowed' }),
    })).response.status).toBe(400);
  });

  it('enforces application/json and loopback origin on JSON mutations and POST /publish', async () => {
    const idA = workspaceIdForPath(workspaceA);

    // 1. Content-Type check: text/plain rejected with 415
    const textPlainTip = await request('/api/tips', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: json({ workspace: idA, title: 'bad content-type', summary: 'test' }),
    });
    expect(textPlainTip.response.status).toBe(415);

    const textPlainPub = await request('/publish', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: json({ task_id: 't1', event: { foo: 'bar' } }),
    });
    expect(textPlainPub.response.status).toBe(415);

    // 2. Foreign / null Origin check: rejected with 403
    const foreignOriginTip = await request('/api/tips', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://attacker.com' },
      body: json({ workspace: idA, title: 'attack', summary: 'test' }),
    });
    expect(foreignOriginTip.response.status).toBe(403);

    const nullOriginTip = await request('/api/tips', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null' },
      body: json({ workspace: idA, title: 'null origin', summary: 'test' }),
    });
    expect(nullOriginTip.response.status).toBe(403);

    const foreignOriginPub = await request('/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://attacker.com' },
      body: json({ task_id: 't1', event: { foo: 'bar' } }),
    });
    expect(foreignOriginPub.response.status).toBe(403);

    // 3. Valid same-origin JSON request works
    const sameOriginTip = await request('/api/tips', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: json({ workspace: idA, title: 'valid same-origin', summary: 'test' }),
    });
    expect(sameOriginTip.response.status).toBe(200);

    const sameOriginPub = await request('/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: json({ task_id: 't1', event: { type: 'test_event' } }),
    });
    expect(sameOriginPub.response.status).toBe(200);

    // 4. Internal / MCP / CLI requests (without Origin header) work
    const internalTip = await request('/api/tips', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, title: 'internal create', summary: 'test' }),
    });
    expect(internalTip.response.status).toBe(200);

    const internalArchive = await request(`/api/tips/${internalTip.body.id}/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA }),
    });
    expect(internalArchive.response.status).toBe(200);
  });

  it('returns BoardEntry with UTF-8 bytes metadata including multi-byte Chinese strings', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const chineseVal = '中文测试内容'; // 6 Chinese chars = 18 bytes in UTF-8
    await board.write('chinese/key', chineseVal, ['test'], 'author-zh', 'workspace', workspaceA);

    const res = await request(`/api/board?scope=workspace&workspace=${idA}&key=chinese%2Fkey`);
    expect(res.response.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({
      key: 'chinese/key',
      value: chineseVal,
      author: 'author-zh',
      bytes: Buffer.byteLength(chineseVal, 'utf8'),
    });
    expect(res.body.entries[0].bytes).toBe(18);
  });

  it('supports Raw Board HTTP namespace search with key=x and key=x/', async () => {
    const idA = workspaceIdForPath(workspaceA);
    await board.write('ns', 'base', [], 'a', 'workspace', workspaceA);
    await board.write('ns/', 'slash', [], 'a', 'workspace', workspaceA);
    await board.write('ns/child', 'sub', [], 'a', 'workspace', workspaceA);
    await board.write('ns_other', 'other', [], 'a', 'workspace', workspaceA);

    const resX = await request(`/api/board?scope=workspace&workspace=${idA}&key=ns`);
    expect(resX.response.status).toBe(200);
    expect(resX.body.entries.map((e: any) => e.key).sort()).toEqual(['ns', 'ns/', 'ns/child']);

    const resXSlash = await request(`/api/board?scope=workspace&workspace=${idA}&key=ns%2F`);
    expect(resXSlash.response.status).toBe(200);
    expect(resXSlash.body.entries.map((e: any) => e.key).sort()).toEqual(['ns', 'ns/', 'ns/child']);
  });

  it('verifies frontend contract for SSE subscription lifecycle and channel switching', async () => {
    const page = await request('/control-plane');
    expect(page.response.status).toBe(200);
    const html = page.body as string;

    // Check presence of getBoardChannel and global / workspace channel handling
    expect(html).toContain('function getBoardChannel()');
    expect(html).toContain("return '@board/global'");
    expect(html).toContain("return currentWorkspace ? '@board/workspace:' + currentWorkspace : ''");

    // Check that switchView and boardScope change trigger connectBoardSubscription
    expect(html).toContain('function switchView(view)');
    expect(html).toContain('connectBoardSubscription()');
    expect(html).toContain("document.getElementById('boardScope').addEventListener('change'");
  });

  it('serves the complete safe Board management frontend contract', async () => {
    const page = await request('/control-plane');
    expect(page.response.status).toBe(200);
    const html = page.body as string;

    // Mutation UI is a themed form/modal, never a native prompt or HTML injection path.
    for (const anchor of ['newBoardEntry', 'boardForm', 'boardFormKey', 'boardFormValue', 'boardFormTags', 'boardFormAuthor', 'Copy key', 'Copy value', 'boardSort', 'boardResultCount']) {
      expect(html).toContain(anchor);
    }
    expect(html).toContain("api('/api/board', { method: 'POST'");
    expect(html).toContain("api('/api/board', { method: 'DELETE'");
    expect(html).not.toContain('window.prompt');
    expect(html).not.toContain('inner' + 'HTML');
    expect(html).not.toContain('insertAdjacent' + 'HTML');
    expect(html).toContain('document.createElement');
    expect(html).toContain('textContent');
    expect(html).toContain('EnhanceSelect');

    // Creates and edits use distinct CAS preconditions, and edit key is locked.
    expect(html).toContain("payload.expectedTs = boardEditing.mode === 'new' ? null : boardEditing.expectedTs");
    expect(html).toContain('expectedTs: editing ? entry.ts : null');
    expect(html).toContain('keyField.readOnly = editing');
    expect(html).toContain('error.status === 409');
    expect(html).toContain('error.currentTs');
    expect(html).toContain('重新载入当前版本');

    // UTF-8 value size is live checked and guarded again during submit.
    expect(html).toContain('BOARD_VALUE_MAX_BYTES = 32768');
    expect(html).toContain("typeof TextEncoder === 'function'");
    expect(html).toContain('utf8Bytes(value) > BOARD_VALUE_MAX_BYTES');
    expect(html).toContain("addEventListener('input', updateBoardValueBytes)");

    // SSE preserves drafts, remains 300ms debounced, and delete explains tombstones.
    expect(html).toContain("payload.type === 'board_updated'");
    expect(html).toContain('boardEditing.external = true');
    expect(html).toContain('外部已更新');
    expect(html).toContain('}, 300)');
    expect(html).toContain('append-only 历史会保留墓碑');

    // Tips and their actual tips/<id> Board keys link in both directions without an id regex.
    expect(html).toContain("'tips/' + id");
    expect(html).toContain("tr('tips.boardLink', { id: tip.id })");
    expect(html).toContain("key.indexOf('tips/') !== 0");
    expect(html).toContain("key.slice('tips/'.length)");
    expect(html).toContain("tr('board.backToTip')");

    // Long scrolling surfaces on this page avoid the Windows Chromium blur artifact.
    expect(html).toContain('backdrop-filter: none');
    expect(html).toContain('background: var(--solid)');
  });

  it('filters @board/* synthetic channels in moa_status.tasks', async () => {
    const channel = `@board/workspace:1234567890123456`;
    bus.publish(channel, { type: 'board_updated' });
    bus.publish('real-task-id', { type: 'normal_event' });

    const server = createServer(undefined, bus, board, tips);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'moa-status-filter-test', version: '0.0.1' });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: 'moa_status', arguments: {} });
      const status = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      expect(status.tasks).toContain('real-task-id');
      expect(status.tasks).not.toContain(channel);
      expect(status.tasks.every((t: string) => !t.startsWith('@board/'))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('allows opening corrupt agent Markdown via HTTP GET, rejects corrupt save, and saves fixed content', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const agentsDir = join(workspaceA, '.kimi-code', 'agents');
    await mkdir(agentsDir, { recursive: true });
    const corruptContent = '---\nname: broken\ninvalid: : : yaml\n---\nPrompt';
    await writeFile(join(agentsDir, 'broken.md'), corruptContent);

    // GET inspect includes broken agent with valid: false
    const inspectRes = await request(`/api/agent-config?workspace=${idA}`);
    expect(inspectRes.response.status).toBe(200);
    expect(inspectRes.body.agents).toMatchObject([{ name: 'broken', valid: false }]);

    // GET agent returns 200 with raw content and valid: false
    const readRes = await request(`/api/agent-config/agents/broken?workspace=${idA}`);
    expect(readRes.response.status).toBe(200);
    expect(readRes.body.agent).toMatchObject({
      name: 'broken',
      valid: false,
      content: corruptContent,
    });
    expect(readRes.body.agent.error).toBeDefined();

    const originalHash = readRes.body.agent.hash;

    // PUT with corrupt content still fails validation
    const badPut = await request('/api/agent-config/agents/broken', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, content: corruptContent, expectedHash: originalHash }),
    });
    expect(badPut.response.status).toBe(400);

    // PUT with fixed content succeeds
    const fixedContent = '---\nname: broken\ndescription: repaired\n---\nRepaired prompt';
    const goodPut = await request('/api/agent-config/agents/broken', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, content: fixedContent, expectedHash: originalHash }),
    });
    expect(goodPut.response.status).toBe(200);
    expect(goodPut.body.agent.name).toBe('broken');

    // Subsequent GET returns valid: true
    const reReadRes = await request(`/api/agent-config/agents/broken?workspace=${idA}`);
    expect(reReadRes.response.status).toBe(200);
    expect(reReadRes.body.agent.valid).toBe(true);
    expect(reReadRes.body.agent.content).toBe(fixedContent);
  });

  it('serves frontend contract verifying agent config panel visibility, readOnly existing names, and locale change draft preservation', async () => {
    const page = await request('/control-plane');
    expect(page.response.status).toBe(200);
    const html = page.body as string;

    // 1. clearAgentEditor & showAgentEditor keep panel visible when currentWorkspace is set
    expect(html).toContain('agentConfigPanel.hidden = !currentWorkspace');

    // 2. showAgentEditor does NOT call renderAgentBindings() unconditionally
    expect(html).not.toContain('renderAgentMeta(agent); renderAgentBindings();');

    // 3. Existing binding names are set to readOnly
    expect(html).toContain("textField('agent.bindingName', 'name', rowData ? rowData.name : '', !!(rowData && rowData.name))");
    expect(html).toContain('if (readOnly) input.readOnly = true');

    // 4. Locale change calls updateBindingRowTranslations instead of renderAgentBindings
    expect(html).toContain('function updateBindingRowTranslations()');
    expect(html).toContain('if (agentSnapshot) updateBindingRowTranslations()');
  });

  it('maps the new project/handoff routes to 200/400/404/405 as appropriate', async () => {
    const idA = workspaceIdForPath(workspaceA);
    // 200: read-only listings work with an empty registry/inbox.
    expect((await request('/api/projects')).response.status).toBe(200);
    expect((await request(`/api/handoff/inbox?workspace=${idA}`)).response.status).toBe(200);
    expect((await request(`/api/handoff/outbox?workspace=${idA}`)).response.status).toBe(200);
    // 405: exact paths exist but only for the registered method.
    expect((await request('/api/projects', { method: 'POST' })).response.status).toBe(405);
    expect((await request('/api/projects/migrate', { method: 'GET' })).response.status).toBe(405);
    expect((await request('/api/handoff/ho_deadbeef0000/consume', { method: 'GET' })).response.status).toBe(405);
    // 400: transport/field/state/id validation, following ApiValidationError mapping.
    expect((await request('/api/projects/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: 'bad' }) })).response.status).toBe(400);
    expect((await request('/api/projects/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idA, cwd: workspaceA }) })).response.status).toBe(400);
    expect((await request('/api/projects/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idA, projectId: 'not-a-project' }) })).response.status).toBe(400);
    expect((await request('/api/projects/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idA, name: 7 }) })).response.status).toBe(400);
    expect((await request('/api/projects/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idA, nope: true }) })).response.status).toBe(400);
    expect((await request('/api/handoff/inbox?workspace=bad')).response.status).toBe(400);
    expect((await request(`/api/handoff/inbox?workspace=${idA}&state=bogus`)).response.status).toBe(400);
    expect((await request(`/api/handoff/outbox?workspace=${idA}&limit=abc`)).response.status).toBe(400);
    expect((await request('/api/handoff/xyz/consume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idA }) })).response.status).toBe(400);
    expect((await request('/api/handoff/ho_deadbeef0000/consume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({}) })).response.status).toBe(400);
    // 404: well-formed but unknown workspace sidecar / unknown handoff id.
    expect((await request('/api/projects/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: '0'.repeat(16) }) })).response.status).toBe(404);
    expect((await request(`/api/handoff/inbox?workspace=${'0'.repeat(16)}`)).response.status).toBe(404);
    expect((await request('/api/handoff/ho_deadbeef0000/consume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idA }) })).response.status).toBe(404);
    expect((await request('/api/handoff/ho_deadbeef0000/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idA }) })).response.status).toBe(404);
  });

  it('migrates the current workspace into a project via HTTP, archives the legacy files, and stays idempotent', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const idB = workspaceIdForPath(workspaceB);

    // Seed one workspace-scope board record so migration has bytes to rewrite.
    const seeded = await request('/api/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ scope: 'workspace', workspace: idA, key: 'migrate/keep', value: 'v1', author: 'seed' }),
    });
    expect(seeded.response.status).toBe(200);

    const migrated = await request('/api/projects/migrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idA, name: 'Web Project' }),
    });
    expect(migrated.response.status).toBe(200);
    expect(migrated.body.projectId).toMatch(/^p_[0-9a-f]{12}$/);
    expect(migrated.body.moved).toBe(1);
    const projectId = migrated.body.projectId;

    const listed = await request('/api/projects');
    expect(listed.response.status).toBe(200);
    expect(listed.body.projects).toHaveLength(1);
    expect(listed.body.projects[0]).toMatchObject({
      projectId,
      name: 'Web Project',
      aliases: [idA],
      createdAt: expect.any(String),
    });

    // The mounted board's registry resolves the aliased path in-process, and the
    // rewritten record is readable from the project board with scope rewritten.
    expect(board.registry.resolveCached(idA)).toBe(projectId);
    const projectRows = await board.read('migrate/keep', undefined, `project:${projectId}`, 1);
    expect(projectRows).toHaveLength(1);
    expect(projectRows[0]).toMatchObject({ key: 'migrate/keep', value: 'v1', author: 'seed' });

    // Legacy ws file is archived (renamed, never deleted); the sidecar is gone so
    // the migrated workspace is no longer resolvable from the browser surface.
    const names = await readdir(join(home, 'boards'));
    expect(names.some((name) => name.startsWith(`ws-${idA}.jsonl.migrated-`))).toBe(true);
    expect(names).not.toContain(`ws-${idA}.jsonl`);
    expect((await request(`/api/handoff/inbox?workspace=${idA}`)).response.status).toBe(404);

    // Workspace B is untouched: its own workspace board has no migrated keys.
    const onlyB = await request(`/api/board?scope=workspace&workspace=${idB}&key=migrate%2Fkeep`);
    expect(onlyB.response.status).toBe(200);
    expect(onlyB.body.entries).toEqual([]);

    // Idempotent re-migration holds at the store level (the archived sidecar
    // makes the migrated workspace unresolvable over HTTP, by design).
    const again = await migrateWorkspaceToProject(workspaceA, {
      homeDir: home,
      registry: board.registry,
      projectId,
    });
    expect(again).toEqual({ projectId, moved: 0 });

    // A second-owner conflict: a workspace aliased to one project cannot be
    // migrated into another. Aliasing (not migration) keeps B's sidecar, so the
    // browser can still resolve it; the conflict surfaces as a 400 through the
    // existing plain-Error mapping.
    await board.registry.addAlias(projectId, idB);
    const other = await board.registry.createProject('Other');
    const conflict = await request('/api/projects/migrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idB, projectId: other }),
    });
    expect(conflict.response.status).toBe(400);
    expect(conflict.body.error).toContain('already aliased');
  });

  it('serves handoff inbox/outbox and consume/archive transitions over HTTP', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const idB = workspaceIdForPath(workspaceB);

    // Project B receives handoffs; alias B's path (keeps the sidecar, unlike
    // migration, so the browser can still resolve the workspace id).
    const projB = await board.registry.createProject('Recipient');
    await board.registry.addAlias(projB, idB);

    const handoffs = new HandoffStore(board);
    const sent = await handoffs.send(
      { toProject: projB, title: 'HTTP handoff', summary: 'via the browser', context: 'full context', author: 'session-a' },
      workspaceA,
    );
    expect(sent.fromProject).toBe(`ws:${idA}`);

    // Workspace A (unaliased) sees no inbox; the aliased recipient sees it.
    const emptyInbox = await request(`/api/handoff/inbox?workspace=${idA}`);
    expect(emptyInbox.response.status).toBe(200);
    expect(emptyInbox.body.handoffs).toEqual([]);

    const inbox = await request(`/api/handoff/inbox?workspace=${idB}&state=pending`);
    expect(inbox.response.status).toBe(200);
    expect(inbox.body).toMatchObject({ workspace: idB });
    expect(inbox.body.handoffs).toHaveLength(1);
    expect(inbox.body.handoffs[0]).toMatchObject({
      id: sent.id,
      title: 'HTTP handoff',
      summary: 'via the browser',
      fromProject: `ws:${idA}`,
      toProject: projB,
      state: 'pending',
    });
    // HTTP summaries omit the context payload (moa_handoff_read is the full reader).
    expect(inbox.body.handoffs[0]).not.toHaveProperty('context');

    // Outbox from A lists the handoff it sent into the target project.
    const outbox = await request(`/api/handoff/outbox?workspace=${idA}`);
    expect(outbox.response.status).toBe(200);
    expect(outbox.body.handoffs.map((row: any) => row.id)).toEqual([sent.id]);

    // Consume via HTTP: terminal state, consumedAt recorded, actor on the row.
    const consumed = await request(`/api/handoff/${sent.id}/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idB, actor: 'web-user' }),
    });
    expect(consumed.response.status).toBe(200);
    expect(consumed.body).toMatchObject({ id: sent.id, state: 'consumed', consumedAt: expect.any(String) });
    expect((await request(`/api/handoff/inbox?workspace=${idB}&state=consumed`)).body.handoffs).toHaveLength(1);

    // Illegal transition (consumed → consumed) maps to 409.
    const again = await request(`/api/handoff/${sent.id}/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idB }),
    });
    expect(again.response.status).toBe(409);
    expect(again.body.error).toContain('illegal handoff state transition');

    // Archive a second handoff; both terminal rows survive the "all" filter.
    const sent2 = await handoffs.send({ toProject: projB, title: 'Second', summary: 'archive me' }, workspaceA);
    const archived = await request(`/api/handoff/${sent2.id}/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ workspace: idB }),
    });
    expect(archived.response.status).toBe(200);
    expect(archived.body.state).toBe('archived');
    expect((await request(`/api/handoff/inbox?workspace=${idB}&state=pending`)).body.handoffs).toEqual([]);
    expect((await request(`/api/handoff/inbox?workspace=${idB}&state=archived`)).body.handoffs.map((row: any) => row.id)).toEqual([sent2.id]);
    expect((await request(`/api/handoff/inbox?workspace=${idB}&state=pending,consumed,archived`)).body.handoffs).toHaveLength(2);

    // The outbox reflects the consumed state by default (archived rows are
    // hidden); the "all" filter brings both terminal rows back.
    const outboxAfter = await request(`/api/handoff/outbox?workspace=${idA}`);
    expect(outboxAfter.body.handoffs.map((row: any) => row.id)).toEqual([sent.id]);
    const outboxAll = await request(`/api/handoff/outbox?workspace=${idA}&state=pending,consumed,archived`);
    expect(new Set(outboxAll.body.handoffs.map((row: any) => row.id))).toEqual(new Set([sent.id, sent2.id]));
  });

  it('serves the Projects and Handoff Inbox tabs and view anchors in the assembled page', async () => {
    const page = await request('/control-plane');
    expect(page.response.status).toBe(200);
    const html = page.body as string;

    for (const anchor of [
      'projectsTab', 'projectsView', 'projectsList', 'refreshProjects', 'projectsCount',
      'inboxTab', 'inboxView', 'inboxList', 'inboxState', 'refreshInbox', 'inboxViewButton', 'outboxViewButton',
    ]) {
      expect(html).toContain(anchor);
    }
    for (const endpoint of [
      '/api/projects', '/api/projects/migrate', '/api/handoff/inbox', '/api/handoff/outbox',
      "/api/handoff/' + encodeURIComponent(id) + '/consume",
      "/api/handoff/' + encodeURIComponent(id) + '/archive",
    ]) {
      expect(html).toContain(endpoint);
    }
    expect(html).toContain('data-i18n="memory.projects"');
    expect(html).toContain('data-i18n="memory.inbox"');
    expect(html).toContain("switchView('projects')");
    expect(html).toContain("switchView('inbox')");
    expect(html).toContain('loadProjects()');
    expect(html).toContain('loadInbox()');
    expect(html).toContain('migrateCurrentWorkspace');
    expect(html).toContain('consumeHandoff');
    expect(html).toContain('archiveHandoff');
    expect(html).toContain('proj-card');
    expect(html).toContain('ho-row');
    expect(html).toContain('Merge current workspace into this project');
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('window.prompt');
  });

  it('renames workspaces over HTTP: PUT sets, trims, clears, validates, and GET lists the name (task 5a)', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const idB = workspaceIdForPath(workspaceB);

    // Names start out absent.
    const before = await request('/api/workspaces');
    expect(before.body.workspaces.map((w: any) => w.name)).toEqual([null, null]);

    // PUT sets the name; the response row and the listing both carry it.
    const renamed = await request(`/api/workspaces/${idA}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: json({ name: '  Web Side  ' }),
    });
    expect(renamed.response.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: idA, cwd: workspaceA, name: 'Web Side' });
    const after = await request('/api/workspaces');
    expect(after.body.workspaces.find((w: any) => w.id === idA).name).toBe('Web Side');
    expect(after.body.workspaces.find((w: any) => w.id === idB).name).toBe(null);
    // The sidecar keeps cwd/created_at through the read-modify-write.
    const sidecar = JSON.parse(await readFile(join(home, 'boards', `ws-${idA}.meta.json`), 'utf8'));
    expect(sidecar).toMatchObject({ id: idA, cwd: workspaceA, name: 'Web Side' });

    // Empty string clears the name.
    const cleared = await request(`/api/workspaces/${idA}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: json({ name: '' }),
    });
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.name).toBe(null);
    expect((await request('/api/workspaces')).body.workspaces.find((w: any) => w.id === idA).name).toBe(null);

    // Validation: non-string, over-length, unsupported fields, unknown id, malformed id.
    expect((await request(`/api/workspaces/${idA}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: json({ name: 7 }) })).response.status).toBe(400);
    expect((await request(`/api/workspaces/${idA}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: json({ name: 'x'.repeat(81) }) })).response.status).toBe(400);
    expect((await request(`/api/workspaces/${idA}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: json({ name: 'ok', nope: true }) })).response.status).toBe(400);
    expect((await request(`/api/workspaces/${'0'.repeat(16)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: json({ name: 'x' }) })).response.status).toBe(404);
    expect((await request('/api/workspaces/not-an-id', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: json({ name: 'x' }) })).response.status).toBe(400);
    // Method routing on the new parameterized path.
    expect((await request(`/api/workspaces/${idA}`)).response.status).toBe(405);
    const notAllowed = await request(`/api/workspaces/${idA}`);
    expect(notAllowed.response.headers.get('allow')).toContain('PUT');
    expect(notAllowed.response.headers.get('allow')).toContain('DELETE');
  });

  it('browses migrated project content via project:<id> on GET endpoints after the old id 404s (task 5b)', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const idB = workspaceIdForPath(workspaceB);

    // Seed workspace A with a tip and a board entry, then migrate it.
    expect((await request('/api/tips', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idA, title: 'survivor', summary: 'migrated tip' }) })).response.status).toBe(200);
    expect((await request('/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ scope: 'workspace', workspace: idA, key: 'browse/keep', value: 'v1' }) })).response.status).toBe(200);
    const migrated = await request('/api/projects/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idA, name: 'Browsable' }) });
    expect(migrated.response.status).toBe(200);
    const projectId = migrated.body.projectId;

    // Migration recorded the cwd so project:<id> can resolve a path.
    const meta = JSON.parse(await readFile(join(home, 'boards', `project-${projectId}.meta.json`), 'utf8'));
    expect(meta).toMatchObject({ projectId, cwds: [workspaceA] });

    // The archived sidecar makes the old workspace id 404 on every GET.
    expect((await request(`/api/tips?workspace=${idA}`)).response.status).toBe(404);
    expect((await request(`/api/board?scope=workspace&workspace=${idA}`)).response.status).toBe(404);
    expect((await request(`/api/handoff/inbox?workspace=${idA}`)).response.status).toBe(404);

    // A handoff addressed to the project lands in the project inbox.
    const handoffs = new HandoffStore(board);
    const sent = await handoffs.send({ toProject: projectId, title: 'to project', summary: 'browse me' }, workspaceB);

    // project:<id> browses tips, board, and inbox/outbox through cwds[0].
    const tips = await request(`/api/tips?workspace=${encodeURIComponent(`project:${projectId}`)}`);
    expect(tips.response.status).toBe(200);
    expect(tips.body).toMatchObject({ workspace: `project:${projectId}` });
    expect(tips.body.tips.map((t: any) => t.title)).toEqual(['survivor']);
    const tipId = tips.body.tips[0].id;
    expect((await request(`/api/tips/${encodeURIComponent(tipId)}?workspace=${encodeURIComponent(`project:${projectId}`)}`)).response.status).toBe(200);

    const boardRows = await request(`/api/board?scope=workspace&workspace=${encodeURIComponent(`project:${projectId}`)}`);
    expect(boardRows.response.status).toBe(200);
    expect(boardRows.body.entries.map((e: any) => e.key)).toContain('browse/keep');

    const inbox = await request(`/api/handoff/inbox?workspace=${encodeURIComponent(`project:${projectId}`)}`);
    expect(inbox.response.status).toBe(200);
    expect(inbox.body.handoffs.map((h: any) => h.id)).toEqual([sent.id]);
    const outbox = await request(`/api/handoff/outbox?workspace=${idB}`);
    expect(outbox.body.handoffs.map((h: any) => h.id)).toEqual([sent.id]);

    // Missing meta / unknown project → 404; malformed project id → 400.
    const emptyProject = await board.registry.createProject('no meta yet');
    expect((await request(`/api/tips?workspace=project:${emptyProject}`)).response.status).toBe(404);
    expect((await request(`/api/tips?workspace=project:p_${'0'.repeat(12)}`)).response.status).toBe(404);
    expect((await request('/api/tips?workspace=project:not-a-project')).response.status).toBe(400);
    expect((await request('/api/board?scope=workspace&workspace=project:zzz')).response.status).toBe(400);

    // Contract evolution (0.3.2, was "browse-only, mutations 400"): after a
    // merge every member workspace aliases to the project scope, and the
    // archived member sidecars leave project:<id> as the ONLY UI handle —
    // keeping mutations strict made consume/archive on merged projects
    // impossible from the panel. Mutations now resolve project:<id> through
    // cwds[0]; alias resolution lands the write in the exact same project
    // scope any member workspace would hit.
    const boardWrite = await request('/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ scope: 'workspace', workspace: `project:${projectId}`, key: 'yes', value: 'write' }) });
    expect(boardWrite.response.status).toBe(200);
    expect(boardWrite.body).toMatchObject({ ok: true, entry: { key: 'yes', value: 'write' } });
    const tipCreate = await request('/api/tips', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: `project:${projectId}`, title: 'x', summary: 'y' }) });
    expect(tipCreate.response.status).toBe(200);
    expect(tipCreate.body).toMatchObject({ title: 'x' });
    const consumed = await request(`/api/handoff/${sent.id}/consume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: `project:${projectId}` }) });
    expect(consumed.response.status).toBe(200);
    expect(consumed.body).toMatchObject({ id: sent.id, state: 'consumed' });
    // The writes landed in the project scope, visible through the same view.
    expect((await request(`/api/board?scope=workspace&workspace=${encodeURIComponent(`project:${projectId}`)}`)).body.entries.map((e: any) => e.key)).toContain('yes');
    expect((await request(`/api/handoff/inbox?workspace=${encodeURIComponent(`project:${projectId}`)}&state=consumed`)).body.handoffs).toHaveLength(1);
  });

  it('self-heals legacy pre-task5 projects: project:<id> browses after the missing meta is repaired', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const boardsDir = join(home, 'boards');

    // Seed a tip while A is still a plain workspace, then simulate what a
    // pre-task5 migration left behind: records moved into project-<id>.jsonl,
    // the ws board + sidecar archived as .migrated-<ts>, the alias registered,
    // and NO project meta — the exact state that used to 404 on browse.
    expect((await request('/api/tips', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idA, title: 'legacy', summary: 'from before task 5' }) })).response.status).toBe(200);
    const projectId = await board.registry.createProject('legacy');
    const stamp = Date.now();
    await writeFile(join(boardsDir, `project-${projectId}.jsonl`), await readFile(join(boardsDir, `ws-${idA}.jsonl`), 'utf8'));
    await rename(join(boardsDir, `ws-${idA}.jsonl`), join(boardsDir, `ws-${idA}.jsonl.migrated-${stamp}`));
    await rename(join(boardsDir, `ws-${idA}.meta.json`), join(boardsDir, `ws-${idA}.meta.json.migrated-${stamp}`));
    await board.registry.addAlias(projectId, idA);

    // The legacy project's meta is missing: the first browse self-heals it
    // instead of 404ing, and the repaired meta lands on disk.
    const tips = await request(`/api/tips?workspace=${encodeURIComponent(`project:${projectId}`)}`);
    expect(tips.response.status).toBe(200);
    expect(tips.body).toMatchObject({ workspace: `project:${projectId}` });
    expect(tips.body.tips.map((t: any) => t.title)).toEqual(['legacy']);
    const meta = JSON.parse(await readFile(join(boardsDir, `project-${projectId}.meta.json`), 'utf8'));
    expect(meta).toMatchObject({ projectId, cwds: [workspaceA] });
    expect(typeof meta.created_at).toBe('string');

    // With the meta in place, a second browse is an ordinary read (no rewrite).
    expect((await request(`/api/tips?workspace=${encodeURIComponent(`project:${projectId}`)}`)).response.status).toBe(200);

    // A project with no aliases / no sidecar still 404s and writes no meta.
    const bare = await board.registry.createProject('bare');
    expect((await request(`/api/tips?workspace=${encodeURIComponent(`project:${bare}`)}`)).response.status).toBe(404);
    await expect(readFile(join(boardsDir, `project-${bare}.meta.json`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('releases workspaces over HTTP: archives files, unaliases, hides, and restarts empty (task 5c)', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const idB = workspaceIdForPath(workspaceB);

    // A has board content and an aliased project; releasing must drop the
    // alias first. (Write before aliasing so the record lands in the ws file.)
    expect((await request('/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ scope: 'workspace', workspace: idA, key: 'release/keep', value: 'v1' }) })).response.status).toBe(200);
    const projectId = await board.registry.createProject('victim');
    await board.registry.addAlias(projectId, idA);

    const released = await request(`/api/workspaces/${idA}`, { method: 'DELETE' });
    expect(released.response.status).toBe(200);
    expect(released.body).toEqual({ ok: true, id: idA, releasedAlias: true });

    // Files are archived with .released- stamps; nothing is deleted.
    const names = await readdir(join(home, 'boards'));
    expect(names).not.toContain(`ws-${idA}.jsonl`);
    expect(names).not.toContain(`ws-${idA}.meta.json`);
    expect(names.some((n) => n.startsWith(`ws-${idA}.jsonl.released-`))).toBe(true);
    expect(names.some((n) => n.startsWith(`ws-${idA}.meta.json.released-`))).toBe(true);

    // The alias is gone (the project itself survives), the listing loses A,
    // and the old id no longer resolves.
    await board.registry.refreshIfStale();
    expect(board.registry.resolveCached(idA)).toBeUndefined();
    expect((await request('/api/projects')).body.projects[0].projectId).toBe(projectId);
    expect((await request('/api/workspaces')).body.workspaces.map((w: any) => w.id)).toEqual([idB]);
    expect((await request(`/api/tips?workspace=${idA}`)).response.status).toBe(404);
    expect((await request(`/api/workspaces/${idA}`, { method: 'DELETE' })).response.status).toBe(404);

    // The directory's next write starts from an empty board in a fresh file.
    await board.write('fresh/start', 'v2', undefined, 'seed', 'workspace', workspaceA);
    const freshNames = await readdir(join(home, 'boards'));
    expect(freshNames).toContain(`ws-${idA}.jsonl`);
    const rows = await board.read(undefined, undefined, 'workspace', undefined, workspaceA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'fresh/start', value: 'v2' });

    // Unaliased release reports releasedAlias false; malformed ids are 400s.
    expect((await request(`/api/workspaces/${idB}`, { method: 'DELETE' })).body).toEqual({ ok: true, id: idB, releasedAlias: false });
    expect((await request('/api/workspaces/bad-id', { method: 'DELETE' })).response.status).toBe(400);
  });

  it('serves the workspace rename/release/project-browse frontend contract in the assembled page (task 5)', async () => {
    const page = await request('/control-plane');
    expect(page.response.status).toBe(200);
    const html = page.body as string;

    // Workspace bar actions + inline rename form (no window.prompt anywhere).
    for (const anchor of [
      'renameWorkspaceButton', 'releaseWorkspaceButton', 'workspaceRename',
      'workspaceRenameInput', 'workspaceRenameSave', 'workspaceRenameCancel',
    ]) {
      expect(html).toContain(anchor);
    }
    expect(html).toContain('maxlength="80"');
    expect(html).toContain("document.createElement('optgroup')");
    expect(html).toContain("tr('workspace.groupWorkspaces')");
    expect(html).toContain("tr('workspace.groupProjects')");
    expect(html).toContain("'project:' + project.projectId");
    expect(html).toContain("tr('workspace.releaseConfirm'");
    expect(html).toContain('workspace.renamed');
    expect(html).toContain("method: 'PUT'");
    expect(html).toContain("method: 'DELETE'");
    expect(html).toContain("'/api/workspaces/' + encodeURIComponent(");
    expect(html).toContain("api('/api/projects').catch(");
    // Project selections subscribe to the project board channel.
    expect(html).toContain("if (currentWorkspace && isProjectValue(currentWorkspace)) return '@board/' + currentWorkspace");
    // Display contract: named workspaces show "name (cwd)".
    expect(html).toContain("item.name ? item.name + ' (' + item.cwd + ')' : item.cwd");
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('window.prompt');
    expect(html).not.toContain('insertAdjacent' + 'HTML');
  });
});

describe('control plane across Bus instances sharing sidecars', () => {
  it('reopens the same Tip from a second BoardStore/Bus without using the second host cwd', async () => {
    const idA = workspaceIdForPath(workspaceA);
    await tips.create({ title: 'shared', summary: 'from first instance' }, workspaceA);

    const secondBusCwd = await mkdtemp(join(home, 'second-bus-cwd-'));
    const secondBus = new Bus({ port: 0, cwd: secondBusCwd, instancesDir: join(home, 'instances-2'), logsDir: join(home, 'logs') });
    const secondBoard = new BoardStore({ homeDir: home, workspaceCwd: workspaceB });
    const secondTips = new TipStore(secondBoard);
    try {
      await secondBus.start();
      secondBus.mountControlPlane(secondBoard, secondTips);
      const response = await fetch(`http://127.0.0.1:${secondBus.actualPort}/api/tips?workspace=${idA}`);
      expect(response.status).toBe(200);
      expect((await response.json()).tips[0]).toMatchObject({ title: 'shared', summary: 'from first instance' });
      const ownWorkspace = await fetch(`http://127.0.0.1:${secondBus.actualPort}/api/tips?workspace=${workspaceIdForPath(workspaceB)}`);
      expect((await ownWorkspace.json()).tips).toEqual([]);
    } finally {
      await secondBoard.close();
      await secondBus.stop();
      await rm(secondBusCwd, { recursive: true, force: true });
    }
  });
});
