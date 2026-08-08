/**
 * Project management tests (mailbox task 6): the three management actions —
 * rename (6a), alias detach / un-merge (6b), and archive / soft-delete (6c) —
 * across the ProjectRegistry projection, the BoardStore file helpers, the
 * Control Plane HTTP surface, and the assembled frontend contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore, workspaceIdForPath } from '../src/core/store/board.js';
import { ProjectRegistry, PROJECT_NAME_MAX_CHARS, newProjectId } from '../src/core/store/project-registry.js';
import { migrateWorkspaceToProject } from '../src/core/store/project-migration.js';
import { Bus } from '../src/core/bus/bus.js';
import { TipStore } from '../src/modules/tips/tips.js';

const json = (value: unknown): string => JSON.stringify(value);

// ---- store layer: registry archive projection (task 6c) ----

describe('project registry archive projection (task 6c)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'moamcp-pm-registry-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const registryFile = () => join(home, 'registry.jsonl');
  async function records(): Promise<Array<Record<string, unknown>>> {
    return (await readFile(registryFile(), 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('archiveProject appends an archive record (append-only; history untouched)', async () => {
    const r = new ProjectRegistry({ homeDir: home });
    const id = await r.createProject('victim');
    await r.addAlias(id, 'abcdef0123456789');
    await r.archiveProject(id);

    const recs = await records();
    expect(recs.map((rec) => rec.op)).toEqual(['create', 'alias', 'archive']);
    expect(recs[2]).toMatchObject({ op: 'archive', projectId: id });
    expect(recs.every((rec) => typeof rec.ts === 'string')).toBe(true);
  });

  it('an archived project disappears from listProjects and stops resolving', async () => {
    const r = new ProjectRegistry({ homeDir: home });
    const keep = await r.createProject('keep');
    const gone = await r.createProject('gone');
    await r.addAlias(gone, '0123456789abcdef');
    expect(r.resolveCached('0123456789abcdef')).toBe(gone);

    await r.archiveProject(gone);
    expect((await r.listProjects()).map((p) => p.projectId)).toEqual([keep]);
    // The alias is inert even before any unalias record lands.
    expect(r.resolveCached('0123456789abcdef')).toBeUndefined();
  });

  it('archive projection survives a reopen (second instance folds the tombstone)', async () => {
    const first = new ProjectRegistry({ homeDir: home });
    const id = await first.createProject('ephemeral');
    await first.archiveProject(id);

    const second = new ProjectRegistry({ homeDir: home });
    expect(await second.listProjects()).toEqual([]);
    expect(second.resolveCached('whatever')).toBeUndefined();
  });

  it('mutations treat an archived project as unknown: addAlias / rename / re-archive all reject', async () => {
    const r = new ProjectRegistry({ homeDir: home });
    const id = await r.createProject('sealed');
    await r.archiveProject(id);

    await expect(r.addAlias(id, 'ffffffffffffffff')).rejects.toThrow(/unknown projectId/);
    await expect(r.renameProject(id, 'nope')).rejects.toThrow(/unknown projectId/);
    await expect(r.archiveProject(id)).rejects.toThrow(/unknown projectId/);
    await expect(r.archiveProject(newProjectId())).rejects.toThrow(/unknown projectId/);
    await expect(r.archiveProject('bogus')).rejects.toThrow(/invalid projectId/);
  });

  it('renameProject trims, enforces the name cap, and keeps rejecting empty names', async () => {
    const r = new ProjectRegistry({ homeDir: home });
    const id = await r.createProject('before');
    await r.renameProject(id, '  padded  ');
    expect((await r.listProjects())[0].name).toBe('padded');
    await expect(r.renameProject(id, 'x'.repeat(PROJECT_NAME_MAX_CHARS + 1))).rejects.toThrow(/exceeds/);
    await expect(r.renameProject(id, '')).rejects.toThrow(/name/);
    await expect(r.renameProject(id, '   ')).rejects.toThrow(/name/);
    await expect(r.renameProject(id, 7)).rejects.toThrow(/name must be a string/);
  });
});

// ---- store layer: board file helpers (task 6b / 6c) ----

describe('board project management helpers (task 6b/6c)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'moamcp-pm-board-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function store(cwd: string): BoardStore {
    return new BoardStore({ homeDir: home, workspaceCwd: cwd, waitCapMs: 400 });
  }
  const boardsDir = () => join(home, 'boards');

  it('removeProjectCwd drops just the matching cwd from the project meta under the lock', async () => {
    const cwdA = join(home, 'cwd-a');
    const cwdB = join(home, 'cwd-b');
    const b = store(cwdA);
    const projectId = await b.registry.createProject();
    await b.registry.addAlias(projectId, workspaceIdForPath(cwdA));
    await b.registry.addAlias(projectId, workspaceIdForPath(cwdB));
    // Touch both scopes so both cwds land in the sidecar.
    await b.write('k/a', 'v', undefined, 's', 'workspace', cwdA);
    await b.write('k/b', 'v', undefined, 's', 'workspace', cwdB);

    await b.removeProjectCwd(projectId, cwdA);
    let meta = JSON.parse(await readFile(join(boardsDir(), `project-${projectId}.meta.json`), 'utf8'));
    expect(meta.cwds).toEqual([cwdB]);

    // Removing an absent cwd is a no-op; the other cwd survives.
    await b.removeProjectCwd(projectId, cwdA);
    meta = JSON.parse(await readFile(join(boardsDir(), `project-${projectId}.meta.json`), 'utf8'));
    expect(meta.cwds).toEqual([cwdB]);
    await expect(b.removeProjectCwd('bogus', cwdA)).rejects.toThrow(/invalid projectId/);
    await b.close();
  });

  it('restoreWorkspaceSidecar restores the newest migrated sidecar only', async () => {
    const cwd = join(home, 'restore-me');
    const hash = workspaceIdForPath(cwd);
    const b = store(cwd);
    const info = await b.registerWorkspace(cwd);
    const projectId = await b.registry.createProject();
    await b.registry.addAlias(projectId, hash);

    // No archive yet: nothing to restore.
    expect(await b.restoreWorkspaceSidecar(hash)).toBe(false);

    // Archive the sidecar twice (two migrated copies), then restore → newest wins.
    await rename(join(boardsDir(), `ws-${hash}.meta.json`), join(boardsDir(), `ws-${hash}.meta.json.migrated-1000`));
    await writeFile(
      join(boardsDir(), `ws-${hash}.meta.json.migrated-2000`),
      JSON.stringify({ id: hash, cwd, created_at: new Date().toISOString(), name: 'Newest' }, null, 2),
    );
    expect(await b.restoreWorkspaceSidecar(hash)).toBe(true);
    const names = await readdir(boardsDir());
    expect(names).toContain(`ws-${hash}.meta.json`);
    const restored = JSON.parse(await readFile(join(boardsDir(), `ws-${hash}.meta.json`), 'utf8'));
    expect(restored.name).toBe('Newest'); // the newest archive, not migrated-1000
    // A live sidecar now exists: a second restore is a no-op.
    expect(await b.restoreWorkspaceSidecar(hash)).toBe(false);
    expect(info.id).toBe(hash);
    await b.close();
  });

  it('detachProjectAlias removes the cwd, restores the sidecar AND the pre-migration ws board, keeping project data', async () => {
    const cwd = join(home, 'detachable');
    const hash = workspaceIdForPath(cwd);
    const b = store(cwd);
    await b.write('detach/keep', 'v1', undefined, 's', 'workspace', cwd);
    // Migration archives the ws sidecar to .migrated-* and moves the record to the project.
    const { projectId } = await migrateWorkspaceToProject(cwd, { homeDir: home, registry: b.registry });

    const result = await b.detachProjectAlias(projectId, hash);
    expect(result).toEqual({ removedCwd: cwd, restoredSidecar: true, restoredBoard: true });

    // The project keeps its migrated record; the directory is a workspace
    // again with its pre-migration ws board restored (plan c: rollback).
    expect((await b.read('detach/keep', undefined, `project:${projectId}`, 1))[0]).toMatchObject({ value: 'v1' });
    expect((await b.listWorkspaces()).some((w) => w.id === hash)).toBe(true);
    const meta = JSON.parse(await readFile(join(boardsDir(), `project-${projectId}.meta.json`), 'utf8'));
    expect(meta.cwds).toEqual([]);
    await b.close();
  });

  it('archiveProject archives the files and drops every alias', async () => {
    const cwd = join(home, 'archivable');
    const hash = workspaceIdForPath(cwd);
    const b = store(cwd);
    const projectId = await b.registry.createProject('doomed');
    await b.registry.addAlias(projectId, hash);
    // Write after aliasing so the record lands in the project board file.
    await b.write('archive/keep', 'v1', undefined, 's', 'workspace', cwd);

    const result = await b.archiveProject(projectId);
    expect(result).toEqual({ ok: true, projectId });

    const names = await readdir(boardsDir());
    expect(names).not.toContain(`project-${projectId}.jsonl`);
    expect(names).not.toContain(`project-${projectId}.meta.json`);
    expect(names.some((n) => n.startsWith(`project-${projectId}.jsonl.archived-`))).toBe(true);
    expect(names.some((n) => n.startsWith(`project-${projectId}.meta.json.archived-`))).toBe(true);
    const archived = await readFile(join(boardsDir(), names.find((n) => n.startsWith(`project-${projectId}.jsonl.archived-`)) as string), 'utf8');
    expect(archived).toContain('archive/keep');

    // Alias removed, project hidden, and the archived board content is intact.
    await b.registry.refreshIfStale();
    expect(b.registry.resolveCached(hash)).toBeUndefined();
    expect(await b.registry.listProjects()).toEqual([]);
    await expect(b.archiveProject(projectId)).rejects.toThrow(/unknown projectId/);
    await b.close();
  });
});

// ---- HTTP layer + frontend contract (task 6a/6b/6c) ----

describe('control plane project management (task 6)', () => {
  let home: string;
  let workspaceA: string;
  let workspaceB: string;
  let busCwd: string;
  let bus: Bus;
  let board: BoardStore;
  let port: number;

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

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'moamcp-pm-http-'));
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
    bus.mountControlPlane(board, new TipStore(board));
    await board.registerWorkspace(workspaceA);
    await board.registerWorkspace(workspaceB);
  });

  afterEach(async () => {
    await board.close();
    await bus.stop();
    await rm(home, { recursive: true, force: true });
  });

  const put = (path: string, body: unknown): Promise<{ response: Response; body: any }> =>
    request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: json(body) });

  it('renames projects over HTTP: PUT sets/trims, validates, 404s unknown, and lists the new name (6a)', async () => {
    const projectId = await board.registry.createProject('before');

    const renamed = await put(`/api/projects/${projectId}`, { name: '  Web Side  ' });
    expect(renamed.response.status).toBe(200);
    expect(renamed.body).toEqual({ ok: true, projectId, name: 'Web Side' });
    const after = await request('/api/projects');
    expect(after.body.projects.find((p: any) => p.projectId === projectId).name).toBe('Web Side');

    // Validation: empty / whitespace-only (projects keep a name once set), non-string, over-length, extra field.
    expect((await put(`/api/projects/${projectId}`, { name: '' })).response.status).toBe(400);
    expect((await put(`/api/projects/${projectId}`, { name: '   ' })).response.status).toBe(400);
    expect((await put(`/api/projects/${projectId}`, { name: 7 })).response.status).toBe(400);
    expect((await put(`/api/projects/${projectId}`, { name: 'x'.repeat(PROJECT_NAME_MAX_CHARS + 1) })).response.status).toBe(400);
    expect((await put(`/api/projects/${projectId}`, { name: 'ok', nope: true })).response.status).toBe(400);
    // Unknown / malformed id, and method routing.
    expect((await put(`/api/projects/${newProjectId()}`, { name: 'x' })).response.status).toBe(404);
    expect((await put('/api/projects/not-a-project', { name: 'x' })).response.status).toBe(400);
    const notAllowed = await request(`/api/projects/${projectId}`);
    expect(notAllowed.response.status).toBe(405);
    expect(notAllowed.response.headers.get('allow')).toContain('PUT');
  });

  it('detaches an alias over HTTP: alias removed, meta cwd dropped, sidecar restored, next write independent (6b)', async () => {
    const idA = workspaceIdForPath(workspaceA);
    // Seed a record, then migrate so the sidecar becomes a .migrated-* archive.
    expect((await request('/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ scope: 'workspace', workspace: idA, key: 'detach/keep', value: 'v1' }) })).response.status).toBe(200);
    const migrated = await request('/api/projects/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idA, name: 'Detachable' }) });
    expect(migrated.response.status).toBe(200);
    const projectId = migrated.body.projectId;
    expect((await request('/api/workspaces')).body.workspaces.some((w: any) => w.id === idA)).toBe(false);

    // A hash that belongs to another project (or none) 404s; so does a malformed hash.
    const other = await board.registry.createProject('other');
    expect((await request(`/api/projects/${other}/aliases/${idA}`, { method: 'DELETE' })).response.status).toBe(404);
    expect((await request(`/api/projects/${projectId}/aliases/${'0'.repeat(16)}`, { method: 'DELETE' })).response.status).toBe(404);
    expect((await request(`/api/projects/${projectId}/aliases/not-a-hash`, { method: 'DELETE' })).response.status).toBe(404);
    expect((await request(`/api/projects/${newProjectId()}/aliases/${idA}`, { method: 'DELETE' })).response.status).toBe(404);

    // The real detach succeeds and reports the restored sidecar.
    const detached = await request(`/api/projects/${projectId}/aliases/${idA}`, { method: 'DELETE' });
    expect(detached.response.status).toBe(200);
    expect(detached.body).toEqual({ ok: true, projectId, pathHash: idA, removedCwd: workspaceA, restoredSidecar: true });

    // Alias gone, the project survives with an empty cwds list, and the
    // directory is back in the workspace listing (sidecar restored).
    await board.registry.refreshIfStale();
    expect(board.registry.resolveCached(idA)).toBeUndefined();
    expect((await request('/api/projects')).body.projects.find((p: any) => p.projectId === projectId).aliases).toEqual([]);
    const meta = JSON.parse(await readFile(join(home, 'boards', `project-${projectId}.meta.json`), 'utf8'));
    expect(meta.cwds).toEqual([]);
    expect((await request('/api/workspaces')).body.workspaces.some((w: any) => w.id === idA)).toBe(true);

    // The project keeps the migrated record; the restored ws board means the
    // directory's next write lands in the pre-migration snapshot (plan c:
    // detach = rollback), independent of the project board.
    expect((await board.read('detach/keep', undefined, `project:${projectId}`, 1))[0]).toMatchObject({ value: 'v1' });
    await board.write('detach/after', 'v2', undefined, 'seed', 'workspace', workspaceA);
    const names = await readdir(join(home, 'boards'));
    expect(names).toContain(`ws-${idA}.jsonl`);
    const wsRows = await board.read(undefined, undefined, 'workspace', undefined, workspaceA);
    expect(wsRows.map((r) => r.key)).toEqual(['detach/after', 'detach/keep']); // restored record + the new one
    expect(wsRows.find((r) => r.key === 'detach/keep')).toMatchObject({ value: 'v1' });

    // Detaching again is now a 404 (the alias no longer belongs to the project).
    expect((await request(`/api/projects/${projectId}/aliases/${idA}`, { method: 'DELETE' })).response.status).toBe(404);
  });

  it('archives a project over HTTP: hidden, files archived, aliases dropped, browse/second-archive 404 (6c)', async () => {
    const idA = workspaceIdForPath(workspaceA);
    expect((await request('/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ scope: 'workspace', workspace: idA, key: 'archive/keep', value: 'v1' }) })).response.status).toBe(200);
    const migrated = await request('/api/projects/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idA, name: 'Archivable' }) });
    const projectId = migrated.body.projectId;

    const archived = await request(`/api/projects/${projectId}/archive`, { method: 'POST' });
    expect(archived.response.status).toBe(200);
    expect(archived.body).toEqual({ ok: true, projectId });

    // Gone from the listing; files archived (never deleted); alias dropped.
    expect((await request('/api/projects')).body.projects).toEqual([]);
    const names = await readdir(join(home, 'boards'));
    expect(names).not.toContain(`project-${projectId}.jsonl`);
    expect(names).not.toContain(`project-${projectId}.meta.json`);
    expect(names.some((n) => n.startsWith(`project-${projectId}.jsonl.archived-`))).toBe(true);
    expect(names.some((n) => n.startsWith(`project-${projectId}.meta.json.archived-`))).toBe(true);
    await board.registry.refreshIfStale();
    expect(board.registry.resolveCached(idA)).toBeUndefined();

    // Browsing the archived project 404s (meta archived, projection filters it).
    expect((await request(`/api/tips?workspace=${encodeURIComponent(`project:${projectId}`)}`)).response.status).toBe(404);
    expect((await request(`/api/board?scope=workspace&workspace=${encodeURIComponent(`project:${projectId}`)}`)).response.status).toBe(404);

    // Second archive / unknown / malformed all 404/400.
    expect((await request(`/api/projects/${projectId}/archive`, { method: 'POST' })).response.status).toBe(404);
    expect((await request(`/api/projects/${newProjectId()}/archive`, { method: 'POST' })).response.status).toBe(404);
    expect((await request('/api/projects/not-a-project/archive', { method: 'POST' })).response.status).toBe(400);
    // Renaming an archived project 404s too.
    expect((await put(`/api/projects/${projectId}`, { name: 'ghost' })).response.status).toBe(404);
  });

  it('lists member workspace directories per project (GET /api/projects enrichment)', async () => {
    const idA = workspaceIdForPath(workspaceA);
    const idB = workspaceIdForPath(workspaceB);
    await request('/api/projects/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idA, name: 'Dirs' }) });
    const projectsAfterFirst = (await request('/api/projects')).body.projects;
    const projectId = projectsAfterFirst[0].projectId;
    // Second workspace joins via migrate targeting the existing project.
    await request('/api/projects/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ workspace: idB, projectId }) });

    const projects = (await request('/api/projects')).body.projects;
    expect(projects).toHaveLength(1);
    const dirs = projects[0].workspaces;
    expect(Array.isArray(dirs)).toBe(true);
    expect(dirs).toHaveLength(2);
    const byHash = Object.fromEntries(dirs.map((d: any) => [d.hash, d.cwd]));
    expect(byHash[idA]).toBe(workspaceA);
    expect(byHash[idB]).toBe(workspaceB);
    // Legacy alias shape stays intact for existing consumers.
    expect(projects[0].aliases.sort()).toEqual([idA, idB].sort());
  });

  it('serves the project rename/detach/archive frontend contract in the assembled page (task 6)', async () => {
    const page = await request('/control-plane');
    expect(page.response.status).toBe(200);
    const html = page.body as string;

    // Rename (inline editor reusing the workspace-rename pattern).
    expect(html).toContain('openProjectRename');
    expect(html).toContain("'/api/projects/' + encodeURIComponent(project.projectId)");
    expect(html).toContain('projects.renamePlaceholder');
    expect(html).toContain('projects.renamed');
    expect(html).toContain('projects.renameRequired');
    // Alias detach (× chip button + confirm).
    expect(html).toContain('proj-alias-detach');
    expect(html).toContain('detachProjectAliasAction');
    expect(html).toContain("'/aliases/' + encodeURIComponent(alias)");
    expect(html).toContain("tr('projects.detachConfirm'");
    expect(html).toContain('projects.detached');
    // Archive (danger button + confirm).
    expect(html).toContain('archiveProjectAction');
    expect(html).toContain("+ '/archive'");
    expect(html).toContain("tr('projects.archiveConfirm'");
    expect(html).toContain('projects.archived');
    // Safety contract: safe DOM construction only.
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('window.prompt');
    expect(html).not.toContain('insertAdjacent' + 'HTML');
  });
});
