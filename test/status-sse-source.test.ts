/**
 * omkc-status/src/sse-source.test.ts port (classify + probe selection) plus
 * batch-1b regressions: SSE frame parsing (split chunks, CRLF, multi-line,
 * comments), F1 read-idle timeout, F4 reconnect throttle, F2/finiteTime fold
 * guards, F7 stop→start generation race, controller assembly, F6 takeover.
 * Batch-0.6.1 regressions: P1 header-stage timeout (never-ending /events
 * headers), F3 stop-while-connected fast exit (F8 no-op removal has no
 * observable test delta by design).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifySourceHealth,
  OMKC_PRODUCT,
  OmkcSource,
  type OmkcSourceInfo,
  type OmkcSourceOptions,
} from '../src/modules/status/sse-source.js';
import { StateFold, type OmkcEvent } from '../src/modules/status/state.js';
import { createStatusController } from '../src/modules/status/index.js';
import { syncStatusOnTakeover } from '../src/server.js';

async function waitFor(cond: () => boolean, ms = 5000, step = 20): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('waitFor timed out');
}

/** A valid omkc /health body (status-protocol-v1). */
function health(): Record<string, unknown> {
  return { ok: true, product: OMKC_PRODUCT, protocolVersion: 1, version: '1.0.0', pid: 7 };
}

/** Per-mock /events connection bookkeeping. */
export interface MockEventsCtx {
  connections: number;
  connectTimes: number[];
  active: number;
  maxActive: number;
  closes: number;
}

export interface MockSource {
  port: number;
  ctx: MockEventsCtx;
  close(): Promise<void>;
}

function mockHandler(
  body: Record<string, unknown>,
  onEvents: ((res: http.ServerResponse, ctx: MockEventsCtx) => void) | undefined,
  ctx: MockEventsCtx,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // writeHead alone buffers headers until the first write()/end() — the
      // client's fetch would never resolve and subscribe() would hang before
      // reaching its read loop. Flush explicitly so a held-open, byte-silent
      // stream (idle-timeout tests) still establishes the connection.
      res.flushHeaders();
      ctx.connections++;
      ctx.connectTimes.push(Date.now());
      ctx.active++;
      ctx.maxActive = Math.max(ctx.maxActive, ctx.active);
      res.on('close', () => {
        ctx.active--;
        ctx.closes++;
      });
      onEvents?.(res, ctx);
      return;
    }
    res.writeHead(404);
    res.end();
  };
}

/** Mock omkc source on a random localhost port. */
function startMockSource(
  body: Record<string, unknown>,
  onEvents?: (res: http.ServerResponse, ctx: MockEventsCtx) => void,
): Promise<MockSource> {
  return new Promise((resolve) => {
    const ctx: MockEventsCtx = {
      connections: 0,
      connectTimes: [],
      active: 0,
      maxActive: 0,
      closes: 0,
    };
    const server = http.createServer(mockHandler(body, onEvents, ctx));
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        ctx,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

/** Try to bind a mock source on a specific port; null on EADDRINUSE. */
function startMockSourceOn(
  port: number,
  body: Record<string, unknown>,
  onEvents?: (res: http.ServerResponse, ctx: MockEventsCtx) => void,
): Promise<MockSource | null> {
  return new Promise((resolve) => {
    const ctx: MockEventsCtx = {
      connections: 0,
      connectTimes: [],
      active: 0,
      maxActive: 0,
      closes: 0,
    };
    const server = http.createServer(mockHandler(body, onEvents, ctx));
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        ctx,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

/**
 * Mock source whose /events handler accepts the TCP connection but never
 * writes HTTP headers (P1): fetch() hangs until the source's header-stage
 * timeout aborts the attempt. /health probes are timestamped so a test can
 * assert the fallback to probing.
 */
function startSilentEventsMock(
  body: Record<string, unknown>,
): Promise<{ port: number; ctx: MockEventsCtx; healthProbes: number[]; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const ctx: MockEventsCtx = {
      connections: 0,
      connectTimes: [],
      active: 0,
      maxActive: 0,
      closes: 0,
    };
    const healthProbes: number[] = [];
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        healthProbes.push(Date.now());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      if (req.url === '/events') {
        ctx.connections++;
        ctx.connectTimes.push(Date.now());
        ctx.active++;
        ctx.maxActive = Math.max(ctx.maxActive, ctx.active);
        res.on('close', () => {
          ctx.active--;
          ctx.closes++;
        });
        return; // accept the socket, never writeHead/flushHeaders/end
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        ctx,
        healthProbes,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

/** Run a probe over [probeMin, probeMax] and resolve with the first source
 *  OmkcSource connects to; reject if nothing connects within timeoutMs. */
function connectOnce(probeMin: number, probeMax: number, timeoutMs: number): Promise<OmkcSourceInfo> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const source = new OmkcSource({
      probeMin,
      probeMax,
      probeIntervalMs: 50,
      probeTimeoutMs: 100,
      onEvent: () => {},
      onConnect: (info) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void source.stop().then(() => resolve(info));
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void source.stop().then(() => reject(new Error(`no connect within ${timeoutMs}ms`)));
    }, timeoutMs);
    source.start();
  });
}

/** OmkcSource wired to short, injectable timings + recording callbacks. */
function makeSource(extra: Partial<OmkcSourceOptions> & { probePort: number }) {
  const { probePort, ...opts } = extra;
  const events: Array<{ raw: string; ev: OmkcEvent | null }> = [];
  const connects: OmkcSourceInfo[] = [];
  const disconnects: OmkcSourceInfo[] = [];
  const disconnectAt: number[] = [];
  const source = new OmkcSource({
    probeMin: probePort,
    probeMax: probePort,
    probeIntervalMs: 60,
    probeTimeoutMs: 100,
    readIdleTimeoutMs: 200,
    onEvent: (raw, ev) => events.push({ raw, ev }),
    onConnect: (info) => connects.push(info),
    onDisconnect: (info) => {
      disconnects.push(info);
      disconnectAt.push(Date.now());
    },
    ...opts,
  });
  return {
    source,
    events,
    connects,
    disconnects,
    disconnectAt,
    stop: () => source.stop(),
  };
}

describe('classifySourceHealth (status-protocol-v1)', () => {
  it('accepts a legacy v0 body with no protocolVersion', () => {
    const info = classifySourceHealth(
      { ok: true, product: OMKC_PRODUCT, version: '0.0.0', pid: 7 },
      39631,
    );
    expect(info).toEqual({
      port: 39631,
      pid: 7,
      version: '0.0.0',
      protocolVersion: undefined,
      legacy: true,
    });
  });

  it('accepts protocolVersion 1', () => {
    const info = classifySourceHealth(
      { ok: true, product: OMKC_PRODUCT, protocolVersion: 1, version: '1.0.0', pid: 7 },
      39631,
    );
    expect(info).toEqual({
      port: 39631,
      pid: 7,
      version: '1.0.0',
      protocolVersion: 1,
      legacy: false,
    });
  });

  it('rejects an unknown future major (> 1)', () => {
    expect(classifySourceHealth({ ok: true, product: OMKC_PRODUCT, protocolVersion: 2 }, 39631)).toBeNull();
  });

  it('rejects a wrong product or a non-ok body', () => {
    expect(
      classifySourceHealth({ ok: true, product: 'something-else', protocolVersion: 1 }, 39631),
    ).toBeNull();
    expect(classifySourceHealth({ ok: false, product: OMKC_PRODUCT, protocolVersion: 1 }, 39631)).toBeNull();
  });
});

describe('OmkcSource probe selection', () => {
  it('picks the lowest port among multiple matching sources', async () => {
    let low: MockSource | null = null;
    let high: MockSource | null = null;
    for (let attempt = 0; attempt < 25 && high === null; attempt++) {
      low = await startMockSource(health());
      high = await startMockSourceOn(low.port + 1, health());
      if (high === null) {
        await low.close();
        low = null;
      }
    }
    if (!low || !high) throw new Error('could not allocate a contiguous port pair');
    try {
      const info = await connectOnce(low.port, high.port, 3000);
      expect(info.port).toBe(low.port);
    } finally {
      await high.close();
      await low.close();
    }
  });

  it('skips a non-omkc-status-source product and connects to the next port', async () => {
    let low: MockSource | null = null;
    let high: MockSource | null = null;
    for (let attempt = 0; attempt < 25 && high === null; attempt++) {
      low = await startMockSource({ ok: true, product: 'something-else', protocolVersion: 1 });
      high = await startMockSourceOn(low.port + 1, health());
      if (high === null) {
        await low.close();
        low = null;
      }
    }
    if (!low || !high) throw new Error('could not allocate a contiguous port pair');
    try {
      const info = await connectOnce(low.port, high.port, 3000);
      expect(info.port).toBe(high.port);
    } finally {
      await high.close();
      await low.close();
    }
  });

  it('skips a future-major source on a lower port and connects to v1 on the next', async () => {
    let low: MockSource | null = null;
    let high: MockSource | null = null;
    for (let attempt = 0; attempt < 25 && high === null; attempt++) {
      low = await startMockSource({
        ok: true,
        product: OMKC_PRODUCT,
        protocolVersion: 2,
        version: '9.9.9',
        pid: 1,
      });
      high = await startMockSourceOn(low.port + 1, health());
      if (high === null) {
        await low.close();
        low = null;
      }
    }
    if (!low || !high) throw new Error('could not allocate a contiguous port pair');
    try {
      const info = await connectOnce(low.port, high.port, 3000);
      expect(info.port).toBe(high.port);
      expect(info.protocolVersion).toBe(1);
    } finally {
      await high.close();
      await low.close();
    }
  });
});

describe('OmkcSource /events stream', () => {
  it('forwards parsed events (raw frame + folded-before event object)', async () => {
    const ev = { ts: 1, sessionId: 's1', agentId: 'main', type: 'turn.started' };
    const mock = await startMockSource(health(), (res) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    });
    const h = makeSource({ probePort: mock.port });
    try {
      h.source.start();
      await waitFor(() => h.connects.length === 1);
      await waitFor(() => h.events.length === 1);
      expect(h.events[0].ev).toEqual(ev);
      expect(JSON.parse(h.events[0].raw)).toEqual(ev);
    } finally {
      await h.stop();
      await mock.close();
    }
  });

  it('reassembles frames split across chunks (incl. a mid-UTF-8-byte split) and handles CRLF', async () => {
    const ev1 = { ts: 1, sessionId: 's1', agentId: 'main', type: 'turn.started' };
    const ev2 = { ts: 2, sessionId: 's1', agentId: 'main', type: 'turn.ended', payload: { reason: 'completed' } };
    // ev3 ends in a 2-byte UTF-8 char ('é') that is cut mid-byte by the chunk split.
    const ev3 = { ts: 3, sessionId: 's1', agentId: 'main', type: 'agent.status.updated', payload: { model: 'a-é' } };
    const frame3 = Buffer.from(`data: ${JSON.stringify(ev3)}\n\n`, 'utf8');
    const cut = frame3.indexOf(Buffer.from('é')) + 1; // one byte into the two-byte é
    const mock = await startMockSource(health(), (res) => {
      // frame 1: split in two with a gap (plain ASCII split)
      res.write(`data: ${JSON.stringify(ev1).slice(0, 18)}`);
      setTimeout(() => {
        res.write(`${JSON.stringify(ev1).slice(18)}\n\n`);
        // frame 2: CRLF line endings
        res.write(`data: ${JSON.stringify(ev2)}\r\n\r\n`);
        // frame 3: split mid-multibyte-character
        res.write(frame3.subarray(0, cut));
      }, 30);
      setTimeout(() => {
        res.write(frame3.subarray(cut));
      }, 60);
    });
    const h = makeSource({ probePort: mock.port });
    try {
      h.source.start();
      await waitFor(() => h.events.length === 3);
      expect(h.events[0].ev).toEqual(ev1);
      expect(h.events[1].ev).toEqual(ev2);
      expect(h.events[1].raw).not.toContain('\r');
      expect(h.events[2].ev).toEqual(ev3); // é survived the mid-byte split
    } finally {
      await h.stop();
      await mock.close();
    }
  });

  it('ignores `: heartbeat` comment frames and they keep the stream alive (F1)', async () => {
    const mock = await startMockSource(health(), (res) => {
      const hb = setInterval(() => res.write(': heartbeat\n\n'), 50);
      res.on('close', () => clearInterval(hb));
    });
    const h = makeSource({ probePort: mock.port, readIdleTimeoutMs: 150 });
    try {
      h.source.start();
      await waitFor(() => h.connects.length === 1);
      // several read-idle windows' worth of heartbeats
      await new Promise((r) => setTimeout(r, 500));
      expect(h.events).toHaveLength(0); // comments never reach onEvent
      expect(h.disconnects).toHaveLength(0); // heartbeats reset the idle timer
    } finally {
      await h.stop();
      await mock.close();
    }
  });

  it('forwards unparseable frames with ev === null', async () => {
    const mock = await startMockSource(health(), (res) => {
      res.write('data: not-json-at-all\n\n');
    });
    const h = makeSource({ probePort: mock.port });
    try {
      h.source.start();
      await waitFor(() => h.events.length === 1);
      expect(h.events[0].raw).toBe('not-json-at-all');
      expect(h.events[0].ev).toBeNull();
    } finally {
      await h.stop();
      await mock.close();
    }
  });

  it('joins multi-line data blocks with \\n (the `\\ndata: ` escape reverse)', async () => {
    const mock = await startMockSource(health(), (res) => {
      res.write('data: line-one\ndata: line-two\n\n');
    });
    const h = makeSource({ probePort: mock.port });
    try {
      h.source.start();
      await waitFor(() => h.events.length === 1);
      expect(h.events[0].raw).toBe('line-one\nline-two');
      expect(h.events[0].ev).toBeNull(); // plain text, not JSON
    } finally {
      await h.stop();
      await mock.close();
    }
  });
});

describe('StateFold guards (batch-1b regressions)', () => {
  it('drops parseable frames without a string type instead of throwing (F2)', () => {
    const fold = new StateFold();
    expect(() =>
      fold.applyOmkcEvent({ ts: 1, sessionId: 's1', agentId: 'main' } as unknown as OmkcEvent),
    ).not.toThrow();
    expect(fold.agentCount).toBe(0);
    // non-string type is dropped too, not thrown
    expect(() =>
      fold.applyOmkcEvent({ ts: 2, sessionId: 's1', agentId: 'main', type: 42 } as unknown as OmkcEvent),
    ).not.toThrow();
    expect(fold.agentCount).toBe(0);
  });

  it('guards Infinity ev.ts via finiteTime (batch-1a NOTE regression)', () => {
    const fold = new StateFold({ staleMs: 1000 });
    fold.applyOmkcEvent({ ts: 1e999, sessionId: 's1', agentId: 'main', type: 'turn.started' } as OmkcEvent);
    const [agent] = fold.snapshotAgents();
    expect(Number.isFinite(agent.lastSeen)).toBe(true);
    expect(agent.busy).toBe(true); // the event itself is still applied
    fold.sweepStale(Date.now() + 2000);
    expect(fold.snapshotAgents()[0].stale).toBe(true);
    expect(JSON.stringify(fold.snapshotAgents())).not.toContain('"lastSeen":null');
  });
});

describe('OmkcSource reconnect / idle / stop lifecycle', () => {
  it('reconnects after the server closes the stream, throttled ≥ probeIntervalMs (F4)', async () => {
    const probeIntervalMs = 100;
    const mock = await startMockSource(health(), (res) => {
      res.write('data: {"ts":1,"sessionId":"s1","agentId":"main","type":"turn.started"}\n\n');
      res.end(); // server closes the stream right after the first frame
    });
    const h = makeSource({ probePort: mock.port, probeIntervalMs });
    try {
      h.source.start();
      await waitFor(() => mock.ctx.connections >= 2);
      const gap = mock.ctx.connectTimes[1] - mock.ctx.connectTimes[0];
      // without the F4 sleep the second connection would come within ~1ms
      expect(gap).toBeGreaterThanOrEqual(probeIntervalMs);
    } finally {
      await h.stop();
      await mock.close();
    }
  });

  it('treats a silent /events stream as dead and falls back to probing (F1)', async () => {
    const mock = await startMockSource(health()); // never writes a byte
    const h = makeSource({ probePort: mock.port, readIdleTimeoutMs: 120, probeIntervalMs: 60 });
    try {
      h.source.start();
      await waitFor(() => h.connects.length === 1);
      await waitFor(() => h.disconnects.length === 1, 5000);
      const idleMs = h.disconnectAt[0] - mock.ctx.connectTimes[0];
      expect(idleMs).toBeGreaterThanOrEqual(80); // ≈ readIdleTimeoutMs
      expect(idleMs).toBeLessThan(500);
      // back to probing: it tries /events again (and times out again)
      await waitFor(() => mock.ctx.connections >= 2, 5000);
    } finally {
      await h.stop();
      await mock.close();
    }
  });

  it('aborts a /events attempt whose headers never arrive and falls back to probing (P1)', async () => {
    const readIdleTimeoutMs = 150;
    const probeIntervalMs = 60;
    const mock = await startSilentEventsMock(health());
    const h = makeSource({ probePort: mock.port, readIdleTimeoutMs, probeIntervalMs });
    try {
      h.source.start();
      // The first /events attempt hangs on headers; the per-attempt header
      // timeout (same idle budget as the read stage) must abort it and loop
      // back to probing. Without it, undici's default header timeout (~300s)
      // would stall the attempt and no second /health probe would arrive
      // within the 5s waitFor deadline.
      await waitFor(() => mock.healthProbes.length >= 2, 5000);
      const gap = mock.healthProbes[1] - mock.healthProbes[0];
      // ≈ readIdleTimeoutMs (header hang) + probeIntervalMs (F4 throttle)
      expect(gap).toBeLessThan(2 * readIdleTimeoutMs + probeIntervalMs);
      // the hanging attempt reached the server but never became a connection
      expect(mock.ctx.connections).toBeGreaterThanOrEqual(1);
      expect(h.connects).toHaveLength(0);
      expect(h.disconnects).toHaveLength(0);
    } finally {
      await h.stop();
      await mock.close();
    }
  });

  it('stop() during the probe sleep exits within ~2×probeIntervalMs', async () => {
    // Grab a port and free it: nothing listens there, so the source stays in
    // the not-found probe→sleep branch forever.
    const probe = await startMockSource(health());
    const probePort = probe.port;
    await probe.close();
    const h = makeSource({ probePort, probeIntervalMs: 300, probeTimeoutMs: 50 });
    h.source.start();
    // let the first probe round finish; the loop is now inside the sleep
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    await h.stop();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2 * 300);
  });

  it('stop() while connected exits without waiting out a probe interval (F3)', async () => {
    const probeIntervalMs = 120;
    const mock = await startMockSource(health()); // /events held open, byte-silent
    const h = makeSource({ probePort: mock.port, probeIntervalMs });
    try {
      h.source.start();
      await waitFor(() => h.connects.length === 1);
      const t0 = Date.now();
      await h.stop();
      const elapsed = Date.now() - t0;
      // Without the F3 short-circuit the loop would wait out a full
      // probeIntervalMs after the disconnect before exiting; the 2× bound
      // leaves headroom for CI jitter on the (much faster) fixed path.
      expect(elapsed).toBeLessThan(2 * probeIntervalMs);
    } finally {
      await mock.close();
    }
  });
});

describe('OmkcSource stop→start race (F7)', () => {
  it('never runs two subscriptions concurrently after an unawaited restart', async () => {
    const mock = await startMockSource(health(), (res) => {
      res.write(': mock\n\n'); // hold open until the client aborts
    });
    const h = makeSource({ probePort: mock.port, probeIntervalMs: 50 });
    try {
      h.source.start();
      await waitFor(() => mock.ctx.connections === 1);
      // restart without awaiting stop(): the old generation must die on its
      // own, otherwise it would subscribe again alongside the new one.
      h.source.stop();
      h.source.start();
      await waitFor(() => mock.ctx.connections >= 2, 5000);
      // give any stale loop time to attempt a third connection
      await new Promise((r) => setTimeout(r, 3 * 50 + 50));
      expect(mock.ctx.connections).toBeLessThanOrEqual(2);
      expect(mock.ctx.maxActive).toBeLessThanOrEqual(1);
      expect(h.connects).toHaveLength(2); // old + new generation, exactly
    } finally {
      await h.stop();
      await mock.close();
    }
  });
});

describe('StatusController assembly (batch 1b)', () => {
  it('start() raises the omkc source into the fold; stop() stays synchronous', async () => {
    const mock = await startMockSource(health(), (res) => {
      res.write('data: {"ts":1,"sessionId":"s1","agentId":"main","type":"turn.started"}\n\n');
    });
    const missing = join(tmpdir(), 'moamcp-ctrl-missing');
    const controller = createStatusController({
      env: { OMKC_HOME: `${missing}-omkc`, KIMI_CODE_HOME: `${missing}-kimi` } as NodeJS.ProcessEnv,
      omkcProbeMin: mock.port,
      omkcProbeMax: mock.port,
      omkcProbeIntervalMs: 50,
      omkcProbeTimeoutMs: 100,
    });
    expect(controller.isStarted()).toBe(false);
    expect(mock.ctx.connections).toBe(0); // no probing before start()
    controller.start();
    expect(controller.isStarted()).toBe(true);
    await waitFor(() => controller.getFold().agentCount >= 1);
    const [agent] = controller.getFold().snapshotAgents();
    expect(agent.busy).toBe(true); // turn.started arrived over SSE and folded
    expect(agent.source).toBe('omkc');
    expect(mock.ctx.connections).toBe(1);
    // stop() keeps its synchronous signature (F5): no promise returned.
    expect(controller.stop()).toBeUndefined();
    expect(controller.isStarted()).toBe(false);
  });

  it('syncStatusOnTakeover starts on own and stops on reuse, idempotently (F6/F1)', () => {
    const missing = join(tmpdir(), 'moamcp-takeover-missing');
    const controller = createStatusController({
      env: { OMKC_HOME: `${missing}-omkc`, KIMI_CODE_HOME: `${missing}-kimi` } as NodeJS.ProcessEnv,
      omkcProbeMin: 40000,
      omkcProbeMax: 40000,
      omkcProbeIntervalMs: 50,
      omkcProbeTimeoutMs: 50,
    });
    // reuse never starts the controller
    syncStatusOnTakeover({ mode: 'reuse', port: 1 }, controller);
    expect(controller.isStarted()).toBe(false);
    // own starts it
    syncStatusOnTakeover({ mode: 'own', port: 1 }, controller);
    expect(controller.isStarted()).toBe(true);
    // own→own re-takeover is idempotent
    syncStatusOnTakeover({ mode: 'own', port: 2 }, controller);
    expect(controller.isStarted()).toBe(true);
    // own→reuse stops it (batch 1c P3)
    syncStatusOnTakeover({ mode: 'reuse', port: 2 }, controller);
    expect(controller.isStarted()).toBe(false);
    // reuse→reuse re-takeover is idempotent
    syncStatusOnTakeover({ mode: 'reuse', port: 2 }, controller);
    expect(controller.isStarted()).toBe(false);
    // and a later own re-takeover restarts it
    syncStatusOnTakeover({ mode: 'own', port: 3 }, controller);
    expect(controller.isStarted()).toBe(true);
    controller.stop();
  });
});
