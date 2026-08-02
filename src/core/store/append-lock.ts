/**
 * Cross-process append lock for JSONL writers (mailbox task 1).
 *
 * BoardStore serializes mutations in-process with a per-scope promise queue,
 * but that queue does not span processes: two moamcp sessions sharing one home
 * could append to the same JSONL concurrently and tear lines. `withAppendLock`
 * is the missing primitive — a tiny advisory lock acquired by atomically
 * creating `<file>.lock` with `fs.open(..., 'wx')` (O_CREAT|O_EXCL), which the
 * OS guarantees only one process can win.
 *
 * Semantics:
 *   - Acquisition retries every 50ms until the total timeout (default 10s,
 *     injectable via options) elapses, then rejects with
 *     `AppendLockTimeoutError`.
 *   - A lock file whose mtime is older than 30s is presumed to belong to a
 *     crashed holder; it is force-unlinked and acquisition retried once, so a
 *     single stale lock cannot wedge writers forever.
 *   - Release is unconditional: `fn`'s result or rejection is propagated, but
 *     the lock file is unlinked in `finally`, so an exception never leaks the
 *     lock.
 *
 * The lock covers only the write side; readers (board folds) stay lock-free and
 * rely on the existing size-based refresh.
 */
import { open, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

/** Total time to keep waiting for the lock before giving up. */
export const APPEND_LOCK_DEFAULT_TIMEOUT_MS = 10_000;
/** Pause between acquisition attempts. */
export const APPEND_LOCK_RETRY_INTERVAL_MS = 50;
/** Lock file age beyond which the holder is presumed crashed and the lock reclaimed. */
export const APPEND_LOCK_STALE_MS = 30_000;

export interface AppendLockOptions {
  /** Total time to wait for the lock before rejecting. Default APPEND_LOCK_DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Pause between acquisition attempts. Default APPEND_LOCK_RETRY_INTERVAL_MS. */
  retryIntervalMs?: number;
  /** mtime age at which an existing lock is treated as stale. Default APPEND_LOCK_STALE_MS. */
  staleMs?: number;
}

/** Rejected when the lock stays held (or un-reclaimable) past the total timeout. */
export class AppendLockTimeoutError extends Error {
  readonly code = 'APPEND_LOCK_TIMEOUT';

  constructor(lockFile: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for append lock ${lockFile}`);
    this.name = 'AppendLockTimeoutError';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True when the lock file exists and its mtime is older than the stale horizon. */
async function isStaleLock(lockFile: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockFile);
    return Date.now() - info.mtimeMs > staleMs;
  } catch (err) {
    // The holder released between the failed open and this stat; not stale, keep waiting.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Best-effort removal of a stale lock; a peer may have already reclaimed it. */
async function removeLockFile(lockFile: string): Promise<void> {
  try {
    await unlink(lockFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Run `fn` while holding the exclusive append lock for `file`; the lock file is
 * `<file>.lock` and is removed when `fn` settles, successfully or not.
 */
export async function withAppendLock<T>(file: string, fn: () => Promise<T>, opts: AppendLockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? APPEND_LOCK_DEFAULT_TIMEOUT_MS;
  const retryIntervalMs = opts.retryIntervalMs ?? APPEND_LOCK_RETRY_INTERVAL_MS;
  const staleMs = opts.staleMs ?? APPEND_LOCK_STALE_MS;
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  // A stale lock is reclaimed at most once per acquisition so a dead holder is
  // not unlinked by every waiter racing to break it.
  let reclaimed = false;

  let handle: FileHandle | undefined;
  for (;;) {
    try {
      handle = await open(lockFile, 'wx');
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (!reclaimed && (await isStaleLock(lockFile, staleMs))) {
        reclaimed = true;
        await removeLockFile(lockFile);
        continue; // retry the open immediately after reclaiming the stale lock
      }
      if (Date.now() >= deadline) throw new AppendLockTimeoutError(lockFile, timeoutMs);
      await sleep(retryIntervalMs);
    }
  }

  try {
    return await fn();
  } finally {
    // Close before unlink (Windows sharing); removal runs even if close fails.
    try {
      await handle.close();
    } finally {
      await removeLockFile(lockFile);
    }
  }
}
