/**
 * Bus — SSE channel + frontend card, same process as the MCP stdio server.
 *
 * Port selection follows the port-discovery design (§3.2): register in the
 * instance registry first (intended port), then bind — on `EADDRINUSE`,
 * consult the registry (excluding our own pid entry) to decide who holds the
 * port: a live moamcp whose HTTP health probe passes → reuse signal; a dead
 * entry (swept by listLive) or a non-moamcp listener → port+1 walk, capped
 * at `PORT_RETRY_LIMIT` (then throw — never swallow). After a successful
 * bind the actually-bound port is written back via `update({port})`.
 *
 * Reuse mode watches the host Bus (`GET /tasks` every 10s, 1s timeout,
 * 3 consecutive failures declare it dead). A dead host triggers a takeover
 * that re-runs the start flow above: the atomicity of the bind arbitrates
 * races between reusers — the winner becomes the owner, a loser re-attaches
 * to it via the usual reuse lookup (or walks ports if the holder is not a
 * live moamcp), so a killed owner never leaves headless reusers behind.
 *
 * Discovery is registry-first (`<MOAMCP_HOME|~/.moamcp>/instances/<pid>.json`);
 * `bus.port` is still written for backward compatibility but is no longer the
 * primary discovery mechanism.
 *
 * Zero-dependency: node:http + hand-rolled SSE (`data: <json>\n\n` frames).
 * Endpoints:
 *   GET  /                     → self-contained debate card (frontend.ts)
 *   GET  /tasks                → active task list (derived from the event log)
 *   GET  /subscribe?task_id=X  → SSE stream of all events for that task
 *   GET  /archive?task_id=X&file=result.json|probe.json|events.jsonl
 *                              → archived files written by moa_complete
 *   POST /publish              → {task_id, event} fan-out (internal / future hub)
 *
 * Subscribers that connect late get the per-task event log replayed so the
 * card can render roster/history from a cold start.
 */
import { createServer, get, type Server, type ServerResponse } from 'node:http';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { FRONTEND_HTML } from './frontend.js';
import { createRegistry, pidAlive, type InstanceRegistration } from './registry.js';

/** Maximum consecutive `EADDRINUSE` port+1 retries (mirrors kap-server `PORT_RETRY_LIMIT`). */
export const PORT_RETRY_LIMIT = 100;

/** Reuse health probe: 200ms, 0 retries — loopback is ample; failure means port+1 (design §3.3). */
export const PROBE_TIMEOUT_MS = 200;

/**
 * Reuse-mode host watch: how often the host Bus is probed, the probe
 * timeout, and how many consecutive failures declare it dead and trigger
 * a takeover attempt. Worst-case detection delay is ~3 intervals (~30s).
 */
export const REUSE_WATCH_INTERVAL_MS = 10_000;
export const REUSE_WATCH_TIMEOUT_MS = 1_000;
export const REUSE_WATCH_FAIL_THRESHOLD = 3;

export type BusMode = 'own' | 'reuse';

/** What `start()` decided: bind a fresh Bus, or reuse a live moamcp already on the port. */
export interface BusStartResult {
  readonly mode: BusMode;
  readonly port: number;
}

export interface BusOptions {
  /** Requested port; `MOAMCP_BUS_PORT` overrides the default, which is 8913. `0` = ephemeral. */
  port?: number;
  /** Directory where bus.port is written. Default process.cwd(). */
  cwd?: string;
  /** Max events kept per task for replay to late subscribers. */
  replayLimit?: number;
  /** Archive root written by moa_complete (logs/{task_id}). Default 'logs'. */
  logsDir?: string;
  /** Instance registry directory. Default `<MOAMCP_HOME|~/.moamcp>/instances`. */
  instancesDir?: string;
  /** Port+1 retry cap. Default PORT_RETRY_LIMIT (100); tests inject a tiny value. */
  portRetryLimit?: number;
  /** Reuse-mode host Bus probe interval. Default REUSE_WATCH_INTERVAL_MS (10s). */
  reuseWatchIntervalMs?: number;
  /** Reuse-mode host Bus probe timeout. Default REUSE_WATCH_TIMEOUT_MS (1s). */
  reuseWatchTimeoutMs?: number;
  /** Consecutive probe failures before the host is declared dead. Default REUSE_WATCH_FAIL_THRESHOLD (3). */
  reuseWatchFailThreshold?: number;
}

/** Files the /archive endpoint is allowed to serve, with their content types. */
const ARCHIVE_FILES: Record<string, string> = {
  'result.json': 'application/json; charset=utf-8',
  'probe.json': 'application/json; charset=utf-8',
  'events.jsonl': 'application/x-ndjson; charset=utf-8',
};

/** `MOAMCP_BUS_PORT` as a positive integer, or undefined when unset/invalid. */
function envBusPort(): number | undefined {
  const raw = Number(process.env.MOAMCP_BUS_PORT);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * Reuse health probe: `GET /tasks` on the port holder, 200ms timeout,
 * 0 retries. Confirms the listener really is a moamcp Bus before reuse —
 * guards against pid recycling where the registry entry's pid is alive but
 * the listener has changed. Any failure/timeout reads as "not moamcp".
 */
function busProbe(port: number, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((done) => {
    const req = get({ host: '127.0.0.1', port, path: '/tasks', timeout: timeoutMs }, (res) => {
      res.resume(); // drain; we only care about the status line
      done(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
  });
}

export class Bus {
  private server: Server;
  private subscribers = new Map<string, Set<ServerResponse>>();
  /** Per-task serialized frames, replayed to late subscribers. */
  private eventLog = new Map<string, string[]>();
  private port = 0;
  private startMode: BusMode = 'own';
  private registration?: InstanceRegistration;
  private wrotePortFile = false;
  private readonly requestedPort: number;
  private readonly cwd: string;
  private readonly replayLimit: number;
  private readonly logsDir: string;
  private readonly portRetryLimit: number;
  private readonly registry: ReturnType<typeof createRegistry>;
  private readonly watchIntervalMs: number;
  private readonly watchTimeoutMs: number;
  private readonly watchFailThreshold: number;
  /** Reuse-mode host watch timer (undefined outside reuse mode). */
  private hostWatch?: NodeJS.Timeout;
  private hostWatchFails = 0;
  private probing = false;
  private takingOver = false;
  private stopped = false;

  /**
   * Fires after a dead-host takeover settles: `mode: 'own'` means this
   * process won the port and now serves its own Bus; `mode: 'reuse'` means
   * it lost the race and re-attached to the new owner. Callers re-point the
   * event sink and card_url from the result.
   */
  onTakeover?: (result: BusStartResult) => void;

  constructor(opts: BusOptions = {}) {
    this.requestedPort = opts.port ?? envBusPort() ?? 8913;
    this.cwd = opts.cwd ?? process.cwd();
    this.replayLimit = opts.replayLimit ?? 200;
    this.logsDir = opts.logsDir ?? 'logs';
    this.portRetryLimit = opts.portRetryLimit ?? PORT_RETRY_LIMIT;
    this.watchIntervalMs = opts.reuseWatchIntervalMs ?? REUSE_WATCH_INTERVAL_MS;
    this.watchTimeoutMs = opts.reuseWatchTimeoutMs ?? REUSE_WATCH_TIMEOUT_MS;
    this.watchFailThreshold = opts.reuseWatchFailThreshold ?? REUSE_WATCH_FAIL_THRESHOLD;
    this.registry = createRegistry({ instancesDir: opts.instancesDir });
    this.server = createServer((req, res) => void this.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }));
  }

  get actualPort(): number {
    return this.port;
  }

  /** 'own' (this process bound the Bus) or 'reuse' (a live moamcp already serves it). */
  get mode(): BusMode {
    return this.startMode;
  }

  /** Structured start outcome for callers wiring reuse mode (design §3.3). */
  get startResult(): BusStartResult {
    return { mode: this.startMode, port: this.port };
  }

  /**
   * Register → bind (port walk + reuse detection) → write back the bound port.
   * Returns the usable port in either mode. On bind failure the registration
   * is released before the error is rethrown, so a failed start leaves no
   * stale entry behind; callers still get the raw error.
   */
  async start(): Promise<number> {
    if (this.requestedPort === 0) {
      // Ephemeral bind: the OS picks a free port, so there is nothing to
      // retry and no fixed port to discover — skip the registry/reuse dance
      // entirely (mirrors kap-server's "port 0 is never retried" carve-out).
      this.port = await this.listenOnce(0);
      this.startMode = 'own';
      await this.writePortFile();
      return this.port;
    }

    // Register BEFORE binding: during the bind window the entry is visible to
    // concurrent peers, so they detect "moamcp holds this port" instead of
    // misreading it as a third-party listener (design §3.2 TOCTOU note).
    const registration = await this.registry.register({ pid: process.pid, port: this.requestedPort });
    this.registration = registration;

    let result: BusStartResult;
    try {
      result = await this.bindWithPortWalk();
    } catch (err) {
      // Port walk exhausted or a non-EADDRINUSE bind error: drop the entry,
      // then rethrow — never swallow, never leave an unbound entry behind.
      await this.releaseRegistration();
      throw err;
    }

    if (result.mode === 'reuse') {
      // This process will not listen: remove its own entry so the registry
      // does not carry a live-pid entry with no listener behind it (design
      // §3.3/§4). The reuse wiring itself (event forwarding, card_url) is the
      // caller's job; here we only decide and signal.
      await this.releaseRegistration();
      this.startMode = 'reuse';
      this.port = result.port;
      // Watch the host: a dead owner must not leave this process a headless
      // zombie forwarding into a dead port. Runs on both the initial reuse
      // and a re-attach after a lost takeover race.
      this.startHostWatch(result.port);
      return this.port;
    }

    this.startMode = 'own';
    this.port = result.port;
    // Advertise the actually-bound port (the port+1 walk winner), so registry
    // readers find the real listener.
    await registration.update({ port: result.port });
    await this.writePortFile(); // compat: bus.port is no longer the primary discovery channel
    return this.port;
  }

  /** Fan an event out to all subscribers of the task (and append to the replay log). */
  publish(taskId: string, event: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify({ task_id: taskId, ts: new Date().toISOString(), ...event })}\n\n`;
    const log = this.eventLog.get(taskId) ?? [];
    log.push(frame);
    if (log.length > this.replayLimit) log.shift();
    this.eventLog.set(taskId, log);
    for (const res of this.subscribers.get(taskId) ?? []) res.write(frame);
  }

  /** Active task ids, derived from the event log keys (zero-intrusion; design §3.4). */
  activeTasks(): string[] {
    return [...this.eventLog.keys()];
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopHostWatch();
    for (const subs of this.subscribers.values()) for (const res of subs) res.end();
    this.subscribers.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.releaseRegistration();
    if (this.wrotePortFile) await rm(join(this.cwd, 'bus.port'), { force: true });
  }

  // ---- internals ----

  /**
   * Port+1 walk on EADDRINUSE (mirrors kap-server `listenWithPortRetry`):
   * on a busy port, ask the registry who holds it — a live moamcp (entry
   * with matching port, pid alive, probe passing) yields a reuse signal;
   * anything else walks to port+1. Throws once the cap or 65535 is hit.
   */
  private async bindWithPortWalk(): Promise<BusStartResult> {
    let port = this.requestedPort;
    for (let attempt = 0; ; attempt++) {
      try {
        const bound = await this.listenOnce(port);
        return { mode: 'own', port: bound };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
        if (attempt >= this.portRetryLimit || port >= 65535) throw err;
        const reuseTarget = await this.findReuseTarget(port);
        if (reuseTarget !== undefined) return { mode: 'reuse', port: reuseTarget.port };
        port += 1;
      }
    }
  }

  /**
   * Registry lookup for the holder of a busy port. `listLive` sweeps dead-pid
   * entries as a side effect (the "dead entry → delete + port+1" case); our
   * own pid entry is excluded so we never match ourselves. A matching live
   * entry must still pass the HTTP probe, else it reads as non-moamcp.
   */
  private async findReuseTarget(port: number): Promise<{ port: number } | undefined> {
    const live = await this.registry.listLive();
    const holder = live.find((entry) => entry.port === port && entry.pid !== process.pid);
    if (holder === undefined || !pidAlive(holder.pid)) return undefined;
    if (!(await busProbe(holder.port))) return undefined;
    return { port: holder.port };
  }

  private listenOnce(port: number): Promise<number> {
    return new Promise<number>((resolveListen, reject) => {
      const onError = (err: NodeJS.ErrnoException) => reject(err);
      this.server.once('error', onError);
      // Loopback-only: the Bus carries debate transcripts (potentially code
      // context) and an unauthenticated POST /publish — never expose it to
      // the network. All internal traffic (probes, reuse forwarding, cards)
      // already targets 127.0.0.1.
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        resolveListen((this.server.address() as AddressInfo).port);
      });
    });
  }

  private async writePortFile(): Promise<void> {
    await writeFile(join(this.cwd, 'bus.port'), String(this.port));
    this.wrotePortFile = true;
  }

  private async releaseRegistration(): Promise<void> {
    const registration = this.registration;
    this.registration = undefined;
    if (registration !== undefined) {
      // Best-effort: a cleanup failure must not mask the real outcome.
      await registration.release().catch(() => {});
    }
  }

  /**
   * Reuse-mode host watch: probe the host Bus (`GET /tasks`) every
   * `watchIntervalMs`; `watchFailThreshold` CONSECUTIVE failures declare it
   * dead and trigger a takeover attempt. Any success resets the counter.
   * The timer is unref'd so it never holds the process up on shutdown.
   */
  private startHostWatch(hostPort: number): void {
    this.stopHostWatch();
    if (this.stopped) return;
    const timer = setInterval(() => void this.watchTick(hostPort), this.watchIntervalMs);
    timer.unref();
    this.hostWatch = timer;
  }

  private stopHostWatch(): void {
    if (this.hostWatch !== undefined) {
      clearInterval(this.hostWatch);
      this.hostWatch = undefined;
    }
    this.hostWatchFails = 0;
  }

  private async watchTick(hostPort: number): Promise<void> {
    if (this.probing || this.takingOver) return; // no overlapping probes / takeovers
    this.probing = true;
    try {
      if (await busProbe(hostPort, this.watchTimeoutMs)) {
        this.hostWatchFails = 0;
        return;
      }
      this.hostWatchFails += 1;
      if (this.hostWatchFails < this.watchFailThreshold) {
        console.warn(
          `[moamcp] reuse: host Bus probe failed at http://127.0.0.1:${hostPort}/ ` +
            `(${this.hostWatchFails}/${this.watchFailThreshold})`,
        );
        return;
      }
      this.stopHostWatch();
      console.warn(
        `[moamcp] reuse: host Bus at http://127.0.0.1:${hostPort}/ declared dead after ` +
          `${this.watchFailThreshold} consecutive probe failures; attempting takeover`,
      );
      await this.attemptTakeover(hostPort);
    } catch (err) {
      // A watchdog bug must never take the server down with it.
      console.warn(`[moamcp] reuse: host watch error: ${(err as Error).message}`);
    } finally {
      this.probing = false;
    }
  }

  /**
   * Dead-host takeover: re-run the normal start flow (register → bind walk
   * from the requested port → write back the bound port). The atomicity of
   * the bind is the race arbiter when several reusers declare death at
   * once: the one that wins the contested port becomes the owner — its
   * registry entry is restored and events are served locally. A loser goes
   * through the usual reuse lookup (registry entry + live pid + HTTP probe,
   * so an unrelated process that grabbed the port reads as non-moamcp and
   * falls through to the port+1 walk) and re-enters reuse mode under the
   * new owner. A bind failure (walk exhausted) leaves us in reuse mode on
   * the dead port — events keep dropping with a warning — and retries on
   * the next watch cycle.
   */
  private async attemptTakeover(deadPort: number): Promise<void> {
    this.takingOver = true;
    try {
      await this.start();
      if (this.stopped) {
        // Shut down mid-takeover: tear down whatever just got bound.
        await this.stop().catch(() => {});
        return;
      }
      this.onTakeover?.(this.startResult);
    } catch (err) {
      console.warn(
        `[moamcp] takeover: bind failed (${(err as Error).message}); ` +
          'staying in reuse mode, retrying on the next watch cycle',
      );
      this.startHostWatch(deadPort);
    } finally {
      this.takingOver = false;
    }
  }

  private async handle(req: import('node:http').IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FRONTEND_HTML);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/tasks') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ tasks: this.activeTasks() }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/subscribe') {
      const taskId = url.searchParams.get('task_id');
      if (!taskId) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'task_id query param required' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(':ok\n\n');
      for (const frame of this.eventLog.get(taskId) ?? []) res.write(frame); // replay
      let subs = this.subscribers.get(taskId);
      if (!subs) this.subscribers.set(taskId, (subs = new Set()));
      subs.add(res);
      req.on('close', () => {
        subs.delete(res);
        if (subs.size === 0) this.subscribers.delete(taskId);
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/archive') {
      const taskId = url.searchParams.get('task_id') ?? '';
      const file = url.searchParams.get('file') ?? '';
      const contentType = ARCHIVE_FILES[file];
      if (!taskId || /[\\/]|\.\./.test(taskId) || !contentType) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'valid task_id and file (result.json|probe.json|events.jsonl) required' }));
        return;
      }
      try {
        const content = await readFile(resolve(this.logsDir, taskId, file), 'utf8');
        res.writeHead(200, { 'content-type': contentType });
        res.end(content);
      } catch {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'archive not found' }));
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/publish') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { task_id: taskId, event } = JSON.parse(body) as { task_id?: string; event?: Record<string, unknown> };
      if (!taskId || !event) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'body must be {task_id, event}' }));
        return;
      }
      this.publish(taskId, event);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
}
