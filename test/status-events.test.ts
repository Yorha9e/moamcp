/**
 * 0.8.0 P3/P5: the /status/events SSE push face. Real controller + temp home +
 * real Bus for the wire-level contract (503, snapshot first frame, agent
 * frames after a fold mutation, ACAO, disconnect cleanup); a fake-response
 * harness for the heartbeat and the slow-client backlog destroy — the fake
 * makes the backlog boundary deterministic, since real socket buffer sizes
 * are OS-dependent. All timing checks are convergent with generous margins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/core/bus/bus.js';
import {
  createStatusController,
  statusRoutes,
  type StatusController,
} from '../src/modules/status/index.js';
import type { MoaRouteContext } from '../src/modules/types.js';

async function waitFor(cond: () => boolean, ms = 5000, step = 20): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('waitFor timed out');
}

/** Parse a raw SSE byte buffer into frames; returns the unparsed tail. */
interface SseFrame {
  event?: string;
  data?: string;
  comment?: string;
}

function parseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const frames = parts.map((block) => {
    const out: SseFrame = {};
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) out.comment = line.slice(1).trim();
      else if (line.startsWith('event:')) out.event = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        out.data = (out.data === undefined ? '' : `${out.data}\n`) + line.slice(5).replace(/^ /, '');
      }
    }
    return out;
  });
  return { frames, rest };
}

/** Read SSE frames from a fetch response until `predicate` matches (or timeout).
 *  On success the reader is canceled so the server sees the client close —
 *  callers must not also call res.body.cancel() (the stream stays locked). */
async function readFrames(
  res: Response,
  predicate: (frames: SseFrame[]) => boolean,
  timeoutMs = 5000,
): Promise<SseFrame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const frames: SseFrame[] = [];
  const deadline = Date.now() + timeoutMs;
  const finish = async (): Promise<SseFrame[]> => {
    await reader.cancel().catch(() => undefined);
    return frames;
  };
  for (;;) {
    if (predicate(frames)) return finish();
    if (Date.now() > deadline) throw new Error('readFrames timed out');
    const { done, value } = await reader.read();
    if (done) return frames;
    text += decoder.decode(value, { stream: true });
    const parsed = parseFrames(text);
    frames.push(...parsed.frames);
    text = parsed.rest;
  }
}

/** Hermetic controller: never watches a real ~/.omkc or probes a real omkc. */
function makeController(home?: string): StatusController {
  const missing = join(tmpdir(), 'moamcp-status-events-missing');
  return createStatusController({
    env: home
      ? ({ OMKC_HOME: home, KIMI_CODE_HOME: `${home}.missing-kimi` } as NodeJS.ProcessEnv)
      : ({ OMKC_HOME: `${missing}-omkc`, KIMI_CODE_HOME: `${missing}-kimi` } as NodeJS.ProcessEnv),
    scanIntervalMs: 40,
    pollIntervalMs: 15,
    omkcProbeMin: 40000,
    omkcProbeMax: 40000,
    omkcProbeIntervalMs: 5000,
    omkcProbeTimeoutMs: 50,
  });
}

async function writeWire(home: string, sessionId: string, agentId: string, time: number): Promise<void> {
  const dir = join(home, 'sessions', 'wd_x', sessionId, 'agents', agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'wire.jsonl'), `${JSON.stringify({ type: 'turn.prompt', time })}\n`);
}

async function appendWire(home: string, sessionId: string, agentId: string, time: number): Promise<void> {
  const file = join(home, 'sessions', 'wd_x', sessionId, 'agents', agentId, 'wire.jsonl');
  await writeFile(file, `${JSON.stringify({ type: 'turn.prompt', time })}\n`, { flag: 'a' });
}

/** Minimal fake MoaRouteContext for the heartbeat/backlog tests. */
function makeFakeCtx(opts: { writeReturns?: boolean } = {}) {
  const writes: string[] = [];
  const closeHandlers: Array<() => void> = [];
  let destroyed = false;
  const res = {
    setHeader: () => undefined,
    writeHead: () => undefined,
    write: (frame: string) => {
      writes.push(frame);
      return opts.writeReturns ?? true;
    },
    once: () => undefined,
    on: () => undefined,
    destroy: () => {
      destroyed = true;
    },
    end: () => undefined,
  };
  const req = {
    on: (ev: string, cb: () => void) => {
      if (ev === 'close') closeHandlers.push(cb);
    },
  };
  const ctx = {
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    url: new URL('http://127.0.0.1/status/events'),
    sendJson: () => undefined,
  } as unknown as MoaRouteContext;
  return { ctx, writes, closeHandlers, isDestroyed: () => destroyed };
}

describe('/status/events (0.8.0)', () => {
  let home: string;
  let bus: Bus;
  let controller: StatusController | undefined;

  afterEach(async () => {
    controller?.stop();
    await bus?.stop();
    if (home) await rm(home, { recursive: true, force: true });
    controller = undefined;
    home = undefined;
    bus = undefined as unknown as Bus;
  });

  async function startBus(ctrl: StatusController): Promise<number> {
    controller = ctrl;
    // The controller's temp home may already exist (tests that fold agents
    // before starting the Bus); keep it — the Bus only needs a cwd for bus.port.
    if (home === undefined) home = await mkdtemp(join(tmpdir(), 'moamcp-status-events-'));
    bus = new Bus({
      port: 0,
      cwd: home,
      instancesDir: join(home, 'instances'),
      logsDir: join(home, 'logs'),
      statusController: ctrl,
    });
    return bus.start();
  }

  it('503s like /status (status_not_ready + ACAO + Retry-After) while not started', async () => {
    const ctrl = makeController();
    const port = await startBus(ctrl);
    const res = await fetch(`http://127.0.0.1:${port}/status/events`);
    expect(res.status).toBe(503);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('retry-after')).toBe('2');
    expect(await res.json()).toEqual({ error: 'status_not_ready', started: false });
  });

  it('opens with a full snapshot frame identical to GET /status + ACAO', async () => {
    const ctrl = makeController();
    const port = await startBus(ctrl);
    ctrl.setPort(port);
    ctrl.start();
    const res = await fetch(`http://127.0.0.1:${port}/status/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readFrames(res, (fs) => fs.length >= 1);
    expect(frames[0].event).toBe('snapshot');
    const snap = JSON.parse(frames[0].data!);
    // same top-level shape as GET /status
    expect(Object.keys(snap).sort()).toEqual(['agents', 'scan', 'server', 'sessions', 'sources']);
    expect(snap.server).toMatchObject({ pid: process.pid, port });
    expect(Array.isArray(snap.agents)).toBe(true);
  });

  it('emits one single-agent frame per changed agent after a fold mutation', async () => {
    home = await mkdtemp(join(tmpdir(), 'moamcp-status-events-'));
    const ctrl = makeController(home);
    await writeWire(home, 'sess-1', 'main', 1000);
    ctrl.start();
    await waitFor(() => ctrl.getFold().agentCount >= 1);
    await waitFor(() => ctrl.scanStatus().homes.every((h) => h.catchingUp === 0));
    const port = await startBus(ctrl);
    ctrl.setPort(port);
    const res = await fetch(`http://127.0.0.1:${port}/status/events`);
    // wait until an agent frame arrives (the post-catch-up append below)
    await appendWire(home, 'sess-1', 'main', 2000);
    const frames = await readFrames(res, (fs) => fs.some((f) => f.event === 'agent'));
    expect(frames[0].event).toBe('snapshot'); // snapshot always comes first
    const agentFrames = frames.filter((f) => f.event === 'agent');
    expect(agentFrames.length).toBeGreaterThanOrEqual(1);
    const agent = JSON.parse(agentFrames[0].data!);
    expect(agent.sessionId).toBe('sess-1');
    expect(agent.agentId).toBe('main');
    expect(agent.busy).toBe(true); // turn.prompt folded
    expect(agent).not.toHaveProperty('agents'); // single agent, not a snapshot
  });

  it('emits a heartbeat comment frame on the configured cadence and stops on close', async () => {
    const ctrl = makeController();
    ctrl.start();
    const h = makeFakeCtx();
    const route = statusRoutes(ctrl, { heartbeatMs: 20 }).find((r) => r.path === '/status/events')!;
    route.handler(h.ctx);
    expect(ctrl.statusSubscriberCount()).toBe(1);
    // snapshot frame lands first, then heartbeats every 20ms
    expect(h.writes[0].startsWith('event: snapshot')).toBe(true);
    await waitFor(() => h.writes.some((w) => w.startsWith(': heartbeat')));
    // closing the request unsubscribes and stops the heartbeat timer
    for (const cb of h.closeHandlers) cb();
    expect(ctrl.statusSubscriberCount()).toBe(0);
    const writesAtClose = h.writes.length;
    await new Promise((r) => setTimeout(r, 80)); // several heartbeat windows
    expect(h.writes.length).toBe(writesAtClose);
  });

  it('destroys a subscriber whose undrained frame backlog exceeds the threshold', async () => {
    home = await mkdtemp(join(tmpdir(), 'moamcp-status-events-'));
    const ctrl = makeController(home);
    // 4 agents folded + caught up first (initial bulk read is suppressed)
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
      await writeWire(home, 'sess-1', id, 1000 + i);
    }
    ctrl.start();
    await waitFor(() => ctrl.getFold().agentCount >= 4);
    await waitFor(() => ctrl.scanStatus().homes.every((h) => h.catchingUp === 0));
    // appends after catch-up -> real broadcast marks -> agent frames
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
      await appendWire(home, 'sess-1', id, 2000 + i);
    }
    // fake response that never drains: every write reports backpressure
    const h = makeFakeCtx({ writeReturns: false });
    const route = statusRoutes(ctrl, { maxBacklog: 3 }).find((r) => r.path === '/status/events')!;
    route.handler(h.ctx);
    // snapshot (1) + agent frames push the undrained count past 3 -> destroy
    await waitFor(() => h.isDestroyed());
    // the destroy leads to req close -> unsubscribe cleanup
    for (const cb of h.closeHandlers) cb();
    expect(ctrl.statusSubscriberCount()).toBe(0);
  });

  it('unsubscribes and leaves no leak when the client disconnects', async () => {
    const ctrl = makeController();
    const port = await startBus(ctrl);
    ctrl.setPort(port);
    ctrl.start();
    const res = await fetch(`http://127.0.0.1:${port}/status/events`);
    await readFrames(res, (fs) => fs.length >= 1); // snapshot confirms the subscription
    expect(ctrl.statusSubscriberCount()).toBe(1);
    // readFrames cancels the reader on success -> the server sees the client
    // close and must unsubscribe
    await waitFor(() => ctrl.statusSubscriberCount() === 0);
    // a later mutation does not resurrect the dead subscription
    await new Promise((r) => setTimeout(r, 120));
    expect(ctrl.statusSubscriberCount()).toBe(0);
  });
});
