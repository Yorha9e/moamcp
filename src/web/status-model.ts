/**
 * status-model.ts — single source of truth for the Status Board tree model
 * (design decision D2/D3). Pure TS: zero imports, no module-level closures,
 * every function self-contained so `Function.prototype.toString()` output
 * runs unmodified in a bare vm. The page embeds STATUS_MODEL_JS (the same
 * serialized source) so the browser and vitest execute the identical logic.
 *
 * Semantics (critic F2/F3/F4, corrected gone):
 *  - key = `${sessionId}:${agentId}`; subagents with their own fold entry are
 *    independent nodes; tasks-only subagents become "orphan leaves" attached
 *    to the parent entry's subagents[] list (deduped by key, never doubled).
 *  - tree: parentAgentId is authoritative; parent.subagents[] only backfills
 *    orphan leaves. Cycles (A->B->A) are broken by re-rooting every member —
 *    traversal and deletion are visited-guarded, no stack overflow possible.
 *  - reparent: an agent frame whose parentAgentId changed, or whose parent
 *    arrived later, moves the row (same-key detach + attach), never duplicates.
 *  - gone(P) deletes P's own row plus only its orphan leaves; independent live
 *    children survive and re-root to the session top as pending roots (parent
 *    missing -> 暂挂根), so a later out-of-order parent frame re-attaches them.
 *  - session-gone removes the group when it has no live agents, otherwise the
 *    group is marked `gone` (ended) while in-frame agent rows are retained;
 *    the next agent frame revives the group (re-hang).
 *  - status derivation: stale overrides busy (E8); phase missing falls back to
 *    busy?'busy':'idle'; subagents carry the running/completed/failed/killed/
 *    suspended/unknown enum; main agents derive terminal state from
 *    lastTurnReason/lastFinishReason (no completed enum on main).
 */

/** Loose wire shape accepted by the model (snapshot agent or SSE agent frame). */
export interface RawAgent {
  sessionId?: unknown;
  agentId?: unknown;
  parentAgentId?: unknown;
  kind?: unknown;
  model?: unknown;
  phase?: unknown;
  home?: unknown;
  workDirHash?: unknown;
  contextTokens?: unknown;
  planMode?: unknown;
  busy?: unknown;
  stale?: unknown;
  lastFinishReason?: unknown;
  lastTurnReason?: unknown;
  lastToolCall?: unknown;
  lastSeen?: unknown;
  firstSeen?: unknown;
  source?: unknown;
  subagents?: unknown;
  [key: string]: unknown;
}

export interface RawSession {
  sessionId?: unknown;
  title?: unknown;
  workDir?: unknown;
  home?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface RawSnapshot {
  sessions?: unknown;
  agents?: unknown;
  [key: string]: unknown;
}

/** One normalized model entry (an independent agent or an orphan leaf). */
export interface ModelEntry {
  key: string;
  sessionId: string;
  agentId: string;
  /** Resolved parent key; null when root (including pending roots). */
  parentKey: string | null;
  /** Missing parent this entry is pending under (暂挂根), if any. */
  pendingParent?: string;
  parentAgentId?: string | null;
  kind?: string;
  model?: string;
  phase?: string;
  home?: string;
  workDirHash?: string;
  contextTokens?: number;
  planMode?: boolean;
  busy: boolean;
  stale: boolean;
  lastFinishReason?: string;
  lastTurnReason?: string;
  /** Latest tool call from the wire (fold's ToolCallInfo shape); drives the
   *  "Last tool" column + error marker in the page (reviewer fix: the model
   *  used to drop it, so the column was always '–'). */
  lastToolCall?: { name?: string; ts?: number; description?: string; isError?: boolean };
  lastSeen: number;
  firstSeen: number;
  source?: string;
  /** True for tasks-only leaves synthesized from a parent's subagents[]. */
  orphan: boolean;
  /** Subagent status enum for orphan leaves. */
  subStatus?: string;
  subName?: string;
  subDescription?: string;
  /** Raw subagents list carried by the latest frame (drives orphan fill). */
  subagents: unknown[];
  children: string[];
  seq: number;
}

export interface SessionRow {
  sessionId: string;
  title?: string;
  workDir?: string;
  home?: string;
  createdAt?: string;
  updatedAt?: string;
  /** True after a session-gone frame with surviving live agents. */
  gone: boolean;
}

export interface StatusModel {
  byKey: Record<string, ModelEntry>;
  roots: Record<string, string[]>;
  sessions: Record<string, SessionRow>;
  sessionOrder: string[];
  /** missing parentKey -> pending child keys. */
  pending: Record<string, string[]>;
  /** orphan key -> parent key (dedup registry). */
  orphans: Record<string, string>;
  seq: number;
}

export interface StatusDerivation {
  key: string;
  tone: 'busy' | 'done' | 'err' | 'warn' | 'stale' | 'idle';
  /** Raw display text when the key alone is not translatable (unknown phase). */
  label?: string;
}

export function agentKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

/** Fresh empty model. */
export function newModel(): StatusModel {
  return {
    byKey: {},
    roots: {},
    sessions: {},
    sessionOrder: [],
    pending: {},
    orphans: {},
    seq: 0,
  };
}

function removeFromArray(arr: unknown[], value: string): void {
  if (!arr) return;
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1);
}

/** Create (or revive) the session row; a frame for a gone session re-hangs it. */
function ensureSession(model: StatusModel, sessionId: string, info?: RawAgent | RawSession): SessionRow {
  let row = model.sessions[sessionId];
  if (!row) {
    row = { sessionId, gone: false };
    model.sessions[sessionId] = row;
    model.sessionOrder.push(sessionId);
    model.roots[sessionId] = model.roots[sessionId] || [];
  } else if (row.gone) {
    // A frame for this session proves it is alive again (re-hang).
    row.gone = false;
  }
  if (info) {
    if (typeof info.title === 'string') row.title = info.title;
    if (typeof info.workDir === 'string') row.workDir = info.workDir;
    if (typeof info.home === 'string') row.home = info.home;
  }
  return row;
}

export function upsertSession(model: StatusModel, session: RawSession): void {
  if (!session || typeof session.sessionId !== 'string') return;
  const row = ensureSession(model, session.sessionId, session);
  if (typeof session.createdAt === 'string') row.createdAt = session.createdAt;
  if (typeof session.updatedAt === 'string') row.updatedAt = session.updatedAt;
}

function pushRoot(model: StatusModel, entry: ModelEntry): void {
  const roots = model.roots[entry.sessionId] || (model.roots[entry.sessionId] = []);
  if (roots.indexOf(entry.key) === -1) roots.push(entry.key);
}

function registerPending(model: StatusModel, parentKey: string, childKey: string): void {
  const list = model.pending[parentKey] || (model.pending[parentKey] = []);
  if (list.indexOf(childKey) === -1) list.push(childKey);
}

/** Walk the parent chain upward; true when attaching `targetKey` under `startKey` would form a cycle. */
function wouldCycle(model: StatusModel, startKey: string, targetKey: string): boolean {
  const seen: Record<string, boolean> = {};
  let cur: string | null = startKey;
  while (cur) {
    if (cur === targetKey) return true;
    if (seen[cur]) return true; // safety: never walk an existing cycle
    seen[cur] = true;
    const e: ModelEntry | undefined = model.byKey[cur];
    cur = e ? e.parentKey || null : null;
  }
  return false;
}

/** Pull an entry out of its current parent/roots/pending registrations. */
function detachEntry(model: StatusModel, entry: ModelEntry): void {
  if (entry.parentKey) {
    const parent = model.byKey[entry.parentKey];
    if (parent) removeFromArray(parent.children, entry.key);
  } else {
    const roots = model.roots[entry.sessionId];
    if (roots) removeFromArray(roots, entry.key);
  }
  if (entry.pendingParent) {
    const pend = model.pending[entry.pendingParent];
    if (pend) removeFromArray(pend, entry.key);
  }
}

/** Resolve the entry's parent (reparent / pending-root) and place it. */
function resolveAndAttach(model: StatusModel, entry: ModelEntry): void {
  detachEntry(model, entry);
  const raw = entry.parentAgentId;
  let parentKey: string | null = null;
  if (typeof raw === 'string' && raw && raw !== entry.agentId) {
    const candidate = agentKey(entry.sessionId, raw);
    const candEntry = model.byKey[candidate];
    if (candEntry && !candEntry.orphan) {
      if (!wouldCycle(model, candidate, entry.key)) parentKey = candidate;
    } else {
      // Parent absent (or an orphan-only node): pending root (暂挂根).
      entry.pendingParent = candidate;
      registerPending(model, candidate, entry.key);
      pushRoot(model, entry);
      entry.parentKey = null;
      return;
    }
  }
  entry.pendingParent = undefined;
  entry.parentKey = parentKey;
  if (parentKey) {
    model.byKey[parentKey].children.push(entry.key);
    const roots = model.roots[entry.sessionId];
    if (roots) removeFromArray(roots, entry.key);
  } else {
    pushRoot(model, entry);
  }
}

/** Backfill orphan leaves from an entry's subagents[] (deduped by key). */
function fillOrphans(model: StatusModel, entry: ModelEntry): void {
  const subs = entry.subagents;
  if (!Array.isArray(subs) || subs.length === 0) return;
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i] as Record<string, unknown>;
    if (!sub || typeof sub !== 'object') continue;
    const subId = typeof sub.subagentId === 'string' ? sub.subagentId : undefined;
    if (!subId) continue;
    const skey = agentKey(entry.sessionId, subId);
    const existing = model.byKey[skey];
    if (existing && !existing.orphan) continue; // has an independent entry
    if (model.orphans[skey] !== undefined) continue; // already placed (dedup)
    const ts = typeof sub.ts === 'number' ? sub.ts : 0;
    const orphan: ModelEntry = {
      key: skey,
      sessionId: entry.sessionId,
      agentId: subId,
      parentKey: entry.key,
      kind: 'sub',
      orphan: true,
      subStatus: typeof sub.status === 'string' ? sub.status : 'unknown',
      subName: typeof sub.name === 'string' ? sub.name : undefined,
      subDescription: typeof sub.description === 'string' ? sub.description : undefined,
      busy: false,
      stale: false,
      lastSeen: ts,
      firstSeen: ts,
      subagents: [],
      children: [],
      seq: model.seq++,
    };
    model.byKey[skey] = orphan;
    model.orphans[skey] = entry.key;
    entry.children.push(skey);
  }
}

/** Re-attach children that were pending under a now-existing parent. */
function drainPending(model: StatusModel, parentKey: string): void {
  const pend = model.pending[parentKey];
  if (!pend || pend.length === 0) return;
  delete model.pending[parentKey];
  for (let i = 0; i < pend.length; i++) {
    const childKey = pend[i];
    const child = model.byKey[childKey];
    if (!child || child.orphan) continue;
    if (child.pendingParent !== parentKey) continue;
    resolveAndAttach(model, child);
  }
}

function normalizeEntry(model: StatusModel, agent: RawAgent, existing: ModelEntry | undefined): ModelEntry {
  const entry: ModelEntry =
    existing ||
    ({
      key: agentKey(agent.sessionId as string, agent.agentId as string),
      sessionId: agent.sessionId as string,
      agentId: agent.agentId as string,
      parentKey: null,
      busy: false,
      stale: false,
      lastSeen: 0,
      firstSeen: 0,
      orphan: false,
      subagents: [],
      children: [],
      seq: model.seq++,
    } as ModelEntry);
  entry.sessionId = agent.sessionId as string;
  entry.agentId = agent.agentId as string;
  entry.parentAgentId = typeof agent.parentAgentId === 'string' ? agent.parentAgentId : null;
  if (typeof agent.kind === 'string') entry.kind = agent.kind;
  if (typeof agent.model === 'string') entry.model = agent.model;
  if (typeof agent.phase === 'string' && agent.phase) entry.phase = agent.phase;
  if (typeof agent.home === 'string') entry.home = agent.home;
  if (typeof agent.workDirHash === 'string') entry.workDirHash = agent.workDirHash;
  if (typeof agent.contextTokens === 'number') entry.contextTokens = agent.contextTokens;
  if (typeof agent.planMode === 'boolean') entry.planMode = agent.planMode;
  if (typeof agent.busy === 'boolean') entry.busy = agent.busy;
  if (typeof agent.stale === 'boolean') entry.stale = agent.stale;
  if (typeof agent.lastFinishReason === 'string') entry.lastFinishReason = agent.lastFinishReason;
  if (typeof agent.lastTurnReason === 'string') entry.lastTurnReason = agent.lastTurnReason;
  // Keep the latest tool call (fold never clears it; a frame without the field
  // leaves the previous value in place, consistent with model/kind/phase).
  if (agent.lastToolCall && typeof agent.lastToolCall === 'object') {
    entry.lastToolCall = agent.lastToolCall as ModelEntry['lastToolCall'];
  }
  if (typeof agent.lastSeen === 'number') entry.lastSeen = agent.lastSeen;
  if (typeof agent.firstSeen === 'number') entry.firstSeen = agent.firstSeen;
  if (typeof agent.source === 'string') entry.source = agent.source;
  entry.subagents = Array.isArray(agent.subagents) ? agent.subagents : [];
  return entry;
}

/** Drop the session row when it no longer has any agent entries. */
function pruneEmptySession(model: StatusModel, sessionId: string): void {
  const keys = Object.keys(model.byKey);
  for (let i = 0; i < keys.length; i++) {
    if (model.byKey[keys[i]].sessionId === sessionId) return;
  }
  delete model.sessions[sessionId];
  delete model.roots[sessionId];
  removeFromArray(model.sessionOrder, sessionId);
}

/**
 * Upsert one agent (snapshot entry or incremental frame). Returns a minimal
 * change record; the model itself is the authority the page re-renders from.
 */
export function upsertAgent(model: StatusModel, agent: RawAgent): { key: string; sessionId: string; created: boolean } {
  const sessionId = agent?.sessionId;
  const agentId = agent?.agentId;
  if (typeof sessionId !== 'string' || typeof agentId !== 'string') {
    return { key: '', sessionId: '', created: false };
  }
  const key = agentKey(sessionId, agentId);
  const existing = model.byKey[key];
  ensureSession(model, sessionId, agent);

  // Orphan promotion: a real entry supersedes an orphan copy placed earlier.
  if (existing && existing.orphan) {
    const orphanParentKey = model.orphans[key];
    if (orphanParentKey !== undefined) {
      delete model.orphans[key];
      const parent = model.byKey[orphanParentKey];
      if (parent) removeFromArray(parent.children, key);
    }
    delete model.byKey[key];
  }

  const entry = normalizeEntry(model, agent, existing && !existing.orphan ? existing : undefined);
  model.byKey[key] = entry;
  resolveAndAttach(model, entry);
  fillOrphans(model, entry);
  // A parent frame may adopt children that were pending roots.
  drainPending(model, key);
  return { key, sessionId, created: !existing || existing.orphan };
}

/**
 * gone(P): delete P's row plus only its orphan leaves; independent live
 * children survive and re-root to the session top as pending roots under P's
 * key (a later out-of-order parent frame re-attaches them).
 */
export function removeAgent(model: StatusModel, sessionId: string, agentId: string): { removed: string[] } {
  const key = agentKey(sessionId, agentId);
  const entry = model.byKey[key];
  if (!entry) return { removed: [] };

  if (entry.orphan) {
    delete model.byKey[key];
    delete model.orphans[key];
    if (entry.parentKey) {
      const parent = model.byKey[entry.parentKey];
      if (parent) removeFromArray(parent.children, key);
    }
    if (entry.pendingParent) {
      const pend = model.pending[entry.pendingParent];
      if (pend) removeFromArray(pend, key);
    }
    return { removed: [key] };
  }

  const children = entry.children.slice();
  const removed: string[] = [];
  // Orphan leaves die with the parent; independent children are kept.
  for (let i = 0; i < children.length; i++) {
    const ck = children[i];
    const child = model.byKey[ck];
    if (child && child.orphan) {
      delete model.byKey[ck];
      delete model.orphans[ck];
      removed.push(ck);
    }
  }
  removed.push(key);
  delete model.byKey[key];
  detachEntry(model, entry);

  // Re-root surviving independent children as pending roots under the dead key.
  for (let i = 0; i < children.length; i++) {
    const ck = children[i];
    const child = model.byKey[ck];
    if (!child || child.orphan) continue;
    if (child.pendingParent && child.pendingParent !== key) {
      const oldPend = model.pending[child.pendingParent];
      if (oldPend) removeFromArray(oldPend, ck);
    }
    child.parentKey = null;
    child.pendingParent = key;
    pushRoot(model, child);
    registerPending(model, key, ck);
  }
  pruneEmptySession(model, sessionId);
  return { removed };
}

/**
 * session-gone: drop the group entirely when it has no live agents; otherwise
 * mark the group `gone` (ended) while in-frame agent rows are retained — the
 * next agent frame for the session revives the group (re-hang).
 */
export function removeSession(model: StatusModel, sessionId: string): { removed: boolean; kept: string[] } {
  const row = model.sessions[sessionId];
  if (!row) return { removed: false, kept: [] };
  const keys = Object.keys(model.byKey);
  const live: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    if (model.byKey[keys[i]].sessionId === sessionId) live.push(keys[i]);
  }
  if (live.length === 0) {
    delete model.sessions[sessionId];
    delete model.roots[sessionId];
    removeFromArray(model.sessionOrder, sessionId);
    return { removed: true, kept: [] };
  }
  row.gone = true;
  return { removed: false, kept: live };
}

/** Reset and rebuild the whole model from a /status snapshot. */
export function applySnapshot(model: StatusModel, snapshot: RawSnapshot): StatusModel {
  model.byKey = {};
  model.roots = {};
  model.sessions = {};
  model.sessionOrder = [];
  model.pending = {};
  model.orphans = {};
  model.seq = 0;
  const sessions = Array.isArray(snapshot?.sessions) ? (snapshot.sessions as RawSession[]) : [];
  const agents = Array.isArray(snapshot?.agents) ? (snapshot.agents as RawAgent[]) : [];
  for (let i = 0; i < sessions.length; i++) upsertSession(model, sessions[i]);
  for (let i = 0; i < agents.length; i++) upsertAgent(model, agents[i]);
  return model;
}

/** { agents, sessions } counts over entries actually in the model. */
export function modelCounts(model: StatusModel): { agents: number; sessions: number } {
  const keys = Object.keys(model.byKey);
  const seen: Record<string, boolean> = {};
  let sessions = 0;
  for (let i = 0; i < keys.length; i++) {
    const s = model.byKey[keys[i]].sessionId;
    if (!seen[s]) {
      seen[s] = true;
      sessions++;
    }
  }
  return { agents: keys.length, sessions };
}

function statusOf(st: string): StatusDerivation {
  switch (st) {
    case 'busy':
      return { key: 'busy', tone: 'busy' };
    case 'running':
    case 'started':
      return { key: 'running', tone: 'busy' };
    case 'completed':
      return { key: 'completed', tone: 'done' };
    case 'killed':
      return { key: 'killed', tone: 'err' };
    case 'failed':
      return { key: 'failed', tone: 'err' };
    case 'suspended':
      return { key: 'suspended', tone: 'warn' };
    case 'idle':
      return { key: 'idle', tone: 'idle' };
    default:
      return { key: 'unknown', tone: 'idle' };
  }
}

function phaseOf(phase: string, busy: boolean): StatusDerivation {
  switch (phase) {
    case 'idle':
      return { key: 'idle', tone: 'idle' };
    case 'done':
    case 'complete':
    case 'completed':
      return { key: 'completed', tone: 'done' };
    case 'failed':
      return { key: 'failed', tone: 'err' };
    case 'suspended':
    case 'blocked':
    case 'waiting':
    case 'cancelled':
      return { key: 'suspended', tone: 'warn' };
    case 'thinking':
    case 'working':
    case 'tool':
    case 'writing':
    case 'reading':
      return { key: 'busy', tone: 'busy' };
    default:
      // Unknown engine phase: surface the raw text, tone follows busy-ness.
      return { key: busy ? 'busy' : 'idle', tone: busy ? 'busy' : 'idle', label: phase };
  }
}

/** Status column derivation (E8: stale wins over busy). */
export function deriveStatus(entry: ModelEntry | undefined | null): StatusDerivation {
  if (!entry) return { key: 'unknown', tone: 'idle' };
  if (entry.stale === true) return { key: 'stale', tone: 'stale' };
  if (entry.orphan) {
    const st = entry.subStatus || 'unknown';
    if (st === 'spawned') return { key: 'running', tone: 'busy' };
    return statusOf(st);
  }
  if (typeof entry.phase === 'string' && entry.phase) return phaseOf(entry.phase, entry.busy === true);
  if (entry.busy === true) return { key: 'busy', tone: 'busy' };
  // Main agents have no completed enum; derive terminal display from reasons.
  const reason = entry.lastTurnReason || entry.lastFinishReason;
  if (typeof reason === 'string' && reason) {
    if (reason === 'completed' || reason === 'end_turn' || reason === 'done') return { key: 'completed', tone: 'done' };
    if (reason === 'failed' || reason === 'error') return { key: 'failed', tone: 'err' };
    if (reason === 'cancelled' || reason === 'blocked') return { key: 'suspended', tone: 'warn' };
  }
  return { key: 'idle', tone: 'idle' };
}

const MODEL_FUNCTIONS: Array<(...args: any[]) => any> = [
  agentKey,
  newModel,
  upsertSession,
  upsertAgent,
  removeAgent,
  removeSession,
  applySnapshot,
  modelCounts,
  deriveStatus,
  removeFromArray,
  ensureSession,
  pushRoot,
  registerPending,
  wouldCycle,
  detachEntry,
  resolveAndAttach,
  fillOrphans,
  drainPending,
  normalizeEntry,
  pruneEmptySession,
  statusOf,
  phaseOf,
];

/**
 * The serialized model source (D2): identical code the browser page inlines
 * and the drift-protection test executes in a bare vm.
 */
export const STATUS_MODEL_JS = `(function () {
'use strict';
${MODEL_FUNCTIONS.map((fn) => fn.toString()).join('\n')}
window.__moaStatusModel = {
  agentKey: agentKey,
  newModel: newModel,
  upsertSession: upsertSession,
  upsertAgent: upsertAgent,
  removeAgent: removeAgent,
  removeSession: removeSession,
  applySnapshot: applySnapshot,
  modelCounts: modelCounts,
  deriveStatus: deriveStatus
};
})();`;
