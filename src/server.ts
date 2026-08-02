#!/usr/bin/env node
/**
 * moamcp — MCP server (stdio) exposing the mailbox debate hub.
 * Tool list per design doc §5.3: moa_init, moa_start_debate, moa_wait_turn,
 * moa_submit_turn, moa_complete (plus the board/tip tools and moa_status).
 *
 * Assembly entry point (esbuild bundle root): build the core infrastructure
 * (Bus, BoardStore) and modules (DebateHub, TipStore), wire the reuse/
 * takeover event sink, then hand everything to the MCP adapter — tool
 * definitions themselves live in src/modules/*, aggregated by adapters/mcp.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createServer } from './adapters/mcp.js';
import { Bus } from './core/bus/bus.js';
import { BoardStore } from './core/store/board.js';
import { DebateHub, defaultLogsDir, type DomainEvent } from './modules/debate/state.js';
import { TipStore } from './modules/tips/tips.js';

// Public entry surface: tests and embedders import createServer from here.
export { createServer };

/** Best-effort forward timeout for reuse-mode publishes (design §3.3: no retries). */
const REUSE_PUBLISH_TIMEOUT_MS = 2000;

/** Debate-card URL for a task; task_id is percent-encoded so it cannot break the query string. */
export function cardUrl(port: number, taskId: string): string {
  return `http://127.0.0.1:${port}/?task_id=${encodeURIComponent(taskId)}`;
}

/**
 * Reuse-mode event sink (design §3.3): forward each domain event to the Bus
 * that owns the port via `POST /publish`. Strictly one-way best-effort — a
 * timeout, network failure, or non-200 response logs a warning and drops the
 * event; it never blocks or retries the MCP call chain. Dropped events are
 * covered by the two fallbacks: the owning Bus's SSE replay buffer (last 200
 * frames per task) and the shared archive root.
 */
function reusePublishForwarder(port: number): (taskId: string, event: DomainEvent) => void {
  return (taskId, event) => {
    const body = JSON.stringify({ task_id: taskId, event });
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/publish',
        timeout: REUSE_PUBLISH_TIMEOUT_MS,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume(); // drain; we only care about the status
        if (res.statusCode !== 200) {
          console.warn(`[moamcp] reuse publish dropped: HTTP ${res.statusCode} (task=${taskId}, type=${event.type})`);
        }
      },
    );
    // A timeout destroys the request, which surfaces through 'error' — one warn path.
    req.on('timeout', () => req.destroy(new Error(`publish timeout after ${REUSE_PUBLISH_TIMEOUT_MS}ms`)));
    req.on('error', (err) => {
      console.warn(`[moamcp] reuse publish dropped: ${err.message} (task=${taskId}, type=${event.type})`);
    });
    req.end(body);
  };
}

async function main(): Promise<void> {
  const waitCap = Number(process.env.MOAMCP_WAIT_CAP_MS);
  // Bus: SSE channel + frontend card. Port rules per the port-discovery design
  // (§3.2/§3.3): register → bind 39813 (MOAMCP_BUS_PORT overrides) → a live
  // moamcp holding the port means reuse mode (no listener in this process);
  // anything else walks port+1 up to the cap.
  const busPort = Number(process.env.MOAMCP_BUS_PORT);
  // Reuse-mode host watch tuning (defaults: 10s interval / 1s timeout /
  // 3 consecutive failures → dead → takeover).
  const watchIntervalMs = Number(process.env.MOAMCP_BUS_WATCH_INTERVAL_MS);
  const watchTimeoutMs = Number(process.env.MOAMCP_BUS_WATCH_TIMEOUT_MS);
  const watchFailThreshold = Number(process.env.MOAMCP_BUS_WATCH_FAILS);
  // Fixed archive root shared by all instances (reuse mode's /archive depends
  // on it): MOAMCP_LOGS_DIR or <MOAMCP_HOME|~/.moamcp>/logs (design §3.1).
  const logsDir = defaultLogsDir();
  const bus = new Bus({
    ...(Number.isFinite(busPort) && busPort > 0 ? { port: busPort } : {}),
    ...(Number.isFinite(watchIntervalMs) && watchIntervalMs > 0 ? { reuseWatchIntervalMs: watchIntervalMs } : {}),
    ...(Number.isFinite(watchTimeoutMs) && watchTimeoutMs > 0 ? { reuseWatchTimeoutMs: watchTimeoutMs } : {}),
    ...(Number.isFinite(watchFailThreshold) && watchFailThreshold > 0 ? { reuseWatchFailThreshold: watchFailThreshold } : {}),
    cwd: process.cwd(),
    logsDir,
  });
  let actualPort: number;
  try {
    actualPort = await bus.start();
  } catch (err) {
    // Port walk exhausted (or another bind failure): bus.start() has already
    // released the registry entry; close whatever partially started, then exit
    // loudly — never leave a half-initialized server behind (design §3.2/§4).
    await bus.stop().catch(() => {});
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error('[moamcp] no free Bus port: port+1 walk exhausted, giving up');
    }
    throw err;
  }
  const startResult = bus.startResult;
  // own: fan events out on this process's Bus. reuse: forward them to the Bus
  // that owns the port — best-effort, never blocks the MCP call chain (§3.3).
  // Either way the card points at the owning Bus's port. Both go through
  // mutable bindings: in reuse mode the watched host Bus can die, and the
  // Bus takeover re-points them via onTakeover — the event outlet switches
  // from forwarding to the local Bus (or to a new host) while the DebateHub
  // state machine in this process's memory stays untouched.
  let sink: (taskId: string, event: DomainEvent) => void =
    startResult.mode === 'own'
      ? (taskId, event) => bus.publish(taskId, event)
      : reusePublishForwarder(startResult.port);
  let cardPort = startResult.port;
  bus.onTakeover = (result) => {
    cardPort = result.port;
    sink =
      result.mode === 'own'
        ? (taskId, event) => bus.publish(taskId, event)
        : reusePublishForwarder(result.port);
    console.error(
      result.mode === 'own'
        ? `[moamcp] takeover: now owns the Bus at http://127.0.0.1:${result.port}/ (registry entry restored, card_url re-pointed, events served locally)`
        : `[moamcp] takeover: lost the port race; reusing new Bus at http://127.0.0.1:${result.port}/`,
    );
  };
  // Shared blackboard: task-scope events ride the task's SSE stream (card-
  // visible); workspace/global events fan out on a synthetic `@board/<scope>`
  // bus channel for Control Plane invalidation (card panels are future work).
  // Routing goes through the mutable `sink`, so a reuse-mode takeover re-points
  // board events (forwarded ↔ local Bus) exactly like debate events.
  const board = new BoardStore({
    ...(Number.isFinite(waitCap) && waitCap > 0 ? { waitCapMs: waitCap } : {}),
    workspaceCwd: process.cwd(),
    emit: (scope, event) => sink(scope.kind === 'task' ? scope.taskId : `@board/${scope.key}`, event),
  });
  const hub = new DebateHub({
    ...(Number.isFinite(waitCap) && waitCap > 0 ? { waitCapMs: waitCap } : {}),
    logsDir,
    emit: (taskId, event) => sink(taskId, event),
    cardUrlFactory: (taskId) => cardUrl(cardPort, taskId),
    board,
  });
  const tips = new TipStore(board);
  const server = createServer(hub, bus, board, tips);
  await server.connect(new StdioServerTransport());
  if (startResult.mode === 'reuse') {
    console.error(
      `[moamcp] reuse: forwarding events to existing Bus at http://127.0.0.1:${actualPort}/ (this process does not listen)`,
    );
  } else {
    console.error(`[moamcp] bus: http://127.0.0.1:${actualPort}/?task_id=<id> (port file: bus.port)`);
  }
  // Best-effort bus.port cleanup. Note: Windows does not deliver SIGTERM to
  // Node processes, so when the host CLI kills us the file may survive —
  // harmless, since it is overwritten on every start.
  const { rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  process.on('exit', () => rmSync(join(process.cwd(), 'bus.port'), { force: true }));
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void bus.stop().finally(() => process.exit(0));
  };
  // Shutdown when the MCP transport closes (parent exited / stdin closed).
  server.onclose = () => shutdown();
  process.stdin.on('close', () => shutdown());
  process.stdin.on('end', () => shutdown());

  // Parent death watchdog: if the spawning process dies, exit.
  // On Windows, stdin close is not always delivered reliably.
  if (process.ppid) {
    const parentPid = process.ppid;
    const watchdog = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        clearInterval(watchdog);
        shutdown();
      }
    }, 5000);
    watchdog.unref(); // Don't keep the process alive just for the watchdog.
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('moamcp server failed:', err);
    process.exit(1);
  });
}
