/**
 * Status module: live agent/session view folded from the CLI homes' session
 * trees (wire.jsonl / state.json / tasks/*.json) plus the omkc embedded SSE
 * source. Batch 1a wired the WireWatcher (source ①) into the StateFold;
 * batch 1b adds the omkc SSE source (source ②) to the same fold. The
 * controller owns watcher + SSE lifecycle and the stale sweep; the module
 * exposes the `moa_status_agents` tool over that fold.
 */
import fs from 'node:fs';
import type { MoaModule, MoaToolDef } from '../types.js';
import { OmkcSource } from './sse-source.js';
import { StateFold } from './state.js';
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
}

/** Watcher dirs are re-checked every 30s (homes may appear later). */
const HOME_RECHECK_MS = 30_000;
/** Stale heuristic sweep cadence (matches cli.ts). */
const SWEEP_MS = 5000;
/** agents payload cap: prevents a ~1.6MB full dump from flooding context. */
const AGENTS_CAP = 100;

export function createStatusController(opts: StatusControllerOptions = {}): StatusController {
  const fold = new StateFold({ staleMs: opts.staleMs });
  const watchers = new Map<string, WireWatcher>();
  let started = false;
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
  };
}

function statusAgentsTool(controller: StatusController): MoaToolDef {
  return {
    name: 'moa_status_agents',
    description:
      'Live agent/session status folded from the CLI homes\' session trees (wire.jsonl / state.json / tasks/*.json). ' +
      'Returns aggregate counts plus per-agent snapshots ordered by lastSeen (most recent first), capped at 100 by default ' +
      `(pass limit or sessionId to filter). started is false until the status controller is running — agents is then empty by design; ` +
      'the state is always explicit, never silently stale.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Only return agents of this sessionId' },
        limit: { type: 'number', description: `Max agents to return (default ${AGENTS_CAP})` },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const started = controller.isStarted();
      const fold = controller.getFold();
      const sessionId =
        typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : undefined;
      const rawLimit = typeof args.limit === 'number' ? args.limit : AGENTS_CAP;
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : AGENTS_CAP;
      let agents = started ? fold.snapshotAgents() : [];
      if (sessionId) agents = agents.filter((a) => a.sessionId === sessionId);
      agents.sort((a, b) => b.lastSeen - a.lastSeen);
      return {
        started,
        scanning: started ? controller.scanStatus().scanning : false,
        sessionCount: started ? fold.sessionCount : 0,
        agentCount: started ? fold.agentCount : 0,
        sessions: started ? fold.snapshotSessions() : [],
        agents: agents.slice(0, limit),
        agentsTruncated: agents.length,
      };
    },
  };
}

/** Create the status module (id 'status', tier 'experimental'). */
export function createStatusModule(controller: StatusController): MoaModule {
  return {
    id: 'status',
    tier: 'experimental',
    tools: [statusAgentsTool(controller)],
  };
}
