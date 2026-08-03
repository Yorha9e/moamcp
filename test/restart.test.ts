/**
 * Controlled bus restart (BUS_VERSION_RESTART.md task C): the owner releases
 * its port on `POST /api/bus/restart` so a newer-code process can take over,
 * then re-attaches *passively* (no takeover — re-binding stale code here
 * would defeat the purpose) and forwards events to the new owner once it
 * answers. busProbe only checks `GET /tasks` 200, so the "new owner" is
 * simulated with a plain HTTP server — the whole flow stays in-process.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus, type BusStartResult } from '../src/core/bus/bus.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createHttpServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function poll<T>(fn: () => Promise<T | undefined>, what: string, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function probeTasks(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/tasks', timeout: 500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

describe('bus controlled restart (BUS_VERSION_RESTART.md task C)', () => {
  let home: string | undefined;

  afterEach(async () => {
    if (home !== undefined) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  it('POST /api/bus/restart releases the port and passively re-attaches to the new owner', async () => {
    home = await mkdtemp(join(tmpdir(), 'moamcp-restart-'));
    const port = await freePort();
    const takeoverEvents: BusStartResult[] = [];
    const bus = new Bus({
      port,
      cwd: home,
      instancesDir: join(home, 'instances'),
      logsDir: join(home, 'logs'),
      reuseWatchIntervalMs: 100,
      reuseWatchTimeoutMs: 100,
      reuseWatchFailThreshold: 1,
    });
    bus.onTakeover = (result) => takeoverEvents.push(result);
    expect(await bus.start()).toBe(port);
    expect(bus.mode).toBe('own');

    const res = await fetch(`http://127.0.0.1:${port}/api/bus/restart`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, releasing: true });

    // The listener is gone: /tasks refuses connections.
    await poll(async () => (await probeTasks(port) ? undefined : true), 'port released');

    // A fake "new owner" answers /tasks on the released port.
    const owner = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tasks: [] }));
    });
    await new Promise<void>((r) => owner.listen(port, '127.0.0.1', () => r()));

    // The released bus passively re-attaches: onTakeover fires with reuse.
    const settled = await poll(
      async () => (takeoverEvents.length > 0 ? takeoverEvents[0] : undefined),
      'passive re-attach',
    );
    expect(settled).toMatchObject({ mode: 'reuse', port });
    expect(bus.mode).toBe('reuse');

    // A second release is rejected: this process is no longer the owner.
    await expect(bus.releaseAndReattach()).rejects.toMatchObject({ code: 'NOT_OWNER' });

    owner.close();
    await bus.stop();
  });

  it('POST /api/bus/restart rejects a foreign Origin (same rule as other write endpoints)', async () => {
    home = await mkdtemp(join(tmpdir(), 'moamcp-restart-'));
    const port = await freePort();
    const bus = new Bus({
      port,
      cwd: home,
      instancesDir: join(home, 'instances'),
      logsDir: join(home, 'logs'),
    });
    expect(await bus.start()).toBe(port);

    const crossSite = await fetch(`http://127.0.0.1:${port}/api/bus/restart`, {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    });
    expect(crossSite.status).toBe(403);
    // No Origin header (curl / same-process clients) is still allowed.
    const noOrigin = await fetch(`http://127.0.0.1:${port}/api/bus/restart`, { method: 'POST' });
    expect(noOrigin.status).toBe(202);

    await bus.stop();
  });

  it('releaseAndReattach fires onRelease once, after the port is already free (task D)', async () => {
    home = await mkdtemp(join(tmpdir(), 'moamcp-restart-'));
    const port = await freePort();
    const bus = new Bus({
      port,
      cwd: home,
      instancesDir: join(home, 'instances'),
      logsDir: join(home, 'logs'),
      reuseWatchIntervalMs: 100,
      reuseWatchTimeoutMs: 100,
      reuseWatchFailThreshold: 1,
    });
    expect(await bus.start()).toBe(port);

    let calls = 0;
    bus.onRelease = () => {
      calls++;
    };
    await bus.releaseAndReattach();
    expect(calls).toBe(1);
    expect(await probeTasks(port)).toBe(false); // listener really is gone
    expect(bus.mode).toBe('reuse');

    // A failing hook must not break the passive re-attach path.
    const bus2 = new Bus({
      port,
      cwd: home,
      instancesDir: join(home, 'instances'),
      logsDir: join(home, 'logs'),
      reuseWatchIntervalMs: 100,
      reuseWatchTimeoutMs: 100,
      reuseWatchFailThreshold: 1,
    });
    expect(await bus2.start()).toBe(port);
    bus2.onRelease = () => {
      throw new Error('boom');
    };
    await expect(bus2.releaseAndReattach()).resolves.toBeUndefined();
    expect(bus2.mode).toBe('reuse');

    // NOT_OWNER on a second release never fires the hook again.
    await expect(bus.releaseAndReattach()).rejects.toMatchObject({ code: 'NOT_OWNER' });
    expect(calls).toBe(1);

    await bus.stop();
    await bus2.stop();
  });
});
