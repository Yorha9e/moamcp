/**
 * Project Tips — a typed workspace view over BoardStore entries under `tips/`.
 *
 * Tips deliberately keep the BoardStore as the only persistence layer. The
 * store requires an explicit absolute workspace for every operation so a
 * plugin process cwd can never silently select the wrong project.
 */
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import {
  BOARD_VALUE_MAX_BYTES,
  BoardStore,
  type BoardEntry,
  normalizeWorkspacePath,
} from './board.js';

export const PROJECT_TIP_STATUSES = [
  'captured',
  'exploring',
  'planned',
  'implemented',
  'deferred',
  'discarded',
  'archived',
] as const;

export type ProjectTipStatus = (typeof PROJECT_TIP_STATUSES)[number];

export interface TipDocumentRef {
  path: string;
  section?: string;
  note?: string;
  contentHash?: string;
}

export interface ProjectTip {
  id: string;
  title: string;
  summary: string;
  status: ProjectTipStatus;
  createdAt: string;
  updatedAt: string;
  context?: string;
  module?: string;
  tags?: string[];
  nextAction?: string;
  documentRefs?: TipDocumentRef[];
  sourceRefs?: string[];
  relatedTipIds?: string[];
  relatedProjects?: string[];
  sourceSessionId?: string;
  author?: string;
}

export type TipCreateInput = Omit<ProjectTip, 'id' | 'status' | 'createdAt' | 'updatedAt'> & {
  status?: ProjectTipStatus;
};

export type TipNullable<T> = T | null;

export interface TipUpdateInput {
  title?: string;
  summary?: string;
  status?: ProjectTipStatus;
  context?: TipNullable<string>;
  module?: TipNullable<string>;
  tags?: TipNullable<string[]>;
  nextAction?: TipNullable<string>;
  documentRefs?: TipNullable<TipDocumentRef[]>;
  sourceRefs?: TipNullable<string[]>;
  relatedTipIds?: TipNullable<string[]>;
  relatedProjects?: TipNullable<string[]>;
  sourceSessionId?: TipNullable<string>;
  /** BoardEntry actor for this mutation; it is never copied into ProjectTip. */
  actor?: TipNullable<string>;
  /** Rejected explicitly so callers get a useful error instead of a silent no-op. */
  id?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  creator?: unknown;
}

export interface TipListOptions {
  status?: ProjectTipStatus | ProjectTipStatus[];
  module?: string;
  tag?: string;
  /** Accepted as a compatibility alias for callers that naturally say tags. */
  tags?: string | string[];
  includeArchived?: boolean;
  limit?: number;
}

/** The list contract contains metadata only; full references are read-only details. */
export type ProjectTipSummary = Pick<
  ProjectTip,
  'id' | 'title' | 'summary' | 'status' | 'module' | 'tags' | 'nextAction' | 'author' | 'createdAt' | 'updatedAt'
>;

export class TipNotFoundError extends Error {
  readonly code = 'TIP_NOT_FOUND';

  constructor(id: string) {
    super(`tip not found: ${id}`);
    this.name = 'TipNotFoundError';
  }
}

export class TipCorruptError extends Error {
  readonly code = 'TIP_CORRUPT';

  constructor(id: string, message: string) {
    super(`corrupt tip ${id}: ${message}`);
    this.name = 'TipCorruptError';
  }
}

export class TipValidationError extends Error {
  readonly code = 'TIP_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'TipValidationError';
  }
}

const CONTEXT_MAX_BYTES = 8 * 1024;
const TIP_LIST_DEFAULT_LIMIT = 100;
const TIP_LIST_MAX_LIMIT = 1000;
const TIP_PREFIX = 'tips/';
const TIP_TAG = 'tip';

function assertWorkspace(workspace: unknown): string {
  if (typeof workspace !== 'string' || workspace.length === 0 || !isAbsolute(workspace)) {
    throw new TipValidationError('workspace must be an absolute path');
  }
  return normalizeWorkspacePath(workspace);
}

function tipKey(id: string): string {
  return `${TIP_PREFIX}${id}`;
}

function requireString(value: unknown, field: string, nonEmpty = true): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    throw new TipValidationError(`${field} must be a${nonEmpty ? ' non-empty' : ''} string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function normalizeActor(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'anonymous';
  return requireString(value, 'actor');
}

function validateStatus(value: unknown, field = 'status'): ProjectTipStatus {
  if (typeof value !== 'string' || !PROJECT_TIP_STATUSES.includes(value as ProjectTipStatus)) {
    throw new TipValidationError(`${field} must be one of: ${PROJECT_TIP_STATUSES.join(', ')}`);
  }
  return value as ProjectTipStatus;
}

function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TipValidationError(`${field} must be an array of non-empty strings`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value as string[]) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function validateDocumentRefs(value: unknown): TipDocumentRef[] {
  if (!Array.isArray(value)) throw new TipValidationError('documentRefs must be an array');
  const result: TipDocumentRef[] = [];
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TipValidationError(`documentRefs[${index}] must be an object`);
    }
    const ref = raw as Record<string, unknown>;
    const out: TipDocumentRef = { path: requireString(ref.path, `documentRefs[${index}].path`) };
    for (const field of ['section', 'note', 'contentHash'] as const) {
      const item = ref[field];
      if (item !== undefined) out[field] = requireString(item, `documentRefs[${index}].${field}`);
    }
    const stableValue = JSON.stringify(out);
    if (seen.has(stableValue)) return;
    seen.add(stableValue);
    result.push(out);
  });
  return result;
}

function validateContext(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > CONTEXT_MAX_BYTES) {
    throw new TipValidationError(`context exceeds ${CONTEXT_MAX_BYTES} bytes`);
  }
  return value;
}

function validateDate(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (Number.isNaN(Date.parse(result))) throw new TipValidationError(`${field} must be an ISO 8601 timestamp`);
  return result;
}

function validateTip(value: unknown): ProjectTip {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TipValidationError('tip value must be an object');
  }
  const raw = value as Record<string, unknown>;
  const id = requireString(raw.id, 'id');
  if (!id.startsWith('tip_')) throw new TipValidationError('id must start with tip_');
  const tip: ProjectTip = {
    id,
    title: requireString(raw.title, 'title'),
    summary: requireString(raw.summary, 'summary'),
    status: validateStatus(raw.status),
    createdAt: validateDate(raw.createdAt, 'createdAt'),
    updatedAt: validateDate(raw.updatedAt, 'updatedAt'),
  };
  if (raw.context !== undefined) tip.context = validateContext(requireString(raw.context, 'context', false));
  if (raw.module !== undefined) tip.module = optionalString(raw.module, 'module');
  if (raw.tags !== undefined) tip.tags = validateStringArray(raw.tags, 'tags');
  if (raw.nextAction !== undefined) tip.nextAction = requireString(raw.nextAction, 'nextAction', false);
  if (raw.documentRefs !== undefined) tip.documentRefs = validateDocumentRefs(raw.documentRefs);
  if (raw.sourceRefs !== undefined) tip.sourceRefs = validateStringArray(raw.sourceRefs, 'sourceRefs');
  if (raw.relatedTipIds !== undefined) tip.relatedTipIds = validateStringArray(raw.relatedTipIds, 'relatedTipIds');
  if (raw.relatedProjects !== undefined) tip.relatedProjects = validateStringArray(raw.relatedProjects, 'relatedProjects');
  if (raw.sourceSessionId !== undefined) tip.sourceSessionId = requireString(raw.sourceSessionId, 'sourceSessionId');
  if (raw.author !== undefined) tip.author = requireString(raw.author, 'author');
  return tip;
}

function cloneTip(tip: ProjectTip): ProjectTip {
  return JSON.parse(JSON.stringify(tip)) as ProjectTip;
}

function tipTags(tip: ProjectTip): string[] {
  const tags = new Set<string>([TIP_TAG, `tip:status:${tip.status}`]);
  if (tip.module !== undefined) tags.add(`tip:module:${tip.module}`);
  for (const tag of tip.tags ?? []) tags.add(`tip:tag:${tag}`);
  return [...tags];
}

function encodeTip(tip: ProjectTip): string {
  const value = JSON.stringify(tip);
  if (Buffer.byteLength(value, 'utf8') > BOARD_VALUE_MAX_BYTES) {
    throw new TipValidationError(`tip value exceeds ${BOARD_VALUE_MAX_BYTES} bytes`);
  }
  return value;
}

function summaryOf(tip: ProjectTip): ProjectTipSummary {
  const copy = cloneTip(tip);
  const summary: ProjectTipSummary = {
    id: copy.id,
    title: copy.title,
    summary: copy.summary,
    status: copy.status,
    createdAt: copy.createdAt,
    updatedAt: copy.updatedAt,
  };
  if (copy.module !== undefined) summary.module = copy.module;
  if (copy.tags !== undefined) summary.tags = copy.tags;
  if (copy.nextAction !== undefined) summary.nextAction = copy.nextAction;
  if (copy.author !== undefined) summary.author = copy.author;
  return summary;
}

function normalizeTipLimit(value: unknown): number {
  if (value === undefined || value === null) return TIP_LIST_DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new TipValidationError('limit must be a positive number');
  }
  return Math.min(Math.floor(value), TIP_LIST_MAX_LIMIT);
}

function statuses(value: unknown): ProjectTipStatus[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => validateStatus(item));
}

function filterTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return validateStringArray(list, 'tag');
}

export class TipStore {
  readonly board: BoardStore;

  constructor(board: BoardStore) {
    this.board = board;
  }

  /** Create a new captured Tip with a UUID-backed stable id. */
  async create(input: TipCreateInput, workspace: string): Promise<ProjectTip>;
  async create(workspace: string, input: TipCreateInput): Promise<ProjectTip>;
  async create(first: TipCreateInput | string, second: string | TipCreateInput): Promise<ProjectTip> {
    const workspace = typeof first === 'string' ? assertWorkspace(first) : assertWorkspace(second);
    const input = (typeof first === 'string' ? second : first) as TipCreateInput;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new TipValidationError('create input must be an object');
    }
    const raw = input as Record<string, unknown>;
    for (const field of ['id', 'createdAt', 'updatedAt', 'creator']) {
      if (field in raw) throw new TipValidationError(`${field} cannot be supplied when creating a tip`);
    }
    const title = requireString(raw.title, 'title');
    const summary = requireString(raw.summary, 'summary');
    const status = raw.status === undefined ? 'captured' : validateStatus(raw.status);
    const id = `tip_${randomUUID()}`;
    return this.board.mutate('workspace', (entries, commitTs) => {
      const key = tipKey(id);
      if (entries.has(key)) throw new TipValidationError(`tip id collision: ${id}`);
      const tip = this.buildTip({ ...raw, id, title, summary, status, createdAt: commitTs, updatedAt: commitTs });
      entries.set(key, {
        key,
        value: encodeTip(tip),
        author: tip.author ?? 'anonymous',
        ts: commitTs,
        tags: tipTags(tip),
      });
      return tip;
    }, workspace);
  }

  /** Return undefined for an absent id; malformed persisted data throws TipCorruptError. */
  async read(id: string, workspace: string): Promise<ProjectTip | undefined>;
  async read(workspace: string, id: string): Promise<ProjectTip | undefined>;
  async read(first: string, second: string): Promise<ProjectTip | undefined> {
    const workspace = assertWorkspace(isAbsolute(first) ? first : second);
    const id = isAbsolute(first) ? second : first;
    const normalizedId = requireString(id, 'id');
    const rows = await this.board.read(tipKey(normalizedId), undefined, 'workspace', 1, workspace);
    const entry = rows[0];
    if (entry === undefined) return undefined;
    return this.decodeEntry(normalizedId, entry);
  }

  /** List lightweight summaries, hiding archived rows unless explicitly requested. */
  async list(options: TipListOptions | undefined, workspace: string): Promise<ProjectTipSummary[]>;
  async list(workspace: string, options?: TipListOptions): Promise<ProjectTipSummary[]>;
  async list(first: TipListOptions | string | undefined, second?: string | TipListOptions): Promise<ProjectTipSummary[]> {
    const workspace = assertWorkspace(typeof first === 'string' ? first : second);
    const options = (typeof first === 'string' ? second : first) as TipListOptions | undefined;
    const filters = options ?? {};
    if (filters.includeArchived !== undefined && typeof filters.includeArchived !== 'boolean') {
      throw new TipValidationError('includeArchived must be a boolean');
    }
    const wantedStatuses = statuses(filters.status);
    const wantedTags = filterTags(filters.tags ?? filters.tag);
    const limit = normalizeTipLimit(filters.limit);
    const rows = await this.board.read(undefined, undefined, 'workspace', TIP_LIST_MAX_LIMIT, workspace);
    const tips: ProjectTip[] = [];
    for (const row of rows) {
      if (!row.key.startsWith(TIP_PREFIX)) continue;
      const id = row.key.slice(TIP_PREFIX.length);
      tips.push(this.decodeEntry(id, row));
    }
    const filtered = tips.filter((tip) => {
      if (!filters.includeArchived && tip.status === 'archived') return false;
      if (wantedStatuses !== undefined && !wantedStatuses.includes(tip.status)) return false;
      if (filters.module !== undefined && tip.module !== filters.module) return false;
      if (wantedTags !== undefined && !wantedTags.every((tag) => (tip.tags ?? []).includes(tag))) return false;
      return true;
    });
    filtered.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return filtered.slice(0, limit).map(summaryOf);
  }

  /** Apply an update atomically; omitted fields survive and null clears optionals. */
  async update(id: string, patch: TipUpdateInput, workspace: string, actor?: string | null): Promise<ProjectTip>;
  async update(workspace: string, id: string, patch: TipUpdateInput, actor?: string | null): Promise<ProjectTip>;
  async update(
    first: string,
    second: string | TipUpdateInput,
    third: TipUpdateInput | string,
    fourth?: string | null,
  ): Promise<ProjectTip> {
    const workspace = assertWorkspace(isAbsolute(first) ? first : third);
    const id = isAbsolute(first) ? second as string : first;
    const patch = (isAbsolute(first) ? third : second) as TipUpdateInput;
    const normalizedId = requireString(id, 'id');
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new TipValidationError('update patch must be an object');
    const rawPatch = patch as Record<string, unknown>;
    const boardAuthor = normalizeActor(fourth !== undefined ? fourth : rawPatch.actor);
    for (const field of ['id', 'createdAt', 'updatedAt', 'creator', 'author']) {
      if (field in patch) throw new TipValidationError(`${field} cannot be changed`);
    }
    const contentPatch = { ...rawPatch };
    delete contentPatch.actor;
    const key = tipKey(normalizedId);
    return this.board.mutate('workspace', (entries, commitTs) => {
      const entry = entries.get(key);
      if (entry === undefined) throw new TipNotFoundError(normalizedId);
      const current = this.decodeEntry(normalizedId, entry);
      const next = this.applyPatch(current, contentPatch as TipUpdateInput);
      next.updatedAt = commitTs;
      entries.set(key, { key, value: encodeTip(next), author: boardAuthor, ts: commitTs, tags: tipTags(next) });
      return next;
    }, workspace);
  }

  /** Archive is deliberately a narrow status transition, preserving all content. */
  async archive(id: string, workspace: string, actor?: string | null): Promise<ProjectTip>;
  async archive(workspace: string, id: string, actor?: string | null): Promise<ProjectTip>;
  async archive(first: string, second: string, third?: string | null): Promise<ProjectTip> {
    const workspace = assertWorkspace(isAbsolute(first) ? first : second);
    const id = isAbsolute(first) ? second : first;
    const normalizedId = requireString(id, 'id');
    const boardAuthor = normalizeActor(third);
    const key = tipKey(normalizedId);
    return this.board.mutate('workspace', (entries, commitTs) => {
      const entry = entries.get(key);
      if (entry === undefined) throw new TipNotFoundError(normalizedId);
      const current = this.decodeEntry(normalizedId, entry);
      const archived: ProjectTip = { ...current, status: 'archived', updatedAt: commitTs };
      entries.set(key, { key, value: encodeTip(archived), author: boardAuthor, ts: commitTs, tags: tipTags(archived) });
      return archived;
    }, workspace);
  }

  private buildTip(raw: Record<string, unknown>): ProjectTip {
    const tip = validateTip(raw);
    if (raw.context !== undefined) tip.context = validateContext(requireString(raw.context, 'context', false));
    return tip;
  }

  private applyPatch(current: ProjectTip, patch: TipUpdateInput): ProjectTip {
    const next = cloneTip(current);
    const raw = patch as Record<string, unknown>;
    const required = ['title', 'summary', 'status'] as const;
    for (const field of required) {
      if (!(field in raw)) continue;
      if (raw[field] === null) throw new TipValidationError(`${field} cannot be cleared`);
      if (field === 'status') next.status = validateStatus(raw[field]);
      else next[field] = requireString(raw[field], field) as never;
    }
    const optionalFields = [
      'context', 'module', 'tags', 'nextAction', 'documentRefs', 'sourceRefs',
      'relatedTipIds', 'relatedProjects', 'sourceSessionId',
    ] as const;
    for (const field of optionalFields) {
      if (!(field in raw)) continue;
      const value = raw[field];
      if (value === null) {
        delete next[field];
        continue;
      }
      if (field === 'context') next.context = validateContext(requireString(value, field, false));
      else if (field === 'module') next.module = requireString(value, field);
      else if (field === 'tags' || field === 'sourceRefs' || field === 'relatedTipIds' || field === 'relatedProjects') {
        next[field] = validateStringArray(value, field) as never;
      } else if (field === 'documentRefs') next.documentRefs = validateDocumentRefs(value);
      else next[field] = requireString(value, field, field === 'sourceSessionId') as never;
    }
    return validateTip(next);
  }

  private decodeEntry(id: string, entry: BoardEntry): ProjectTip {
    let value: unknown;
    try {
      value = JSON.parse(entry.value);
    } catch {
      throw new TipCorruptError(id, 'value is not valid JSON');
    }
    try {
      const tip = validateTip(value);
      if (tip.id !== id || entry.key !== tipKey(id)) throw new TipValidationError('id/key mismatch');
      return tip;
    } catch (err) {
      if (err instanceof TipCorruptError) throw err;
      throw new TipCorruptError(id, (err as Error).message);
    }
  }
}

export function isProjectTipStatus(value: unknown): value is ProjectTipStatus {
  return typeof value === 'string' && PROJECT_TIP_STATUSES.includes(value as ProjectTipStatus);
}
