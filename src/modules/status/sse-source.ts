import type { OmkcEvent } from './state.js';

/** omkc embedded status source: probe window and identity contract. */
export const OMKC_PROBE_MIN = 39631;
export const OMKC_PROBE_MAX = 39731;
export const OMKC_PRODUCT = 'omkc-status-source';
/**
 * Highest `status-protocol-v1` major this service consumes from an embedded
 * source's /health. A source advertising an unknown future major (> 1) is
 * skipped so probing continues to other ports (and degrades to wire-only if it
 * was the only source); a source advertising no version at all is legacy v0.
 */
export const OMKC_PROTOCOL_VERSION_MAX = 1;
/**
 * Read-idle timeout for the /events stream (F1, batch 1b): the server emits
 * `: heartbeat` comment frames every 15s, so 3×15s without a single byte means
 * the stream is dead. Timed by bytes, not event frames — a heartbeat must keep
 * the stream alive without ever triggering onEvent.
 */
export const READ_IDLE_TIMEOUT_MS = 3 * 15_000;

export interface OmkcSourceInfo {
  port: number;
  pid?: number;
  version?: string;
  /** status-protocol major advertised on /health; undefined for legacy v0. */
  protocolVersion?: number;
  /** true when the source advertised no protocolVersion (pre-v1, legacy v0). */
  legacy?: boolean;
}

export interface OmkcSourceStatus {
  connected: boolean;
  port: number | null;
  pid: number | null;
  version: string | null;
  connectedAt: number | null;
  protocolVersion: number | null;
  legacy: boolean;
}

/**
 * Classify an embedded source's /health body per `status-protocol-v1`: only a
 * matching product counts; a missing `protocolVersion` is legacy v0 (accepted);
 * `1` is accepted; an unknown future major (> OMKC_PROTOCOL_VERSION_MAX) is
 * rejected (null) so the probe skips this port and tries the others.
 */
export function classifySourceHealth(
  body: Record<string, unknown>,
  port: number,
): OmkcSourceInfo | null {
  if (body.ok !== true || body.product !== OMKC_PRODUCT) return null;
  const protocolVersion =
    typeof body.protocolVersion === 'number' ? body.protocolVersion : undefined;
  if (protocolVersion !== undefined && protocolVersion > OMKC_PROTOCOL_VERSION_MAX) return null;
  return {
    port,
    pid: typeof body.pid === 'number' ? body.pid : undefined,
    version: typeof body.version === 'string' ? body.version : undefined,
    protocolVersion,
    legacy: protocolVersion === undefined,
  };
}

export interface OmkcSourceOptions {
  probeMin?: number;
  probeMax?: number;
  /** Health probe interval while disconnected (default 5000ms). */
  probeIntervalMs?: number;
  /** Per-port /health timeout (default 200ms). */
  probeTimeoutMs?: number;
  /** Read-idle timeout for the /events stream (default READ_IDLE_TIMEOUT_MS). */
  readIdleTimeoutMs?: number;
  /** Every SSE `data:` frame from the omkc source. */
  onEvent: (raw: string, ev: OmkcEvent | null) => void;
  onConnect?: (info: OmkcSourceInfo) => void;
  onDisconnect?: (info: OmkcSourceInfo) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enhanced source ②: discovers the omkc fork's embedded status endpoint by
 * probing 127.0.0.1:39631..39731 /health (200ms per-port timeout, all ports
 * in parallel) every 5s; only a body with product == "omkc-status-source"
 * counts. Once found, subscribes to /events (SSE) and forwards every frame.
 * When the stream drops, the service falls back to pure wire-watcher mode
 * and resumes probing.
 *
 * onDisconnect fires on ANY teardown of an established connection — an
 * abnormal drop, a read-idle timeout, or a deliberate stop() all take the
 * same path. Consumers must not rely on it to distinguish stop() from an
 * error; stop() itself never rejects.
 */
export class OmkcSource {
  private readonly probeMin: number;
  private readonly probeMax: number;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly readIdleTimeoutMs: number;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private current: OmkcSourceInfo | null = null;
  private connectedAt: number | null = null;
  /**
   * Loop generation (F7, batch 1b): bumped on every start()/stop(). Each
   * loop() captures its own generation and exits as soon as it no longer
   * matches, so a stop() → start() without awaiting stop() can never leave
   * two loops alive and subscribing concurrently.
   */
  private generation = 0;

  constructor(private readonly opts: OmkcSourceOptions) {
    this.probeMin = opts.probeMin ?? OMKC_PROBE_MIN;
    this.probeMax = opts.probeMax ?? OMKC_PROBE_MAX;
    this.probeIntervalMs = opts.probeIntervalMs ?? 5000;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 200;
    this.readIdleTimeoutMs = opts.readIdleTimeoutMs ?? READ_IDLE_TIMEOUT_MS;
  }

  get status(): OmkcSourceStatus {
    return {
      connected: this.current !== null,
      port: this.current?.port ?? null,
      pid: this.current?.pid ?? null,
      version: this.current?.version ?? null,
      connectedAt: this.connectedAt,
      protocolVersion: this.current?.protocolVersion ?? null,
      legacy: this.current?.legacy ?? false,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    const gen = this.generation;
    this.loopPromise = this.loop(gen);
  }

  async stop(): Promise<void> {
    // Async signature, but never rejects (batch 1b F6): every await below is
    // caught, so callers can fire-and-forget with `void source.stop()`.
    this.running = false;
    this.generation += 1; // F7: invalidate any in-flight loop from an earlier start()
    this.abort?.abort();
    await this.loopPromise?.catch(() => undefined);
  }

  private async loop(gen: number): Promise<void> {
    while (this.running && gen === this.generation) {
      const found = await this.probe();
      if (!this.running || gen !== this.generation) break;
      if (found) {
        try {
          await this.subscribe(found);
        } catch {
          // fall through: back to probing
        }
        if (this.current) {
          const info = this.current;
          this.current = null;
          this.connectedAt = null;
          this.opts.onDisconnect?.(info);
        }
        // F3 (batch 0.6.1): a stop() landing mid-connection would otherwise
        // make this branch wait out the full probeIntervalMs before the loop
        // notices running=false. Break out immediately instead; normal
        // operation keeps running=true, so the F4 reconnect throttle below is
        // unaffected.
        if (!this.running || gen !== this.generation) break;
        // F4 (deviation from omkc-status): the original looped straight back
        // into probe() when a subscribe ended, so a source that accepts
        // /events but immediately closes caused a tight probe→subscribe→probe
        // spin. Throttle this branch with the same probeIntervalMs sleep the
        // not-found branch uses. Cost: after a CLI restart, reconnecting to a
        // healthy source waits at most probeIntervalMs.
        await sleep(this.probeIntervalMs);
      } else {
        await sleep(this.probeIntervalMs);
      }
    }
  }

  /** Probe the whole port window in parallel; first product match wins. */
  private async probe(): Promise<OmkcSourceInfo | null> {
    const ports: number[] = [];
    for (let p = this.probeMin; p <= this.probeMax; p++) ports.push(p);
    const results = await Promise.all(ports.map((p) => this.tryHealth(p)));
    return results.find((r) => r !== null) ?? null;
  }

  private async tryHealth(port: number): Promise<OmkcSourceInfo | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.probeTimeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
      if (!res.ok) return null;
      return classifySourceHealth((await res.json()) as Record<string, unknown>, port);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async subscribe(info: OmkcSourceInfo): Promise<void> {
    this.abort = new AbortController();
    // P1 (batch 0.6.1): a server that accepts /events over TCP but never
    // writes HTTP headers would otherwise leave fetch() hanging until
    // undici's default header timeout (~300s) — far past the read-idle
    // budget. Race the header stage against a per-attempt AbortController on
    // the same idle budget as the read stage (header stage and read stage
    // share the same idle budget), and link it to this.abort so stop() tears
    // the attempt down too.
    const attempt = new AbortController();
    const linkAbort = () => attempt.abort();
    this.abort.signal.addEventListener('abort', linkAbort);
    const headerTimer = setTimeout(() => attempt.abort(), this.readIdleTimeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/events`, {
        signal: attempt.signal,
        headers: { Accept: 'text/event-stream' },
      });
      clearTimeout(headerTimer);
      if (!res.ok || !res.body) throw new Error(`omkc /events: HTTP ${res.status}`);
      this.current = info;
      this.connectedAt = Date.now();
      this.opts.onConnect?.(info);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let dataLines: string[] = [];
      let idleTimer: NodeJS.Timeout | null = null;
      const flush = () => {
        if (dataLines.length === 0) return;
        const raw = dataLines.join('\n');
        dataLines = [];
        let parsed: OmkcEvent | null = null;
        try {
          parsed = JSON.parse(raw) as OmkcEvent;
        } catch {
          // forward raw anyway
        }
        this.opts.onEvent(raw, parsed);
      };
      try {
        for (;;) {
          // F1 (deviation from omkc-status): race every read against a read-idle
          // timer. The server's `: heartbeat` comment frames (15s) keep the
          // stream alive, so the timeout means no bytes at all for
          // READ_IDLE_TIMEOUT_MS — abort the stream and let the caller fall back
          // to probing. Timed by bytes, not frames: heartbeats reset it without
          // ever reaching onEvent.
          const idle = new Promise<'idle'>((resolve) => {
            idleTimer = setTimeout(() => resolve('idle'), this.readIdleTimeoutMs);
          });
          const chunk = await Promise.race([reader.read(), idle]);
          if (idleTimer) clearTimeout(idleTimer);
          if (chunk === 'idle') {
            this.abort?.abort();
            throw new Error(`omkc /events: no bytes for ${this.readIdleTimeoutMs}ms (read idle timeout)`);
          }
          const { done, value } = chunk;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line === '' || line === '\r') {
              flush();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).replace(/^ /, '').replace(/\r$/, ''));
            }
            // event:/id:/comment lines are ignored; frames are data-only
          }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        // F8 removed (batch 0.6.1): the former `buffer += decoder.decode()`
        // flush at stream end was proven a no-op — TextDecoder's stream mode
        // already re-assembles multi-byte characters split across chunk
        // boundaries, and an unterminated final line was never flushed anyway.
        // A side-by-side run with and without the line showed identical
        // observable behavior, so it is deleted rather than kept as dead code.
        flush();
        reader.releaseLock();
      }
    } finally {
      // Always drop the per-attempt abort link when the attempt ends; leaving
      // one listener per attempt across reconnect cycles would pile them up.
      clearTimeout(headerTimer);
      this.abort.signal.removeEventListener('abort', linkAbort);
    }
  }
}
