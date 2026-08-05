/**
 * Batch 1c P2: the read-only status REST surface. GET /status mirrors the
 * omkc-status /state snapshot once the controller is started, and 503s with
 * Retry-After: 2 (status_not_ready) while the controller is missing or not
 * started; GET /health is the Bus-level fast-fail health. Both read-only
 * endpoints carry Access-Control-Allow-Origin: * (the write endpoints keep
 * checkOrigin). Also covers the injection seam: a Bus without a status
 * controller serves /status 503 without throwing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/core/bus/bus.js';
import { createStatusController, type StatusController } from '../src/modules/status/index.js';

describe('status REST surface (batch 1c)', () => {
  let home: string;
  let bus: Bus;

  afterEach(async () => {
    await bus.stop();
    if (home) await rm(home, { recursive: true, force: true });
  });

  /** Hermetic controller: never watches a real ~/.omkc or probes a real omkc. */
  function makeController(): StatusController {
    const missing = join(tmpdir(), 'moamcp-status-rest-missing');
    return createStatusController({
      env: { OMKC_HOME: `${missing}-omkc`, KIMI_CODE_HOME: `${missing}-kimi` } as NodeJS.ProcessEnv,
      omkcProbeMin: 40000,
      omkcProbeMax: 40000,
      omkcProbeIntervalMs: 5000,
      omkcProbeTimeoutMs: 100,
    });
  }

  async function startBus(controller?: StatusController): Promise<number> {
    home = await mkdtemp(join(tmpdir(), 'moamcp-status-rest-'));
    bus = new Bus({
      port: 0,
      cwd: home,
      instancesDir: join(home, 'instances'),
      logsDir: join(home, 'logs'),
      ...(controller === undefined ? {} : { statusController: controller }),
    });
    return bus.start();
  }

  it('GET /status 503s with status_not_ready + Retry-After when the controller is not started', async () => {
    const controller = makeController();
    const port = await startBus(controller);
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(503);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('retry-after')).toBe('2');
    expect(await res.json()).toEqual({ error: 'status_not_ready', started: false });
  });

  it('GET /status serves the full snapshot shape + ACAO once started', async () => {
    const controller = makeController();
    const port = await startBus(controller);
    // The assembly (server.ts) passes startResult.port to the controller.
    controller.setPort(port);
    controller.start();
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['agents', 'scan', 'server', 'sessions', 'sources']);
    expect(body.server).toMatchObject({ pid: process.pid, port });
    expect(typeof body.server.started_at).toBe('string');
    expect(typeof body.server.uptime).toBe('number');
    expect(body.scan).toHaveProperty('scanning');
    expect(typeof body.scan.scanning).toBe('boolean');
    expect(Array.isArray(body.scan.homes)).toBe(true);
    expect(body.sources.wire).toEqual({ sessions: 0, agents: 0 });
    expect(body.sources.omkc).toHaveProperty('connected');
    expect(body.sources.omkc.connected).toBe(false);
    expect(body.sessions).toEqual([]);
    expect(body.agents).toEqual([]);
  });

  it('GET /health is the lightweight Bus health with ACAO', async () => {
    const port = await startBus(); // no controller needed: bus-level endpoint
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, mode: 'own' });
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime).toBe('number');
  });

  it('a Bus without a status controller still serves /status as 503 (undefined-controller seam)', async () => {
    const port = await startBus(); // no statusController option
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(await res.json()).toEqual({ error: 'status_not_ready', started: false });
  });
});
