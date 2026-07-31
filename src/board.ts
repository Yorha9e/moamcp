/**
 * Shared blackboard — a structured, pull-on-demand, waitable cross-agent
 * information channel.
 *
 * Three scopes:
 *   - `task:<task_id>`  debate-local notes; in-memory, archived by
 *     `moa_complete` as `board.jsonl` alongside the three-layer archive.
 *   - `workspace`       cross-session module handoff within one project;
 *       persisted at `<home>/boards/ws-<sha1(cwd)[:16]>.jsonl`. The workspace
 *       identity is the moamcp server process's cwd (the project root the host
 *       CLI spawns the MCP server with).
 *   - `global`          cross-project; persisted at `<home>/boards/global.jsonl`.
 *
 * Data model: entries `{key, value, author, ts, tags[]}` where value is a
 * markdown string capped at 32 KB. Same-key writes are last-write-wins; the
 * on-disk format is append-only JSONL (`{op:'write'|'delete', ...}` records)
 * and the current view is rebuilt by folding the log on first access, so
 * deletes leave tombstones instead of rewriting history.
 *
 * Concurrency: every mutation runs on a per-scope promise queue (same pattern
 * as DebateHub.enqueue) so interleaved writes serialize and wait-checks are
 * atomic w.r.t. the write that wakes them. Events (`board_updated`) fire after
 * the append lands; the server routes task-scope events onto the task's SSE
 * stream and workspace/global events onto a synthetic `@board/<scope>` bus
 * channel (card panels for those are future work).
 *
 * Multi-process caveat (accepted simplification, mirrors the instance
 * registry's documented race window): two moamcp processes sharing one home
 * each hold an in-memory fold — a peer's append is not observed until this
 * process re-loads the scope, and cross-process waiters are never woken
 * directly; they fall back to the safety-cap timeout + `{retry:true}` polling
 * loop. Unparseable JSONL lines (torn cross-process appends) are skipped with
 * a warning rather than poisoning the fold.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { moamcpHome } from './registry.js';
import { DEFAULT_WAIT_CAP_MS } from './state.js';

/** Hard cap on a single entry value (markdown payload; larger content belongs in files). */
export const BOARD_VALUE_MAX_BYTES = 32 * 1024;

/** Default/max entry counts for unbounded reads ("limit 防爆"). */
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 1000;
const KEY_MAX_BYTES = 512;

export interface BoardEntry {
  key: string;
  value: string;
  author: string;
  /** ISO timestamp, monotonic within a process (sub-ms writes still order strictly). */
  ts: string;
  tags: string[];
}

/** One append-only JSONL line; tombstones carry no value/tags. */
interface BoardRecord {
  op: 'write' | 'delete';
  /** Canonical scope key (`global`, `workspace:<hash>`, `task:<id>`). */
  scope: string;
  key: string;
  value?: string;
  author: string;
  ts: string;
  tags?: string[];
}

export type BoardWaitPayload =
  | { status: 'ready'; entry: BoardEntry }
  | { status: 'timeout'; retry: true }
  | { status: 'closed' };

/** Fired after a write/delete lands; the server routes it by scope kind. */
export interface BoardEvent {
  type: 'board_updated';
  op: 'write' | 'delete';
  /** Human-facing scope name as callers pass it (`workspace` / `global` / `task:<id>`). */
  scope: string;
  key: string;
  author: string;
  ts: string;
  // Structurally assignable to the hub's DomainEvent (routes through the same sink).
  [key: string]: unknown;
}

export type BoardScope =
  | { kind: 'global'; key: string; label: string }
  | { kind: 'workspace'; key: string; label: string }
  | { kind: 'task'; key: string; label: string; taskId: string };

export interface BoardStoreOptions {
  /** Brand home holding `boards/`. Default `moamcpHome()` (read at call time, so `MOAMCP_HOME` redirects). */
  homeDir?: string;
  /** Workspace identity. Default `process.cwd()`. */
  workspaceCwd?: string;
  /** Safety cap for one `wait` call. Default DEFAULT_WAIT_CAP_MS (25min). */
  waitCapMs?: number;
  /** Event sink (wired by the server to the SSE outlet). */
  emit?: (scope: BoardScope, event: BoardEvent) => void;
}

interface Waiter {
  key: string;
  /** Resolve only for entries strictly newer than this epoch (undefined: any value). */
  sinceEpoch: number | undefined;
  resolve: (payload: BoardWaitPayload) => void;
  timer: NodeJS.Timeout;
}

interface ScopeState {
  /** Folded current view: key → latest live entry (deleted keys absent). */
  entries: Map<string, BoardEntry>;
  /** Persistent scopes: whether the JSONL fold has run. */
  loaded: boolean;
  /** Task scopes: raw record log replayed into `board.jsonl` at archive time. */
  history?: BoardRecord[];
  /** Persistent scopes: append target. */
  file?: string;
  /** Workspace scopes: sidecar recording which cwd the hash stands for. */
  metaFile?: string;
  metaWritten?: boolean;
  metaCwd?: string;
  waiters: Set<Waiter>;
}

function validateKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0) throw new Error('key must be a non-empty string');
  if (Buffer.byteLength(key, 'utf8') > KEY_MAX_BYTES) throw new Error(`key exceeds ${KEY_MAX_BYTES} bytes`);
  return key;
}

function validateValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('value must be a string (markdown)');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > BOARD_VALUE_MAX_BYTES) {
    throw new Error(`value too large: ${bytes} bytes > ${BOARD_VALUE_MAX_BYTES} (put large content in files, reference them from the board)`);
  }
  return value;
}

function normalizeTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new Error('tags must be a string array');
  return tags.map((tag) => {
    if (typeof tag !== 'string' || tag.length === 0) throw new Error('tags must be non-empty strings');
    return tag;
  });
}

function normalizeAuthor(author: unknown): string {
  if (author === undefined || author === null || author === '') return 'anonymous';
  if (typeof author !== 'string') throw new Error('author must be a string');
  return author;
}

function isRecord(value: BoardRecord): boolean {
  return (
    (value.op === 'write' || value.op === 'delete') &&
    typeof value.key === 'string' &&
    typeof value.author === 'string' &&
    typeof value.ts === 'string' &&
    (value.op === 'delete' || typeof value.value === 'string')
  );
}

export class BoardStore {
  private readonly scopes = new Map<string, ScopeState>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly homeDir?: string;
  private readonly workspaceCwd: string;
  private readonly waitCapMs: number;
  private readonly emitFn?: (scope: BoardScope, event: BoardEvent) => void;
  /** Monotonic ts generator state: strictly increasing epoch across writes in this process. */
  private lastEpoch = 0;

  constructor(opts: BoardStoreOptions = {}) {
    this.homeDir = opts.homeDir;
    this.workspaceCwd = opts.workspaceCwd ?? process.cwd();
    this.waitCapMs = opts.waitCapMs ?? DEFAULT_WAIT_CAP_MS;
    this.emitFn = opts.emit;
  }

  // ---- tools ----

  async write(
    key: unknown,
    value: unknown,
    tags: unknown,
    author: unknown,
    scopeInput: unknown,
  ): Promise<{ ok: true; ts: string }> {
    const k = validateKey(key);
    const v = validateValue(value);
    const normalizedTags = normalizeTags(tags);
    const normalizedAuthor = normalizeAuthor(author);
    const scope = this.parseScope(scopeInput);
    const state = this.scopeState(scope);
    return this.enqueue(scope.key, async () => {
      await this.fold(state);
      const ts = this.nextTs();
      const entry: BoardEntry = { key: k, value: v, author: normalizedAuthor, ts, tags: normalizedTags };
      state.entries.set(k, entry);
      const record: BoardRecord = {
        op: 'write',
        scope: scope.key,
        key: k,
        value: v,
        author: normalizedAuthor,
        ts,
        ...(normalizedTags.length > 0 ? { tags: normalizedTags } : {}),
      };
      await this.persist(state, record);
      this.wakeWaiters(state, entry);
      this.emit(scope, { type: 'board_updated', op: 'write', scope: scope.label, key: k, author: normalizedAuthor, ts });
      return { ok: true as const, ts };
    });
  }

  /**
   * Folded read: with `key`, the live entry for that key (0/1 rows); with
   * `tag`, live entries carrying that tag; with neither, every key's latest
   * value. Newest first, capped by `limit` (default 100, max 1000).
   */
  async read(key: unknown, tag: unknown, scopeInput: unknown, limit?: unknown): Promise<BoardEntry[]> {
    if (key !== undefined && key !== null) validateKey(key);
    if (tag !== undefined && tag !== null && typeof tag !== 'string') throw new Error('tag must be a string');
    const scope = this.parseScope(scopeInput);
    const state = this.scopeState(scope);
    const cap = normalizeLimit(limit);
    return this.enqueue(scope.key, async () => {
      await this.fold(state);
      let entries = [...state.entries.values()];
      if (typeof key === 'string') entries = entries.filter((entry) => entry.key === key);
      if (typeof tag === 'string') entries = entries.filter((entry) => entry.tags.includes(tag));
      entries.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
      return entries.slice(0, cap);
    });
  }

  /** Lightweight browse: one row per live key, values replaced by their byte size. */
  async list(scopeInput: unknown): Promise<Array<{ key: string; author: string; ts: string; tags: string[]; bytes: number }>> {
    const scope = this.parseScope(scopeInput);
    const state = this.scopeState(scope);
    return this.enqueue(scope.key, async () => {
      await this.fold(state);
      return [...state.entries.values()]
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
        .map((entry) => ({
          key: entry.key,
          author: entry.author,
          ts: entry.ts,
          tags: entry.tags,
          bytes: Buffer.byteLength(entry.value, 'utf8'),
        }));
    });
  }

  /**
   * Long-poll until `key` has a value — or, with `since` (ISO timestamp),
   * until the entry is strictly newer than it ("wait for the next update").
   * Resolves `{status:'ready', entry}` on wake, `{status:'timeout', retry:true}`
   * at the cap (`timeoutMs` overrides, clamped to the cap), `{status:'closed'}`
   * when a task scope is archived out from under the waiter. Deletes do not
   * wake: waiters asked for a value, not a change.
   */
  async wait(key: unknown, scopeInput: unknown, timeoutMs?: unknown, since?: unknown): Promise<BoardWaitPayload> {
    const k = validateKey(key);
    const scope = this.parseScope(scopeInput);
    const state = this.scopeState(scope);
    let sinceEpoch: number | undefined;
    if (since !== undefined && since !== null) {
      if (typeof since !== 'string' || Number.isNaN(Date.parse(since))) {
        throw new Error(`invalid since timestamp: ${String(since)} (expected ISO 8601)`);
      }
      sinceEpoch = Date.parse(since);
    }
    let effectiveTimeout = this.waitCapMs;
    if (timeoutMs !== undefined && timeoutMs !== null) {
      if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('timeoutMs must be a positive number');
      }
      effectiveTimeout = Math.min(timeoutMs, this.waitCapMs);
    }
    // The check runs inside the per-scope queue (atomic w.r.t. writes), but the
    // suspended promise is returned in a holder so the queue itself does NOT
    // wait for it — otherwise every later call would queue behind it.
    type Outcome = { kind: 'now'; payload: BoardWaitPayload } | { kind: 'suspended'; promise: Promise<BoardWaitPayload> };
    const outcome = await this.enqueue<Outcome>(scope.key, async () => {
      await this.fold(state);
      const current = state.entries.get(k);
      if (current !== undefined && (sinceEpoch === undefined || Date.parse(current.ts) > sinceEpoch)) {
        return { kind: 'now', payload: { status: 'ready', entry: current } };
      }
      const promise = new Promise<BoardWaitPayload>((resolve) => {
        const waiter: Waiter = {
          key: k,
          sinceEpoch,
          resolve,
          timer: setTimeout(() => {
            state.waiters.delete(waiter);
            resolve({ status: 'timeout', retry: true });
          }, effectiveTimeout),
        };
        state.waiters.add(waiter);
      });
      return { kind: 'suspended', promise };
    });
    return outcome.kind === 'now' ? outcome.payload : outcome.promise;
  }

  /** Tombstone delete: the key vanishes from read/list; the JSONL keeps the record. */
  async delete(key: unknown, author: unknown, scopeInput: unknown): Promise<{ ok: true; ts: string }> {
    const k = validateKey(key);
    const normalizedAuthor = normalizeAuthor(author);
    const scope = this.parseScope(scopeInput);
    const state = this.scopeState(scope);
    return this.enqueue(scope.key, async () => {
      await this.fold(state);
      const ts = this.nextTs();
      state.entries.delete(k);
      await this.persist(state, { op: 'delete', scope: scope.key, key: k, author: normalizedAuthor, ts });
      this.emit(scope, { type: 'board_updated', op: 'delete', scope: scope.label, key: k, author: normalizedAuthor, ts });
      return { ok: true as const, ts };
    });
  }

  // ---- task lifecycle ----

  /**
   * Write the task scope's raw record log to `<dir>/board.jsonl` (the fourth
   * archive layer), wake any remaining waiters with `{status:'closed'}`, and
   * drop the in-memory scope. Called by `DebateHub.complete`. Idempotent for
   * tasks that never used the board (writes an empty file).
   */
  async archiveTask(taskId: string, dir: string): Promise<void> {
    const key = `task:${taskId}`;
    const state = this.scopes.get(key);
    const records = state?.history ?? [];
    await mkdir(dir, { recursive: true });
    const body = records.length > 0 ? records.map((record) => JSON.stringify(record)).join('\n') + '\n' : '';
    await writeFile(resolve(dir, 'board.jsonl'), body);
    if (state !== undefined) {
      for (const waiter of [...state.waiters]) {
        state.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve({ status: 'closed' });
      }
      this.scopes.delete(key);
      this.queues.delete(key);
    }
  }

  // ---- internals ----

  private parseScope(input: unknown): BoardScope {
    if (input === undefined || input === null) input = 'workspace';
    if (typeof input !== 'string') throw new Error('scope must be a string');
    const raw = input.trim();
    if (raw === 'workspace') {
      const hash = createHash('sha1').update(resolve(this.workspaceCwd)).digest('hex').slice(0, 16);
      return { kind: 'workspace', key: `workspace:${hash}`, label: 'workspace' };
    }
    if (raw === 'global') return { kind: 'global', key: 'global', label: 'global' };
    if (raw.startsWith('task:')) {
      const taskId = raw.slice('task:'.length);
      if (taskId.length === 0) throw new Error('invalid scope: task:<task_id> requires a non-empty task_id');
      return { kind: 'task', key: raw, label: raw, taskId };
    }
    throw new Error(`invalid scope: ${input} (expected "workspace", "global", or "task:<task_id>")`);
  }

  private boardsDir(): string {
    return join(this.homeDir ?? moamcpHome(), 'boards');
  }

  private scopeState(scope: BoardScope): ScopeState {
    let state = this.scopes.get(scope.key);
    if (state !== undefined) return state;
    state = { entries: new Map(), loaded: false, waiters: new Set() };
    if (scope.kind === 'task') {
      state.history = [];
    } else if (scope.kind === 'global') {
      state.file = join(this.boardsDir(), 'global.jsonl');
    } else {
      const hash = scope.key.slice('workspace:'.length);
      state.file = join(this.boardsDir(), `ws-${hash}.jsonl`);
      state.metaFile = join(this.boardsDir(), `ws-${hash}.meta.json`);
      state.metaCwd = resolve(this.workspaceCwd);
    }
    this.scopes.set(scope.key, state);
    return state;
  }

  /** Fold the append-only log into the current view (once per scope per process). */
  private async fold(state: ScopeState): Promise<void> {
    if (state.loaded) return;
    state.loaded = true; // a missing/unreadable log still counts as loaded (empty board)
    if (state.file === undefined) return; // task scopes are memory-only
    let raw: string;
    try {
      raw = await readFile(state.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      let record: BoardRecord;
      try {
        record = JSON.parse(line) as BoardRecord;
      } catch {
        console.warn(`[moamcp] board: skipping unparseable line in ${state.file}`);
        continue;
      }
      if (!isRecord(record)) {
        console.warn(`[moamcp] board: skipping malformed record in ${state.file}`);
        continue;
      }
      if (record.op === 'write') {
        state.entries.set(record.key, {
          key: record.key,
          value: record.value as string,
          author: record.author,
          ts: record.ts,
          tags: record.tags ?? [],
        });
      } else {
        state.entries.delete(record.key);
      }
    }
  }

  /** Append a record to the scope's JSONL (persistent scopes only) + task history. */
  private async persist(state: ScopeState, record: BoardRecord): Promise<void> {
    if (state.history !== undefined) state.history.push(record);
    if (state.file === undefined) return;
    await mkdir(this.boardsDir(), { recursive: true });
    if (state.metaFile !== undefined && !state.metaWritten) {
      state.metaWritten = true; // best-effort; a failed sidecar must not fail the write
      await writeFile(state.metaFile, JSON.stringify({ cwd: state.metaCwd, created_at: record.ts }, null, 2)).catch(() => {});
    }
    await appendFile(state.file, JSON.stringify(record) + '\n');
  }

  private wakeWaiters(state: ScopeState, entry: BoardEntry): void {
    const epoch = Date.parse(entry.ts);
    for (const waiter of [...state.waiters]) {
      if (waiter.key !== entry.key) continue;
      if (waiter.sinceEpoch !== undefined && epoch <= waiter.sinceEpoch) continue;
      state.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve({ status: 'ready', entry });
    }
  }

  /** Strictly increasing ISO timestamp: same-millisecond writes still order (wait's `since` depends on it). */
  private nextTs(): string {
    const now = Date.now();
    this.lastEpoch = now > this.lastEpoch ? now : this.lastEpoch + 1;
    return new Date(this.lastEpoch).toISOString();
  }

  private emit(scope: BoardScope, event: BoardEvent): void {
    this.emitFn?.(scope, event);
  }

  /** Serialize all mutations for one scope through a promise chain (mirrors DebateHub.enqueue). */
  private enqueue<T>(scopeKey: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.queues.get(scopeKey) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(
      scopeKey,
      next.catch(() => {}),
    );
    return next;
  }
}

function normalizeLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_READ_LIMIT;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    throw new Error('limit must be a positive number');
  }
  return Math.min(Math.floor(limit), MAX_READ_LIMIT);
}
