/**
 * Project registry tests (mailbox task 2): the documented JSONL record schema
 * (create/alias/unalias/rename), addAlias idempotency + second-owner conflict,
 * synchronous resolveCached, and the size-driven projection invalidation
 * (rebuild across instances, external appends, malformed-line skip, shrink).
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry, newProjectId } from '../src/core/store/project-registry.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'moamcp-registry-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const registryFile = () => join(home, 'registry.jsonl');

/** Every record on disk, in append order. */
async function records(): Promise<Array<Record<string, unknown>>> {
  return (await readFile(registryFile(), 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---- CRUD + record schema ----

it('createProject returns p_<12hex> ids and folds them into listProjects', async () => {
  const r = new ProjectRegistry({ homeDir: home });
  const a = await r.createProject('alpha');
  const b = await r.createProject();
  expect(a).toMatch(/^p_[0-9a-f]{12}$/);
  expect(b).toMatch(/^p_[0-9a-f]{12}$/);
  expect(a).not.toBe(b);
  expect(newProjectId()).toMatch(/^p_[0-9a-f]{12}$/);

  const list = await r.listProjects();
  expect(list).toHaveLength(2);
  expect(list[0]).toMatchObject({ projectId: a, name: 'alpha', aliases: [] });
  expect(list[0].createdAt).toEqual(expect.any(String));
  expect('name' in list[1]).toBe(false); // unnamed create carries no name key
});

it('writes the documented record schema: create/alias/rename/unalias with ts', async () => {
  const r = new ProjectRegistry({ homeDir: home });
  const id = await r.createProject('x');
  await r.addAlias(id, 'abcdef0123456789');
  await r.renameProject(id, 'y');
  await r.removeAlias('abcdef0123456789');

  const recs = await records();
  expect(recs).toHaveLength(4);
  expect(recs[0]).toMatchObject({ op: 'create', projectId: id, name: 'x' });
  expect(recs[1]).toMatchObject({ op: 'alias', projectId: id, pathHash: 'abcdef0123456789' });
  expect(recs[2]).toMatchObject({ op: 'rename', projectId: id, name: 'y' });
  expect(recs[3]).toMatchObject({ op: 'unalias', projectId: id, pathHash: 'abcdef0123456789' });
  expect(recs.every((rec) => typeof rec.ts === 'string' && !Number.isNaN(Date.parse(rec.ts as string)))).toBe(true);
});

// ---- alias semantics ----

it('addAlias is idempotent: the second identical call appends nothing', async () => {
  const r = new ProjectRegistry({ homeDir: home });
  const id = await r.createProject();
  await r.addAlias(id, 'aabbccddeeff0011');
  await r.addAlias(id, 'aabbccddeeff0011');

  expect((await records()).map((rec) => rec.op)).toEqual(['create', 'alias']); // one alias record
  expect((await r.listProjects())[0].aliases).toEqual(['aabbccddeeff0011']);
  expect(r.resolveCached('aabbccddeeff0011')).toBe(id);
});

it('addAlias rejects a second owner for the same pathHash, and unknown projects', async () => {
  const r = new ProjectRegistry({ homeDir: home });
  const a = await r.createProject('a');
  const b = await r.createProject('b');
  await r.addAlias(a, 'deadbeefdeadbeef');

  await expect(r.addAlias(b, 'deadbeefdeadbeef')).rejects.toThrow(/already aliased to project/);
  await expect(r.addAlias(newProjectId(), 'ffffffffffffffff')).rejects.toThrow(/unknown projectId/); // unowned hash, absent project
  await expect(r.addAlias('bogus', 'deadbeefdeadbeef')).rejects.toThrow(/invalid projectId/);
  await expect(r.addAlias(a, '')).rejects.toThrow(/pathHash/);
  expect(r.resolveCached('deadbeefdeadbeef')).toBe(a); // the conflict left the first owner untouched
});

it('removeAlias drops the alias (idempotent) and appends one unalias record', async () => {
  const r = new ProjectRegistry({ homeDir: home });
  const id = await r.createProject();
  await r.addAlias(id, '0123456789abcdef');
  expect(r.resolveCached('0123456789abcdef')).toBe(id);

  await r.removeAlias('0123456789abcdef');
  expect(r.resolveCached('0123456789abcdef')).toBeUndefined();
  await r.removeAlias('0123456789abcdef'); // idempotent: no second record

  expect((await records()).map((rec) => rec.op)).toEqual(['create', 'alias', 'unalias']);
  expect((await r.listProjects())[0].aliases).toEqual([]);
});

it('renameProject updates the folded name and rejects unknown ids / empty names', async () => {
  const r = new ProjectRegistry({ homeDir: home });
  const id = await r.createProject('before');
  await r.renameProject(id, 'after');
  expect((await r.listProjects())[0].name).toBe('after');
  await expect(r.renameProject(newProjectId(), 'x')).rejects.toThrow(/unknown projectId/);
  await expect(r.renameProject(id, '')).rejects.toThrow(/name/);
});

// ---- projection: size-driven invalidation ----

it('a second instance rebuilds the projection from the file once the size moves', async () => {
  const first = new ProjectRegistry({ homeDir: home });
  const id = await first.createProject('shared');
  await first.addAlias(id, 'feedfacefeedface');

  const second = new ProjectRegistry({ homeDir: home });
  expect(second.resolveCached('feedfacefeedface')).toBeUndefined(); // cold cache before any refresh
  expect((await second.listProjects()).map((p) => p.projectId)).toEqual([id]); // listProjects refreshes
  expect(second.resolveCached('feedfacefeedface')).toBe(id);

  // An external append (peer process) is picked up by refreshIfStale.
  await appendFile(
    registryFile(),
    JSON.stringify({ op: 'alias', projectId: id, pathHash: 'cafebabecafebabe', ts: new Date().toISOString() }) + '\n',
  );
  await second.refreshIfStale();
  expect(second.resolveCached('cafebabecafebabe')).toBe(id);

  // Unchanged file: a no-op refresh keeps the same answers.
  await second.refreshIfStale();
  expect(second.resolveCached('feedfacefeedface')).toBe(id);
});

it('skips malformed lines and rebuilds when the log shrinks', async () => {
  const r = new ProjectRegistry({ homeDir: home });
  const id = await r.createProject();
  await appendFile(registryFile(), '{not json\n');
  await appendFile(registryFile(), JSON.stringify({ op: 'nonsense' }) + '\n');
  await r.refreshIfStale();
  expect((await r.listProjects()).map((p) => p.projectId)).toEqual([id]); // garbage skipped, view intact

  await writeFile(registryFile(), ''); // shrink to empty: the projection follows
  await r.refreshIfStale();
  expect(await r.listProjects()).toEqual([]);
  expect(r.resolveCached('whatever')).toBeUndefined();
});

it('two registries interleave aliases on the same log without losing records', async () => {
  const a = new ProjectRegistry({ homeDir: home });
  const b = new ProjectRegistry({ homeDir: home });
  const [pa, pb] = await Promise.all([a.createProject('a'), b.createProject('b')]);
  await Promise.all([
    a.addAlias(pa, '1111111111111111'),
    b.addAlias(pb, '2222222222222222'),
    a.addAlias(pa, '3333333333333333'),
    b.addAlias(pb, '4444444444444444'),
  ]);

  const fresh = new ProjectRegistry({ homeDir: home });
  const byId = new Map((await fresh.listProjects()).map((p) => [p.projectId, p.aliases]));
  expect(byId.get(pa)).toEqual(['1111111111111111', '3333333333333333']);
  expect(byId.get(pb)).toEqual(['2222222222222222', '4444444444444444']);
});
