import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCHIVE_FILE_NAMES,
  ArchiveIndex,
  isValidTaskId,
  type ArchiveIndexFileSystem,
} from '../src/core/store/archive-index.js';

let home: string;
let logsDir: string;

const realFileSystem: ArchiveIndexFileSystem = {
  readdir: (path, options) => readdir(path, options),
  lstat,
  open,
};

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function task(name: string): Promise<string> {
  const dir = join(logsDir, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'moamcp-archive-index-'));
  logsDir = join(home, 'logs');
  await mkdir(logsDir);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('ArchiveIndex', () => {
  it('indexes only whitelisted files and returns a bounded result summary', async () => {
    const dir = await task('normal-task');
    await writeFile(join(dir, 'result.json'), JSON.stringify({
      task_id: 'normal-task',
      status: 'complete',
      rounds_configured: 3,
      rounds_completed: 2,
      turns: 7,
      finished_at: '2026-03-10T12:00:00.000Z',
      early: true,
      reason: 'unanimous_signoff',
      transcript: [{ content: 'must never escape' }],
      signoffs: { agent: 'also private' },
      arbitrary: 'not part of the summary',
    }));
    await writeFile(join(dir, 'probe.json'), '{}');
    await writeFile(join(dir, 'events.jsonl'), '{"turn":1}\n');
    await writeFile(join(dir, 'board.jsonl'), '');
    await writeFile(join(dir, 'secret.txt'), 'not indexed');

    const entries = await new ArchiveIndex(logsDir).list();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.taskId).toBe('normal-task');
    expect(Object.keys(entry.files)).toEqual(ARCHIVE_FILE_NAMES);
    expect(entry.files['result.json']).toMatchObject({ exists: true, size: expect.any(Number), mtime: expect.any(String) });
    expect(entry.files['board.jsonl'].size).toBe(0);
    expect(entry.summary).toEqual({
      status: 'complete',
      rounds_configured: 3,
      rounds_completed: 2,
      turns: 7,
      finished_at: '2026-03-10T12:00:00.000Z',
      early: true,
      reason: 'unanimous_signoff',
    });
    expect(entry).toMatchObject({ updatedAt: expect.any(String), degraded: false, errors: [] });
    expect(JSON.stringify(entry)).not.toContain('must never escape');
    expect(JSON.stringify(entry)).not.toContain('also private');
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
  });

  it('sorts multiple directories by the latest recognized file mtime, newest first', async () => {
    const older = await task('older');
    const newer = await task('newer');
    const empty = await task('empty');
    await writeFile(join(older, 'events.jsonl'), 'old');
    await writeFile(join(newer, 'probe.json'), '{}');
    await writeFile(join(older, 'ignored.tmp'), 'new but not recognized');

    const oldTime = new Date('2024-01-01T00:00:00.000Z');
    const newTime = new Date('2025-01-01T00:00:00.000Z');
    const ignoredTime = new Date('2030-01-01T00:00:00.000Z');
    await utimes(join(older, 'events.jsonl'), oldTime, oldTime);
    await utimes(join(newer, 'probe.json'), newTime, newTime);
    await utimes(join(older, 'ignored.tmp'), ignoredTime, ignoredTime);

    const entries = await new ArchiveIndex(logsDir).list();
    expect(entries.map((entry) => entry.taskId)).toEqual(['newer', 'older', 'empty']);
    expect(entries[0].updatedAt).toBe(newTime.toISOString());
    expect(entries[1].updatedAt).toBe(oldTime.toISOString());
    expect(entries[2].updatedAt).toBeNull();
    expect(empty).toBe(join(logsDir, 'empty'));
  });

  it('keeps missing result.json as explicit metadata and degrades only the damaged result', async () => {
    const missing = await task('missing-result');
    await writeFile(join(missing, 'events.jsonl'), '{"turn":1}\n');
    const damaged = await task('damaged-result');
    await writeFile(join(damaged, 'result.json'), '{ definitely not JSON');

    const entries = await new ArchiveIndex(logsDir).list();
    const missingEntry = entries.find((entry) => entry.taskId === 'missing-result');
    const damagedEntry = entries.find((entry) => entry.taskId === 'damaged-result');
    expect(missingEntry).toMatchObject({
      files: { 'result.json': { exists: false, size: null, mtime: null } },
      degraded: false,
      errors: [],
    });
    expect(missingEntry).not.toHaveProperty('summary');
    expect(damagedEntry).toMatchObject({
      files: { 'result.json': { exists: true } },
      degraded: true,
      errors: [{ operation: 'parse', file: 'result.json', code: 'INVALID_JSON' }],
    });
    expect(damagedEntry).not.toHaveProperty('summary');
  });

  it('ignores symlinked task directories', async () => {
    const outside = join(home, 'outside-task');
    await mkdir(outside);
    await writeFile(join(outside, 'result.json'), JSON.stringify({ status: 'private' }));
    await symlink(outside, join(logsDir, 'linked-task'), process.platform === 'win32' ? 'junction' : 'dir');
    await task('real-task');

    const entries = await new ArchiveIndex(logsDir).list();
    expect(entries.map((entry) => entry.taskId)).toEqual(['real-task']);
  });

  it('ignores invalid directory names and exports strict reusable task-id validation', async () => {
    await task('valid-task_01');
    await task('bad..task');
    await task('   ');

    expect((await new ArchiveIndex(logsDir).list()).map((entry) => entry.taskId)).toEqual(['valid-task_01']);
    expect(isValidTaskId('valid-task_01')).toBe(true);
    for (const invalid of ['', '   ', '.', '..', 'a..b', 'a/b', 'a\\b', '\0', null, 1, false]) {
      expect(isValidTaskId(invalid)).toBe(false);
    }
  });

  it('returns an empty list when logsDir does not exist', async () => {
    await expect(new ArchiveIndex(join(home, 'does-not-exist')).list()).resolves.toEqual([]);
  });

  it('reports a deterministic unreadable-file failure and continues indexing other tasks', async () => {
    const blocked = await task('blocked-probe');
    const blockedFile = join(blocked, 'probe.json');
    await writeFile(blockedFile, '{}');
    const healthy = await task('healthy');
    await writeFile(join(healthy, 'probe.json'), '{}');

    const unreadableFs: ArchiveIndexFileSystem = {
      ...realFileSystem,
      async open(path, flags) {
        if (path === blockedFile) throw errno('EACCES');
        return open(path, flags);
      },
    };
    const entries = await new ArchiveIndex(logsDir, unreadableFs).list();
    const blockedEntry = entries.find((entry) => entry.taskId === 'blocked-probe');
    expect(blockedEntry).toMatchObject({
      files: { 'probe.json': { exists: true } },
      degraded: true,
      errors: [{ operation: 'read', file: 'probe.json', code: 'EACCES' }],
    });
    expect(entries.find((entry) => entry.taskId === 'healthy')?.degraded).toBe(false);
  });

  it('turns stable simulated file and directory races into per-item errors', async () => {
    const changed = await task('changed-result');
    await writeFile(join(changed, 'result.json'), JSON.stringify({ status: 'complete' }));
    await task('vanished-directory');
    await task('healthy-race-neighbor');

    let resultStats = 0;
    const racingFs: ArchiveIndexFileSystem = {
      ...realFileSystem,
      async lstat(path): Promise<Stats> {
        if (path === join(logsDir, 'vanished-directory')) throw errno('ENOENT');
        if (path === join(changed, 'result.json')) {
          resultStats += 1;
          if (resultStats >= 2) throw errno('ENOENT');
        }
        return lstat(path);
      },
    };

    const entries = await new ArchiveIndex(logsDir, racingFs).list();
    expect(entries.find((entry) => entry.taskId === 'changed-result')).toMatchObject({
      degraded: true,
      errors: [{ operation: 'read', file: 'result.json', code: 'ENOENT' }],
    });
    expect(entries.find((entry) => entry.taskId === 'vanished-directory')).toMatchObject({
      updatedAt: null,
      degraded: true,
      errors: [{ operation: 'directory', code: 'ENOENT' }],
    });
    expect(entries.find((entry) => entry.taskId === 'healthy-race-neighbor')?.degraded).toBe(false);
  });

  it('rejects symlink/non-regular whitelist entries rather than following them', async () => {
    const dir = await task('unsafe-file');
    await mkdir(join(dir, 'result.json'));

    const [entry] = await new ArchiveIndex(logsDir).list();
    expect(entry.files['result.json']).toEqual({ exists: false, size: null, mtime: null });
    expect(entry).toMatchObject({
      degraded: true,
      errors: [{ operation: 'stat', file: 'result.json', code: 'UNSAFE_FILE_TYPE' }],
    });
  });
});
