/**
 * Project registry — stable project identities that workspace paths alias to
 * (mailbox task 2).
 *
 * A project is a logical identity (`p_<12hex>`) independent of any directory;
 * workspace paths (hashed to the same sixteen-hex id BoardStore uses for its
 * `ws-<id>.jsonl` files) become aliases of a project. Once a workspace is
 * aliased, BoardStore's `parseScope` resolves the workspace scope to the
 * project's shared board file (`project-<id>.jsonl`), so several directories
 * — or a migrated workspace — can back one board.
 *
 * Persistence: `<home>/registry.jsonl`, append-only records
 *   {op:'create',  projectId, name?, ts}
 *   {op:'alias',   projectId, pathHash, ts}
 *   {op:'unalias', projectId, pathHash, ts}
 *   {op:'rename',  projectId, name, ts}
 * The current view is an in-memory projection rebuilt by folding the log,
 * invalidated by the real file size (same pattern as BoardStore's `fold()`),
 * so `resolveCached` can answer synchronously on the parseScope hot path while
 * peer processes' appends are picked up on the next `refreshIfStale`.
 *
 * Concurrency: every append runs under `withAppendLock` (task 1) and conflict
 * checks re-refresh the projection inside the lock, so two processes cannot
 * register competing owners for the same pathHash.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { moamcpHome } from '../bus/registry.js';
import { withAppendLock } from './append-lock.js';

/** One append-only line of `<home>/registry.jsonl`. */
export type ProjectRegistryRecord =
  | { op: 'create'; projectId: string; name?: string; ts: string }
  | { op: 'alias'; projectId: string; pathHash: string; ts: string }
  | { op: 'unalias'; projectId: string; pathHash: string; ts: string }
  | { op: 'rename'; projectId: string; name: string; ts: string };

/** Folded per-project view behind the projection maps. */
interface ProjectProjection {
  name?: string;
  createdAt: string;
  aliases: Set<string>;
}

/** Row shape returned by `listProjects` (aliases sorted for determinism). */
export interface ProjectSummary {
  projectId: string;
  name?: string;
  aliases: string[];
  createdAt: string;
}

export interface ProjectRegistryOptions {
  /** Brand home holding `registry.jsonl`. Default `moamcpHome()` (read at call time, so `MOAMCP_HOME` redirects). */
  homeDir?: string;
}

export const PROJECT_ID_PATTERN = /^p_[0-9a-f]{12}$/;

/** Fresh project id: `p_` + the first 12 hex chars of a dashed-less randomUUID. */
export function newProjectId(): string {
  return 'p_' + randomUUID().replace(/-/g, '').slice(0, 12);
}

function validateProjectId(projectId: unknown): string {
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(`invalid projectId: ${String(projectId)} (expected p_<12 hex chars>)`);
  }
  return projectId;
}

function validatePathHash(pathHash: unknown): string {
  if (typeof pathHash !== 'string' || pathHash.length === 0) {
    throw new Error('pathHash must be a non-empty string');
  }
  return pathHash;
}

/** undefined/null stay absent; anything else must be a non-empty string. */
function normalizeOptionalName(name: unknown): string | undefined {
  if (name === undefined || name === null) return undefined;
  if (typeof name !== 'string' || name.length === 0) throw new Error('name must be a non-empty string');
  return name;
}

function validateName(name: unknown): string {
  const normalized = normalizeOptionalName(name);
  if (normalized === undefined) throw new Error('name must be a non-empty string');
  return normalized;
}

function isRegistryRecord(value: unknown): value is ProjectRegistryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.ts !== 'string') return false;
  switch (record.op) {
    case 'create':
      return typeof record.projectId === 'string' && (record.name === undefined || typeof record.name === 'string');
    case 'alias':
    case 'unalias':
      return typeof record.projectId === 'string' && typeof record.pathHash === 'string';
    case 'rename':
      return typeof record.projectId === 'string' && typeof record.name === 'string';
    default:
      return false;
  }
}

export class ProjectRegistry {
  private readonly homeDir?: string;
  /** Folded view: projectId → projection. */
  private readonly projects = new Map<string, ProjectProjection>();
  /** Folded view: pathHash → owning projectId. */
  private readonly byAlias = new Map<string, string>();
  /** Whether the log fold has run at least once. */
  private loaded = false;
  /** Whether the last fold saw the file. */
  private fileExists = false;
  /** Bytes actually returned by the last stable read; never a pre-read stat size. */
  private fileBytes = 0;

  constructor(opts: ProjectRegistryOptions = {}) {
    this.homeDir = opts.homeDir;
  }

  /** `<home>/registry.jsonl`; home resolves at call time like BoardStore's boards dir. */
  registryFile(): string {
    return join(this.homeDir ?? moamcpHome(), 'registry.jsonl');
  }

  /**
   * Synchronous alias lookup on the in-memory projection (no I/O). This is the
   * parseScope hot path: a miss simply keeps the legacy workspace scope, and a
   * stale projection self-heals on the next fold-driven `refreshIfStale`.
   */
  resolveCached(pathHash: string): string | undefined {
    return this.byAlias.get(pathHash);
  }

  /**
   * Rebuild the projection when the log's size changed (or appeared/vanished).
   * Size check only: unchanged files are neither opened nor read.
   */
  async refreshIfStale(): Promise<void> {
    const file = this.registryFile();
    let currentSize: number | undefined;
    try {
      currentSize = (await stat(file)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const exists = currentSize !== undefined;
    if (this.loaded && this.fileExists === exists && (!exists || this.fileBytes === currentSize)) return;

    this.projects.clear();
    this.byAlias.clear();
    this.loaded = true;
    this.fileExists = exists;
    if (!exists) {
      this.fileBytes = 0;
      return;
    }

    // Read until the size observed before reading matches the bytes returned,
    // so a racing append never folds a torn tail as the whole truth (mirrors
    // BoardStore.readPersistentSnapshot).
    let raw = '';
    let bytes = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        raw = await readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.fileExists = false;
          this.fileBytes = 0;
          return;
        }
        throw err;
      }
      bytes = Buffer.byteLength(raw, 'utf8');
      let afterSize: number | undefined;
      try {
        afterSize = (await stat(file)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (afterSize === bytes) break;
    }
    this.fileBytes = bytes;

    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        console.warn(`[moamcp] registry: skipping unparseable line in ${file}`);
        continue;
      }
      if (!isRegistryRecord(record)) {
        console.warn(`[moamcp] registry: skipping malformed record in ${file}`);
        continue;
      }
      this.applyRecord(record);
    }
  }

  /** Create a project (optionally named) and return its fresh `p_<12hex>` id. */
  async createProject(name?: unknown): Promise<string> {
    const normalizedName = normalizeOptionalName(name);
    const projectId = newProjectId();
    await this.appendUnderLock({
      op: 'create',
      projectId,
      ...(normalizedName !== undefined ? { name: normalizedName } : {}),
      ts: new Date().toISOString(),
    });
    return projectId;
  }

  /**
   * Alias a pathHash to a project. Idempotent when the hash already belongs to
   * that project; rejects when it belongs to another (second-owner conflict)
   * or when the project is unknown.
   */
  async addAlias(projectId: unknown, pathHash: unknown): Promise<void> {
    const id = validateProjectId(projectId);
    const hash = validatePathHash(pathHash);
    await this.mutateUnderLock(async () => {
      const owner = this.byAlias.get(hash);
      if (owner === id) return; // already this project's alias: no record, no error
      if (owner !== undefined) {
        throw new Error(`pathHash ${hash} is already aliased to project ${owner} (cannot alias to ${id})`);
      }
      if (!this.projects.has(id)) throw new Error(`unknown projectId: ${id}`);
      await this.appendRecord({ op: 'alias', projectId: id, pathHash: hash, ts: new Date().toISOString() });
    });
  }

  /** Drop a pathHash alias (record op `unalias`); idempotent for unmapped hashes. */
  async removeAlias(pathHash: unknown): Promise<void> {
    const hash = validatePathHash(pathHash);
    await this.mutateUnderLock(async () => {
      const owner = this.byAlias.get(hash);
      if (owner === undefined) return;
      await this.appendRecord({ op: 'unalias', projectId: owner, pathHash: hash, ts: new Date().toISOString() });
    });
  }

  /** Rename a project; rejects for unknown projects. */
  async renameProject(projectId: unknown, name: unknown): Promise<void> {
    const id = validateProjectId(projectId);
    const normalizedName = validateName(name);
    await this.mutateUnderLock(async () => {
      if (!this.projects.has(id)) throw new Error(`unknown projectId: ${id}`);
      await this.appendRecord({ op: 'rename', projectId: id, name: normalizedName, ts: new Date().toISOString() });
    });
  }

  /** Folded project list (refreshes first); sorted by creation, then id. */
  async listProjects(): Promise<ProjectSummary[]> {
    await this.refreshIfStale();
    return [...this.projects.entries()]
      .map(([projectId, project]) => ({
        projectId,
        ...(project.name !== undefined ? { name: project.name } : {}),
        aliases: [...project.aliases].sort(),
        createdAt: project.createdAt,
      }))
      .sort((a, b) => {
        const order = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        return Number.isFinite(order) && order !== 0 ? order : a.projectId.localeCompare(b.projectId);
      });
  }

  // ---- internals ----

  /**
   * Run a check-then-append mutation under the registry's append lock, with a
   * forced-enough refresh inside the lock: peers also append under this lock,
   * so any peer change moved the file size and the refresh observes it.
   */
  private async mutateUnderLock(fn: () => Promise<void>): Promise<void> {
    const file = this.registryFile();
    await this.acquireLock(file, async () => {
      await this.refreshIfStale();
      await fn();
    });
  }

  /** createProject's unconditional append (still locked + refreshed). */
  private async appendUnderLock(record: ProjectRegistryRecord): Promise<void> {
    const file = this.registryFile();
    await this.acquireLock(file, async () => {
      await this.refreshIfStale();
      await this.appendRecord(record);
    });
  }

  /** The lock file lives beside the log, so its directory must pre-exist acquisition. */
  private async acquireLock(file: string, fn: () => Promise<void>): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await withAppendLock(file, fn);
  }

  /** Append one record line and fold it into the projection. Caller holds the lock. */
  private async appendRecord(record: ProjectRegistryRecord): Promise<void> {
    const file = this.registryFile();
    const line = JSON.stringify(record) + '\n';
    await appendFile(file, line, 'utf8');
    this.applyRecord(record);
    // The lock excludes peer appends, so the bookkeeping stays exact without a stat.
    this.loaded = true;
    this.fileExists = true;
    this.fileBytes += Buffer.byteLength(line, 'utf8');
  }

  /** Fold one record into the projection (log is authoritative; last write wins). */
  private applyRecord(record: ProjectRegistryRecord): void {
    switch (record.op) {
      case 'create': {
        if (this.projects.has(record.projectId)) return; // replay/idempotent
        this.projects.set(record.projectId, {
          ...(record.name !== undefined ? { name: record.name } : {}),
          createdAt: record.ts,
          aliases: new Set(),
        });
        return;
      }
      case 'alias': {
        let project = this.projects.get(record.projectId);
        if (project === undefined) {
          // Defensive: an alias record with no create seen (partial log) still
          // resolves; the placeholder carries the record's timestamp.
          project = { createdAt: record.ts, aliases: new Set() };
          this.projects.set(record.projectId, project);
        }
        const previous = this.byAlias.get(record.pathHash);
        if (previous !== undefined && previous !== record.projectId) {
          this.projects.get(previous)?.aliases.delete(record.pathHash);
        }
        this.byAlias.set(record.pathHash, record.projectId);
        project.aliases.add(record.pathHash);
        return;
      }
      case 'unalias': {
        const owner = this.byAlias.get(record.pathHash);
        this.byAlias.delete(record.pathHash);
        if (owner !== undefined) this.projects.get(owner)?.aliases.delete(record.pathHash);
        return;
      }
      case 'rename': {
        const project = this.projects.get(record.projectId);
        if (project !== undefined) project.name = record.name;
        return;
      }
    }
  }
}
