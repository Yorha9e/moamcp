/**
 * status-model.ts — single source of truth for the Status Board tree model
 * (design decision D2/D3). Pure TS: zero imports, no module-level closures,
 * every function self-contained so `Function.prototype.toString()` output
 * runs unmodified in a bare vm. The page embeds STATUS_MODEL_JS (the same
 * serialized source) so the browser and vitest execute the identical logic.
 *
 * F1 (0.9.0 review): STATUS_MODEL_JS is a *parameterized* IIFE — every
 * serialized function source is passed positionally as a string argument,
 * rewritten to reference the fixed source-level parameter names, and re-created
 * inside the IIFE with sloppy direct `eval` (function expressions passed as
 * arguments would close over the caller's scope and could not see the
 * parameters). esbuild's production bundle renames status-model's exported
 * `agentKey` to `agentKey2` (src/modules/status/state.ts exports the same
 * name), and a plain IIFE's static `agentKey: agentKey` text then references
 * an undefined identifier (whole page dies). Positional binding makes the
 * inlined model immune to such renames.
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
  workDir?: unknown;
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
  workDirHash?: unknown;
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
  workDir?: string;
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
  workDirHash?: string;
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
  /**
   * F1 (0.10.0 review): per-session resolved directory cache. Pure derived
   * data — sessionDirKey's result (dirKey) plus the first agent-workDir label
   * fallback that dirLabel used to discover by a full byKey scan. Invalidated
   * on every write path that can change either value (upsertSession /
   * upsertAgent / removeAgent / removeSession / pruneEmptySession /
   * applySnapshot), so reads are O(1) and the cache never goes stale.
   */
  dirCache: Record<string, { dirKey: string; agentWorkDir?: string }>;
  seq: number;
}

export interface StatusDerivation {
  key: string;
  tone: 'busy' | 'done' | 'err' | 'warn' | 'stale' | 'idle';
  /** Raw display text when the key alone is not translatable (unknown phase). */
  label?: string;
}

/** Wire shape of a debate participant declaration (agent_specs entry). */
export interface DebateSpecLike {
  id: string;
  tag?: string;
}

/**
 * Map debate participant declarations (agent_specs) to live sub-agent keys.
 * Type-only on the TS side — never serialized (the page passes plain arrays).
 *
 * Each spec collects every distinct hit; rule 1 is kind-agnostic, rules 2-4
 * only match kind 'sub' entries:
 *  1. exact agentId equality;
 *  2. a subagent whose declared type name equals the spec id;
 *  3. a subagent whose declared type name equals the spec tag;
 *  4. a sub entry whose model equals the spec tag (only when the tag looks
 *     like a model id, i.e. contains '/').
 *
 * Subagent type names come from every entry's subagents[] list (elements
 * carry subagentId/name/status), indexed by the subagent's own key; orphan
 * leaves synthesized from those lists carry kind 'sub', so they are matched
 * through the same path as independent sub entries. Self-contained (the
 * serialization wrapper requires it): no imports, no module-level state, and
 * the only model helper it calls is the key joiner.
 */
export function matchDebateSpecs(model: StatusModel, specs: DebateSpecLike[]): Record<string, string[]> {
  const out: Record<string, string[]> = Object.create(null);
  if (!model || !Array.isArray(specs)) return out;
  const byId: Record<string, string[]> = Object.create(null);
  const nameOf: Record<string, string> = Object.create(null);
  const byModel: Record<string, string[]> = Object.create(null);
  const keys = Object.keys(model.byKey);
  for (let i = 0; i < keys.length; i++) {
    const e = model.byKey[keys[i]];
    if (typeof e.agentId === 'string' && e.agentId) {
      const list = byId[e.agentId] || (byId[e.agentId] = []);
      list.push(e.key);
    }
    const subs = e.subagents;
    if (Array.isArray(subs)) {
      for (let j = 0; j < subs.length; j++) {
        const sub = subs[j] as Record<string, unknown>;
        if (!sub || typeof sub !== 'object') continue;
        const subId = typeof sub.subagentId === 'string' ? sub.subagentId : undefined;
        const subName = typeof sub.name === 'string' ? sub.name : undefined;
        if (!subId || !subName) continue;
        const skey = agentKey(e.sessionId, subId);
        if (nameOf[skey] === undefined) nameOf[skey] = subName;
      }
    }
    if (e.kind === 'sub' && typeof e.model === 'string' && e.model) {
      const list = byModel[e.model] || (byModel[e.model] = []);
      list.push(e.key);
    }
  }
  // F4 (second pass): an orphan leaf carries its own subName when the parent
  // no longer declares it in subagents[] (the leaf persists after the list
  // drops the id). Parent-declared names win — the first pass registered them,
  // and this backfill never overrides an existing value.
  for (let i = 0; i < keys.length; i++) {
    const e = model.byKey[keys[i]];
    if (e.orphan === true && nameOf[e.key] === undefined && typeof e.subName === 'string' && e.subName) {
      nameOf[e.key] = e.subName;
    }
  }
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    if (!spec || typeof spec.id !== 'string' || !spec.id) continue;
    const hits: string[] = [];
    const seen: Record<string, boolean> = Object.create(null);
    const addHit = (k: string): void => {
      if (seen[k]) return;
      seen[k] = true;
      hits.push(k);
    };
    const ids = byId[spec.id];
    if (ids) {
      for (let j = 0; j < ids.length; j++) addHit(ids[j]);
    }
    const tag = typeof spec.tag === 'string' && spec.tag ? spec.tag : undefined;
    const nk = Object.keys(nameOf);
    for (let j = 0; j < nk.length; j++) {
      if (nameOf[nk[j]] === spec.id) {
        const e = model.byKey[nk[j]];
        if (e && e.kind === 'sub') addHit(nk[j]);
      }
      if (tag && nameOf[nk[j]] === tag) {
        const e = model.byKey[nk[j]];
        if (e && e.kind === 'sub') addHit(nk[j]);
      }
    }
    if (tag && tag.indexOf('/') !== -1) {
      const mk = byModel[tag];
      if (mk) {
        for (let j = 0; j < mk.length; j++) addHit(mk[j]);
      }
    }
    out[spec.id] = hits;
  }
  return out;
}

export function agentKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

/**
 * Fresh empty model. F3 (0.10.0 review): every sessionId/dirKey-keyed map is
 * null-prototype so a sessionId/workDirHash of exactly '__proto__' /
 * 'constructor' cannot pollute the prototype chain (a plain-object __proto__
 * store would re-point the map's prototype and crash pushRoot/groups).
 */
export function newModel(): StatusModel {
  return {
    byKey: {},
    roots: Object.create(null),
    sessions: Object.create(null),
    sessionOrder: [],
    pending: Object.create(null),
    orphans: Object.create(null),
    dirCache: Object.create(null),
    seq: 0,
  };
}

/** F1: drop a session's resolved directory cache entry (recomputed lazily). */
function invalidateDirCache(model: StatusModel, sessionId: string): void {
  delete model.dirCache[sessionId];
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
    // Session metadata follows the title/workDir/home copy pattern. workDir and
    // workDirHash are taken from the SESSION record only: an agent frame
    // (info.agentId present) carries them merely as per-agent display data, and
    // sessionDirKey/listDirectories read agent fields as their own fallback
    // levels ('hash:' prefix / label chain) — letting an agent frame write the
    // row would shadow those fallbacks (the session record is the row's writer).
    const isAgentInfo = typeof (info as RawAgent).agentId === 'string';
    if (typeof info.title === 'string') row.title = info.title;
    if (!isAgentInfo && typeof info.workDir === 'string') row.workDir = info.workDir;
    if (!isAgentInfo && typeof info.workDirHash === 'string') row.workDirHash = info.workDirHash;
    if (typeof info.home === 'string') row.home = info.home;
  }
  return row;
}

export function upsertSession(model: StatusModel, session: RawSession): void {
  if (!session || typeof session.sessionId !== 'string') return;
  const row = ensureSession(model, session.sessionId, session);
  if (typeof session.createdAt === 'string') row.createdAt = session.createdAt;
  if (typeof session.updatedAt === 'string') row.updatedAt = session.updatedAt;
  // The session row's workDir/workDirHash may have changed -> dir cache stale.
  invalidateDirCache(model, session.sessionId);
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
  if (typeof agent.workDir === 'string') entry.workDir = agent.workDir;
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
  delete model.dirCache[sessionId];
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
  // A new/changed agent can supply the workDirHash/workDir fallbacks that
  // sessionDirKey/dirLabel read -> the session's dir cache is stale.
  invalidateDirCache(model, sessionId);

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
  // The removed agent may have been the session's workDirHash/workDir fallback.
  invalidateDirCache(model, sessionId);

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
  // The session row itself may be deleted below (dir cache stale either way).
  invalidateDirCache(model, sessionId);
  const keys = Object.keys(model.byKey);
  const live: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    if (model.byKey[keys[i]].sessionId === sessionId) live.push(keys[i]);
  }
  if (live.length === 0) {
    delete model.sessions[sessionId];
    delete model.roots[sessionId];
    delete model.dirCache[sessionId];
    removeFromArray(model.sessionOrder, sessionId);
    return { removed: true, kept: [] };
  }
  row.gone = true;
  return { removed: false, kept: live };
}

/** Reset and rebuild the whole model from a /status snapshot. */
export function applySnapshot(model: StatusModel, snapshot: RawSnapshot): StatusModel {
  model.byKey = {};
  model.roots = Object.create(null);
  model.sessions = Object.create(null);
  model.sessionOrder = [];
  model.pending = Object.create(null);
  model.orphans = Object.create(null);
  model.dirCache = Object.create(null);
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
  // F3: null-proto — a sessionId of exactly '__proto__' must count as a session.
  const seen: Record<string, boolean> = Object.create(null);
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

/**
 * 活跃判定：busy && !stale，页顶活跃分区的成员资格。
 * 已知边界：
 * ① orphan 叶 busy 恒 false，即使 subStatus=running 也不进活跃分区（与 deriveStatus 的显示语义有意区分）；
 * ② stale 只随 snapshot/agent 帧更新（后端 sweep 不推 stale 翻转帧），连接期内静音 busy agent
 *    会留在活跃区直到下次快照/gone。
 */
export function isActiveAgent(entry: ModelEntry | null | undefined): boolean {
  return !!entry && entry.busy === true && entry.stale !== true;
}

/**
 * 目录 key 四级兜底链：SessionRow.workDir → SessionRow.workDirHash →
 * 该 session 下任一 agent 的 workDirHash（加 'hash:' 前缀）→ '__unknown__'。
 *
 * F1 (0.10.0 review): the resolved result is cached on the model (dirCache),
 * keyed by sessionId, and invalidated on every write path that can change it
 * (upsertSession/upsertAgent/removeAgent/removeSession/pruneEmptySession/
 * applySnapshot). Reads are O(1) after the first computation — the old
 * implementation re-scanned all of byKey for every session lacking row-level
 * directory info (313/323 real sessions, ~550K iterations per listDirectories).
 * The cache also records the first agent-workDir label fallback (dirLabel's old
 * byKey scan) so listDirectories never walks byKey either.
 */
export function sessionDirKey(model: StatusModel, sessionId: string): string {
  const cached = model.dirCache[sessionId];
  if (cached) return cached.dirKey;
  const row = model.sessions[sessionId];
  if (row && typeof row.workDir === 'string' && row.workDir) {
    // Level 1: the row workDir is both the key and the label (dirLabel reads
    // the row directly), so no fallback scan is needed.
    model.dirCache[sessionId] = { dirKey: row.workDir };
    return row.workDir;
  }
  let dirKey: string | undefined;
  if (row && typeof row.workDirHash === 'string' && row.workDirHash) {
    dirKey = row.workDirHash; // Level 2
  }
  // Level 3 fallback + the label's agent-workDir fallback: one scan, only when
  // the row does not already answer the key (and only until the first hit).
  let agentWorkDir: string | undefined;
  const keys = Object.keys(model.byKey);
  for (let i = 0; i < keys.length; i++) {
    const e = model.byKey[keys[i]];
    if (e.sessionId !== sessionId) continue;
    if (!agentWorkDir && typeof e.workDir === 'string' && e.workDir) agentWorkDir = e.workDir;
    if (!dirKey && typeof e.workDirHash === 'string' && e.workDirHash) dirKey = 'hash:' + e.workDirHash;
  }
  if (!dirKey) dirKey = '__unknown__'; // Level 4
  model.dirCache[sessionId] = { dirKey, agentWorkDir };
  return dirKey;
}

/**
 * 单 session 分区：按 model.roots[sessionId] DFS（visited 防环，与页面 resortSession 的遍历序
 * 一致），活跃/不活跃各自保持 DFS 序返回 key 数组。
 *
 * M1 (active-ancestor inheritance)：活跃判定不再只看自身 isActiveAgent —— 一个 agent
 * 阻塞在长前台 subagent 调用里时（编排者等 worker 返回），其自身 wire 停更会被判为
 * 不活跃并折进不活跃区、整棵子树消失（两次假断行）。现在：先 DFS 收集全部 key 序并
 * 标记活跃种子（busy && !stale），再对每个种子沿 parentKey 链把祖先标记为有效活跃
 * （effActive，visited/已标记即停 防环，复用 activeAgentKeysWithAncestors 的链走模式，
 * 单遍、无递归重算），最后按 seed||effActive 分区。返回值多带一个 effActive ——
 * 种子 + 祖先闭包（即活跃侧成员资格），页面渲染器的同侧子树/侧根判定直接消费它，
 * 避免与 isActiveAgent 的原始语义分叉（否则活跃区会重复/错嵌行）。
 */
export function partitionSession(
  model: StatusModel,
  sessionId: string,
): { active: string[]; inactive: string[]; effActive: Record<string, boolean> } {
  const active: string[] = [];
  const inactive: string[] = [];
  const effActive: Record<string, boolean> = {};
  const visited: Record<string, boolean> = {};
  const order: string[] = [];
  const stack: string[] = [];
  const rs = model.roots[sessionId] || [];
  for (let i = rs.length - 1; i >= 0; i--) stack.push(rs[i]);
  // Pass 1: DFS 收集全部 key（保持遍历序）+ 标记活跃种子。
  while (stack.length) {
    const key = stack.pop();
    if (key === undefined) continue;
    if (visited[key]) continue;
    visited[key] = true;
    const e = model.byKey[key];
    if (!e) continue;
    order.push(key);
    if (isActiveAgent(e)) effActive[key] = true;
    const children = e.children;
    for (let j = children.length - 1; j >= 0; j--) {
      if (!visited[children[j]]) stack.push(children[j]);
    }
  }
  // Pass 2: 每个种子的 parentKey 祖先链标记为有效活跃（单遍；已标记即停 ——
  // 任何节点被标记时其整条祖先链已随同一次链走上溯完毕，故可安全短路）。
  for (let i = 0; i < order.length; i++) {
    if (!effActive[order[i]]) continue;
    let cur: string | null = model.byKey[order[i]].parentKey || null;
    while (cur && !effActive[cur]) {
      effActive[cur] = true;
      const e = model.byKey[cur];
      if (!e) break; // 断链：缺失的父项不渲染，停
      cur = e.parentKey || null;
    }
  }
  // Pass 3: 按 effActive（种子或有效活跃祖先）分区，保持 DFS 序。
  for (let i = 0; i < order.length; i++) {
    if (effActive[order[i]]) active.push(order[i]);
    else inactive.push(order[i]);
  }
  return { active, inactive, effActive };
}

/** 一个目录分组的渲染数据（页顶活跃分区 + 目录树共用的分组源）。 */
export interface DirGroup {
  dirKey: string;
  label: string;
  sessionIds: string[];
  activeAgents: number;
  hiddenSessions: number;
  hasActive: boolean;
}

/**
 * 目录分组：sessionIds 按 model.sessionOrder 序；label 链 = SessionRow.workDir →
 * 该 session 任一 agent 的 workDir → dirKey('hash:xxx' 取 hash 前 8 位) → '__unknown__' 原样；
 * hiddenSessions = 该目录内 partition.active.length===0 的 session 数；
 * activeAgents = 该目录所有 session 的 active 总数；
 * 排序：hasActive 降序 → activeAgents 降序 → dirKey 升序（稳定 tie-break，防跨 flush 抖动）。
 * F1: sessionDirKey/dirLabel both read the model dir cache (see sessionDirKey),
 * so this never scans byKey; the groups map is null-proto (F3, dirKey can be
 * exactly '__proto__').
 */
export function listDirectories(model: StatusModel): DirGroup[] {
  function dirLabel(model: StatusModel, dirKey: string, sessionId: string): string {
    const row = model.sessions[sessionId];
    if (row && typeof row.workDir === 'string' && row.workDir) return row.workDir;
    // Agent-workDir fallback: cached by sessionDirKey (first agent with a
    // workDir, byKey insertion order — identical to the old O(n) scan).
    const cached = model.dirCache[sessionId];
    if (cached && typeof cached.agentWorkDir === 'string' && cached.agentWorkDir) return cached.agentWorkDir;
    if (dirKey.indexOf('hash:') === 0 && dirKey.length > 5) return dirKey.slice(5, 13);
    // Bare hash (SessionRow.workDirHash — the dir-key chain's level 2): label it
    // like the 'hash:'-prefixed form, first 8 chars (plan: hash 兜底 label 统一前 8 位).
    if (row && typeof row.workDirHash === 'string' && row.workDirHash === dirKey && dirKey.length > 8) {
      return dirKey.slice(0, 8);
    }
    return dirKey;
  }
  const groups: Record<string, DirGroup> = Object.create(null);
  const order: string[] = [];
  for (let i = 0; i < model.sessionOrder.length; i++) {
    const sid = model.sessionOrder[i];
    const key = sessionDirKey(model, sid);
    let g = groups[key];
    if (!g) {
      g = {
        dirKey: key,
        label: dirLabel(model, key, sid),
        sessionIds: [],
        activeAgents: 0,
        hiddenSessions: 0,
        hasActive: false,
      };
      groups[key] = g;
      order.push(key);
    }
    g.sessionIds.push(sid);
    const part = partitionSession(model, sid);
    if (part.active.length > 0) {
      g.activeAgents += part.active.length;
      g.hasActive = true;
    } else {
      g.hiddenSessions += 1;
    }
  }
  order.sort(function (a: string, b: string) {
    const ga = groups[a];
    const gb = groups[b];
    if (ga.hasActive !== gb.hasActive) return ga.hasActive ? -1 : 1;
    if (ga.activeAgents !== gb.activeAgents) return gb.activeAgents - ga.activeAgents;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  const out: DirGroup[] = [];
  for (let i = 0; i < order.length; i++) out.push(groups[order[i]]);
  return out;
}

/**
 * 页顶活跃分区的 key 序：listDirectories 序 → 目录内 sessionIds 序 → partition.active DFS 序
 * （稳定序，明确不用"最新置顶"）。
 */
export function activeAgentKeys(model: StatusModel): string[] {
  const out: string[] = [];
  const dirs = listDirectories(model);
  for (let i = 0; i < dirs.length; i++) {
    const ids = dirs[i].sessionIds;
    for (let j = 0; j < ids.length; j++) {
      const part = partitionSession(model, ids[j]);
      for (let k = 0; k < part.active.length; k++) out.push(part.active[k]);
    }
  }
  return out;
}

/**
 * 活跃分区 + 祖先链闭包（B1，0.11.0；M1 更新）：M1 之后 partitionSession 的 active
 * 已经包含"活跃种子 + 全部祖先"闭包（effActive），activeAgentKeys 亦然，所以这里
 * 不再需要额外前插祖先链 —— 链走仍保留作为断链/防环的安全网（已 seen 即跳过），
 * 输出序 = activeAgentKeys 序（DFS 序保证祖先先于后代，稳定序跨 flush 不抖动）。
 * rollupActive 标记与 isActiveAgent 严格区分：成员自身 busy && !stale 为种子
 * （rollupActive=false），仅因后代活跃而被带出的祖先为 rollupActive=true ——
 * 页顶活跃分区据此显示"经子 agent 带出"徽标（B2，M1 后祖先也是活跃分区成员，
 * 徽标语义不变）。
 */
export function activeAgentKeysWithAncestors(
  model: StatusModel,
): Array<{ key: string; rollupActive: boolean }> {
  const seeds = activeAgentKeys(model);
  const out: Array<{ key: string; rollupActive: boolean }> = [];
  const seen: Record<string, boolean> = {};
  for (let i = 0; i < seeds.length; i++) {
    const leaf = seeds[i];
    const ancestors: string[] = [];
    const visited: Record<string, boolean> = {};
    let cur: string | null = model.byKey[leaf] ? model.byKey[leaf].parentKey || null : null;
    while (cur && !visited[cur]) {
      visited[cur] = true;
      const e = model.byKey[cur];
      if (!e) break; // broken chain: stop here (the missing parent is not rendered)
      ancestors.push(cur);
      cur = e.parentKey || null;
    }
    // 祖先链反向序（根→叶）→ 叶子；已在前面输出的 key 不重复。徽标跟随
    // isActiveAgent（M1：一条链在注入环等病态下可能经此路径先于其种子身份被输出）。
    for (let j = ancestors.length - 1; j >= 0; j--) {
      const ak = ancestors[j];
      if (seen[ak]) continue;
      seen[ak] = true;
      out.push({ key: ak, rollupActive: !isActiveAgent(model.byKey[ak]) });
    }
    if (!seen[leaf]) {
      seen[leaf] = true;
      // M1: activeAgentKeys 成员可能是被带出的祖先 —— 徽标跟随 isActiveAgent。
      out.push({ key: leaf, rollupActive: !isActiveAgent(model.byKey[leaf]) });
    }
  }
  return out;
}

/**
 * 子树 DFS key 列表（C1，0.11.0）：visited 防环，从 rootKey 出发沿 children 前序
 * 遍历（含 rootKey 自身）。页面用它枚举子树成员以做懒建/拆除（折叠=清容器+从 rowEls
 * 删子树 key 防幽灵，展开=懒建）。不得用于 session 计数（updateSessionEl 的计数是
 * partition 数组长度 O(1)，本批不做计数缓存）。
 */
export function subtreeKeys(model: StatusModel, rootKey: string): string[] {
  const out: string[] = [];
  const visited: Record<string, boolean> = {};
  const stack: string[] = [rootKey];
  while (stack.length) {
    const key = stack.pop();
    if (key === undefined || visited[key]) continue;
    visited[key] = true;
    out.push(key);
    const e = model.byKey[key];
    if (!e) continue;
    const children = e.children;
    for (let j = children.length - 1; j >= 0; j--) {
      if (!visited[children[j]]) stack.push(children[j]);
    }
  }
  return out;
}

/** (source-level name, function) pairs serialized into the page (F1). The IIFE
 *  binds each serialized source positionally to its fixed name below, so
 *  esbuild's cross-module renames (agentKey -> agentKey2 in the production
 *  bundle) cannot break the inlined model. */
const MODEL_FUNCTIONS: Array<[string, (...args: any[]) => any]> = [
  ['agentKey', agentKey],
  ['newModel', newModel],
  ['upsertSession', upsertSession],
  ['upsertAgent', upsertAgent],
  ['removeAgent', removeAgent],
  ['removeSession', removeSession],
  ['applySnapshot', applySnapshot],
  ['modelCounts', modelCounts],
  ['deriveStatus', deriveStatus],
  ['removeFromArray', removeFromArray],
  ['ensureSession', ensureSession],
  ['invalidateDirCache', invalidateDirCache],
  ['pushRoot', pushRoot],
  ['registerPending', registerPending],
  ['wouldCycle', wouldCycle],
  ['detachEntry', detachEntry],
  ['resolveAndAttach', resolveAndAttach],
  ['fillOrphans', fillOrphans],
  ['drainPending', drainPending],
  ['normalizeEntry', normalizeEntry],
  ['pruneEmptySession', pruneEmptySession],
  ['statusOf', statusOf],
  ['phaseOf', phaseOf],
  ['isActiveAgent', isActiveAgent],
  ['sessionDirKey', sessionDirKey],
  ['partitionSession', partitionSession],
  ['listDirectories', listDirectories],
  ['activeAgentKeys', activeAgentKeys],
  ['activeAgentKeysWithAncestors', activeAgentKeysWithAncestors],
  ['subtreeKeys', subtreeKeys],
  ['matchDebateSpecs', matchDebateSpecs],
];

/** Public API surface the page consumes (subset of MODEL_FUNCTIONS). */
export const MODEL_API_EXPORTS = [
  'agentKey',
  'newModel',
  'upsertSession',
  'upsertAgent',
  'removeAgent',
  'removeSession',
  'applySnapshot',
  'modelCounts',
  'deriveStatus',
  'isActiveAgent',
  'sessionDirKey',
  'partitionSession',
  'listDirectories',
  'activeAgentKeys',
  'activeAgentKeysWithAncestors',
  'subtreeKeys',
  'matchDebateSpecs',
];

/** The name the function actually carries in this build (its `toString()`
 *  source name — identical to the source-level name when esbuild did not
 *  rename it, e.g. `agentKey2` in the production bundle). */
function serializedName(fn: (...args: any[]) => any): string {
  const m = /^function\s+([$\w]+)/.exec(fn.toString());
  return m ? m[1] : '';
}

/**
 * Serialize one model function for the page IIFE, rewriting the declaration
 * name and every cross-reference to other model functions to the FIXED
 * source-level names. `Function.prototype.toString()` reflects esbuild's
 * renames (the production bundle renames status-model's `agentKey` to
 * `agentKey2` because src/modules/status/state.ts exports the same name), so
 * the rewritten source always binds to the fixed parameter names regardless of
 * what the bundler chose. The model sources contain no string literals or
 * comments that embed another model function's identifier, so the identifier
 * substitution is exact for this codebase.
 */
function serializedModelFunction(pair: [string, (...args: any[]) => any]): string {
  const [fixed, fn] = pair;
  let src = fn.toString();
  const cur = serializedName(fn);
  if (cur && cur !== fixed) {
    src = src.replace(/^function\s+[$\w]+/, 'function ' + fixed);
  }
  for (const [otherFixed, otherFn] of MODEL_FUNCTIONS) {
    if (otherFn === fn) continue;
    const otherCur = serializedName(otherFn);
    if (otherCur && otherCur !== otherFixed) {
      src = src.split(otherCur).join(otherFixed);
    }
  }
  return src;
}

/**
 * The serialized model source (D2 + F1): a *parameterized* IIFE. Each function
 * source is passed positionally as a string argument (rewritten to reference
 * the fixed parameter names) and re-created inside the IIFE via sloppy-mode
 * direct `eval`, so the declarations land in the IIFE's own scope and their
 * inter-calls resolve through the fixed names. A naive `(…)(fn.toString()…)`
 * call would NOT work — a function expression passed as an argument closes
 * over the caller's scope, where the parameter names do not exist (verified
 * against the production bundle: `ReferenceError: agentKey is not defined`).
 * The IIFE must stay sloppy for the eval'd declarations to leak into its
 * scope; the model code does not depend on strict-mode semantics.
 */
/**
 * JSON-stringify one serialized model source for embedding in the page's
 * `<script>` block (F1 review, attack surface d). `JSON.stringify` does not
 * escape `<`, so a model source containing `</script>` or `<!--` would let the
 * HTML parser close the script early or enter the escaped-data state. Escaping
 * `<` as `\u003C` keeps the raw markup inert while evaluating to the identical
 * string at runtime (`\u003C` is `<`). Model sources today only contain bare
 * `<` (for-loop conditions), which a classic script tolerates — the escaping
 * is a hardening so future sources cannot smuggle `</script>` or `<!--` in.
 */
function jsonStringForHtml(src: string): string {
  return JSON.stringify(src).replace(/</g, '\\u003C');
}

export const STATUS_MODEL_JS = `(function (${MODEL_FUNCTIONS.map((f) => f[0]).join(', ')}) {
var __srcs = [${MODEL_FUNCTIONS.map((f) => f[0]).join(', ')}];
for (var __i = 0; __i < __srcs.length; __i++) eval(__srcs[__i]);
window.__moaStatusModel = {
${MODEL_API_EXPORTS.map((n) => `  ${n}: ${n},`).join('\n')}
};
})(${MODEL_FUNCTIONS.map((f) => jsonStringForHtml(serializedModelFunction(f))).join(',\n')});`;
