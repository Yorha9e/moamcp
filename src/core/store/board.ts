/**
 * Shared blackboard — a structured, pull-on-demand, waitable cross-agent
 * information channel.
 *
 * Three scopes:
 *   - `task:<task_id>`  debate-local notes; in-memory, archived by
 *     `moa_complete` as `board.jsonl` alongside the three-layer archive.
 *   - `workspace`       cross-session module handoff within one project;
 *       persisted at `<home>/boards/ws-<sha1(workspace)[:16]>.jsonl`. The
 *       workspace identity is the explicitly supplied absolute project path;
 *       the process cwd remains the legacy default when no path is supplied.
 *       When the workspace hash is aliased to a project in the ProjectRegistry
 *       (`<home>/registry.jsonl`), the scope transparently resolves to that
 *       project instead: key `project:<projectId>`, persisted at
 *       `<home>/boards/project-<projectId>.jsonl` with a `cwds[]` sidecar —
 *       so aliased directories share one board. Unaliased behavior is
 *       unchanged; callers still pass `workspace` (aliasing is invisible to
 *       the tool surface).
 *   - `global`          cross-project; persisted at `<home>/boards/global.jsonl`.
 *   - `project:<projectId>`  direct address of a project board by id (mailbox
 *       task 3: HandoffStore writes into a target project's board without an
 *       aliased workspace path); same `project-<projectId>.jsonl` file as the
 *       alias-resolved form, but no cwd sidecar entry (no directory involved).
 *
 * Data model: entries `{key, value, author, ts, tags[]}` where value is a
 * markdown string capped at 96 KB. Same-key writes are last-write-wins; the
 * on-disk format is append-only JSONL (`{op:'write'|'delete', ...}` records)
 * and the current view is rebuilt by folding the log on access, so deletes
 * leave tombstones instead of rewriting history.
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
 * each hold an in-memory fold. Persistent waiters use one unref'd stat/read
 * poller per scope, so a peer's append is observed and can wake a waiter
 * without a local event. Torn JSONL appends are retried or skipped with a
 * warning rather than poisoning the fold. Every persistent append runs under
 * `withAppendLock` (append-lock.ts), so concurrent appenders from different
 * processes serialize on `<file>.lock` and never tear lines — this is what
 * makes alias-shared project boards safe to write from several sessions.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { moamcpHome } from '../bus/registry.js';
import { DEFAULT_WAIT_CAP_MS } from '../constants.js';
import { withAppendLock } from './append-lock.js';
import { PROJECT_ID_PATTERN, ProjectRegistry } from './project-registry.js';

/**
 * Hard caps on persisted payloads (markdown/JSON; larger content belongs in files).
 * Raw board values and handoff entries share the 96 KB ceiling; tips cap their
 * JSON-encoded value at 48 KB (their raw `context` field is capped separately at
 * 32 KB, so the layers fail closed independently by design).
 */
export const BOARD_VALUE_MAX_BYTES = 96 * 1024;
/** Handoff entries are JSON under `handoff/<id>`; same ceiling as raw board values. */
export const HANDOFF_VALUE_MAX_BYTES = 96 * 1024;
/** Tips are JSON under `tips/<id>`; encoded size capped at 48 KB. */
export const TIP_VALUE_MAX_BYTES = 48 * 1024;

/** Default/max entry counts for unbounded reads ("limit 防爆"). */
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 1000;
const KEY_MAX_BYTES = 512;

/** Poll cadence for persistent waits; timers are unref'd and only run with waiters. */
export const DEFAULT_BOARD_POLL_INTERVAL_MS = 250;
/** Backward-friendly alias for callers that want to describe the interval directly. */
export const BOARD_POLL_INTERVAL_MS = DEFAULT_BOARD_POLL_INTERVAL_MS;

/** Character cap for a custom workspace name (mailbox task 5a; HTTP enforces the same cap). */
export const WORKSPACE_NAME_MAX_CHARS = 80;

/** A registered workspace sidecar (`ws-<id>.meta.json`) plus board activity metadata. */
export interface WorkspaceInfo {
  id: string;
  cwd: string;
  createdAt: string;
  /** mtime of the workspace JSONL when it exists; absent for empty workspaces. */
  updatedAt?: string;
  /** Optional user-defined display name kept in the sidecar (mailbox task 5a). */
  name?: string;
}

/** Normalize a workspace path without resolving a relative path by accident. */
export function normalizeWorkspacePath(workspace: string): string {
  if (typeof workspace !== 'string' || workspace.length === 0 || !isAbsolute(workspace)) {
    throw new Error('workspace must be an absolute path');
  }
  return resolve(workspace);
}

/** The stable sixteen-hex-character identity used by workspace board files. */
export function workspaceIdForPath(workspace: string): string {
  return createHash('sha1').update(normalizeWorkspacePath(workspace)).digest('hex').slice(0, 16);
}

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
  /** Canonical scope key (`global`, `workspace:<hash>`, `project:<projectId>`, `task:<id>`). */
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
  | { kind: 'workspace'; key: string; label: string; id?: string; cwd?: string }
  | { kind: 'project'; key: string; label: string; id: string; cwd?: string }
  | { kind: 'task'; key: string; label: string; taskId: string };

export interface BoardMutationCommit<T> {
  result: T;
  writes: Array<{ key: string; value: string; author?: string; tags?: string[] }>;
}

export interface BoardStoreOptions {
  /** Brand home holding `boards/`. Default `moamcpHome()` (read at call time, so `MOAMCP_HOME` redirects). */
  homeDir?: string;
  /** Workspace identity. Default `process.cwd()`. */
  workspaceCwd?: string;
  /** Safety cap for one `wait` call. Default DEFAULT_WAIT_CAP_MS (25min). */
  waitCapMs?: number;
  /** Poll cadence for persistent waits. Default 250ms; tests may inject a shorter interval. */
  pollIntervalMs?: number;
  /** Alias accepted by callers that name this as a workspace poll interval. */
  workspacePollIntervalMs?: number;
  /** Event sink (wired by the server to the SSE outlet). */
  emit?: (scope: BoardScope, event: BoardEvent) => void;
  /** Project registry backing workspace→project alias resolution. Default: one bound to `homeDir`. */
  registry?: ProjectRegistry;
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
  /** Last record timestamp per key, including tombstones, for timestamp LWW folding. */
  versions: Map<string, string>;
  /** Persistent scopes: whether the JSONL fold has run. */
  loaded: boolean;
  /** Persistent scopes: whether the last snapshot saw the file. */
  fileExists?: boolean;
  /** Bytes actually returned by the last stable read; never a pre-read stat size. */
  fileBytes?: number;
  /** Task scopes: raw record log replayed into `board.jsonl` at archive time. */
  history?: BoardRecord[];
  /** Persistent scopes: append target. */
  file?: string;
  /** Workspace/project scopes: sidecar recording which cwd(s) the identity stands for. */
  metaFile?: string;
  metaWritten?: boolean;
  metaCwd?: string;
  /** Project scopes: the sidecar keeps a `cwds[]` array instead of one `cwd`. */
  projectScope?: boolean;
  /** One unref'd poller per persistent scope, while at least one waiter exists. */
  pollTimer?: NodeJS.Timeout;
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
    (value.tags === undefined || (Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string'))) &&
    (value.op === 'delete' || typeof value.value === 'string')
  );
}

function cloneEntry(entry: BoardEntry): BoardEntry {
  return { ...entry, tags: [...entry.tags] };
}

function cloneEntries(entries: Map<string, BoardEntry>): Map<string, BoardEntry> {
  return new Map([...entries].map(([key, entry]) => [key, cloneEntry(entry)]));
}

function sameEntry(a: BoardEntry | undefined, b: BoardEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.key === b.key && a.value === b.value && a.author === b.author && a.ts === b.ts &&
    a.tags.length === b.tags.length && a.tags.every((tag, index) => tag === b.tags[index]);
}

function compareTimestamps(a: string, b: string): number {
  const ae = Date.parse(a);
  const be = Date.parse(b);
  if (Number.isFinite(ae) && Number.isFinite(be)) return ae - be;
  return a < b ? -1 : a > b ? 1 : 0;
}

function validPollInterval(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : DEFAULT_BOARD_POLL_INTERVAL_MS;
}

export function matchKeyNamespace(entryKey: string, searchKey: string): boolean {
  if (entryKey === searchKey) return true;
  const prefix = searchKey.endsWith('/') ? searchKey : searchKey + '/';
  if (entryKey.startsWith(prefix)) return true;
  const baseKey = searchKey.endsWith('/') ? searchKey.slice(0, -1) : searchKey;
  if (entryKey === baseKey) return true;
  return false;
}

export class BoardStore {
  private readonly scopes = new Map<string, ScopeState>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly homeDir?: string;
  private readonly workspaceCwd: string;
  private readonly waitCapMs: number;
  private readonly pollIntervalMs: number;
  private readonly emitFn?: (scope: BoardScope, event: BoardEvent) => void;
  private closed = false;
  /** Monotonic ts generator state: strictly increasing epoch across writes in this process. */
  private lastEpoch = 0;
  /** Workspace→project alias resolution; its projection refreshes piggyback on `fold`. */
  readonly registry: ProjectRegistry;

  constructor(opts: BoardStoreOptions = {}) {
    this.homeDir = opts.homeDir;
    // The legacy constructor option accepted a cwd and resolved it implicitly;
    // keep that behavior while per-call `workspace` values are strict absolute paths.
    this.workspaceCwd = resolve(opts.workspaceCwd ?? process.cwd());
    this.waitCapMs = opts.waitCapMs ?? DEFAULT_WAIT_CAP_MS;
    this.pollIntervalMs = validPollInterval(opts.pollIntervalMs ?? opts.workspacePollIntervalMs);
    this.emitFn = opts.emit;
    this.registry = opts.registry ?? new ProjectRegistry({ homeDir: opts.homeDir });
  }

  // ---- tools ----

  async write(
    key: unknown,
    value: unknown,
    tags: unknown,
    author: unknown,
    scopeInput: unknown,
    workspace?: unknown,
  ): Promise<{ ok: true; ts: string }> {
    this.assertOpen();
    const k = validateKey(key);
    const v = validateValue(value);
    const normalizedTags = normalizeTags(tags);
    const normalizedAuthor = normalizeAuthor(author);
    await this.refreshRegistryForScope();
    const scope = this.parseScope(scopeInput, workspace);
    const state = this.scopeState(scope);
    return this.enqueue(scope.key, async () => {
      await this.fold(state);
      const ts = this.nextTs();
      const record: BoardRecord = {
        op: 'write',
        scope: scope.key,
        key: k,
        value: v,
        author: normalizedAuthor,
        ts,
        ...(normalizedTags.length > 0 ? { tags: normalizedTags } : {}),
      };
      this.applyRecord(state, record);
      await this.persist(state, record);
      const entry = state.entries.get(k);
      if (entry !== undefined && entry.ts === ts) this.wakeWaiters(state, entry);
      this.emit(scope, { type: 'board_updated', op: 'write', scope: scope.label, key: k, author: normalizedAuthor, ts });
      return { ok: true as const, ts };
    });
  }

  /**
   * Folded read: with `key`, the live entry for that key (0/1 rows); with
   * `tag`, live entries carrying that tag; with neither, every key's latest
   * value. Newest first, capped by `limit` (default 100, max 1000).
   */
  async read(key: unknown, tag: unknown, scopeInput: unknown, limit?: unknown, workspace?: unknown): Promise<BoardEntry[]> {
    this.assertOpen();
    // Accept the natural `(key, tag, scope, workspace)` spelling as well as
    // the legacy limit position; MCP callers use the explicit final field.
    if (workspace === undefined && typeof limit === 'string' && isAbsolute(limit)) {
      workspace = limit;
      limit = undefined;
    }
    if (key !== undefined && key !== null) validateKey(key);
    if (tag !== undefined && tag !== null && typeof tag !== 'string') throw new Error('tag must be a string');
    await this.refreshRegistryForScope();
    const scope = this.parseScope(scopeInput, workspace);
    const state = this.scopeState(scope);
    const cap = normalizeLimit(limit);
    return this.enqueue(scope.key, async () => {
      await this.fold(state);
      let entries = [...state.entries.values()];
      if (typeof key === 'string') entries = entries.filter((entry) => entry.key === key);
      if (typeof tag === 'string') entries = entries.filter((entry) => entry.tags.includes(tag));
      entries.sort((a, b) => compareTimestamps(b.ts, a.ts));
      return entries.slice(0, cap).map(cloneEntry);
    });
  }

  /**
   * Namespace search for Raw Board: matches exact `key` as well as any descendant
   * under `key/` (handling trailing slashes naturally), but does not match `xyz`
   * when searching for `x`. Filtering happens before limit, capped by `limit`.
   */
  async readNamespace(
    keyPrefix: unknown,
    tag: unknown,
    scopeInput: unknown,
    limit?: unknown,
    workspace?: unknown,
  ): Promise<BoardEntry[]> {
    this.assertOpen();
    if (workspace === undefined && typeof limit === 'string' && isAbsolute(limit)) {
      workspace = limit;
      limit = undefined;
    }
    if (keyPrefix !== undefined && keyPrefix !== null) validateKey(keyPrefix);
    if (tag !== undefined && tag !== null && typeof tag !== 'string') throw new Error('tag must be a string');
    await this.refreshRegistryForScope();
    const scope = this.parseScope(scopeInput, workspace);
    const state = this.scopeState(scope);
    const cap = normalizeLimit(limit);
    return this.enqueue(scope.key, async () => {
      await this.fold(state);
      let entries = [...state.entries.values()];
      if (typeof keyPrefix === 'string' && keyPrefix.length > 0) {
        entries = entries.filter((entry) => matchKeyNamespace(entry.key, keyPrefix));
      }
      if (typeof tag === 'string') entries = entries.filter((entry) => entry.tags.includes(tag));
      entries.sort((a, b) => compareTimestamps(b.ts, a.ts));
      return entries.slice(0, cap).map(cloneEntry);
    });
  }

  /** Lightweight browse: one row per live key, values replaced by their byte size. */
  async list(scopeInput: unknown, workspace?: unknown): Promise<Array<{ key: string; author: string; ts: string; tags: string[]; bytes: number }>> {
    this.assertOpen();
    await this.refreshRegistryForScope();
    const scope = this.parseScope(scopeInput, workspace);
    const state = this.scopeState(scope);
    return this.enqueue(scope.key, async () => {
      await this.fold(state);
      return [...state.entries.values()]
        .sort((a, b) => compareTimestamps(b.ts, a.ts))
        .map((entry) => ({
          key: entry.key,
          author: entry.author,
          ts: entry.ts,
          tags: [...entry.tags],
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
  async wait(key: unknown, scopeInput: unknown, timeoutMs?: unknown, since?: unknown, workspace?: unknown): Promise<BoardWaitPayload> {
    this.assertOpen();
    if (workspace === undefined && typeof since === 'string' && isAbsolute(since)) {
      workspace = since;
      since = undefined;
    }
    const k = validateKey(key);
    await this.refreshRegistryForScope();
    const scope = this.parseScope(scopeInput, workspace);
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
        return { kind: 'now', payload: { status: 'ready', entry: cloneEntry(current) } };
      }
      const promise = new Promise<BoardWaitPayload>((resolve) => {
        const waiter: Waiter = {
          key: k,
          sinceEpoch,
          resolve,
          timer: setTimeout(() => {
            state.waiters.delete(waiter);
            this.stopPollIfIdle(state);
            resolve({ status: 'timeout', retry: true });
          }, effectiveTimeout),
        };
        state.waiters.add(waiter);
        this.ensurePollTimer(scope, state);
      });
      return { kind: 'suspended', promise };
    });
    return outcome.kind === 'now' ? outcome.payload : outcome.promise;
  }

  /**
   * Atomically inspect and mutate one scope. The callback runs inside the same
   * scope queue as reads/writes and receives the one commit timestamp used for
   * every changed BoardEntry and JSONL record. The preferred form is
   * `mutate(scope, (entries, commitTs) => result, workspace)`; a key-oriented
   * overload is retained for small typed projections such as Tips.
   */
  async mutate<T>(
    scopeInput: unknown,
    mutator: (entries: Map<string, BoardEntry>, commitTs: string) => T | Promise<T>,
    workspace?: unknown,
  ): Promise<T>;
  async mutate<T>(
    key: unknown,
    scopeInput: unknown,
    mutator: (entry: BoardEntry | undefined, commitTs: string) => T | Promise<T>,
    workspace?: unknown,
  ): Promise<T>;
  async mutate<T>(first: unknown, second: unknown, third?: unknown, fourth?: unknown): Promise<T> {
    this.assertOpen();
    const scopeMode = typeof second === 'function';
    const key = scopeMode ? undefined : validateKey(first);
    const scopeInput = scopeMode ? first : second;
    const mutator = (scopeMode ? second : third) as
      | ((entries: Map<string, BoardEntry>, commitTs: string) => T | Promise<T>)
      | ((entry: BoardEntry | undefined, commitTs: string) => T | Promise<T>);
    if (typeof mutator !== 'function') throw new Error('mutate requires a function mutator');
    const workspace = scopeMode ? third : fourth;
    await this.refreshRegistryForScope();
    const scope = this.parseScope(scopeInput, workspace);
    const state = this.scopeState(scope);
    return this.enqueue(scope.key, async () => {
      await this.fold(state);
      const before = cloneEntries(state.entries);
      const beforeVersions = new Map(state.versions);
      const commitTs = this.nextTs();
      let result: T;
      try {
        if (scopeMode) {
          result = await (mutator as (entries: Map<string, BoardEntry>, ts: string) => T | Promise<T>)(state.entries, commitTs);
          // Optional explicit commit form for callers that prefer returning
          // changes rather than mutating the supplied Map.
          if (isMutationCommit(result)) {
            for (const change of result.writes) {
              const changedKey = validateKey(change.key);
              const changedValue = validateValue(change.value);
              const changedTags = normalizeTags(change.tags);
              const changedAuthor = normalizeAuthor(change.author);
              state.entries.set(changedKey, {
                key: changedKey,
                value: changedValue,
                author: changedAuthor,
                ts: commitTs,
                tags: changedTags,
              });
            }
            result = (result as unknown as BoardMutationCommit<T>).result;
          }
        } else {
          const current = key === undefined ? undefined : state.entries.get(key);
          const returned = await (mutator as (entry: BoardEntry | undefined, ts: string) => unknown)(
            current === undefined ? undefined : cloneEntry(current),
            commitTs,
          );
          if (returned === undefined) {
            result = returned as T;
          } else if (returned === null) {
            if (key !== undefined) state.entries.delete(key);
            result = returned as T;
          } else {
            const candidate = (typeof returned === 'string'
              ? { ...(current ?? { key: key as string, author: 'anonymous', tags: [] }), value: returned }
              : typeof returned === 'object' && returned !== null && 'value' in returned
                ? { ...(current ?? { key: key as string, author: 'anonymous', tags: [] }), ...(returned as Record<string, unknown>) }
                : current) as Record<string, unknown> | undefined;
            if (candidate === undefined || key === undefined) throw new Error('key mutator must return a value or BoardEntry');
            const candidateKey = validateKey(candidate.key);
            if (candidateKey !== key) throw new Error(`mutate key mismatch: expected ${key}, got ${candidateKey}`);
            state.entries.set(key, {
              key,
              value: validateValue(candidate.value),
              author: normalizeAuthor(candidate.author),
              ts: commitTs,
              tags: normalizeTags(candidate.tags),
            });
            result = returned as T;
          }
        }
        const records = this.recordsForDiff(scope, state, before, commitTs);
        for (const record of records) {
          await this.persist(state, record);
          this.applyRecord(state, record);
          const entry = state.entries.get(record.key);
          if (record.op === 'write' && entry !== undefined && entry.ts === record.ts) this.wakeWaiters(state, entry);
          this.emit(scope, {
            type: 'board_updated',
            op: record.op,
            scope: scope.label,
            key: record.key,
            author: record.author,
            ts: record.ts,
          });
        }
        return result;
      } catch (err) {
        state.entries.clear();
        for (const [entryKey, entry] of before) state.entries.set(entryKey, entry);
        state.versions.clear();
        for (const [versionKey, version] of beforeVersions) state.versions.set(versionKey, version);
        throw err;
      }
    });
  }

  /** Tombstone delete: the key vanishes from read/list; the JSONL keeps the record. */
  async delete(key: unknown, author: unknown, scopeInput: unknown, workspace?: unknown): Promise<{ ok: true; ts: string }> {
    this.assertOpen();
    const k = validateKey(key);
    const normalizedAuthor = normalizeAuthor(author);
    await this.refreshRegistryForScope();
    const scope = this.parseScope(scopeInput, workspace);
    const state = this.scopeState(scope);
    return this.enqueue(scope.key, async () => {
      await this.fold(state);
      const ts = this.nextTs();
      const record: BoardRecord = { op: 'delete', scope: scope.key, key: k, author: normalizedAuthor, ts };
      this.applyRecord(state, record);
      await this.persist(state, record);
      this.emit(scope, { type: 'board_updated', op: 'delete', scope: scope.label, key: k, author: normalizedAuthor, ts });
      return { ok: true as const, ts };
    });
  }

  // ---- workspace registry ----

  /** Register an absolute project path and return stable sidecar metadata. */
  async registerWorkspace(workspace?: unknown): Promise<WorkspaceInfo> {
    this.assertOpen();
    const cwd = workspace === undefined || workspace === null ? this.workspaceCwd : normalizeWorkspacePath(workspace as string);
    const id = workspaceIdForPath(cwd);
    const file = join(this.boardsDir(), `ws-${id}.meta.json`);
    const existing = await this.readWorkspaceInfo(file, id, cwd);
    if (existing !== undefined) return existing;
    const info: WorkspaceInfo = { id, cwd, createdAt: new Date().toISOString() };
    await this.writeWorkspaceSidecar(info);
    return this.withWorkspaceUpdatedAt(info);
  }

  /** Scan valid workspace sidecars; malformed or hash/cwd-mismatched files are ignored. */
  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    this.assertOpen();
    let names: string[];
    try {
      names = await readdir(this.boardsDir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const workspaces: WorkspaceInfo[] = [];
    for (const name of names) {
      if (!/^ws-[0-9a-f]{16}\.meta\.json$/.test(name)) continue;
      const id = name.slice('ws-'.length, -'.meta.json'.length);
      const info = await this.readWorkspaceInfo(join(this.boardsDir(), name), id);
      if (info !== undefined) workspaces.push(info);
    }
    workspaces.sort((a, b) => a.id.localeCompare(b.id));
    return workspaces;
  }

  /** Alias that makes the scan operation explicit to callers. */
  async scanWorkspaces(): Promise<WorkspaceInfo[]> {
    return this.listWorkspaces();
  }

  /** Resolve a sidecar id to its normalized project path, or undefined when absent. */
  async resolveWorkspace(id: unknown): Promise<string | undefined> {
    this.assertOpen();
    const normalizedId = normalizeWorkspaceId(id);
    if (normalizedId === undefined) return undefined;
    const match = (await this.listWorkspaces()).find((workspace) => workspace.id === normalizedId);
    return match?.cwd;
  }

  /** Explicit alias for callers that distinguish id resolution from path registration. */
  async resolveWorkspaceId(id: unknown): Promise<string | undefined> {
    return this.resolveWorkspace(id);
  }

  /**
   * Rename a registered workspace (mailbox task 5a): read-modify-write the
   * `ws-<id>.meta.json` sidecar under its append lock, preserving `cwd` and
   * `created_at`. An empty or whitespace-only `name` clears the custom name.
   * Rejects for malformed ids and for sidecars that are missing or corrupt.
   */
  async renameWorkspace(id: unknown, name: unknown): Promise<WorkspaceInfo> {
    this.assertOpen();
    const normalizedId = normalizeWorkspaceId(id);
    if (normalizedId === undefined) throw new Error('workspace must be a 16-character workspace sidecar id');
    if (typeof name !== 'string') throw new Error('name must be a string');
    const trimmedName = name.trim();
    if (trimmedName.length > WORKSPACE_NAME_MAX_CHARS) {
      throw new Error(`name exceeds ${WORKSPACE_NAME_MAX_CHARS} characters`);
    }
    const file = join(this.boardsDir(), `ws-${normalizedId}.meta.json`);
    // The lock file is created beside the sidecar, so the boards dir must
    // exist before acquisition (mirrors ensureProjectSidecar).
    await mkdir(this.boardsDir(), { recursive: true });
    return withAppendLock(file, async () => {
      let doc: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
        if (typeof parsed === 'object' && parsed !== null) doc = parsed as Record<string, unknown>;
      } catch {
        doc = undefined; // missing/corrupt sidecar: treated as unknown below
      }
      let valid = false;
      try {
        valid =
          doc !== undefined &&
          doc.id === normalizedId &&
          typeof doc.cwd === 'string' &&
          typeof doc.created_at === 'string' &&
          workspaceIdForPath(parseWorkspaceCwd(doc.cwd)) === normalizedId;
      } catch {
        valid = false; // malformed cwd: treat the sidecar as unknown
      }
      if (!valid || doc === undefined || typeof doc.cwd !== 'string' || typeof doc.created_at !== 'string') {
        throw new Error(`workspace not found: ${normalizedId}`);
      }
      const next: Record<string, unknown> = { id: normalizedId, cwd: doc.cwd, created_at: doc.created_at };
      if (trimmedName.length > 0) next.name = trimmedName;
      await writeFile(file, JSON.stringify(next, null, 2));
      const info = await this.readWorkspaceInfo(file, normalizedId);
      if (info === undefined) throw new Error(`workspace not found: ${normalizedId}`);
      return info;
    });
  }

  /**
   * Release a workspace (mailbox task 5c): archive, never delete. Drops the
   * path's project alias when present (the directory's next write falls back
   * to a fresh `ws-<hash>.jsonl`), then renames `ws-<hash>.jsonl` and the
   * sidecar to `*.released-<epoch-ms>` so `listWorkspaces` no longer lists
   * the workspace while every record stays recoverable. The renames run under
   * the board file's append lock so a concurrent appender can never write
   * into a file mid-rename. Returns whether an alias was released.
   */
  async releaseWorkspace(id: unknown): Promise<{ ok: true; releasedAlias: boolean }> {
    this.assertOpen();
    const normalizedId = normalizeWorkspaceId(id);
    if (normalizedId === undefined) throw new Error('workspace must be a 16-character workspace sidecar id');
    const file = join(this.boardsDir(), `ws-${normalizedId}.jsonl`);
    const metaFile = join(this.boardsDir(), `ws-${normalizedId}.meta.json`);

    // 1. Release the path alias first so any write racing the release already
    //    resolves back to the plain workspace scope.
    let releasedAlias = false;
    await this.registry.refreshIfStale().catch(() => {});
    if (this.registry.resolveCached(normalizedId) !== undefined) {
      await this.registry.removeAlias(normalizedId);
      releasedAlias = true;
    }

    // 2+3. Archive the board and sidecar (absent files are skipped).
    const stamp = Date.now();
    await mkdir(this.boardsDir(), { recursive: true });
    await withAppendLock(file, async () => {
      await archiveFileRename(file, `${file}.released-${stamp}`);
    });
    await withAppendLock(metaFile, async () => {
      await archiveFileRename(metaFile, `${metaFile}.released-${stamp}`);
    });

    // A live scope may still believe its sidecar/board exist: drop the flags
    // so the next operation folds an empty board and re-registers a fresh
    // sidecar (the directory "starts from an empty board" in-process too).
    const state = this.scopes.get(`workspace:${normalizedId}`);
    if (state !== undefined) {
      state.metaWritten = false;
      state.loaded = false;
    }
    return { ok: true, releasedAlias };
  }

  /**
   * Self-heal a project's meta sidecar (`project-<id>.meta.json`) for projects
   * created before task 5 — their migration archived the workspace sidecars but
   * never wrote the meta, so `project:<id>` browsing 404s. Rebuilds `cwds[]`
   * from the aliased workspace sidecars: each alias's live
   * `ws-<hash>.meta.json` first, then its archived `ws-<hash>.meta.json.migrated-*`
   * copies; a sidecar's `cwd` is kept only when it is an absolute path string,
   * and duplicates are dropped while preserving first-appearance order.
   *
   * With at least one recovered cwd the meta is written under the append lock
   * (same `{projectId, cwds[], created_at}` shape as `ensureProjectSidecar`;
   * `created_at` is the registry create record's timestamp, else now) and the
   * recovered cwds are returned. With none, returns `[]` and writes nothing.
   */
  async repairProjectMeta(projectId: string): Promise<string[]> {
    this.assertOpen();
    const project = (await this.registry.listProjects()).find((candidate) => candidate.projectId === projectId);
    if (project === undefined) return [];
    const boardsDir = this.boardsDir();
    let names: string[];
    try {
      names = await readdir(boardsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const cwds: string[] = [];
    const seen = new Set<string>();
    for (const hash of project.aliases) {
      const liveName = `ws-${hash}.meta.json`;
      const migratedPrefix = `ws-${hash}.meta.json.migrated-`;
      const candidates = names.includes(liveName) ? [liveName] : [];
      candidates.push(...names.filter((name) => name.startsWith(migratedPrefix)).sort());
      for (const name of candidates) {
        const cwd = await workspaceSidecarCwd(join(boardsDir, name));
        if (cwd !== undefined && !seen.has(cwd)) {
          seen.add(cwd);
          cwds.push(cwd);
        }
      }
    }
    if (cwds.length === 0) return [];
    const metaFile = join(boardsDir, `project-${projectId}.meta.json`);
    // The lock file is created beside the meta, so the boards dir must exist
    // before acquisition (mirrors ensureProjectSidecar).
    await mkdir(boardsDir, { recursive: true });
    await withAppendLock(metaFile, async () => {
      let doc: { projectId: string; cwds: string[]; created_at: string } | undefined;
      try {
        const parsed = JSON.parse(await readFile(metaFile, 'utf8')) as Record<string, unknown>;
        if (
          parsed.projectId === projectId &&
          Array.isArray(parsed.cwds) &&
          parsed.cwds.every((entry) => typeof entry === 'string') &&
          typeof parsed.created_at === 'string'
        ) {
          doc = parsed as unknown as { projectId: string; cwds: string[]; created_at: string };
        }
      } catch {
        // Missing or corrupt sidecar: rewrite it (mirrors ensureProjectSidecar).
      }
      // A peer may have repaired the meta between our read failure and the lock;
      // never clobber a valid sidecar — only fill the gap.
      if (doc !== undefined) return;
      const next = { projectId, cwds, created_at: project.createdAt ?? new Date().toISOString() };
      await writeFile(metaFile, JSON.stringify(next, null, 2));
    });
    return cwds;
  }

  // ---- project management (mailbox task 6) ----

  /**
   * Remove a cwd from a project's `cwds[]` sidecar (mailbox task 6b). The
   * read-modify-write runs under the meta file's append lock (mirrors
   * `ensureProjectSidecar`); a missing/invalid sidecar or an absent cwd is a
   * no-op. Alias detach uses it so the detached directory stops being reported
   * as one of the project's paths.
   */
  async removeProjectCwd(projectId: unknown, cwd: unknown): Promise<void> {
    this.assertOpen();
    if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error(`invalid projectId: ${String(projectId)} (expected p_<12 hex chars>)`);
    }
    if (typeof cwd !== 'string') throw new Error('cwd must be a string');
    const normalizedCwd = normalizeWorkspacePath(cwd);
    const metaFile = join(this.boardsDir(), `project-${projectId}.meta.json`);
    // The lock file is created beside the meta, so the boards dir must exist
    // before acquisition (mirrors ensureProjectSidecar).
    await mkdir(this.boardsDir(), { recursive: true });
    await withAppendLock(metaFile, async () => {
      let doc: { projectId: string; cwds: string[]; created_at: string } | undefined;
      try {
        const parsed = JSON.parse(await readFile(metaFile, 'utf8')) as Record<string, unknown>;
        if (
          parsed.projectId === projectId &&
          Array.isArray(parsed.cwds) &&
          parsed.cwds.every((entry) => typeof entry === 'string') &&
          typeof parsed.created_at === 'string'
        ) {
          doc = parsed as unknown as { projectId: string; cwds: string[]; created_at: string };
        }
      } catch {
        doc = undefined; // missing/corrupt sidecar: nothing to remove
      }
      if (doc === undefined || !doc.cwds.includes(normalizedCwd)) return;
      doc.cwds = doc.cwds.filter((entry) => entry !== normalizedCwd);
      await writeFile(metaFile, JSON.stringify(doc, null, 2));
    });
  }

  /**
   * Restore a detached workspace's sidecar (mailbox task 6b): rename the newest
   * `ws-<hash>.meta.json.migrated-*` archive back to the live
   * `ws-<hash>.meta.json` so the directory reappears in the workspace list.
   * No archive (or a live sidecar already present) leaves the state untouched
   * and returns false. The board file is restored separately by
   * `restoreWorkspaceBoard` — alias detach rolls the directory back to its
   * pre-migration snapshot while the project keeps its records too.
   */
  async restoreWorkspaceSidecar(pathHash: unknown): Promise<boolean> {
    this.assertOpen();
    if (typeof pathHash !== 'string' || !/^[0-9a-f]{16}$/.test(pathHash)) {
      throw new Error('pathHash must be a 16-hex workspace id');
    }
    const dir = this.boardsDir();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    const liveName = `ws-${pathHash}.meta.json`;
    if (names.includes(liveName)) return false; // already a live workspace
    const prefix = `${liveName}.migrated-`;
    const archives = names
      .filter((name) => name.startsWith(prefix))
      .sort((a, b) => archiveStamp(a, prefix) - archiveStamp(b, prefix));
    if (archives.length === 0) return false; // no archive: next write rebuilds
    const newest = archives[archives.length - 1];
    await rename(join(dir, newest), join(dir, liveName));
    return true;
  }

  /**
   * Restore a detached workspace's board file (un-merge, mailbox task 6b): the
   * symmetric half of `restoreWorkspaceSidecar`. Renames the newest
   * `ws-<hash>.jsonl.migrated-*` archive back to the live `ws-<hash>.jsonl` so
   * the directory's pre-migration records (board writes and tips alike) are
   * recovered — detach = rollback to the pre-merge snapshot. No archive (or a
   * live board already present) leaves the state untouched and returns false;
   * the directory's next write then starts a fresh board (legacy behavior).
   * The rename runs under the board file's append lock so a concurrent
   * appender can never write into a file mid-rename.
   */
  async restoreWorkspaceBoard(pathHash: unknown): Promise<boolean> {
    this.assertOpen();
    if (typeof pathHash !== 'string' || !/^[0-9a-f]{16}$/.test(pathHash)) {
      throw new Error('pathHash must be a 16-hex workspace id');
    }
    const dir = this.boardsDir();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    const liveName = `ws-${pathHash}.jsonl`;
    if (names.includes(liveName)) return false; // already a live board
    const prefix = `${liveName}.migrated-`;
    const archives = names
      .filter((name) => name.startsWith(prefix))
      .sort((a, b) => archiveStamp(a, prefix) - archiveStamp(b, prefix));
    if (archives.length === 0) return false; // no archive: next write starts fresh
    const newest = archives[archives.length - 1];
    // The lock file is created beside the board, so the boards dir must exist
    // before acquisition (readdir above guarantees it; mirrors releaseWorkspace).
    await withAppendLock(join(dir, liveName), async () => {
      await rename(join(dir, newest), join(dir, liveName));
    });
    return true;
  }

  /**
   * Alias detach file work (un-merge, mailbox task 6b): the symmetric half of a
   * merge. Removes the detached directory's cwd from the project's `cwds[]`
   * sidecar and restores its archived workspace sidecar + board file, so it
   * reappears as an independent workspace with its pre-migration records back
   * (rollback to the pre-merge snapshot). The caller has already dropped the
   * registry alias (`registry.removeAlias`); the project's records stay in the
   * project board — nothing is deleted, the merge records never flow back.
   */
  async detachProjectAlias(
    projectId: unknown,
    pathHash: unknown,
  ): Promise<{ removedCwd?: string; restoredSidecar: boolean; restoredBoard: boolean }> {
    this.assertOpen();
    if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error(`invalid projectId: ${String(projectId)} (expected p_<12 hex chars>)`);
    }
    if (typeof pathHash !== 'string' || !/^[0-9a-f]{16}$/.test(pathHash)) {
      throw new Error('pathHash must be a 16-hex workspace id');
    }
    // Resolve the cwd this alias stands for from the project meta.
    const metaFile = join(this.boardsDir(), `project-${projectId}.meta.json`);
    let removedCwd: string | undefined;
    try {
      const parsed = JSON.parse(await readFile(metaFile, 'utf8')) as Record<string, unknown>;
      const cwds = Array.isArray(parsed.cwds) ? parsed.cwds : [];
      removedCwd = cwds.find((entry) => {
        if (typeof entry !== 'string') return false;
        try {
          return workspaceIdForPath(entry) === pathHash;
        } catch {
          return false; // non-absolute/corrupt cwd never matches
        }
      });
    } catch {
      removedCwd = undefined; // missing/corrupt meta: nothing to remove
    }
    if (removedCwd !== undefined) await this.removeProjectCwd(projectId, removedCwd);
    const restoredSidecar = await this.restoreWorkspaceSidecar(pathHash);
    const restoredBoard = await this.restoreWorkspaceBoard(pathHash);
    // A live scope may still believe the legacy files are gone: drop the flags
    // so the next operation folds the restored board/sidecar instead of an
    // empty view (mirrors releaseWorkspace).
    const wsState = this.scopes.get(`workspace:${pathHash}`);
    if (wsState !== undefined) {
      wsState.metaWritten = false;
      wsState.loaded = false;
    }
    return { ...(removedCwd !== undefined ? { removedCwd } : {}), restoredSidecar, restoredBoard };
  }

  /**
   * Archive a project (mailbox task 6c, soft delete): write the registry
   * `archive` tombstone, drop every alias (the directories fall back to plain
   * workspaces, but their migrated sidecars are NOT restored — archive ≠ detach),
   * and archive (never delete) `project-<id>.jsonl` + `project-<id>.meta.json`
   * under their locks. Rejects for unknown / already-archived projects.
   */
  async archiveProject(projectId: unknown): Promise<{ ok: true; projectId: string }> {
    this.assertOpen();
    if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error(`invalid projectId: ${String(projectId)} (expected p_<12 hex chars>)`);
    }
    const registry = this.registry;
    await registry.refreshIfStale();
    // Capture the live project (listProjects already excludes archived) so its
    // aliases can be dropped after the archive record lands.
    const project = (await registry.listProjects()).find((candidate) => candidate.projectId === projectId);
    if (project === undefined) throw new Error(`unknown projectId: ${projectId}`);
    // 1. Registry tombstone first: from here resolveCached refuses the project,
    //    so any racing write already falls back to the plain workspace scope.
    await registry.archiveProject(projectId);
    // 2. Release every alias (directories resolve to plain workspaces again).
    for (const alias of project.aliases) {
      await registry.removeAlias(alias);
    }
    // 3. Archive the board + meta files (absent files are skipped).
    const stamp = Date.now();
    const file = join(this.boardsDir(), `project-${projectId}.jsonl`);
    const metaFile = join(this.boardsDir(), `project-${projectId}.meta.json`);
    await mkdir(this.boardsDir(), { recursive: true });
    await withAppendLock(file, async () => {
      await archiveFileRename(file, `${file}.archived-${stamp}`);
    });
    await withAppendLock(metaFile, async () => {
      await archiveFileRename(metaFile, `${metaFile}.archived-${stamp}`);
    });
    // A live scope may still believe its files exist: drop the flags so a later
    // direct project-scope write folds an empty board instead of a stale view.
    const state = this.scopes.get(`project:${projectId}`);
    if (state !== undefined) {
      state.metaWritten = false;
      state.loaded = false;
    }
    return { ok: true, projectId };
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

  private parseScope(input: unknown, workspaceInput?: unknown): BoardScope {
    if (input === undefined || input === null) input = 'workspace';
    if (typeof input !== 'string') throw new Error('scope must be a string');
    const raw = input.trim();
    if (raw === 'workspace') {
      const cwd = workspaceInput === undefined || workspaceInput === null
        ? this.workspaceCwd
        : normalizeWorkspacePath(workspaceInput as string);
      const id = workspaceIdForPath(cwd);
      // Alias resolution: a workspace hash registered to a project in the
      // registry resolves to that project's shared board. Synchronous on
      // purpose — the projection is refreshed on the fold path, so a stale
      // cache merely behaves like the unaliased legacy scope for one op.
      const projectId = this.registry.resolveCached(id);
      if (projectId !== undefined) {
        // label stays 'workspace': aliasing is invisible to callers/events.
        return { kind: 'project', key: `project:${projectId}`, label: 'workspace', id: projectId, cwd };
      }
      return { kind: 'workspace', key: `workspace:${id}`, label: 'workspace', id, cwd };
    }
    if (raw === 'global') return { kind: 'global', key: 'global', label: 'global' };
    if (raw.startsWith('project:')) {
      // Direct project scope (mailbox task 3): lets a sender address a
      // project board by id without an aliased workspace path — HandoffStore
      // writes into the target project's board this way. The label keeps the
      // raw scope string so events stay distinguishable from the aliased
      // workspace case (which stays invisible as 'workspace').
      const projectId = raw.slice('project:'.length);
      if (!PROJECT_ID_PATTERN.test(projectId)) {
        throw new Error('invalid scope: project:<projectId> requires a p_<12 hex chars> projectId');
      }
      return { kind: 'project', key: raw, label: raw, id: projectId };
    }
    if (raw.startsWith('task:')) {
      const taskId = raw.slice('task:'.length);
      if (taskId.length === 0) throw new Error('invalid scope: task:<task_id> requires a non-empty task_id');
      return { kind: 'task', key: raw, label: raw, taskId };
    }
    throw new Error(`invalid scope: ${input} (expected "workspace", "global", "project:<projectId>", or "task:<task_id>")`);
  }

  /** `<home>/boards` (public so typed views like HandoffStore can enumerate scope files). */
  boardsDir(): string {
    return join(this.homeDir ?? moamcpHome(), 'boards');
  }

  private scopeState(scope: BoardScope): ScopeState {
    let state = this.scopes.get(scope.key);
    if (state !== undefined) {
      // A project board is shared by every aliased cwd, but the scope state
      // (keyed by `project:<id>`) captures just the first one; re-arm the
      // sidecar check whenever a different cwd arrives so each lands in `cwds`.
      if (scope.kind === 'project' && scope.cwd !== undefined && scope.cwd !== state.metaCwd) {
        state.metaCwd = scope.cwd;
        state.metaWritten = false;
      }
      return state;
    }
    state = { entries: new Map(), versions: new Map(), loaded: false, waiters: new Set() };
    if (scope.kind === 'task') {
      state.history = [];
    } else if (scope.kind === 'global') {
      state.file = join(this.boardsDir(), 'global.jsonl');
    } else if (scope.kind === 'project') {
      state.file = join(this.boardsDir(), `project-${scope.id}.jsonl`);
      state.metaFile = join(this.boardsDir(), `project-${scope.id}.meta.json`);
      // A directly addressed project scope (no aliased workspace path) must
      // not record the process default cwd in the project's cwds sidecar.
      state.metaCwd = scope.cwd;
      state.projectScope = true;
    } else {
      const id = scope.id ?? scope.key.slice('workspace:'.length);
      state.file = join(this.boardsDir(), `ws-${id}.jsonl`);
      state.metaFile = join(this.boardsDir(), `ws-${id}.meta.json`);
      state.metaCwd = scope.cwd ?? this.workspaceCwd;
    }
    this.scopes.set(scope.key, state);
    return state;
  }

  /**
   * Fold a task log once; for persistent logs, check the real file size on
   * every operation and rebuild whenever it changes, is created, or shrinks.
   */
  /**
   * Best-effort registry projection refresh *before* scope resolution. Every
   * public entry point calls this ahead of parseScope: without it, a fresh
   * process (or a stale projection) resolves an aliased workspace to its
   * legacy `ws-<hash>` scope for the first operation — the write lands in
   * `ws-<hash>.jsonl` while later reads (post-fold refresh) resolve to
   * `project-<id>.jsonl`, a write/read inconsistency (tip_21f72697).
   *
   * The fast path must stay *synchronous*: entry points enqueue by scope key,
   * so an awaited refresh before the enqueue would desynchronize submission
   * order and break the "queue order follows call order" LWW guarantee for
   * write bursts (regression caught by board.test.ts concurrent-writes).
   * statSync on the registry file is a few µs — cheap enough per op; the
   * async reload only happens when the file actually changed size.
   */
  private lastRegistrySize = -1;
  private async refreshRegistryForScope(): Promise<void> {
    try {
      const size = statSync(this.registry.registryFile()).size;
      if (size === this.lastRegistrySize) return;
      this.lastRegistrySize = size;
      await this.registry.refreshIfStale().catch(() => {});
    } catch {
      // No registry file yet (or unreadable): nothing to refresh, stay sync.
    }
  }

  private async fold(state: ScopeState): Promise<void> {
    // Piggyback the registry projection refresh on every persistent-operation
    // fold (size check only — unchanged files are neither opened nor read), so
    // the synchronous parseScope lookup sees peer-created projects/aliases.
    // A refresh failure degrades to legacy workspace resolution, never fails ops.
    await this.registry.refreshIfStale().catch(() => {});
    if (state.file === undefined) {
      state.loaded = true;
      return;
    }
    if (state.metaFile !== undefined) {
      if (state.projectScope === true) await this.ensureProjectSidecar(state);
      else await this.ensureWorkspaceSidecar(state);
    }
    const snapshot = await this.readPersistentSnapshot(state);
    if (!snapshot.changed) return;
    const previous = state.loaded ? cloneEntries(state.entries) : undefined;
    state.entries.clear();
    state.versions.clear();
    state.loaded = true;
    state.fileExists = snapshot.exists;
    // This is the byte count actually returned by readFile, not the size seen
    // before the read. If an append races the read, the next operation/poll
    // observes the larger size and folds again.
    state.fileBytes = snapshot.bytes;
    for (const line of snapshot.raw.split(/\r?\n/)) {
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
      this.applyRecord(state, record);
    }
    if (previous !== undefined) this.wakeRefreshedWaiters(state, previous);
  }

  /** Read a stable-enough snapshot while never claiming unread bytes were read. */
  private async readPersistentSnapshot(state: ScopeState): Promise<{ changed: boolean; exists: boolean; bytes: number; raw: string }> {
    const file = state.file as string;
    let currentSize: number | undefined;
    try {
      currentSize = (await stat(file)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const exists = currentSize !== undefined;
    if (state.loaded && state.fileExists === exists && (!exists || state.fileBytes === currentSize)) {
      return { changed: false, exists, bytes: state.fileBytes ?? 0, raw: '' };
    }
    if (!exists) return { changed: true, exists: false, bytes: 0, raw: '' };

    let lastRaw = '';
    let lastBytes = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        lastRaw = await readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { changed: true, exists: false, bytes: 0, raw: '' };
        }
        throw err;
      }
      lastBytes = Buffer.byteLength(lastRaw, 'utf8');
      let afterSize: number | undefined;
      try {
        afterSize = (await stat(file)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (afterSize === lastBytes) return { changed: true, exists: true, bytes: lastBytes, raw: lastRaw };
      // A concurrent append/truncate changed the file while it was read. Try
      // again; if it never settles, return the bytes genuinely observed below.
    }
    return { changed: true, exists: true, bytes: lastBytes, raw: lastRaw };
  }

  private async readWorkspaceInfo(file: string, id: string, expectedCwd?: string): Promise<WorkspaceInfo | undefined> {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      if (parsed.id !== id) return undefined;
      const cwd = parseWorkspaceCwd(parsed.cwd);
      if (workspaceIdForPath(cwd) !== id || (expectedCwd !== undefined && cwd !== expectedCwd)) return undefined;
      if (typeof parsed.created_at !== 'string' || Number.isNaN(Date.parse(parsed.created_at))) return undefined;
      const name = parseWorkspaceName(parsed.name);
      return this.withWorkspaceUpdatedAt({ id, cwd, createdAt: parsed.created_at, ...(name === undefined ? {} : { name }) });
    } catch {
      // A sidecar can be observed while another process is replacing it;
      // invalid entries are deliberately ignored by scans and repaired on explicit use.
      return undefined;
    }
  }

  private async withWorkspaceUpdatedAt(info: WorkspaceInfo): Promise<WorkspaceInfo> {
    const updatedAt = await this.workspaceUpdatedAt(info.id);
    return updatedAt === undefined ? info : { ...info, updatedAt };
  }

  private async workspaceUpdatedAt(id: string): Promise<string | undefined> {
    try {
      return (await stat(join(this.boardsDir(), `ws-${id}.jsonl`))).mtime.toISOString();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  private async writeWorkspaceSidecar(info: WorkspaceInfo): Promise<void> {
    await mkdir(this.boardsDir(), { recursive: true });
    const file = join(this.boardsDir(), `ws-${info.id}.meta.json`);
    await writeFile(
      file,
      JSON.stringify(
        { id: info.id, cwd: info.cwd, created_at: info.createdAt, ...(info.name === undefined ? {} : { name: info.name }) },
        null,
        2,
      ),
    );
  }

  /** Ensure an explicitly used workspace is registered, including an empty board. */
  private async ensureWorkspaceSidecar(state: ScopeState): Promise<void> {
    if (state.metaFile === undefined || state.metaCwd === undefined || state.metaWritten) return;
    const id = state.metaFile.match(/ws-([0-9a-f]{16})\.meta\.json$/)?.[1];
    if (id === undefined) return;
    const existing = await this.readWorkspaceInfo(state.metaFile, id, state.metaCwd);
    if (existing !== undefined) {
      state.metaWritten = true;
      return;
    }
    await this.writeWorkspaceSidecar({ id, cwd: state.metaCwd, createdAt: new Date().toISOString() });
    state.metaWritten = true;
  }

  /**
   * Project sidecar (`project-<id>.meta.json`): `{projectId, cwds[], created_at}`.
   * Every aliased cwd that touches the board is appended once (deduped). The
   * read-modify-write runs under the append lock so concurrent sessions cannot
   * lose each other's cwds; a missing/corrupt sidecar is rewritten from scratch.
   */
  private async ensureProjectSidecar(state: ScopeState): Promise<void> {
    if (state.metaFile === undefined || state.metaCwd === undefined || state.metaWritten) return;
    const metaFile = state.metaFile;
    const cwd = state.metaCwd;
    const projectId = metaFile.match(/project-(p_[0-9a-f]{12})\.meta\.json$/)?.[1];
    if (projectId === undefined) return;
    // The lock file is created beside the sidecar, so the boards dir must
    // exist before acquisition (fold can reach this before persist's mkdir).
    await mkdir(this.boardsDir(), { recursive: true });
    await withAppendLock(metaFile, async () => {
      let doc: { projectId: string; cwds: string[]; created_at: string } | undefined;
      try {
        const parsed = JSON.parse(await readFile(metaFile, 'utf8')) as Record<string, unknown>;
        if (
          parsed.projectId === projectId &&
          Array.isArray(parsed.cwds) &&
          parsed.cwds.every((entry) => typeof entry === 'string') &&
          typeof parsed.created_at === 'string'
        ) {
          doc = parsed as unknown as { projectId: string; cwds: string[]; created_at: string };
        }
      } catch {
        // Missing or corrupt sidecar: rewrite it (mirrors ws-sidecar repair).
      }
      if (doc !== undefined && doc.cwds.includes(cwd)) {
        state.metaWritten = true;
        return; // already recorded: no rewrite needed
      }
      const next = doc ?? { projectId, cwds: [] as string[], created_at: new Date().toISOString() };
      if (!next.cwds.includes(cwd)) next.cwds = [...next.cwds, cwd];
      await writeFile(metaFile, JSON.stringify(next, null, 2));
      state.metaWritten = true;
    });
  }

  /** Apply a record only when its timestamp wins the folded LWW view. */
  private applyRecord(state: ScopeState, record: BoardRecord): boolean {
    const recordEpoch = Date.parse(record.ts);
    if (Number.isFinite(recordEpoch) && recordEpoch > this.lastEpoch) this.lastEpoch = recordEpoch;
    const previous = state.versions.get(record.key);
    if (previous !== undefined && compareTimestamps(record.ts, previous) < 0) return false;
    state.versions.set(record.key, record.ts);
    if (record.op === 'write') {
      state.entries.set(record.key, {
        key: record.key,
        value: record.value as string,
        author: record.author,
        ts: record.ts,
        tags: [...(record.tags ?? [])],
      });
    } else {
      state.entries.delete(record.key);
    }
    return true;
  }

  /** Turn a callback's Map changes into append-only records at one commit ts. */
  private recordsForDiff(
    scope: BoardScope,
    state: ScopeState,
    before: Map<string, BoardEntry>,
    commitTs: string,
  ): BoardRecord[] {
    const keys = new Set([...before.keys(), ...state.entries.keys()]);
    const records: BoardRecord[] = [];
    for (const key of keys) {
      const previous = before.get(key);
      const current = state.entries.get(key);
      if (sameEntry(previous, current)) continue;
      if (current === undefined) {
        records.push({
          op: 'delete',
          scope: scope.key,
          key,
          author: previous?.author ?? 'anonymous',
          ts: commitTs,
        });
        continue;
      }
      const entryKey = validateKey(current.key);
      if (entryKey !== key) throw new Error(`mutate map key mismatch: expected ${key}, got ${entryKey}`);
      const value = validateValue(current.value);
      const author = normalizeAuthor(current.author);
      const tags = normalizeTags(current.tags);
      state.entries.set(key, { key, value, author, ts: commitTs, tags });
      records.push({
        op: 'write',
        scope: scope.key,
        key,
        value,
        author,
        ts: commitTs,
        ...(tags.length > 0 ? { tags } : {}),
      });
    }
    return records;
  }

  /** Append a record to the scope's JSONL (persistent scopes only) + task history. */
  private async persist(state: ScopeState, record: BoardRecord): Promise<void> {
    if (state.history !== undefined) state.history.push(record);
    if (state.file === undefined) return;
    const file = state.file;
    await mkdir(this.boardsDir(), { recursive: true });
    if (state.metaFile !== undefined && !state.metaWritten) {
      // A sidecar failure must not make a board write fail; the next operation
      // will retry registration. Explicit registerWorkspace remains strict.
      const sidecar = state.projectScope === true ? this.ensureProjectSidecar(state) : this.ensureWorkspaceSidecar(state);
      await sidecar.catch(() => {});
    }
    // Cross-process serialization: alias-shared project boards (and every
    // other persistent scope) append under `<file>.lock`, so two sessions in
    // the same home can never tear a JSONL line.
    await withAppendLock(file, () => appendFile(file, JSON.stringify(record) + '\n'));
  }

  private wakeWaiters(state: ScopeState, entry: BoardEntry): void {
    const epoch = Date.parse(entry.ts);
    for (const waiter of [...state.waiters]) {
      if (waiter.key !== entry.key) continue;
      if (waiter.sinceEpoch !== undefined && epoch <= waiter.sinceEpoch) continue;
      state.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve({ status: 'ready', entry: cloneEntry(entry) });
    }
    this.stopPollIfIdle(state);
  }

  /** Refresh wake-up path: external writes wake waiters but never emit events. */
  private wakeRefreshedWaiters(state: ScopeState, previous: Map<string, BoardEntry>): void {
    for (const [key, entry] of state.entries) {
      const old = previous.get(key);
      if (old === undefined || old.ts !== entry.ts) this.wakeWaiters(state, entry);
    }
  }

  /** Exactly one unref'd poll timer per persistent scope while it has waiters. */
  private ensurePollTimer(scope: BoardScope, state: ScopeState): void {
    if (state.file === undefined || state.pollTimer !== undefined || state.waiters.size === 0) return;
    const timer = setInterval(() => void this.pollPersistent(scope, state), this.pollIntervalMs);
    timer.unref();
    state.pollTimer = timer;
  }

  private stopPollIfIdle(state: ScopeState): void {
    if (state.waiters.size > 0 || state.pollTimer === undefined) return;
    clearInterval(state.pollTimer);
    state.pollTimer = undefined;
  }

  private async pollPersistent(scope: BoardScope, state: ScopeState): Promise<void> {
    if (state.waiters.size === 0) {
      this.stopPollIfIdle(state);
      return;
    }
    await this.enqueue(scope.key, async () => {
      if (state.waiters.size === 0) {
        this.stopPollIfIdle(state);
        return;
      }
      await this.fold(state);
      this.stopPollIfIdle(state);
    }).catch(() => {});
  }

  /** Close waiters and unref'd pollers; normal task archival remains separate. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.scopes.values()) {
      if (state.pollTimer !== undefined) {
        clearInterval(state.pollTimer);
        state.pollTimer = undefined;
      }
      for (const waiter of [...state.waiters]) {
        state.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve({ status: 'closed' });
      }
    }
  }

  async dispose(): Promise<void> {
    await this.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('BoardStore is closed');
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

function parseWorkspaceCwd(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) throw new Error('invalid workspace sidecar cwd');
  return resolve(value);
}

/** Extract an absolute `cwd` from a workspace sidecar; missing/unreadable/non-absolute entries yield undefined. */
async function workspaceSidecarCwd(file: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const cwd = parsed.cwd;
    return typeof cwd === 'string' && cwd.length > 0 && isAbsolute(cwd) ? cwd : undefined;
  } catch {
    return undefined; // corrupt or transiently-replaced sidecar: skip
  }
}

/** Sidecar `name`: a non-empty string after trimming; anything else is absent. */
function parseWorkspaceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Archive-rename a file; an absent file is simply skipped (release/migration archiving). */
async function archiveFileRename(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Numeric epoch-ms stamp encoded after an archive prefix (orders `.migrated-*` copies). */
function archiveStamp(name: string, prefix: string): number {
  const stamp = Number(name.slice(prefix.length));
  return Number.isFinite(stamp) ? stamp : 0;
}

function normalizeWorkspaceId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.startsWith('ws-') ? value.slice('ws-'.length) : value.startsWith('workspace:') ? value.slice('workspace:'.length) : value;
  return /^[0-9a-f]{16}$/.test(id) ? id : undefined;
}

function isMutationCommit<T>(value: unknown): value is BoardMutationCommit<T> {
  return typeof value === 'object' && value !== null && 'result' in value && Array.isArray((value as { writes?: unknown }).writes);
}

function normalizeLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_READ_LIMIT;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    throw new Error('limit must be a positive number');
  }
  return Math.min(Math.floor(limit), MAX_READ_LIMIT);
}
