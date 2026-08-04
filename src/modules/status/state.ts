import type { SessionState, TaskFile, WireRecord, WireRef } from './watcher.js';

/** Event frame pushed by the omkc embedded SSE source (source ②). */
export interface OmkcEvent {
  ts: number;
  sessionId: string;
  agentId: string;
  type: string;
  payload?: Record<string, unknown>;
}

export interface ToolCallInfo {
  name: string;
  ts: number;
  description?: string;
  /** Set by the following tool result. */
  isError?: boolean;
}

export interface SubagentEntry {
  subagentId: string;
  name?: string;
  description?: string;
  /** wire: unknown | task-file status (running/completed/failed/killed/...)
   *  omkc: spawned -> started -> completed | failed | suspended */
  status: string;
  ts: number;
  resultSummary?: string;
  usage?: unknown;
  contextTokens?: number;
  error?: string;
}

export interface AgentState {
  sessionId: string;
  /** Which CLI home this agent was observed in ('omkc' | 'kimi-code'). */
  home?: string;
  workDirHash?: string;
  agentId: string;
  parentAgentId?: string | null;
  /** 'main' | 'sub' from state.json; undefined until state.json is seen. */
  kind?: string;
  model?: string;
  contextTokens?: number;
  /** Latest usage.record payload (per-step token counters). */
  usage?: unknown;
  maxContextTokens?: number;
  planMode?: boolean;
  /** Engine-reported phase; only available via the omkc SSE source. */
  phase?: string;
  /** Inferred: busy after turn.prompt / step.begin, idle after a terminal
   *  step.end (finishReason != 'tool_use') or turn.cancel. */
  busy: boolean;
  lastFinishReason?: string;
  /** omkc turn.ended reason (completed/cancelled/failed/blocked). */
  lastTurnReason?: string;
  lastToolCall?: ToolCallInfo;
  subagents: SubagentEntry[];
  /** Last event time seen for this agent (record time or omkc ts). */
  lastSeen: number;
  firstSeen: number;
  /** Which source last wrote state fields: wire inference or omkc events. */
  source: 'wire' | 'omkc';
  /** ts of the last omkc event applied to this agent (0 = never). */
  omkcTs: number;
  /** Heuristic liveness: no events for >60s (wire mtime / state.json
   *  updatedAt based — a session dir has no pid to probe). Entry kept. */
  stale: boolean;
}

export interface SessionInfo {
  workDirHash: string;
  sessionId: string;
  /** Which CLI home this session lives in ('omkc' | 'kimi-code'). */
  home?: string;
  title?: string;
  workDir?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Wire inference must not overwrite fields the omkc SSE source owns while
 *  omkc events for that agent are fresh. */
const OMKC_PRIORITY_MS = 30_000;
/** No events for this long -> agent marked stale (kept, not deleted). */
export const STALE_MS = 60_000;

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

/**
 * Deep-copy JSON-shaped payloads (usage counters can nest). Sharing the
 * reference through a snapshot would let callers mutate fold-internal state.
 */
function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Max of two ISO timestamps; parse as a tie-breaker for garbage strings. */
function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta)) return b;
  if (!Number.isFinite(tb)) return a;
  return ta >= tb ? a : b;
}

/**
 * Timestamp guard shared by every entry point that derives a time from
 * external data. NaN enters via Date.parse('not-a-date'); Infinity enters via
 * JSON.parse overflowing a number literal like 1e999. Either would propagate
 * through Math.max (lastSeen becomes NaN/Infinity -> never stale, and
 * JSON.stringify renders it as null). Guarded values fall back to Date.now().
 */
function finiteTime(value: number): number {
  return Number.isFinite(value) ? value : Date.now();
}

/**
 * In-memory fold of both sources into per-(sessionId, agentId) agent state.
 *
 * Source priority: omkc SSE events (source ②) are authoritative for the
 * fields they carry — while an agent has seen an omkc event within
 * OMKC_PRIORITY_MS, wire inference (source ①) only refreshes lastSeen and
 * subagent links, never overwrites model/usage/busy/phase. Once omkc goes
 * silent (disconnect), wire inference resumes ownership automatically.
 */
export class StateFold {
  private readonly agents = new Map<string, AgentState>();
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly omkcPriorityMs: number;
  private readonly staleMs: number;

  constructor(opts?: { omkcPriorityMs?: number; staleMs?: number }) {
    this.omkcPriorityMs = opts?.omkcPriorityMs ?? OMKC_PRIORITY_MS;
    this.staleMs = opts?.staleMs ?? STALE_MS;
  }

  /**
   * Agents are keyed by sessionId + agentId only — deliberately no home and
   * no workDirHash. 1b's OmkcEvent carries neither, so applyOmkcEvent's
   * ensure() cannot fill them; "completing the symmetry" (e.g. keying on home
   * too) would make omkc events unable to override their wire counterparts.
   * Do not change this key.
   */
  private static key(sessionId: string, agentId: string): string {
    return `${sessionId}:${agentId}`;
  }

  private ensure(
    sessionId: string,
    agentId: string,
    ts: number,
    workDirHash?: string,
    home?: string,
  ): AgentState {
    const key = StateFold.key(sessionId, agentId);
    let agent = this.agents.get(key);
    if (!agent) {
      agent = {
        sessionId,
        agentId,
        home,
        workDirHash,
        busy: false,
        subagents: [],
        lastSeen: ts,
        firstSeen: ts,
        source: 'wire',
        omkcTs: 0,
        stale: false,
      };
      this.agents.set(key, agent);
    }
    if (workDirHash && !agent.workDirHash) agent.workDirHash = workDirHash;
    if (home && !agent.home) agent.home = home;
    return agent;
  }

  /** True while omkc events for this agent are fresh enough to own its fields. */
  private omkcOwns(agent: AgentState, now: number): boolean {
    return agent.omkcTs > 0 && now - agent.omkcTs < this.omkcPriorityMs;
  }

  // ---------------------------------------------------------------- source ①

  /** Fold one wire.jsonl record (read-only inference). */
  applyWire(ref: WireRef, record: WireRecord | null): AgentState | null {
    if (!record || typeof record.type !== 'string') return null;
    const rawTs = typeof record.time === 'number' ? record.time : NaN;
    const ts = finiteTime(rawTs); // NaN/Infinity guard (see finiteTime)
    const agent = this.ensure(ref.sessionId, ref.agentId, ts, ref.workDirHash, ref.home);
    agent.lastSeen = Math.max(agent.lastSeen, ts);
    agent.stale = false;
    if (this.omkcOwns(agent, Date.now())) return agent; // omkc owns fields right now

    switch (record.type) {
      case 'metadata':
        break;
      case 'turn.prompt':
      case 'turn.steer':
        agent.busy = true;
        agent.source = 'wire';
        break;
      case 'turn.cancel':
        agent.busy = false;
        agent.lastFinishReason = 'cancelled';
        agent.source = 'wire';
        break;
      case 'config.update': {
        const alias = record.modelAlias;
        if (typeof alias === 'string') agent.model = alias;
        break;
      }
      case 'llm.request': {
        if (!agent.model) {
          const alias = record.modelAlias ?? record.model;
          if (typeof alias === 'string') agent.model = alias;
        }
        break;
      }
      case 'usage.record': {
        if (typeof record.model === 'string') agent.model = record.model;
        if (record.usage !== undefined) agent.usage = record.usage;
        agent.source = 'wire';
        break;
      }
      case 'context.update_token_count': {
        if (typeof record.tokenCount === 'number') agent.contextTokens = record.tokenCount;
        break;
      }
      case 'context.append_loop_event':
        this.applyLoopEvent(agent, asRecord(record.event), ts);
        break;
      default:
        break;
    }
    return agent;
  }

  private applyLoopEvent(agent: AgentState, ev: Record<string, unknown>, ts: number): void {
    switch (ev.type) {
      case 'step.begin':
        agent.busy = true;
        agent.source = 'wire';
        break;
      case 'step.end': {
        if (ev.usage !== undefined) agent.usage = ev.usage;
        const reason = ev.finishReason;
        // A non-tool_use finish reason terminates the turn; there is no
        // explicit turn.end record, so this is how idle is inferred.
        if (typeof reason === 'string' && reason !== 'tool_use') {
          agent.busy = false;
          agent.lastFinishReason = reason;
        }
        agent.source = 'wire';
        break;
      }
      case 'tool.call': {
        if (typeof ev.name === 'string') {
          agent.lastToolCall = {
            name: ev.name,
            ts,
            description: typeof ev.description === 'string' ? ev.description : undefined,
          };
        }
        agent.busy = true;
        agent.source = 'wire';
        break;
      }
      case 'tool.result': {
        const result = asRecord(ev.result);
        if (agent.lastToolCall && typeof result.isError === 'boolean') {
          agent.lastToolCall.isError = result.isError;
        }
        break;
      }
      default:
        // content.part etc.: lastSeen refresh only
        break;
    }
  }

  /** Fold a (re-)read state.json: session metadata + agents table. */
  applySessionState(ref: Omit<WireRef, 'agentId'>, state: SessionState): void {
    // Dual-home dedup: sessions are keyed by workDirHash + sessionId only, so
    // a session mirrored under both CLI homes folds into one entry. Merge
    // semantics: home is first-writer-wins (consistent with the agents table's
    // first-come-first-served home — in practice both converge to 'omkc'
    // because resolveHomes orders it first); title/workDir/createdAt let a
    // later writer overwrite; updatedAt takes the max of both.
    const skey = `${ref.workDirHash}/${ref.sessionId}`;
    const existing = this.sessions.get(skey);
    this.sessions.set(skey, {
      workDirHash: ref.workDirHash,
      sessionId: ref.sessionId,
      home: existing?.home ?? ref.home,
      title: state.title ?? existing?.title,
      workDir: state.workDir ?? existing?.workDir,
      createdAt: state.createdAt ?? existing?.createdAt,
      updatedAt: laterOf(existing?.updatedAt, state.updatedAt),
    });
    const parsed = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
    const ts = finiteTime(parsed); // NaN guard (see finiteTime)
    for (const [agentId, info] of Object.entries(state.agents ?? {})) {
      const agent = this.ensure(ref.sessionId, agentId, ts, ref.workDirHash, ref.home);
      agent.kind = info.type;
      agent.parentAgentId = info.parentAgentId ?? null;
      if (!this.omkcOwns(agent, Date.now())) {
        agent.lastSeen = Math.max(agent.lastSeen, ts || 0);
      }
      // A new agents-table entry under a parent == spawned.
      const parentId = info.parentAgentId;
      if (parentId) {
        const parent = this.ensure(ref.sessionId, parentId, ts, ref.workDirHash, ref.home);
        if (!parent.subagents.some((s) => s.subagentId === agentId)) {
          parent.subagents.push({ subagentId: agentId, status: 'unknown', ts });
        }
      }
    }
  }

  /** Fold a tasks/<taskId>.json snapshot: auxiliary subagent lifecycle. */
  applyTask(ref: WireRef & { taskId: string }, task: TaskFile): void {
    if (task.kind !== 'agent' || typeof task.agentId !== 'string') return;
    const rawTs = task.endedAt ?? task.startedAt ?? NaN;
    const ts = finiteTime(rawTs); // NaN/Infinity guard (see finiteTime)
    const owner = this.ensure(ref.sessionId, ref.agentId, ts, ref.workDirHash, ref.home);
    let sub = owner.subagents.find((s) => s.subagentId === task.agentId);
    if (!sub) {
      sub = { subagentId: task.agentId, status: 'unknown', ts };
      owner.subagents.push(sub);
    }
    if (this.omkcOwns(owner, Date.now())) return; // omkc owns structured sub state
    sub.status = task.status ?? sub.status;
    sub.ts = ts;
    if (typeof task.description === 'string') sub.description = task.description;
    if (typeof task.stopReason === 'string') sub.resultSummary = task.stopReason;
    if (typeof task.subagentType === 'string') sub.name = task.subagentType;
  }

  // ---------------------------------------------------------------- source ②

  /** Fold one omkc SSE event (authoritative overlay, carries real phase). */
  applyOmkcEvent(ev: OmkcEvent | null): AgentState | null {
    if (
      !ev ||
      typeof ev.sessionId !== 'string' ||
      typeof ev.agentId !== 'string' ||
      typeof ev.type !== 'string'
    ) {
      // F2 (batch 1b): a parseable frame without a string `type` is dropped
      // outright — the switch below (and ev.type.startsWith for subagent.*)
      // assumes it, so letting it through would throw.
      return null;
    }
    const payload = asRecord(ev.payload);
    // Batch 1b: ev.ts now routes through the same finiteTime guard as the
    // wire-side entries (this was the batch-1a NOTE) — a non-finite ts
    // (Infinity via a JSON overflow like 1e999) would otherwise propagate
    // into lastSeen and block the stale sweep forever.
    const ts = typeof ev.ts === 'number' ? finiteTime(ev.ts) : Date.now();
    // subagent.* events are filed under the parent agent when identified.
    let agentId = ev.agentId;
    if (ev.type.startsWith('subagent.') && typeof payload.parentAgentId === 'string') {
      agentId = payload.parentAgentId;
    }
    const agent = this.ensure(ev.sessionId, agentId, ts);
    agent.lastSeen = Math.max(agent.lastSeen, ts);
    agent.stale = false;
    agent.omkcTs = Date.now();
    agent.source = 'omkc';

    switch (ev.type) {
      case 'agent.status.updated': {
        if (typeof payload.model === 'string') agent.model = payload.model;
        if (typeof payload.contextTokens === 'number') agent.contextTokens = payload.contextTokens;
        if (typeof payload.maxContextTokens === 'number') agent.maxContextTokens = payload.maxContextTokens;
        if (payload.usage !== undefined) agent.usage = payload.usage;
        if (typeof payload.planMode === 'boolean') agent.planMode = payload.planMode;
        if (typeof payload.phase === 'string') agent.phase = payload.phase;
        break;
      }
      case 'turn.started':
        agent.busy = true;
        break;
      case 'turn.ended':
        agent.busy = false;
        if (typeof payload.reason === 'string') agent.lastTurnReason = payload.reason;
        break;
      case 'tool.call.started':
        if (typeof payload.name === 'string') {
          agent.lastToolCall = {
            name: payload.name,
            ts,
            description: typeof payload.description === 'string' ? payload.description : undefined,
          };
        }
        break;
      case 'tool.result':
        if (agent.lastToolCall && typeof payload.isError === 'boolean') {
          agent.lastToolCall.isError = payload.isError;
        }
        break;
      case 'subagent.spawned':
      case 'subagent.started':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.suspended': {
        const subId = typeof payload.subagentId === 'string' ? payload.subagentId : undefined;
        if (!subId) break;
        let sub = agent.subagents.find((s) => s.subagentId === subId);
        if (!sub) {
          sub = { subagentId: subId, status: 'spawned', ts };
          agent.subagents.push(sub);
        }
        sub.status = ev.type.slice('subagent.'.length);
        sub.ts = ts;
        if (typeof payload.subagentName === 'string') sub.name = payload.subagentName;
        if (typeof payload.description === 'string') sub.description = payload.description;
        if (typeof payload.resultSummary === 'string') sub.resultSummary = payload.resultSummary;
        if (payload.usage !== undefined) sub.usage = payload.usage;
        if (typeof payload.contextTokens === 'number') sub.contextTokens = payload.contextTokens;
        if (typeof payload.error === 'string') sub.error = payload.error;
        break;
      }
      default:
        // compaction.*, goal.updated, skill.activated, error, warning,
        // background.task.*: lastSeen refresh only (still forwarded raw).
        break;
    }
    return agent;
  }

  // ---------------------------------------------------------------- sweep

  /** Mark agents with no events for >STALE_MS as stale (kept, not deleted). */
  sweepStale(now = Date.now()): void {
    for (const agent of this.agents.values()) {
      agent.stale = now - agent.lastSeen > this.staleMs;
    }
  }

  get agentCount(): number {
    return this.agents.size;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  snapshotSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }

  snapshotAgents(): AgentState[] {
    return [...this.agents.values()].map((a) => ({
      ...a,
      // usage is deep-copied too: it can nest, and sharing the reference
      // would leak fold-internal state to snapshot consumers.
      usage: cloneJson(a.usage),
      subagents: a.subagents.map((s) => ({ ...s, usage: cloneJson(s.usage) })),
      lastToolCall: a.lastToolCall ? { ...a.lastToolCall } : undefined,
    }));
  }
}
