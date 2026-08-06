/**
 * Status module: live agent/session view folded from the CLI homes' session
 * trees (wire.jsonl / state.json / tasks/*.json) plus the omkc embedded SSE
 * source. Batch 1a wired the WireWatcher (source ①) into the StateFold;
 * batch 1b adds the omkc SSE source (source ②) to the same fold. Batch 1c
 * adds the read-only REST face: GET /status (snapshot mirroring the omkc
 * /state shape; 503 until the controller starts) plus a reuse-session proxy
 * in `moa_status_agents` that fetches the owning Bus's /status instead of
 * returning a silent empty state.
 *
 * The controller owns watcher + SSE lifecycle and the stale sweep; the module
 * exposes the `moa_status_agents` tool over that fold and the /status route.
 */
import { get } from 'node:http';
import fs from 'node:fs';
import type { MoaModule, MoaRouteDef, MoaToolArgs, MoaToolDef } from '../types.js';
import type { AgentState, SessionInfo } from './state.js';
import { StateFold, agentKey } from './state.js';
import { StatusBroadcaster } from './broadcast.js';
import { OmkcSource, type OmkcSourceStatus } from './sse-source.js';
import {
  resolveHomes,
  sessionsRoot,
  WireWatcher,
  type HomeSpec,
  type WatchProgress,
} from './watcher.js';

export interface StatusControllerOptions {
  /** Env for home resolution (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  scanIntervalMs?: number;
  pollIntervalMs?: number;
  /** Fold stale threshold (default STALE_MS = 60s). */
  staleMs?: number;
  /** Fold eviction threshold (default EVICT_STALE_MS = 24h). */
  evictStaleMs?: number;
  /** Stale/eviction sweep cadence (default SWEEP_MS = 5s; test seam). */
  sweepIntervalMs?: number;
  /** omkc SSE source (source ②) probe window (default 39631..39731). */
  omkcProbeMin?: number;
  omkcProbeMax?: number;
  /** Health probe interval while disconnected (default 5000ms). */
  omkcProbeIntervalMs?: number;
  /** Per-port /health timeout (default 200ms). */
  omkcProbeTimeoutMs?: number;
  /** /events read-idle timeout (default READ_IDLE_TIMEOUT_MS = 45s). */
  omkcReadIdleTimeoutMs?: number;
  /** Broadcast merge cadence (default 50ms). */
  broadcastIntervalMs?: number;
  /** Broadcast clock (test seam; default Date.now). */
  broadcastNow?: () => number;
}

export interface StatusScanStatus {
  scanning: boolean;
  homes: Array<{ home: string } & WatchProgress>;
}

/** One per-flush batch of changed agents for the /status/events fan-out
 *  (single-agent snapshots, already cloned at flush time). */
export type StatusChangeListener = (agents: readonly AgentState[]) => void;

/** One sweep tick's eviction delta, fanned out as minimal `gone` frames: the
 *  entries no longer exist, so no snapshotAgentByKey/dirty path is involved —
 *  the frame IS the whole message (0.8.1 F1). */
export interface StatusGoneBatch {
  evictedAgents: Array<{ sessionId: string; agentId: string }>;
  evictedSessions: Array<{ sessionId: string }>;
}

/** Subscriber for fold-eviction gone frames (the /status/events fan-out). */
export type StatusGoneListener = (gone: StatusGoneBatch) => void;

export interface StatusController {
  /** Start watching (idempotent); also starts the 5s stale sweep. */
  start(): void;
  /** Stop watching (idempotent); sweeps and home re-checks are torn down. */
  stop(): void;
  isStarted(): boolean;
  getFold(): StateFold;
  scanStatus(): StatusScanStatus;
  /** Epoch ms of the most recent start(); null while stopped. */
  startedAt(): number | null;
  /** Known Bus/owner port, set by the assembly from startResult.port (reuse proxy seam). */
  getPort(): number | undefined;
  setPort(port: number | undefined): void;
  /** Embedded omkc SSE source connection status (source ②). */
  omkcStatus(): OmkcSourceStatus;
  /** Subscribe to per-flush agent state changes (the /status/events fan-out). */
  subscribeStatus(listener: StatusChangeListener): void;
  unsubscribe(listener: StatusChangeListener): void;
  /** Subscribe to fold-eviction gone frames (the /status/events fan-out). */
  subscribeGone(listener: StatusGoneListener): void;
  /** Unsubscribe a gone-frame listener (idempotent). */
  unsubscribeGone(listener: StatusGoneListener): void;
  /** Active /status/events subscriber count (audit + test seam). */
  statusSubscriberCount(): number;
}

/** Watcher dirs are re-checked every 30s (homes may appear later). */
const HOME_RECHECK_MS = 30_000;
/** Stale heuristic sweep cadence (matches cli.ts). */
const SWEEP_MS = 5000;
/** agents payload cap: prevents a ~1.6MB full dump from flooding context. */
const AGENTS_CAP = 100;
/** Reuse proxy timeout for GET /status on the owning Bus (loopback, ample). */
export const REMOTE_STATUS_TIMEOUT_MS = 1500;

/**
 * Reuse-session proxy (batch 1c): fetch the owning Bus's read-only /status
 * snapshot. Resolves with the parsed body on HTTP 200 when it is a JSON
 * object; undefined on any other status, a null/non-object or unparseable
 * body, a timeout, or a connection error — the caller falls back to an
 * explicit local-empty state.
 *
 * Every teardown path settles the promise: a peer that resets/aborts the
 * response mid-body emits neither 'end' nor 'timeout' nor an error — only
 * 'close' on the request — so the 'close' listener below is what keeps the
 * tool from hanging on an owner that dies while answering.
 */
export async function fetchRemoteStatus(
  port: number,
  timeoutMs: number = REMOTE_STATUS_TIMEOUT_MS,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let deadline: NodeJS.Timeout;
    const settle = (value: Record<string, unknown> | undefined) => {
      clearTimeout(deadline);
      resolve(value);
    };
    const req = get(
      { host: '127.0.0.1', port, path: '/status', timeout: timeoutMs },
      (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            settle(undefined);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(body);
            // 0.7.1 P1: a 200 whose body is JSON `null` (or any non-object)
            // is not a snapshot — resolve undefined so the caller falls back
            // to local-empty instead of dereferencing `remote.agents` below.
            // Arrays are `typeof 'object'` but are never a valid snapshot
            // either, so they are excluded here too (reviewer fix: a `[]`
            // body used to leak into the remote branch as source:'remote').
            settle(
              parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : undefined,
            );
          } catch {
            settle(undefined);
          }
        });
        // A response that dies before 'end' (abort / stream error) must settle
        // too; an unhandled 'error' here would also crash the process.
        res.on('error', () => settle(undefined));
        res.on('aborted', () => settle(undefined));
      },
    );
    // 0.7.1 P2: `timeout: timeoutMs` is a socket *inactivity* timeout, so a
    // trickle owner (1 byte every 150ms) can stretch the call past timeoutMs
    // indefinitely. This wall-clock deadline destroys the request at
    // timeoutMs no matter what the socket has seen; `settle` clears it on
    // every path above, so it never fires after the promise resolved. The
    // socket timeout stays as the inner inactivity protection.
    deadline = setTimeout(() => {
      req.destroy();
      settle(undefined);
    }, timeoutMs);
    req.on('timeout', () => {
      req.destroy();
      settle(undefined);
    });
    req.on('error', () => settle(undefined));
    // Idempotent: after a normal 'end' (or any path above) this is a no-op;
    // it only fires first when the connection closes without a response end.
    req.on('close', () => settle(undefined));
  });
}

/** /status snapshot shape, mirroring omkc-status's GET /state. */
export interface StatusSnapshot {
  server: {
    pid: number;
    port: number | null;
    started_at: string | null;
    uptime: number;
    /** Fold eviction audit (0.8.0): agents/sessions dropped by sweepStale
     *  after >EVICT_STALE_MS (24h) of inactivity. moamcp-specific additive
     *  fields under `server` — omkc-status consumers ignore unknown keys. */
    evictedAgents: number;
    evictedSessions: number;
  };
  scan: StatusScanStatus;
  sources: {
    wire: { sessions: number; agents: number };
    omkc: OmkcSourceStatus;
  };
  sessions: SessionInfo[];
  agents: AgentState[];
}

/** Fold the current controller state into the omkc /state-mirroring shape. */
export function statusSnapshot(controller: StatusController): StatusSnapshot {
  const fold = controller.getFold();
  const startedAtMs = controller.startedAt();
  return {
    server: {
      pid: process.pid,
      port: controller.getPort() ?? null,
      started_at: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
      uptime: startedAtMs === null ? 0 : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
      evictedAgents: fold.evictedAgents,
      evictedSessions: fold.evictedSessions,
    },
    scan: controller.scanStatus(),
    sources: {
      wire: { sessions: fold.sessionCount, agents: fold.agentCount },
      omkc: controller.omkcStatus(),
    },
    sessions: fold.snapshotSessions(),
    agents: fold.snapshotAgents(),
  };
}

export function createStatusController(opts: StatusControllerOptions = {}): StatusController {
  const fold = new StateFold({ staleMs: opts.staleMs, evictStaleMs: opts.evictStaleMs });
  const watchers = new Map<string, WireWatcher>();
  const statusListeners = new Set<StatusChangeListener>();
  const goneListeners = new Set<StatusGoneListener>();
  let started = false;
  let startedAtMs: number | null = null;
  /** Known Bus/owner port (reuse proxy seam; set after bus.start()). */
  let ownerPort: number | undefined;
  let homeRecheck: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;

  // 0.8.0 broadcast pipeline: every fold mutation goes through the hook
  // points below into this dirty-set merger; the /status/events fan-out
  // resolves the drained keys to single-agent snapshots at flush time.
  // Suppression is driven by watcher catch-up: while any tail is still
  // reading its initial bulk (the scan at start()), marks and flushes are
  // dropped so the full snapshot that opens every SSE connection is the only
  // word on those agents.
  function watchersCatchingUp(): boolean {
    for (const w of watchers.values()) {
      if (w.getProgress().catchingUp > 0) return true;
    }
    return false;
  }

  const broadcaster = new StatusBroadcaster({
    intervalMs: opts.broadcastIntervalMs,
    now: opts.broadcastNow,
    isSuppressed: () => watchersCatchingUp(),
    onChange: (keys) => {
      if (statusListeners.size === 0) return; // nobody to fan out to
      const agents: AgentState[] = [];
      for (const key of keys) {
        const agent = fold.snapshotAgentByKey(key);
        if (agent !== undefined) agents.push(agent);
      }
      if (agents.length === 0) return;
      for (const listener of statusListeners) {
        try {
          listener(agents);
        } catch (err) {
          // A broken subscriber must never break the broadcast loop.
          console.warn(`[moamcp] status broadcast listener error: ${(err as Error).message}`);
        }
      }
    },
  });

  const dirty = (key: string): void => {
    broadcaster.markDirty(key);
  };

  // Batch 1b: the omkc embedded SSE source (source ②) feeds the same fold.
  // Parseable events fold in; raw frames (unparseable JSON) have no landing
  // point and are dropped here. Probe window / timings are injectable so
  // tests can point the source at high-port mock servers.
  const omkc = new OmkcSource({
    probeMin: opts.omkcProbeMin,
    probeMax: opts.omkcProbeMax,
    probeIntervalMs: opts.omkcProbeIntervalMs,
    probeTimeoutMs: opts.omkcProbeTimeoutMs,
    readIdleTimeoutMs: opts.omkcReadIdleTimeoutMs,
    onEvent: (_raw, ev) => {
      const agent = fold.applyOmkcEvent(ev);
      // subagent.* events are filed under the parent — the returned agent is
      // the one whose state actually changed, so dirty that one.
      if (agent) {
        dirty(agentKey(agent.sessionId, agent.agentId));
        // A3 (0.11.0): omkc events carry no workDirHash/home (applyOmkcEvent's
        // ensure() takes neither), so the self-heal invalidation goes to every
        // watcher by sessionId — a row-less session gets its state.json dual
        // key re-armed and applySessionState rebuilds the row + lineage.
        if (!fold.hasSessionRow(agent.sessionId)) {
          for (const w of watchers.values()) w.invalidateSessionStateById(agent.sessionId);
        }
      }
    },
  });

  // cli.ts:44-71 wiring: one watcher per home that exists, callbacks fold
  // straight into the shared StateFold.
  function attachHome(spec: HomeSpec): void {
    if (watchers.has(spec.home)) return;
    const root = sessionsRoot(spec.home);
    let watcher: WireWatcher;
    watcher = new WireWatcher({
      home: spec.label,
      root,
      scanIntervalMs: opts.scanIntervalMs,
      pollIntervalMs: opts.pollIntervalMs,
      onRecord: (ref, _raw, record, fallbackTs) => {
        const agent = fold.applyWire(ref, record, fallbackTs);
        if (agent) {
          dirty(agentKey(agent.sessionId, agent.agentId));
          // A3 (0.11.0): a wire record landing for a session whose fold row was
          // evicted means the row + its parentAgentId lineage are gone (there is
          // no other rebuild path). Invalidate the session's state.json dual key
          // so the next scan re-reads it and applySessionState rebuilds both.
          // Only new activity invalidates — eviction itself never does, so a
          // dead session stays evicted (no evict→reread→evict loop).
          if (!fold.hasSessionRow(ref.sessionId)) watcher.invalidateSessionState(ref);
        }
      },
      onSessionState: (ref, state) => {
        fold.applySessionState(ref, state);
        // A session read can change several agents (agents table + parent
        // subagent links); mark every table entry so the next flush covers
        // them all.
        for (const agentId of Object.keys(state.agents ?? {})) {
          dirty(agentKey(ref.sessionId, agentId));
        }
      },
      onTask: (ref, task) => {
        fold.applyTask(ref, task);
        // tasks/*.json mutations land on the owning agent's subagents list.
        dirty(agentKey(ref.sessionId, ref.agentId));
        // A3: same self-heal as onRecord — a task record for an evicted
        // session must re-arm the state.json re-read.
        if (!fold.hasSessionRow(ref.sessionId)) watcher.invalidateSessionState(ref);
      },
    });
    watcher.start();
    watchers.set(spec.home, watcher);
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      startedAtMs = Date.now();
      // Arm the broadcast flush loop first so no fold mutation can slip past
      // it; the timer is unref'd (never holds the process open on its own).
      broadcaster.start();
      // Re-start watchers kept from a previous run (tail offsets survive
      // stop/start), then attach any home that exists on disk.
      for (const w of watchers.values()) w.start();
      for (const spec of resolveHomes(opts.env)) {
        if (!watchers.has(spec.home) && fs.existsSync(spec.home)) attachHome(spec);
      }
      if (!homeRecheck) {
        // cli.ts:78-83: homes that appear later are picked up by a slow re-check.
        homeRecheck = setInterval(() => {
          for (const spec of resolveHomes(opts.env)) {
            if (!watchers.has(spec.home) && fs.existsSync(spec.home)) attachHome(spec);
          }
        }, HOME_RECHECK_MS);
        homeRecheck.unref();
      }
      if (!sweepTimer) {
        // 0.8.0: sweepStale also runs the fold eviction (>EVICT_STALE_MS) on
        // the same tick. 0.8.1 F1: the sweep returns what it evicted, and the
        // driver fans each entry out as a minimal `gone` frame to connected
        // /status/events subscribers — eviction is no longer silent on the
        // push face. Frames bypass the dirty/snapshot path entirely (the
        // entry no longer exists); a rebuilt agent later surfaces as a normal
        // agent frame with fresh state, firstSeen reset included.
        const sweepIntervalMs = opts.sweepIntervalMs ?? SWEEP_MS;
        sweepTimer = setInterval(() => {
          // A1 (0.11.0): skip this round while any tail is still catching up —
          // including the scan window itself, because new tails are sized at
          // registration (watcher.scanSession) so catchingUp reads > 0 from
          // the moment a non-empty wire is discovered until its pump drains it.
          // A slow-disk first scan therefore can no longer let the sweep evict
          // freshly-restored lineage before the pump folds it. NOTE: the guard
          // deliberately checks ONLY catchingUp, not `scanning` — with equal
          // sweep/scan intervals (5000ms in production) the two timers are
          // phase-aligned, and an unconditional `scanning` check would block
          // every sweep tick against the steady-state rescan and freeze
          // eviction entirely (caught by the 0.8.1 eviction-gone-frame tests).
          if (watchersCatchingUp()) return;
          const evicted = fold.sweepStale();
          if (goneListeners.size === 0) return; // nobody to notify
          if (evicted.evictedAgents.length === 0 && evicted.evictedSessions.length === 0) return;
          const gone: StatusGoneBatch = {
            evictedAgents: evicted.evictedAgents,
            evictedSessions: evicted.evictedSessions,
          };
          for (const listener of goneListeners) {
            try {
              listener(gone);
            } catch (err) {
              // A broken subscriber must never break the sweep loop.
              console.warn(`[moamcp] status gone listener error: ${(err as Error).message}`);
            }
          }
        }, sweepIntervalMs);
        sweepTimer.unref();
      }
      // Batch 1b: raise the omkc SSE subscription too (OmkcSource.start() is
      // idempotent, mirroring the watchers above).
      omkc.start();
    },
    stop(): void {
      if (!started) return;
      started = false;
      startedAtMs = null;
      broadcaster.stop();
      for (const w of watchers.values()) w.stop();
      if (homeRecheck) {
        clearInterval(homeRecheck);
        homeRecheck = null;
      }
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      // Batch 1b (F5): stop() keeps its synchronous signature — the omkc
      // source is stopped fire-and-forget. OmkcSource.stop() never rejects
      // (every await inside is caught), so there is no unhandled-rejection
      // risk and server.ts's shutdown call site stays untouched.
      void omkc.stop();
    },
    isStarted: () => started,
    getFold: () => fold,
    scanStatus: () => {
      const perHome = [...watchers.entries()].map(([home, w]) => ({
        home,
        ...w.getProgress(),
      }));
      return {
        scanning: perHome.some((p) => p.scanning || p.catchingUp > 0),
        homes: perHome,
      };
    },
    startedAt: () => startedAtMs,
    getPort: () => ownerPort,
    setPort: (port) => {
      ownerPort = port;
    },
    omkcStatus: () => omkc.status,
    subscribeStatus: (listener) => {
      statusListeners.add(listener);
    },
    unsubscribe: (listener) => {
      statusListeners.delete(listener);
    },
    subscribeGone: (listener) => {
      goneListeners.add(listener);
    },
    unsubscribeGone: (listener) => {
      goneListeners.delete(listener);
    },
    statusSubscriberCount: () => statusListeners.size,
  };
}

/** The local tool payload: explicit empty state until the controller runs. */
function localStatusPayload(controller: StatusController | undefined, args: MoaToolArgs) {
  const started = controller !== undefined && controller.isStarted();
  const sessionId =
    typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : undefined;
  const rawLimit = typeof args.limit === 'number' ? args.limit : AGENTS_CAP;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : AGENTS_CAP;
  let agents: AgentState[] = [];
  let sessions: SessionInfo[] = [];
  let sessionCount = 0;
  let agentCount = 0;
  let scanning = false;
  if (controller !== undefined && controller.isStarted()) {
    const fold = controller.getFold();
    sessionCount = fold.sessionCount;
    agentCount = fold.agentCount;
    sessions = fold.snapshotSessions();
    scanning = controller.scanStatus().scanning;
    agents = fold.snapshotAgents();
  }
  if (sessionId) agents = agents.filter((a) => a.sessionId === sessionId);
  agents.sort((a, b) => b.lastSeen - a.lastSeen);
  return {
    started,
    scanning,
    sessionCount,
    agentCount,
    sessions,
    agents: agents.slice(0, limit),
    agentsTruncated: agents.length,
  };
}

function statusAgentsTool(
  controller: StatusController | undefined,
  remoteStatusTimeoutMs: number,
): MoaToolDef {
  return {
    name: 'moa_status_agents',
    description:
      'Live agent/session status folded from the CLI homes\' session trees (wire.jsonl / state.json / tasks/*.json) ' +
      'plus the owning Bus\'s /status snapshot. Returns aggregate counts plus per-agent snapshots ordered by lastSeen ' +
      '(most recent first), capped at 100 by default (pass limit or sessionId to filter). source is \'local\' when this ' +
      'process folds the data itself, \'remote\' when a reuse session proxies the owning Bus\'s /status, and ' +
      '\'local-empty\' when nothing is available yet — the state is always explicit, never silently stale.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Only return agents of this sessionId' },
        limit: { type: 'number', description: `Max agents to return (default ${AGENTS_CAP})` },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const started = controller !== undefined && controller.isStarted();
      if (started) {
        // own/started: local fold, unchanged behaviour (batch 1a/1b) + marker.
        return { ...localStatusPayload(controller, args), source: 'local' };
      }
      // Reuse session with a known owner port: proxy the owner's read-only
      // /status. Any failure (503 not-ready, timeout, connection reset)
      // falls back to an explicit local-empty state — never a stale guess.
      const ownerPort = controller?.getPort();
      if (ownerPort !== undefined) {
        const remote = await fetchRemoteStatus(ownerPort, remoteStatusTimeoutMs);
        // 0.7.1 P1: a 200 with a JSON `null`/non-object body must not reach
        // `remote.agents` — non-objects resolve undefined above, and this
        // explicit guard keeps the dereference crash-proof regardless. Arrays
        // (`typeof [] === 'object'`) are excluded too, mirroring the fetch
        // guard above.
        if (
          remote !== undefined &&
          remote !== null &&
          typeof remote === 'object' &&
          !Array.isArray(remote)
        ) {
          // The owner's snapshot passes through verbatim EXCEPT the per-agent
          // list, which honors the same limit/sessionId contract as the local
          // fold: the /status snapshot is uncapped, and letting it through
          // would flood context (the very thing AGENTS_CAP exists to prevent).
          const sessionId =
            typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : undefined;
          const rawLimit = typeof args.limit === 'number' ? args.limit : AGENTS_CAP;
          const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : AGENTS_CAP;
          const remoteAgents = Array.isArray(remote.agents) ? (remote.agents as AgentState[]) : [];
          const filtered = sessionId
            ? remoteAgents.filter((a) => a.sessionId === sessionId)
            : remoteAgents;
          filtered.sort((a, b) => b.lastSeen - a.lastSeen);
          return {
            ...remote,
            agents: filtered.slice(0, limit),
            agentsTruncated: filtered.length,
            source: 'remote',
          };
        }
      }
      return { ...localStatusPayload(controller, args), source: 'local-empty' };
    },
  };
}

/**
 * Slow-client guard (0.8.0): a /status/events subscriber with more than this
 * many agent frames buffered undrained is destroyed — the kimi CLI
 * status-export precedent. ~100 agent frames/50ms worst case means a stuck
 * reader hits 1000 queued frames in well under a second of silence.
 */
export const MAX_BACKLOG_FRAMES = 1000;
/** SSE heartbeat comment cadence (mirrors the omkc source's 15s heartbeat). */
export const SSE_HEARTBEAT_MS = 15_000;

export interface StatusEventsOptions {
  /** Frames buffered without a drain before the connection is destroyed (default 1000). */
  maxBacklog?: number;
  /** Heartbeat comment cadence (default SSE_HEARTBEAT_MS = 15s). */
  heartbeatMs?: number;
}

/**
 * /status/events SSE stream (0.8.0): the push face of the status fold.
 *
 * Contract:
 *  - not started -> 503 status_not_ready, same as GET /status (ACAO *);
 *  - started -> the first frame is `event: snapshot` carrying the full
 *    snapshot (identical shape to GET /status), then one `event: agent`
 *    frame per changed agent per broadcast flush (single-agent JSON, never a
 *    full snapshot clone);
 *  - fold eviction (0.8.1 F1): a sweep tick that drops an agent emits a
 *    minimal `event: agent` frame `{sessionId, agentId, gone: true}`, and a
 *    dropped session emits `event: session` `{sessionId, gone: true}` — a
 *    connected client is told the entry is gone instead of showing it forever
 *    (no full snapshot follows an eviction). A rebuilt agent later arrives as
 *    a normal agent frame with fresh state (firstSeen/usage reset is
 *    expected);
 *  - a `: heartbeat` comment every heartbeatMs keeps proxies alive;
 *  - a subscriber that stops draining (backlog > maxBacklog frames) is
 *    destroyed rather than buffered forever;
 *  - ACAO *; closing the request unsubscribes and clears the heartbeat timer.
 */
function statusEventsRoute(controller: StatusController | undefined, opts: StatusEventsOptions): MoaRouteDef {
  const maxBacklog = opts.maxBacklog ?? MAX_BACKLOG_FRAMES;
  const heartbeatMs = opts.heartbeatMs ?? SSE_HEARTBEAT_MS;
  return {
    method: 'GET',
    path: '/status/events',
    handler: (ctx) => {
      ctx.res.setHeader('access-control-allow-origin', '*');
      if (controller === undefined || !controller.isStarted()) {
        ctx.res.setHeader('retry-after', '2');
        ctx.sendJson(503, { error: 'status_not_ready', started: false });
        return;
      }
      const res = ctx.res;
      let destroyed = false;
      /** Agent/snapshot frames handed to res.write since the last drain. */
      let bufferedFrames = 0;
      /** Guards against stacking 'drain' listeners under sustained backpressure
       *  (one per response max — 11+ stacked listeners trip Node's
       *  MaxListenersExceededWarning on a busy stream). */
      let drainWaiting = false;
      const destroy = (): void => {
        if (destroyed) return;
        destroyed = true;
        res.destroy();
      };
      const sendFrame = (frame: string): void => {
        if (destroyed) return;
        bufferedFrames += 1;
        if (bufferedFrames > maxBacklog) {
          // Stuck reader: it stopped draining; kill the connection instead of
          // buffering without bound (kimi CLI status-export precedent).
          destroy();
          return;
        }
        let accepted = false;
        try {
          accepted = res.write(frame);
        } catch {
          destroy();
          return;
        }
        if (accepted) {
          // Socket buffer absorbed the frame: prior queued frames drained.
          bufferedFrames = 0;
        } else if (!drainWaiting) {
          // Backpressure: the buffer is full; the count grows until 'drain'.
          // Only one 'drain' listener may be pending per response — repeated
          // once('drain') under sustained backpressure stacks listeners and
          // trips MaxListenersExceededWarning.
          drainWaiting = true;
          res.once('drain', () => {
            drainWaiting = false;
            bufferedFrames = 0;
          });
        }
      };
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      // First frame: the full snapshot, identical shape to GET /status.
      sendFrame(`event: snapshot\ndata: ${JSON.stringify(statusSnapshot(controller))}\n\n`);

      const listener: StatusChangeListener = (agents) => {
        for (const agent of agents) {
          sendFrame(`event: agent\ndata: ${JSON.stringify(agent)}\n\n`);
        }
      };
      controller.subscribeStatus(listener);
      // 0.8.1 F1: eviction gone frames. The evicted entry is no longer in the
      // fold, so this path constructs the minimal frame directly — no
      // snapshotAgentByKey, no dirty mark. `gone: true` distinguishes it from
      // a live agent frame carrying the same sessionId/agentId.
      const goneListener: StatusGoneListener = (gone) => {
        for (const agent of gone.evictedAgents) {
          sendFrame(
            `event: agent\ndata: ${JSON.stringify({ sessionId: agent.sessionId, agentId: agent.agentId, gone: true })}\n\n`,
          );
        }
        for (const session of gone.evictedSessions) {
          sendFrame(`event: session\ndata: ${JSON.stringify({ sessionId: session.sessionId, gone: true })}\n\n`);
        }
      };
      controller.subscribeGone(goneListener);
      // Socket errors after a client disconnect are expected — never crash.
      res.on('error', () => undefined);
      const heartbeat = setInterval(() => {
        if (destroyed) return;
        try {
          res.write(': heartbeat\n\n');
        } catch {
          destroy();
        }
      }, heartbeatMs);
      heartbeat.unref();
      // Cleanup on client close: unsubscribe + stop the heartbeat. The
      // connection itself is destroyed by res.destroy() in destroy().
      ctx.req.on('close', () => {
        destroy();
        clearInterval(heartbeat);
        controller.unsubscribe(listener);
        controller.unsubscribeGone(goneListener);
      });
    },
  };
}

/**
 * Read-only /status route (batch 1c): the full snapshot once the controller
 * is running; 503 + Retry-After: 2 while it is missing or not yet started
 * (cold start / reuse session). The endpoint is CORS-open (omkc-status
 * precedent) — the write endpoints keep their checkOrigin policy. 0.8.0 adds
 * the /status/events SSE push face alongside it.
 */
export function statusRoutes(controller: StatusController | undefined, opts: StatusEventsOptions = {}): MoaRouteDef[] {
  return [
    {
      method: 'GET',
      path: '/status',
      handler: (ctx) => {
        ctx.res.setHeader('access-control-allow-origin', '*');
        if (controller === undefined || !controller.isStarted()) {
          ctx.res.setHeader('retry-after', '2');
          ctx.sendJson(503, { error: 'status_not_ready', started: false });
          return;
        }
        ctx.sendJson(200, statusSnapshot(controller));
      },
    },
    statusEventsRoute(controller, opts),
  ];
}

/** Create the status module (id 'status', tier 'experimental'). */
export function createStatusModule(
  controller: StatusController | undefined,
  opts: { remoteStatusTimeoutMs?: number; maxBacklog?: number; heartbeatMs?: number } = {},
): MoaModule {
  return {
    id: 'status',
    tier: 'experimental',
    tools: [statusAgentsTool(controller, opts.remoteStatusTimeoutMs ?? REMOTE_STATUS_TIMEOUT_MS)],
    routes: statusRoutes(controller, { maxBacklog: opts.maxBacklog, heartbeatMs: opts.heartbeatMs }),
  };
}
