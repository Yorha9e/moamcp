/**
 * Instance registry tests: round-trip, dead-pid sweeping, the three pidAlive
 * branches, atomic writes, update idempotence, same-pid overwrite, sweep
 * discipline (only positively-dead entries are unlinked), and MOAMCP_HOME
 * isolation. All paths live in temp dirs — the real home is never touched.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createRegistry,
  defaultInstancesDir,
  moamcpHome,
  pidAlive,
  pidAliveWith,
  ulid,
  VERSION,
} from '../src/registry.js';

const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A pid guaranteed to be dead: run a node child to completion, reuse its pid. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  if (result.pid === undefined) throw new Error('failed to obtain a dead pid');
  return result.pid;
}

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** Plant a well-formed entry file (mkdir included); returns its path. */
async function writeEntry(dir: string, pid: number, port: number, startedAt = Date.now() - 5000): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${pid}.json`);
  await writeFile(file, JSON.stringify({ id: ulid(), pid, port, started_at: startedAt, version: VERSION }));
  return file;
}

let home: string;
let instancesDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'moamcp-reg-'));
  instancesDir = join(home, 'instances');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it('register/listLive/release round-trip', async () => {
  const registry = createRegistry({ instancesDir });
  const reg = await registry.register({ pid: process.pid, port: 8913 });
  expect(reg.pid).toBe(process.pid);
  expect(reg.id).toMatch(CROCKFORD_RE);

  const live = await registry.listLive();
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({ id: reg.id, pid: process.pid, port: 8913, version: VERSION });
  expect(typeof live[0].startedAt).toBe('number');

  await reg.release();
  expect(await registry.listLive()).toHaveLength(0);
  await expect(readdir(instancesDir)).resolves.toEqual([]);
  // release is idempotent
  await reg.release();
});

it('writes the entry atomically: complete JSON on disk, no temp litter', async () => {
  const registry = createRegistry({ instancesDir });
  const reg = await registry.register({ pid: process.pid, port: 9001 });
  const raw = await readFile(join(instancesDir, `${process.pid}.json`), 'utf8');
  expect(JSON.parse(raw)).toEqual({
    id: reg.id,
    pid: process.pid,
    port: 9001,
    started_at: expect.any(Number),
    version: VERSION,
  });
  const names = await readdir(instancesDir);
  expect(names.every((n) => !n.includes('.tmp.'))).toBe(true);
  await reg.release();
});

it('sweeps dead-pid entries on both register and listLive', async () => {
  const stale1 = await writeEntry(instancesDir, deadPid(), 8913);
  const registry = createRegistry({ instancesDir });

  // register sweeps as a private embedded step before writing
  const reg = await registry.register({ pid: process.pid, port: 8914 });
  await expect(readFile(stale1, 'utf8')).rejects.toThrow();

  // listLive sweeps too
  const stale2 = await writeEntry(instancesDir, deadPid(), 8915);
  const live = await registry.listLive();
  expect(live.map((e) => e.pid)).toEqual([process.pid]);
  await expect(readFile(stale2, 'utf8')).rejects.toThrow();
  await reg.release();
});

it('pidAlive: ESRCH → dead; EPERM and other errors → alive (three branches)', () => {
  expect(pidAliveWith(12345, () => {})).toBe(true); // no throw = alive
  expect(pidAliveWith(12345, () => { throw errno('ESRCH'); })).toBe(false);
  expect(pidAliveWith(12345, () => { throw errno('EPERM'); })).toBe(true); // other user, exists
  expect(pidAliveWith(12345, () => { throw errno('EINVAL'); })).toBe(true); // conservative
  // real process table
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(deadPid())).toBe(false);
});

it('update({port}) is idempotent and rewrites the actual port', async () => {
  const registry = createRegistry({ instancesDir });
  const reg = await registry.register({ pid: process.pid, port: 8913 });
  const file = join(instancesDir, `${process.pid}.json`);

  const before = await readFile(file, 'utf8');
  await reg.update({ port: 8913 }); // unchanged port → identical content
  expect(await readFile(file, 'utf8')).toBe(before);

  await reg.update({ port: 8914 }); // write back the bound port
  expect(JSON.parse(await readFile(file, 'utf8')).port).toBe(8914);

  await reg.release();
  await reg.update({ port: 9999 }); // no-op after release: file stays gone
  await expect(readdir(instancesDir)).resolves.toEqual([]);
});

it('same-pid re-register overwrites the previous entry (one file per pid)', async () => {
  const registry = createRegistry({ instancesDir });
  const first = await registry.register({ pid: process.pid, port: 1111 });
  const second = await registry.register({ pid: process.pid, port: 2222 });
  expect(second.id).not.toBe(first.id);

  const live = await registry.listLive();
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({ id: second.id, port: 2222 });
  await second.release();
  await expect(readdir(instancesDir)).resolves.toEqual([]);
});

it('sweep discipline: unlinks only positively-dead entries; keeps live + unparseable', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    await new Promise((r) => setTimeout(r, 100)); // let the child process exist
    await mkdir(instancesDir, { recursive: true });
    await writeFile(join(instancesDir, 'garbage.json'), '{not json'); // unparseable → keep
    await writeEntry(instancesDir, child.pid as number, 7777); // live pid → keep
    const deadFile = await writeEntry(instancesDir, deadPid(), 7778); // dead → unlink

    const registry = createRegistry({ instancesDir });
    const reg = await registry.register({ pid: process.pid, port: 7779 });
    const names = await readdir(instancesDir);
    expect(names).toContain('garbage.json');
    expect(names).toContain(`${child.pid}.json`);
    expect(names).toContain(`${process.pid}.json`);
    expect(names).not.toContain(basename(deadFile));

    // listLive sorts by startedAt ascending (the planted child entry is older)
    const live = await registry.listLive();
    expect(live.map((e) => e.pid)).toEqual([child.pid, process.pid]);
    await reg.release();
  } finally {
    child.kill();
  }
});

it('ulid: 26 Crockford chars and time-ordered', () => {
  const a = ulid(1000);
  const b = ulid(2000);
  expect(a).toMatch(CROCKFORD_RE);
  expect(b).toMatch(CROCKFORD_RE);
  expect(a < b).toBe(true);
});

it('MOAMCP_HOME redirects the default instances dir (temp home, never the real one)', async () => {
  const prev = process.env.MOAMCP_HOME;
  try {
    process.env.MOAMCP_HOME = home;
    expect(moamcpHome()).toBe(home);
    expect(defaultInstancesDir()).toBe(join(home, 'instances'));

    const reg = await createRegistry({}).register({ pid: process.pid, port: 8913 });
    const live = await createRegistry({}).listLive();
    expect(live).toHaveLength(1);
    expect(live[0].pid).toBe(process.pid);
    await reg.release();
  } finally {
    if (prev === undefined) delete process.env.MOAMCP_HOME;
    else process.env.MOAMCP_HOME = prev;
  }
});
