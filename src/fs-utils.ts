/**
 * Small shared file primitives used by the instance registry and the
 * workspace-source-tree adapters.
 *
 * The replace/rename behavior intentionally mirrors the registry's original
 * implementation: a same-directory temporary file is closed before rename,
 * Windows sharing failures get a short bounded retry, and failed writes clean
 * up their temporary file. Callers may optionally run a last-moment check after
 * the temporary file is complete and immediately before the replace.
 */
import { open, rename, unlink } from 'node:fs/promises';
import { randomInt } from 'node:crypto';

/** Number of short retries for a Windows antivirus/editor sharing race. */
export const RENAME_RETRY_LIMIT = 5;
/** Linear backoff base used by the replace retry loop. */
export const RENAME_RETRY_DELAY_MS = 50;

export interface AtomicWriteOptions {
  /**
   * Best-effort in-process CAS hook. It runs after the temporary file is
   * closed, but before the destination replace. A thrown error leaves the
   * destination untouched and removes the temporary file.
   */
  readonly beforeRename?: () => void | Promise<void>;
}

/** True for the replace errors that are transient on Windows. */
export function isReplaceRetryableError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

/** Replace an existing destination with a same-volume temporary file. */
export async function renameReplace(tmpPath: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmpPath, filePath);
      return;
    } catch (error) {
      if (attempt >= RENAME_RETRY_LIMIT || !isReplaceRetryableError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
}

/**
 * Atomic (rename-based) text write. The temporary file lives beside the
 * destination so the final rename does not cross filesystems.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomInt(0x1_0000_0000).toString(16)}`;
  let renamed = false;
  try {
    const handle = await open(tmpPath, 'w');
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforeRename?.();
    await renameReplace(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      // Write/CAS/rename failed: never leave a half-written temp behind.
      try {
        await unlink(tmpPath);
      } catch {
        // best-effort cleanup
      }
    }
  }
}
