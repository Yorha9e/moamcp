import { constants } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';

/** The complete set of archive files this index will inspect. */
export const ARCHIVE_FILE_NAMES = [
  'result.json',
  'probe.json',
  'events.jsonl',
  'board.jsonl',
] as const;

export type ArchiveFileName = (typeof ARCHIVE_FILE_NAMES)[number];

export interface ArchiveFileInfo {
  readonly exists: boolean;
  readonly size: number | null;
  /** ISO-8601 timestamp, or null when the file does not exist/cannot be inspected. */
  readonly mtime: string | null;
}

export interface ArchiveResultSummary {
  readonly status?: string;
  readonly rounds_configured?: number;
  readonly rounds_completed?: number;
  readonly turns?: number;
  readonly finished_at?: string;
  readonly early?: boolean;
  readonly reason?: string;
}

export interface ArchiveIndexError {
  readonly operation: 'directory' | 'stat' | 'read' | 'parse';
  readonly code: string;
  readonly file?: ArchiveFileName;
  /** Deliberately path-free so filesystem locations are not disclosed to consumers. */
  readonly message: string;
}

export interface ArchiveIndexEntry {
  readonly taskId: string;
  readonly files: Readonly<Record<ArchiveFileName, ArchiveFileInfo>>;
  /** Latest mtime among recognized regular files, or null if none could be inspected. */
  readonly updatedAt: string | null;
  readonly summary?: ArchiveResultSummary;
  readonly degraded: boolean;
  readonly errors: readonly ArchiveIndexError[];
}

/**
 * Minimal filesystem seam. Production callers should omit it; it permits deterministic
 * race/error tests without relying on platform-specific permission semantics.
 */
export interface ArchiveIndexFileSystem {
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number): Promise<FileHandle>;
}

const nodeFileSystem: ArchiveIndexFileSystem = {
  readdir: (path, options) => readdir(path, options),
  lstat,
  open,
};

const MISSING_FILE: ArchiveFileInfo = Object.freeze({ exists: false, size: null, mtime: null });
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_SUMMARY_TEXT_LENGTH = 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Reusable task-id guard for future route code. It rejects traversal tokens rather
 * than attempting to normalize them, and accepts strings only.
 */
export function isValidTaskId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value !== '.'
    && !value.includes('..')
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN';
}

function fileError(
  operation: ArchiveIndexError['operation'],
  file: ArchiveFileName,
  code: string,
): ArchiveIndexError {
  return { operation, file, code, message: `${file}: ${code}` };
}

function missingFiles(): Record<ArchiveFileName, ArchiveFileInfo> {
  return {
    'result.json': MISSING_FILE,
    'probe.json': MISSING_FILE,
    'events.jsonl': MISSING_FILE,
    'board.jsonl': MISSING_FILE,
  };
}

function regularFileInfo(stat: Stats): ArchiveFileInfo {
  return {
    exists: true,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

function sameFile(a: Stats, b: Stats): boolean {
  // ino may be zero on some Windows filesystems. In that case the open handle's
  // regular-file check still protects against directories and the two lstat checks
  // below protect the common replacement race.
  if (a.ino !== 0 && b.ino !== 0) return a.dev === b.dev && a.ino === b.ino;
  return a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function safeText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_SUMMARY_TEXT_LENGTH ? value : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function summarize(value: Record<string, unknown>): ArchiveResultSummary {
  const status = safeText(value.status);
  const roundsConfigured = safeCount(value.rounds_configured);
  const roundsCompleted = safeCount(value.rounds_completed);
  const turns = safeCount(value.turns);
  const finishedAt = safeText(value.finished_at);
  const early = typeof value.early === 'boolean' ? value.early : undefined;
  const reason = safeText(value.reason);

  return {
    ...(status === undefined ? {} : { status }),
    ...(roundsConfigured === undefined ? {} : { rounds_configured: roundsConfigured }),
    ...(roundsCompleted === undefined ? {} : { rounds_completed: roundsCompleted }),
    ...(turns === undefined ? {} : { turns }),
    ...(finishedAt === undefined ? {} : { finished_at: finishedAt }),
    ...(early === undefined ? {} : { early }),
    ...(reason === undefined ? {} : { reason }),
  };
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_RESULT_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_RESULT_BYTES) {
    const error = new Error('result too large') as NodeJS.ErrnoException;
    error.code = 'RESULT_TOO_LARGE';
    throw error;
  }
  return buffer.subarray(0, offset);
}

interface ScannedFile {
  info: ArchiveFileInfo;
  stat?: Stats;
  error?: ArchiveIndexError;
}

/** Read-only archive directory index. It never creates, mutates, deletes, or exposes arbitrary reads. */
export class ArchiveIndex {
  readonly logsDir: string;
  private readonly fs: ArchiveIndexFileSystem;

  constructor(logsDir: string, fileSystem: ArchiveIndexFileSystem = nodeFileSystem) {
    if (typeof logsDir !== 'string' || logsDir.length === 0) {
      throw new TypeError('logsDir must be a non-empty string');
    }
    this.logsDir = logsDir;
    this.fs = fileSystem;
  }

  async list(): Promise<readonly ArchiveIndexEntry[]> {
    let children: Dirent[];
    try {
      children = await this.fs.readdir(this.logsDir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }

    const entries = await Promise.all(children.map(async (child) => {
      if (!child.isDirectory() || child.isSymbolicLink() || !isValidTaskId(child.name)) return undefined;
      return this.scanTask(child.name);
    }));

    return entries
      .filter((entry): entry is ArchiveIndexEntry => entry !== undefined)
      .sort((a, b) => {
        const aTime = a.updatedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(a.updatedAt);
        const bTime = b.updatedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(b.updatedAt);
        return bTime - aTime || a.taskId.localeCompare(b.taskId);
      });
  }

  private async scanTask(taskId: string): Promise<ArchiveIndexEntry | undefined> {
    const taskDir = join(this.logsDir, taskId);
    try {
      const taskStat = await this.fs.lstat(taskDir);
      if (!taskStat.isDirectory() || taskStat.isSymbolicLink()) return undefined;
    } catch (error) {
      return {
        taskId,
        files: missingFiles(),
        updatedAt: null,
        degraded: true,
        errors: [{ operation: 'directory', code: errorCode(error), message: `task directory: ${errorCode(error)}` }],
      };
    }

    const errors: ArchiveIndexError[] = [];
    const scans = await Promise.all(ARCHIVE_FILE_NAMES.map(async (file) => [file, await this.scanFile(taskDir, file)] as const));
    const files = missingFiles();
    let latest = Number.NEGATIVE_INFINITY;
    for (const [file, scan] of scans) {
      files[file] = scan.info;
      if (scan.error !== undefined) errors.push(scan.error);
      if (scan.info.exists && scan.stat !== undefined) latest = Math.max(latest, scan.stat.mtimeMs);
    }

    let summary: ArchiveResultSummary | undefined;
    const resultScan = scans.find(([file]) => file === 'result.json')?.[1];
    if (resultScan?.stat !== undefined && resultScan.info.exists && resultScan.error === undefined) {
      const parsed = await this.readResult(taskDir, resultScan.stat);
      if (parsed.error !== undefined) errors.push(parsed.error);
      else summary = parsed.summary;
    }

    return {
      taskId,
      files,
      updatedAt: Number.isFinite(latest) ? new Date(latest).toISOString() : null,
      ...(summary === undefined ? {} : { summary }),
      degraded: errors.length > 0,
      errors,
    };
  }

  private async scanFile(taskDir: string, file: ArchiveFileName): Promise<ScannedFile> {
    const filePath = join(taskDir, file);
    let stat: Stats;
    try {
      stat = await this.fs.lstat(filePath);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return { info: MISSING_FILE };
      return { info: MISSING_FILE, error: fileError('stat', file, code) };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { info: MISSING_FILE, error: fileError('stat', file, 'UNSAFE_FILE_TYPE') };
    }

    const info = regularFileInfo(stat);
    let handle: FileHandle | undefined;
    try {
      const noFollow = constants.O_NOFOLLOW ?? 0;
      handle = await this.fs.open(filePath, constants.O_RDONLY | noFollow);
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || !sameFile(stat, openedStat)) {
        return { info, stat, error: fileError('read', file, 'FILE_CHANGED') };
      }
      return { info, stat };
    } catch (error) {
      return { info, stat, error: fileError('read', file, errorCode(error)) };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readResult(
    taskDir: string,
    originalStat: Stats,
  ): Promise<{ summary?: ArchiveResultSummary; error?: ArchiveIndexError }> {
    const file = 'result.json' as const;
    let handle: FileHandle | undefined;
    try {
      const noFollow = constants.O_NOFOLLOW ?? 0;
      handle = await this.fs.open(join(taskDir, file), constants.O_RDONLY | noFollow);
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || !sameFile(originalStat, openedStat)) {
        return { error: fileError('read', file, 'FILE_CHANGED') };
      }
      const raw = await readBounded(handle);
      const currentStat = await this.fs.lstat(join(taskDir, file));
      if (currentStat.isSymbolicLink() || !currentStat.isFile() || !sameFile(openedStat, currentStat)) {
        return { error: fileError('read', file, 'FILE_CHANGED') };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(UTF8.decode(raw));
      } catch {
        return { error: fileError('parse', file, 'INVALID_JSON') };
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { error: fileError('parse', file, 'RESULT_NOT_OBJECT') };
      }
      return { summary: summarize(parsed as Record<string, unknown>) };
    } catch (error) {
      return { error: fileError('read', file, errorCode(error)) };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
