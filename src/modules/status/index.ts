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
import { StateFold } from './state.js';
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
  /** omkc SSE source (source ②) probe window (default 39631..39731). */
  omkcProbeMin?: number;
  omkcProbeMax?: number;
  /** Health probe interval while disconnected (default 5000ms). */
  omkcProbeIntervalMs?: number;
  /** Per-port /health timeout (default 200ms). */
  omkcProbeTimeoutMs?: number;
  /** /events read-idle timeout (default READ_IDLE_TIMEOUT_MS = 45s). */
  omkcReadIdleTimeoutMs?: number;
}

export interface StatusScanStatus {
  scanning: boolean;
  homes: Array<{ home: string } & WatchProgress>;
}

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
 * snapshot. Resolves with the parsed body on HTTP 200 (a JSON object);
 * undefined on any other status, an unparseable body, a timeout, or a
 * connection error — the caller falls back to an explicit local-empty state.
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
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(body) as Record<string, unknown>);
          } catch {
            resolve(undefined);
          }
        });
        // A response that dies before 'end' (abort / stream error) must settle
        // too; an unhandled 'error' here would also crash the process.
        res.on('error', () => resolve(undefined));
        res.on('aborted', () => resolve(undefined));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.on('error', () => resolve(undefined));
    // Idempotent: after a normal 'end' (or any path above) this is a no-op;
    // it only fires first when the connection closes without a response end.
    req.on('close', () => resolve(undefined));
  });
}

/** /status snapshot shape, mirroring omkc-status's GET /state. */
export interface StatusSnapshot {
  server: {
    pid: number;
    port: number | null;
    started_at: string | null;
    uptime: number;
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
  const fold = new StateFold({ staleMs: opts.staleMs });
  const watchers = new Map<string, WireWatcher>();
  let started = false;
  let startedAtMs: number | null = null;
  /** Known Bus/owner port (reuse proxy seam; set after bus.start()). */
  let ownerPort: number | undefined;
  let homeRecheck: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;

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
      if (ev) fold.applyOmkcEvent(ev);
    },
  });

  // cli.ts:44-71 wiring: one watcher per home that exists, callbacks fold
  // straight into the shared StateFold.
  function attachHome(spec: HomeSpec): void {
    if (watchers.has(spec.home)) return;
    const root = sessionsRoot(spec.home);
    const watcher = new WireWatcher({
      home: spec.label,
      root,
      scanIntervalMs: opts.scanIntervalMs,
      pollIntervalMs: opts.pollIntervalMs,
      onRecord: (ref, _raw, record) => {
        fold.applyWire(ref, record);
      },
      onSessionState: (ref, state) => {
        fold.applySessionState(ref, state);
      },
      onTask: (ref, task) => {
        fold.applyTask(ref, task);
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
        sweepTimer = setInterval(() => fold.sweepStale(), SWEEP_MS);
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
        if (remote !== undefined) {
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
 * Read-only /status route (batch 1c): the full snapshot once the controller
 * is running; 503 + Retry-After: 2 while it is missing or not yet started
 * (cold start / reuse session). The endpoint is CORS-open (omkc-status
 * precedent) — the write endpoints keep their checkOrigin policy.
 */
export function statusRoutes(controller: StatusController | undefined): MoaRouteDef[] {
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
  ];
}

/** Create the status module (id 'status', tier 'experimental'). */
export function createStatusModule(
  controller: StatusController | undefined,
  opts: { remoteStatusTimeoutMs?: number } = {},
): MoaModule {
  return {
    id: 'status',
    tier: 'experimental',
    tools: [statusAgentsTool(controller, opts.remoteStatusTimeoutMs ?? REMOTE_STATUS_TIMEOUT_MS)],
    routes: statusRoutes(controller),
  };
}
