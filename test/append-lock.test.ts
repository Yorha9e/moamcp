/**
 * Append-lock tests (mailbox task 1): mutual exclusion (concurrent writers
 * serialize on one JSONL), unconditional release on error, stale-lock
 * reclamation, acquisition timeout, and the lock-file lifecycle (`<file>.lock`
 * is created while `fn` runs and removed in `finally`).
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPEND_LOCK_DEFAULT_TIMEOUT_MS,
  APPEND_LOCK_RETRY_INTERVAL_MS,
  APPEND_LOCK_STALE_MS,
  AppendLockTimeoutError,
  withAppendLock,
} from '../src/core/store/append-lock.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'moamcp-append-lock-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const file = () => join(home, 'items.jsonl');
const lockFile = () => `${file()}.lock`;

// ---- mutual exclusion ----

it('serializes concurrent writers: the second writer waits for the first to release', async () => {
  const order: string[] = [];
  const entered = deferred();
  const release = deferred();
  const first = withAppendLock(file(), async () => {
    order.push('first-start');
    entered.resolve();
    await release.promise;
    order.push('first-end');
    await appendFile(file(), 'first\n');
  });
  await entered.promise; // the lock is now held by the first writer

  const second = withAppendLock(file(), async () => {
    order.push('second-start');
    await appendFile(file(), 'second\n');
    order.push('second-end');
  });
  await sleep(80); // the second writer is contending but must stay blocked
  expect(order).toEqual(['first-start']);

  release.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  expect((await readFile(file(), 'utf8')).trim().split('\n')).toEqual(['first', 'second']);
});

it('twenty concurrent appends all land: no lost or interleaved lines', async () => {
  const writes = Array.from({ length: 20 }, (_, i) =>
    withAppendLock(file(), async () => {
      await appendFile(file(), `writer-${i}:${'x'.repeat(1024)}\n`);
    }),
  );
  await Promise.all(writes);

  const lines = (await readFile(file(), 'utf8')).trim().split('\n');
  expect(lines).toHaveLength(20);
  // Numeric sort by writer index: every writer landed exactly once.
  const writers = lines.map((line) => Number(line.slice('writer-'.length, line.indexOf(':')))).sort((a, b) => a - b);
  expect(writers).toEqual(Array.from({ length: 20 }, (_, i) => i));
  expect(lines.every((line) => /^writer-\d+:x+$/.test(line))).toBe(true);
});

it('locks are per-file: concurrent writers on different files do not block each other', async () => {
  const a = join(home, 'a.jsonl');
  const b = join(home, 'b.jsonl');
  const entered = deferred();
  const release = deferred();
  const first = withAppendLock(a, async () => {
    entered.resolve();
    await release.promise;
    await appendFile(a, 'a\n');
  });
  await entered.promise;

  // While `a` is held, `b`'s lock is acquired immediately.
  await expect(withAppendLock(b, async () => appendFile(b, 'b\n'), { timeoutMs: 200 })).resolves.toBeUndefined();
  release.resolve();
  await first;

  expect((await readFile(a, 'utf8')).trim()).toBe('a');
  expect((await readFile(b, 'utf8')).trim()).toBe('b');
});

// ---- lock lifecycle ----

it('creates `<file>.lock`, returns the callback result, and removes the lock in finally', async () => {
  const result = await withAppendLock(file(), async () => {
    expect((await stat(lockFile())).isFile()).toBe(true);
    return 42;
  });
  expect(result).toBe(42);
  await expect(stat(lockFile())).rejects.toMatchObject({ code: 'ENOENT' });
});

// ---- release on error ----

it('releases the lock when fn rejects: the error propagates and a later writer succeeds', async () => {
  const boom = new Error('boom');
  await expect(
    withAppendLock(file(), async () => {
      await appendFile(file(), 'partial\n');
      throw boom;
    }),
  ).rejects.toBe(boom);
  await expect(stat(lockFile())).rejects.toMatchObject({ code: 'ENOENT' });

  // The lock is free again: a follow-up writer appends without waiting.
  await withAppendLock(file(), async () => {
    await appendFile(file(), 'after\n');
  });
  expect((await readFile(file(), 'utf8')).trim().split('\n')).toEqual(['partial', 'after']);
});

// ---- stale reclamation ----

it('reclaims a stale lock (mtime older than staleMs) and proceeds', async () => {
  // Simulate a crashed holder: the lock file exists but nobody owns it.
  await writeFile(lockFile(), 'stale');
  const past = new Date(Date.now() - APPEND_LOCK_STALE_MS - 1000);
  await utimes(lockFile(), past, past);

  const result = await withAppendLock(file(), async () => {
    await appendFile(file(), 'reclaimed\n');
    return 'ok';
  });
  expect(result).toBe('ok');
  expect((await readFile(file(), 'utf8')).trim()).toBe('reclaimed');
  await expect(stat(lockFile())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not steal a fresh orphan lock: it times out and leaves the file untouched', async () => {
  await writeFile(lockFile(), 'fresh-orphan');
  await expect(withAppendLock(file(), async () => 1, { timeoutMs: 150 })).rejects.toMatchObject({
    code: 'APPEND_LOCK_TIMEOUT',
  });
  expect(await readFile(lockFile(), 'utf8')).toBe('fresh-orphan'); // not reclaimed
});

// ---- timeout ----

it('throws AppendLockTimeoutError when the lock stays held past the total timeout', async () => {
  const entered = deferred();
  const release = deferred();
  const holder = withAppendLock(file(), async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;

  const t0 = Date.now();
  await expect(withAppendLock(file(), async () => 1, { timeoutMs: 150 })).rejects.toBeInstanceOf(AppendLockTimeoutError);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(100);

  // The holder still owns the lock, so a second waiter times out identically.
  await expect(withAppendLock(file(), async () => 1, { timeoutMs: 150 })).rejects.toMatchObject({
    code: 'APPEND_LOCK_TIMEOUT',
  });

  release.resolve();
  await holder;
  await expect(stat(lockFile())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('exposes the default timing constants', () => {
  expect(APPEND_LOCK_DEFAULT_TIMEOUT_MS).toBe(10_000);
  expect(APPEND_LOCK_RETRY_INTERVAL_MS).toBe(50);
  expect(APPEND_LOCK_STALE_MS).toBe(30_000);
});
