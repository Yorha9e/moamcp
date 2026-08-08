/**
 * Alias-detach snapshot-restore tests (plan c: detach = rollback to the
 * pre-migration snapshot). Detaching a project alias restores the directory's
 * archived `ws-<hash>.jsonl.migrated-*` board — board records and tips alike —
 * while the project board keeps the merge records untouched. Covers the full
 * restore, the no-archive regression (empty-board behavior), the same-hash
 * migrated-archive rotation on re-migration, and project-board invariance.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore, workspaceIdForPath } from '../src/core/store/board.js';
import { migrateWorkspaceToProject } from '../src/core/store/project-migration.js';
import { TipStore } from '../src/modules/tips/tips.js';

describe('detachProjectAlias restores the pre-migration ws board (plan c)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'moamcp-detach-restore-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const boardsDir = () => join(home, 'boards');
  function store(cwd: string): BoardStore {
    return new BoardStore({ homeDir: home, workspaceCwd: cwd, waitCapMs: 400 });
  }
  const wsBoardFile = (cwd: string) => join(boardsDir(), `ws-${workspaceIdForPath(cwd)}.jsonl`);

  it('restores the full pre-migration ws board: board records and tips back line by line', async () => {
    const cwd = join(home, 'restore-full');
    const hash = workspaceIdForPath(cwd);
    const b = store(cwd);
    // Seed a board record (with an LWW overwrite) and a tip before merging.
    await b.write('notes/spec', 'v1', ['x'], 'alice', 'workspace', cwd);
    await b.write('notes/spec', 'v2', ['x'], 'alice', 'workspace', cwd);
    const tips = new TipStore(b);
    const tip = await tips.create(cwd, { title: 'seeded', summary: 'pre-merge', context: 'keep me' });

    // Snapshot the exact pre-migration ws board lines; the archive is a pure
    // rename, so a restore must reproduce them one-for-one.
    const preLines = (await readFile(wsBoardFile(cwd), 'utf8')).trim().split('\n');

    const { projectId } = await migrateWorkspaceToProject(cwd, { homeDir: home, registry: b.registry });
    await b.registry.removeAlias(hash);
    const result = await b.detachProjectAlias(projectId, hash);
    expect(result).toEqual({ removedCwd: cwd, restoredSidecar: true, restoredBoard: true });

    // The restored ws board is byte-identical to the pre-migration snapshot.
    const restoredLines = (await readFile(wsBoardFile(cwd), 'utf8')).trim().split('\n');
    expect(restoredLines).toEqual(preLines);

    // Folding the restored board recovers every record: the LWW board value...
    const spec = await b.read('notes/spec', undefined, 'workspace', undefined, cwd);
    expect(spec[0]).toMatchObject({ key: 'notes/spec', value: 'v2', author: 'alice', tags: ['x'] });
    // ...and the tip, through both the raw fold and the typed view.
    const wsRows = await b.read(undefined, undefined, 'workspace', undefined, cwd);
    expect(wsRows.some((row) => row.key === `tips/${tip.id}`)).toBe(true);
    const restoredTip = await tips.read(cwd, tip.id);
    expect(restoredTip?.title).toBe('seeded');
    await b.close();
  });

  it('with no migrated archive, detach keeps the empty-board behavior (regression)', async () => {
    const cwd = join(home, 'no-archive');
    const hash = workspaceIdForPath(cwd);
    const b = store(cwd);
    await b.registerWorkspace(cwd); // live sidecar, no board, no migration
    const projectId = await b.registry.createProject('plain');
    await b.registry.addAlias(projectId, hash);

    await b.registry.removeAlias(hash);
    const result = await b.detachProjectAlias(projectId, hash);
    // The live sidecar blocks a sidecar restore and no board archive exists.
    expect(result).toEqual({ restoredSidecar: false, restoredBoard: false });
    const names = await readdir(boardsDir());
    expect(names).not.toContain(`ws-${hash}.jsonl`);
    expect(names.some((n) => n.startsWith(`ws-${hash}.jsonl.migrated-`))).toBe(false);

    // The next write still starts from an empty board: only the new record.
    await b.write('fresh/only', 'v', undefined, 'a', 'workspace', cwd);
    const rows = await b.read(undefined, undefined, 'workspace', undefined, cwd);
    expect(rows.map((r) => r.key)).toEqual(['fresh/only']);
    await b.close();
  });

  it('a second migration for the same hash prunes older migrated archives (rotation)', async () => {
    const cwd = join(home, 'rotate');
    const hash = workspaceIdForPath(cwd);
    const b = store(cwd);
    await b.write('rotate/one', 'v1', undefined, 'a', 'workspace', cwd);

    const first = await migrateWorkspaceToProject(cwd, { homeDir: home, registry: b.registry });
    let names = await readdir(boardsDir());
    expect(names.filter((n) => n.startsWith(`ws-${hash}.jsonl.migrated-`))).toHaveLength(1);
    expect(names.filter((n) => n.startsWith(`ws-${hash}.meta.json.migrated-`))).toHaveLength(1);

    // Detach consumes the newest archive; leave an older leftover behind the
    // way a pre-rotation detach (restoring only the newest copy) would.
    await b.registry.removeAlias(hash);
    await b.detachProjectAlias(first.projectId, hash);
    await b.write('rotate/two', 'v2', undefined, 'a', 'workspace', cwd);
    await writeFile(join(boardsDir(), `ws-${hash}.jsonl.migrated-1`), 'stale\n');
    await writeFile(join(boardsDir(), `ws-${hash}.meta.json.migrated-1`), '{}\n');

    // The re-migration creates a fresh archive and sweeps the stale ones.
    await migrateWorkspaceToProject(cwd, { homeDir: home, registry: b.registry });
    names = await readdir(boardsDir());
    const boardArchives = names.filter((n) => n.startsWith(`ws-${hash}.jsonl.migrated-`));
    const metaArchives = names.filter((n) => n.startsWith(`ws-${hash}.meta.json.migrated-`));
    expect(boardArchives).toHaveLength(1);
    expect(metaArchives).toHaveLength(1);
    expect(boardArchives[0]).not.toBe(`ws-${hash}.jsonl.migrated-1`);
    expect(metaArchives[0]).not.toBe(`ws-${hash}.meta.json.migrated-1`);
    await b.close();
  });

  it('detach leaves the project board byte-identical (merge records stay in the project)', async () => {
    const cwd = join(home, 'project-intact');
    const hash = workspaceIdForPath(cwd);
    const b = store(cwd);
    await b.write('notes/keep', 'v1', ['t'], 'a', 'workspace', cwd);
    const { projectId } = await migrateWorkspaceToProject(cwd, { homeDir: home, registry: b.registry });
    const projectFile = join(boardsDir(), `project-${projectId}.jsonl`);
    const before = await readFile(projectFile, 'utf8');
    expect(before).toContain('notes/keep');

    await b.registry.removeAlias(hash);
    const result = await b.detachProjectAlias(projectId, hash);
    expect(result).toMatchObject({ removedCwd: cwd, restoredSidecar: true, restoredBoard: true });

    // The project board file is untouched and still folds its merge records.
    expect(await readFile(projectFile, 'utf8')).toBe(before);
    const rows = await b.read('notes/keep', undefined, `project:${projectId}`, 1);
    expect(rows[0]).toMatchObject({ key: 'notes/keep', value: 'v1', tags: ['t'] });
    await b.close();
  });
});
