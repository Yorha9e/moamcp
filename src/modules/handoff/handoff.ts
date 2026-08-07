/**
 * Directed handoffs (mailbox task 3) — cross-project messages delivered into
 * the TARGET project's board, following the TipStore pattern: a typed view
 * over BoardStore entries under the `handoff/` key namespace.
 *
 * Red lines (design/MAILBOX_IMPL.md §0): handoff content never participates
 * in recall/indexing, never merges projects, and never travels the Bus. The
 * only integration point is BoardStore persistence (append-only JSONL).
 *
 * Scope resolution:
 *   - `send` writes into the target project's scope: `toProject` is a
 *     projectId (`p_<12hex>`, written through the direct `project:<id>`
 *     BoardStore scope) or `user-global` (the global board's `handoff/`
 *     namespace). The sender's identity (`fromProject`) is its workspace's
 *     project alias when registered, otherwise `ws:<pathHash>`.
 *   - v2 (0.12.0) adds optional `toAgent`/`fromAgent` — opaque agent
 *     addresses `<label>:<sessionId>:<agentId>`, shape-checked only, never
 *     registry-resolved. Delivery still routes via `toProject`; the agent
 *     address is a delivery tag (`agent:<toAgent>`) plus an inbox filter.
 *   - inbox/read/consume/archive take the same target designator: an
 *     absolute workspace path (alias-aware, exactly like the workspace
 *     scope), a projectId, or `user-global`. Recipients read their own
 *     inbox through their workspace path; aliasing makes every directory
 *     of one project see the same inbox.
 *   - `outbox` scans every board scope file in `<home>/boards` (global,
 *     project-*, ws-* with a sidecar cwd) and keeps entries whose
 *     `fromProject` matches the sender identity — handoffs live in target
 *     scopes, so the sender side is a scan, not a local read.
 *
 * State machine: `pending → consumed | archived`, both terminal. Any other
 * transition throws HandoffStateError; consume additionally records
 * `consumedAt` at the commit timestamp.
 */
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import {
  HANDOFF_VALUE_MAX_BYTES,
  BoardStore,
  normalizeWorkspacePath,
  workspaceIdForPath,
  type BoardEntry,
} from '../../core/store/board.js';
import { PROJECT_ID_PATTERN } from '../../core/store/project-registry.js';

/** The global board's handoff namespace designator (the only non-project target in v1). */
export const HANDOFF_USER_GLOBAL = 'user-global';

export const HANDOFF_STATES = ['pending', 'consumed', 'archived'] as const;

export type HandoffState = (typeof HANDOFF_STATES)[number];

/**
 * One directed handoff entry as persisted (JSON) under `handoff/<id>`.
 *
 * v1 = project-level addressing only. v2 (0.12.0) adds optional agent-level
 * addressing: `toAgent`/`fromAgent` are OPAQUE address strings of the shape
 * `<label>:<sessionId>:<agentId>` — shape-checked only, never resolved
 * against a registry (the delivery target stays `toProject`). Old v1 entries
 * simply lack the two fields and decode unchanged.
 */
export interface Handoff {
  v: 1 | 2;
  id: string;
  title: string;
  summary: string;
  context?: string;
  /** Sender identity: projectId (aliased workspace) or `ws:<pathHash>`. */
  fromProject: string;
  /** Target designator: projectId or `user-global`. */
  toProject: string;
  /** v2: sender agent address `<label>:<sessionId>:<agentId>` (opaque, shape-checked only). */
  fromAgent?: string;
  /** v2: recipient agent address `<label>:<sessionId>:<agentId>` (opaque, shape-checked only). */
  toAgent?: string;
  state: HandoffState;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp of the consume transition; null until consumed. */
  consumedAt: string | null;
  author: string;
}

/** List rows omit the (potentially large) context payload; `read` returns it. */
export type HandoffSummary = Omit<Handoff, 'context'>;

export type HandoffSendInput = {
  toProject: string;
  title: string;
  summary: string;
  context?: string;
  author?: string;
  /** v2: sender agent address `<label>:<sessionId>:<agentId>` (opaque, shape-checked only). */
  fromAgent?: string;
  /** v2: recipient agent address `<label>:<sessionId>:<agentId>` (opaque, shape-checked only). */
  toAgent?: string;
};

export interface HandoffListOptions {
  /** Filter exact state(s); default hides archived (pending + consumed). */
  state?: HandoffState | HandoffState[];
  limit?: number;
  /**
   * v2: exact string filter on `toAgent`. The caller self-reports its own
   * address, so a misspelled address yields an empty inbox rather than an
   * error — the known no-registry compromise (align via fromAgent echo).
   */
  agent?: string;
}

export class HandoffValidationError extends Error {
  readonly code = 'HANDOFF_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'HandoffValidationError';
  }
}

export class HandoffNotFoundError extends Error {
  readonly code = 'HANDOFF_NOT_FOUND';

  constructor(id: string) {
    super(`handoff not found: ${id}`);
    this.name = 'HandoffNotFoundError';
  }
}

export class HandoffCorruptError extends Error {
  readonly code = 'HANDOFF_CORRUPT';

  constructor(id: string, message: string) {
    super(`corrupt handoff ${id}: ${message}`);
    this.name = 'HandoffCorruptError';
  }
}

export class HandoffStateError extends Error {
  readonly code = 'HANDOFF_INVALID_TRANSITION';

  constructor(from: HandoffState, to: HandoffState) {
    super(`illegal handoff state transition: ${from} → ${to} (only pending → consumed | archived)`);
    this.name = 'HandoffStateError';
  }
}

const HANDOFF_PREFIX = 'handoff/';
const HANDOFF_TAG = 'handoff';
/** Stable handoff id shape (`ho_<12 hex chars>`); exported for the HTTP adapter's path validation. */
export const HANDOFF_ID_PATTERN = /^ho_[0-9a-f]{12}$/;
const HANDOFF_LIST_DEFAULT_LIMIT = 100;
const HANDOFF_LIST_MAX_LIMIT = 1000;
/** Per-scope scan cap for outbox (BoardStore's own hard read limit). */
const HANDOFF_SCAN_MAX = 1000;

/**
 * v2 agent address shape: `<label>:<sessionId>:<agentId>` with label a free
 * `[a-z0-9-]+` harness tag and the two remaining segments non-empty without
 * colons/whitespace. Shape-only validation — no registry resolution.
 */
const AGENT_ADDRESS_PATTERN = /^[a-z0-9-]+:[^:\s]+:[^:\s]+$/;

/** A BoardStore scope designator plus the workspace path it needs (if any). */
interface TargetScope {
  scope: string;
  workspace?: string;
}

function handoffKey(id: string): string {
  return `${HANDOFF_PREFIX}${id}`;
}

function newHandoffId(): string {
  return 'ho_' + randomUUID().replace(/-/g, '').slice(0, 12);
}

function requireString(value: unknown, field: string, nonEmpty = true): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    throw new HandoffValidationError(`${field} must be a${nonEmpty ? ' non-empty' : ''} string`);
  }
  return value;
}

function normalizeActor(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'anonymous';
  return requireString(value, 'actor');
}

function validateState(value: unknown): HandoffState {
  if (typeof value !== 'string' || !HANDOFF_STATES.includes(value as HandoffState)) {
    throw new HandoffValidationError(`state must be one of: ${HANDOFF_STATES.join(', ')}`);
  }
  return value as HandoffState;
}

function validateToProject(value: unknown): string {
  if (value === HANDOFF_USER_GLOBAL) return value;
  if (typeof value === 'string' && PROJECT_ID_PATTERN.test(value)) return value;
  throw new HandoffValidationError(`toProject must be a projectId (p_<12 hex chars>) or "${HANDOFF_USER_GLOBAL}"`);
}

function validateDate(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (Number.isNaN(Date.parse(result))) throw new HandoffValidationError(`${field} must be an ISO 8601 timestamp`);
  return result;
}

/** v2 optional agent address: shape-checked only (`<label>:<sessionId>:<agentId>`). */
function validateAgentAddress(value: unknown, field: string): string {
  const address = requireString(value, field);
  if (!AGENT_ADDRESS_PATTERN.test(address)) {
    throw new HandoffValidationError(
      `${field} must match the agent address shape <label>:<sessionId>:<agentId> ` +
        `(label is [a-z0-9-]+; the other two parts must be non-empty and free of colons/whitespace)`,
    );
  }
  return address;
}

function validateHandoff(value: unknown): Handoff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HandoffValidationError('handoff value must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 && raw.v !== 2) throw new HandoffValidationError('v must be 1 or 2');
  const id = requireString(raw.id, 'id');
  if (!HANDOFF_ID_PATTERN.test(id)) throw new HandoffValidationError('id must match ho_<12 hex chars>');
  const handoff: Handoff = {
    v: raw.v,
    id,
    title: requireString(raw.title, 'title'),
    summary: requireString(raw.summary, 'summary'),
    fromProject: requireString(raw.fromProject, 'fromProject'),
    toProject: validateToProject(raw.toProject),
    state: validateState(raw.state),
    createdAt: validateDate(raw.createdAt, 'createdAt'),
    updatedAt: validateDate(raw.updatedAt, 'updatedAt'),
    consumedAt:
      raw.consumedAt === undefined || raw.consumedAt === null
        ? null
        : validateDate(raw.consumedAt, 'consumedAt'),
    author: requireString(raw.author, 'author'),
  };
  if (raw.toAgent !== undefined) handoff.toAgent = validateAgentAddress(raw.toAgent, 'toAgent');
  if (raw.fromAgent !== undefined) handoff.fromAgent = validateAgentAddress(raw.fromAgent, 'fromAgent');
  if (raw.context !== undefined) handoff.context = requireString(raw.context, 'context', false);
  return handoff;
}

function cloneHandoff(handoff: Handoff): Handoff {
  return JSON.parse(JSON.stringify(handoff)) as Handoff;
}

function summaryOf(handoff: Handoff): HandoffSummary {
  const copy = cloneHandoff(handoff);
  delete copy.context;
  return copy;
}

function handoffTags(handoff: Handoff): string[] {
  const tags = [HANDOFF_TAG, `${HANDOFF_TAG}:state:${handoff.state}`];
  if (handoff.toAgent !== undefined) tags.push(`agent:${handoff.toAgent}`);
  return tags;
}

function encodeHandoff(handoff: Handoff): string {
  // Field order mirrors the documented on-disk schema (MAILBOX_IMPL.md §3a),
  // with the v2 agent-address keys appended after toProject.
  const ordered: Record<string, unknown> = {
    v: handoff.v,
    id: handoff.id,
    title: handoff.title,
    summary: handoff.summary,
  };
  if (handoff.context !== undefined) ordered.context = handoff.context;
  ordered.fromProject = handoff.fromProject;
  ordered.toProject = handoff.toProject;
  if (handoff.fromAgent !== undefined) ordered.fromAgent = handoff.fromAgent;
  if (handoff.toAgent !== undefined) ordered.toAgent = handoff.toAgent;
  ordered.state = handoff.state;
  ordered.createdAt = handoff.createdAt;
  ordered.updatedAt = handoff.updatedAt;
  ordered.consumedAt = handoff.consumedAt;
  ordered.author = handoff.author;
  const value = JSON.stringify(ordered);
  if (Buffer.byteLength(value, 'utf8') > HANDOFF_VALUE_MAX_BYTES) {
    throw new HandoffValidationError(`handoff value exceeds ${HANDOFF_VALUE_MAX_BYTES} bytes`);
  }
  return value;
}

function normalizeLimit(value: unknown): number {
  if (value === undefined || value === null) return HANDOFF_LIST_DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new HandoffValidationError('limit must be a positive number');
  }
  return Math.min(Math.floor(value), HANDOFF_LIST_MAX_LIMIT);
}

function normalizeStateFilter(value: unknown): HandoffState[] {
  // Default inbox view: actionable + acknowledged, archived hidden (tips precedent).
  if (value === undefined || value === null) return ['pending', 'consumed'];
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) throw new HandoffValidationError('state filter must not be empty');
  return list.map((item) => validateState(item));
}

export class HandoffStore {
  readonly board: BoardStore;

  constructor(board: BoardStore) {
    this.board = board;
  }

  /**
   * Send a handoff into the target project's board. `workspace` is the
   * sender's absolute project path (identity only — nothing is written to
   * the sender scope); `input.toProject` selects the target scope.
   */
  async send(input: HandoffSendInput, workspace: string): Promise<Handoff> {
    const from = normalizeWorkspacePath(workspace);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new HandoffValidationError('send input must be an object');
    }
    const raw = input as Record<string, unknown>;
    for (const field of ['id', 'v', 'fromProject', 'state', 'createdAt', 'updatedAt', 'consumedAt']) {
      if (field in raw) throw new HandoffValidationError(`${field} cannot be supplied when sending a handoff`);
    }
    const toProject = validateToProject(raw.toProject);
    const title = requireString(raw.title, 'title');
    const summary = requireString(raw.summary, 'summary');
    const context = raw.context === undefined ? undefined : requireString(raw.context, 'context', false);
    const author = normalizeActor(raw.author);
    const toAgent = raw.toAgent === undefined ? undefined : validateAgentAddress(raw.toAgent, 'toAgent');
    const fromAgent = raw.fromAgent === undefined ? undefined : validateAgentAddress(raw.fromAgent, 'fromAgent');
    const fromProject = await this.senderIdentity(from);
    const id = newHandoffId();
    const key = handoffKey(id);
    const target = this.scopeFor(toProject);
    // Agent-level addressing is a v2 feature; entries without either agent
    // field stay v1 so the on-disk schema (and old readers) are untouched.
    const v = toAgent !== undefined || fromAgent !== undefined ? 2 : 1;
    return this.board.mutate(target.scope, (entries, commitTs) => {
      if (entries.has(key)) throw new HandoffValidationError(`handoff id collision: ${id}`);
      const handoff: Handoff = {
        v,
        id,
        title,
        summary,
        fromProject,
        toProject,
        state: 'pending',
        createdAt: commitTs,
        updatedAt: commitTs,
        consumedAt: null,
        author,
      };
      if (toAgent !== undefined) handoff.toAgent = toAgent;
      if (fromAgent !== undefined) handoff.fromAgent = fromAgent;
      if (context !== undefined) handoff.context = context;
      entries.set(key, {
        key,
        value: encodeHandoff(handoff),
        author,
        ts: commitTs,
        tags: handoffTags(handoff),
      });
      return handoff;
    }, target.workspace);
  }

  /**
   * List handoffs addressed to `target` (workspace path, projectId, or
   * `user-global`), newest first, capped by limit. Archived rows are hidden
   * unless the state filter explicitly asks for them.
   */
  async inbox(target: string, options?: HandoffListOptions): Promise<HandoffSummary[]> {
    const opts = options ?? {};
    const wanted = normalizeStateFilter(opts.state);
    const limit = normalizeLimit(opts.limit);
    const agent = opts.agent === undefined ? undefined : requireString(opts.agent, 'agent');
    const scope = await this.resolveTarget(target);
    const rows = await this.board.readNamespace(HANDOFF_PREFIX, undefined, scope.scope, HANDOFF_SCAN_MAX, scope.workspace);
    return this.collect(rows, wanted, limit, agent);
  }

  /** Read one complete handoff (including context) from `target`'s board. */
  async read(id: string, target: string): Promise<Handoff | undefined> {
    const normalizedId = requireString(id, 'id');
    const scope = await this.resolveTarget(target);
    const rows = await this.board.read(handoffKey(normalizedId), undefined, scope.scope, 1, scope.workspace);
    const entry = rows[0];
    if (entry === undefined) return undefined;
    return this.decodeEntry(normalizedId, entry);
  }

  /** Mark a pending handoff consumed (terminal); records consumedAt. */
  async consume(id: string, target: string, actor?: string | null): Promise<Handoff> {
    return this.transition(id, target, 'consumed', actor);
  }

  /** Archive a pending handoff (terminal), preserving all content. */
  async archive(id: string, target: string, actor?: string | null): Promise<Handoff> {
    return this.transition(id, target, 'archived', actor);
  }

  /**
   * List handoffs SENT from `from` (absolute workspace path) across every
   * board scope file, newest first. Sender identity matches the aliased
   * projectId — plus every `ws:<aliasHash>` of that project, so entries sent
   * before aliasing remain visible.
   */
  async outbox(from: string, options?: HandoffListOptions): Promise<HandoffSummary[]> {
    const opts = options ?? {};
    const workspace = normalizeWorkspacePath(from);
    const identity = await this.senderIdentity(workspace);
    const identities = await this.outboxIdentities(identity);
    const wanted = normalizeStateFilter(opts.state);
    const limit = normalizeLimit(opts.limit);
    const scopes = await this.knownScopes();
    const rows: BoardEntry[] = [];
    for (const scope of scopes) {
      const scopeRows = await this.board.readNamespace(HANDOFF_PREFIX, undefined, scope.scope, HANDOFF_SCAN_MAX, scope.workspace);
      for (const row of scopeRows) rows.push(row);
    }
    const all = this.collect(rows, wanted, Number.MAX_SAFE_INTEGER);
    return all.filter((summary) => identities.has(summary.fromProject)).slice(0, limit);
  }

  // ---- internals ----

  /** The only two pending transitions; everything else throws HandoffStateError. */
  private async transition(id: string, target: string, next: 'consumed' | 'archived', actor?: string | null): Promise<Handoff> {
    const normalizedId = requireString(id, 'id');
    const boardAuthor = normalizeActor(actor);
    const scope = await this.resolveTarget(target);
    const key = handoffKey(normalizedId);
    return this.board.mutate(scope.scope, (entries, commitTs) => {
      const entry = entries.get(key);
      if (entry === undefined) throw new HandoffNotFoundError(normalizedId);
      const current = this.decodeEntry(normalizedId, entry);
      if (current.state !== 'pending') throw new HandoffStateError(current.state, next);
      const updated: Handoff = {
        ...current,
        state: next,
        updatedAt: commitTs,
        consumedAt: next === 'consumed' ? commitTs : current.consumedAt,
      };
      entries.set(key, {
        key,
        value: encodeHandoff(updated),
        author: boardAuthor,
        ts: commitTs,
        tags: handoffTags(updated),
      });
      return updated;
    }, scope.workspace);
  }

  private collect(rows: BoardEntry[], wanted: HandoffState[], limit: number, agent?: string): HandoffSummary[] {
    const handoffs: Handoff[] = [];
    for (const row of rows) {
      if (!row.key.startsWith(HANDOFF_PREFIX)) continue;
      handoffs.push(this.decodeEntry(row.key.slice(HANDOFF_PREFIX.length), row));
    }
    const filtered = handoffs.filter(
      (handoff) => wanted.includes(handoff.state) && (agent === undefined || handoff.toAgent === agent),
    );
    filtered.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return filtered.slice(0, limit).map(summaryOf);
  }

  /**
   * Warm the alias projection, then map the target onto a BoardStore scope.
   * parseScope's resolveCached lookup is synchronous and runs before the
   * board operation's own fold, so a cold instance (fresh process / reopened
   * store) would otherwise resolve an aliased workspace to the legacy
   * ws:<hash> scope on its first recipient-side operation.
   */
  private async resolveTarget(target: unknown): Promise<TargetScope> {
    await this.board.registry.refreshIfStale().catch(() => {});
    return this.scopeFor(target);
  }

  /** Map a target designator onto a BoardStore scope (+workspace when needed). */
  private scopeFor(target: unknown): TargetScope {
    if (typeof target !== 'string' || target.length === 0) {
      throw new HandoffValidationError('target must be a non-empty string');
    }
    if (target === HANDOFF_USER_GLOBAL) return { scope: 'global' };
    if (isAbsolute(target)) return { scope: 'workspace', workspace: normalizeWorkspacePath(target) };
    if (PROJECT_ID_PATTERN.test(target)) return { scope: `project:${target}` };
    throw new HandoffValidationError(
      `target must be an absolute workspace path, a projectId (p_<12 hex chars>), or "${HANDOFF_USER_GLOBAL}"`,
    );
  }

  /** Sender identity: the workspace's project alias when registered, else ws:<pathHash>. */
  private async senderIdentity(workspace: string): Promise<string> {
    const hash = workspaceIdForPath(workspace);
    // A stale projection merely yields the legacy ws:<hash> identity for this
    // send; the next fold-driven refresh self-heals (mirrors parseScope).
    await this.board.registry.refreshIfStale().catch(() => {});
    return this.board.registry.resolveCached(hash) ?? `ws:${hash}`;
  }

  /** Identity set for outbox matching: projectId plus all its alias hashes. */
  private async outboxIdentities(identity: string): Promise<Set<string>> {
    const identities = new Set<string>([identity]);
    if (PROJECT_ID_PATTERN.test(identity)) {
      const projects = await this.board.registry.listProjects();
      const project = projects.find((entry) => entry.projectId === identity);
      if (project !== undefined) {
        for (const alias of project.aliases) identities.add(`ws:${alias}`);
      }
    }
    return identities;
  }

  /**
   * Every addressable board scope in this home: global, each project file,
   * and each workspace file whose sidecar records a cwd (hash→path is only
   * recoverable through the sidecar).
   */
  private async knownScopes(): Promise<TargetScope[]> {
    const scopes: TargetScope[] = [{ scope: 'global' }];
    let names: string[];
    try {
      names = await readdir(this.board.boardsDir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return scopes;
      throw err;
    }
    const workspaces = await this.board.listWorkspaces();
    const cwdById = new Map(workspaces.map((info) => [info.id, info.cwd]));
    for (const name of [...names].sort()) {
      const project = /^project-(p_[0-9a-f]{12})\.jsonl$/.exec(name);
      if (project !== null) {
        scopes.push({ scope: `project:${project[1]}` });
        continue;
      }
      const ws = /^ws-([0-9a-f]{16})\.jsonl$/.exec(name);
      if (ws !== null) {
        const cwd = cwdById.get(ws[1]);
        if (cwd !== undefined) scopes.push({ scope: 'workspace', workspace: cwd });
      }
    }
    return scopes;
  }

  private decodeEntry(id: string, entry: BoardEntry): Handoff {
    let value: unknown;
    try {
      value = JSON.parse(entry.value);
    } catch {
      throw new HandoffCorruptError(id, 'value is not valid JSON');
    }
    try {
      const handoff = validateHandoff(value);
      if (handoff.id !== id || entry.key !== handoffKey(id)) throw new HandoffValidationError('id/key mismatch');
      return handoff;
    } catch (err) {
      if (err instanceof HandoffCorruptError) throw err;
      throw new HandoffCorruptError(id, (err as Error).message);
    }
  }
}
