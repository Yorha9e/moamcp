/**
 * Batch 1c P1/P4/P6 e2e: spawn the REAL `dist/bus-daemon.js` bundle (esbuild
 * build in beforeAll, mirroring reuse.test.ts's dist-build + freePort +
 * SIGKILL-cleanup pattern) and assert the headless owner:
 *
 *  1. owns the contested port and serves the status REST face — GET /status
 *     with the full snapshot (ACAO *) and GET /health;
 *  2. self-exits with code 0 shortly after a disk-version mismatch
 *     (MOAMCP_DAEMON_VERSION_CHECK_MS + MOAMCP_PACKAGE_JSON test seams), i.e.
 *     the P4 interval really fires against the shipped bundle;
 *  3. exits without owning when a live owner already holds the port (the
 *     daemon has no purpose in reuse mode).
 *
 * Assertions are convergent (poll for banners/exit) with generous margins;
 * afterAll + a process-exit hook SIGKILL any leaked child.
 */
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const DAEMON_SCRIPT = join(root, 'dist', 'bus-daemon.js');

const spawned: ChildProcess[] = [];
const cleanupDirs: string[] = [];
/** Pids of detached replacement daemons (spawned by a released daemon, so we
 *  hold no ChildProcess handle) that must be SIGKILL'd on teardown. */
const leakedPids: number[] = [];

// Safety net: never leak daemon children if the worker dies mid-test.
process.on('exit', () => {
  for (const child of spawned) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const pid of leakedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

afterAll(async () => {
  for (const child of spawned) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const pid of leakedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

/** Poll until `fn` returns a value; rejects after `timeoutMs` (convergent). */
async function poll<T>(fn: () => Promise<T | undefined>, what: string, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface DaemonChild {
  readonly child: ChildProcess;
  stderr(): string;
  /** Resolves once stderr contains `match` (timeout rejects with exit info). */
  waitStderr(match: string, timeoutMs?: number): Promise<void>;
  /** Resolves with {code, signal} once the process has exited. */
  waitExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
}

function spawnDaemon(opts: {
  cwd: string;
  env: Record<string, string>;
}): DaemonChild {
  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  spawned.push(child);
  let stderrBuf = '';
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const waiters: Array<{ match: string; resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderrBuf += chunk;
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (stderrBuf.includes(waiters[i].match)) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve();
      }
    }
  });
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });
  return {
    child,
    stderr: () => stderrBuf,
    waitStderr(match, timeoutMs = 20000) {
      if (stderrBuf.includes(match)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.match === match);
          if (i >= 0) waiters.splice(i, 1);
          reject(
            new Error(
              `timeout waiting for "${match}" on daemon stderr; exit=${JSON.stringify(exitInfo)}; stderr: ${stderrBuf}`,
            ),
          );
        }, timeoutMs);
        waiters.push({ match, resolve, reject, timer });
      });
    },
    waitExit(timeoutMs = 20000) {
      if (exitInfo !== null) return Promise.resolve(exitInfo);
      return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timeout waiting for daemon exit; stderr: ${stderrBuf}`));
        }, timeoutMs);
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          exitInfo = { code, signal };
          resolve(exitInfo);
        });
      });
    },
    kill: () => child.kill('SIGKILL'),
  };
}

/** Hermetic daemon env: isolated home/logs/cwd; no real CLI homes watched. */
function daemonEnv(extra: Record<string, string>): Record<string, string> {
  return {
    MOAMCP_HOME: extra.MOAMCP_HOME,
    MOAMCP_LOGS_DIR: extra.MOAMCP_LOGS_DIR,
    MOAMCP_BUS_PORT: extra.MOAMCP_BUS_PORT,
    OMKC_HOME: `${extra.MOAMCP_HOME}-omkc-missing`,
    KIMI_CODE_HOME: `${extra.MOAMCP_HOME}-kimi-missing`,
    ...extra,
  };
}

beforeAll(() => {
  buildSync({
    entryPoints: [join(root, 'src', 'bus-daemon.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; var require = __cr(import.meta.url);",
    },
    alias: {
      process: 'node:process',
    },
    outfile: DAEMON_SCRIPT,
  });
}, 150000);

describe('bus daemon e2e (batch 1c)', () => {
  it('owns the port and serves the status REST face: /status snapshot + /health', async () => {
    const home = await mkdtemp(join(tmpdir(), 'moamcp-daemon-home-'));
    const logs = await mkdtemp(join(tmpdir(), 'moamcp-daemon-logs-'));
    const cwd = await mkdtemp(join(tmpdir(), 'moamcp-daemon-cwd-'));
    cleanupDirs.push(home, logs, cwd);
    const port = await freePort();
    const daemon = spawnDaemon({
      cwd,
      env: daemonEnv({ MOAMCP_HOME: home, MOAMCP_LOGS_DIR: logs, MOAMCP_BUS_PORT: String(port) }),
    });

    await daemon.waitStderr('[moamcp] bus daemon: owns', 20000);
    // It really bound the port: pid is the daemon's, port matches.
    expect(daemon.child.exitCode).toBeNull();

    const statusRes = await fetch(`http://127.0.0.1:${port}/status`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.headers.get('access-control-allow-origin')).toBe('*');
    const body = await statusRes.json();
    expect(Object.keys(body).sort()).toEqual(['agents', 'scan', 'server', 'sessions', 'sources']);
    expect(body.server).toMatchObject({ pid: daemon.child.pid, port });
    expect(typeof body.server.started_at).toBe('string');
    expect(typeof body.server.uptime).toBe('number');
    expect(typeof body.scan.scanning).toBe('boolean');
    expect(body.sources.wire).toEqual({ sessions: 0, agents: 0 });
    expect(body.sources.omkc.connected).toBe(false);
    expect(body.sessions).toEqual([]);
    expect(body.agents).toEqual([]);

    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get('access-control-allow-origin')).toBe('*');
    expect(await healthRes.json()).toMatchObject({ ok: true, mode: 'own' });

    // The daemon is still alive after serving both endpoints (no early exit).
    expect(daemon.child.exitCode).toBeNull();
    daemon.kill();
  }, 30000);

  it('exits 0 shortly after a disk-version mismatch (P4 interval against the real bundle)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'moamcp-daemon-ver-home-'));
    const logs = await mkdtemp(join(tmpdir(), 'moamcp-daemon-ver-logs-'));
    const cwd = await mkdtemp(join(tmpdir(), 'moamcp-daemon-ver-cwd-'));
    cleanupDirs.push(home, logs, cwd);
    const port = await freePort();
    // A newer build "landed on disk": point the daemon at a package.json whose
    // version differs from the running VERSION. MOAMCP_DAEMON_VERSION_CHECK_MS
    // collapses the 60s cadence to 200ms for the test.
    const pkgDir = await mkdtemp(join(tmpdir(), 'moamcp-daemon-ver-pkg-'));
    cleanupDirs.push(pkgDir);
    const pkg = join(pkgDir, 'package.json');
    await writeFile(pkg, JSON.stringify({ name: 'moamcp', version: '9.9.9' }));

    const startedAt = Date.now();
    const daemon = spawnDaemon({
      cwd,
      env: daemonEnv({
        MOAMCP_HOME: home,
        MOAMCP_LOGS_DIR: logs,
        MOAMCP_BUS_PORT: String(port),
        MOAMCP_DAEMON_VERSION_CHECK_MS: '200',
        MOAMCP_PACKAGE_JSON: pkg,
      }),
    });
    // It owned the port before self-terminating — the exit is the version
    // check, not a failed start or a lost race.
    await daemon.waitStderr('[moamcp] bus daemon: owns', 20000);
    const { code } = await daemon.waitExit(15000);
    const elapsedMs = Date.now() - startedAt;
    expect(code).toBe(0);
    // Convergent with margin: expected ~1s total (spawn+start+one 200ms tick);
    // the 10s bound is 10x the expected worst case, never a flake source.
    expect(elapsedMs).toBeLessThan(10000);
    expect(daemon.stderr()).not.toContain('bus daemon failed');
    // 0.7.1 P3: a graceful own-mode exit cleans up its own bus.port file.
    await expect(readFile(join(cwd, 'bus.port'), 'utf8')).rejects.toThrow();
  }, 30000);

  it('exits without owning when a live owner already holds the port (reuse mode)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'moamcp-daemon-reuse-home-'));
    const logs = await mkdtemp(join(tmpdir(), 'moamcp-daemon-reuse-logs-'));
    const cwdA = await mkdtemp(join(tmpdir(), 'moamcp-daemon-reuse-cwdA-'));
    const cwdB = await mkdtemp(join(tmpdir(), 'moamcp-daemon-reuse-cwdB-'));
    cleanupDirs.push(home, logs, cwdA, cwdB);
    const port = await freePort();

    const owner = spawnDaemon({
      cwd: cwdA,
      env: daemonEnv({ MOAMCP_HOME: home, MOAMCP_LOGS_DIR: logs, MOAMCP_BUS_PORT: String(port) }),
    });
    await owner.waitStderr('[moamcp] bus daemon: owns', 20000);

    // A second daemon on the same home/port has no purpose: reuse → exit(0),
    // never a second listener, never a banner.
    const redundant = spawnDaemon({
      cwd: cwdB,
      env: daemonEnv({ MOAMCP_HOME: home, MOAMCP_LOGS_DIR: logs, MOAMCP_BUS_PORT: String(port) }),
    });
    const { code } = await redundant.waitExit(20000);
    expect(code).toBe(0);
    expect(redundant.stderr()).not.toContain('bus daemon: owns');

    // The owner is untouched and still serves.
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    owner.kill();
  }, 40000);

  it('released daemon\'s exit preserves the replacement owner\'s bus.port (0.7.1 P3)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'moamcp-daemon-release-home-'));
    const logs = await mkdtemp(join(tmpdir(), 'moamcp-daemon-release-logs-'));
    const cwd = await mkdtemp(join(tmpdir(), 'moamcp-daemon-release-cwd-'));
    cleanupDirs.push(home, logs, cwd);
    const port = await freePort();
    const daemonA = spawnDaemon({
      cwd,
      env: daemonEnv({ MOAMCP_HOME: home, MOAMCP_LOGS_DIR: logs, MOAMCP_BUS_PORT: String(port) }),
    });
    await daemonA.waitStderr('[moamcp] bus daemon: owns', 20000);
    expect(await readFile(join(cwd, 'bus.port'), 'utf8')).toBe(String(port));

    // Controlled restart: A releases, and its onRelease hook spawns a
    // replacement daemon (detached, stdio ignored — no handle from here) that
    // takes the port over and rewrites bus.port in the SAME cwd.
    const restart = await fetch(`http://127.0.0.1:${port}/api/bus/restart`, { method: 'POST' });
    expect(restart.status).toBe(202);

    // The replacement answers /health once it owns the port (A no longer listens).
    await poll(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        return res.status === 200 ? true : undefined;
      } catch {
        return undefined; // port free / not yet up
      }
    }, 'replacement daemon on the port', 20000);

    // Track the detached replacement for teardown BEFORE any later assertion
    // can fail: A unregistered on release, so the sole instance entry is B's.
    const instancesDir = join(home, 'instances');
    const entry = (await readdir(instancesDir)).find((f) => f.endsWith('.json'));
    expect(entry).toBeDefined();
    const bPid = Number((entry as string).replace(/\.json$/, ''));
    expect(Number.isInteger(bPid) && bPid > 0).toBe(true);
    leakedPids.push(bPid);

    // A passively re-attaches to the new owner and exits 0 (reuse → no purpose).
    const { code } = await daemonA.waitExit(20000);
    expect(code).toBe(0);
    // P3: A's exit handler must NOT delete the file the replacement now owns.
    expect(await readFile(join(cwd, 'bus.port'), 'utf8')).toBe(String(port));

    try {
      process.kill(bPid, 'SIGKILL');
    } catch {
      // already gone
    }
  }, 45000);
});
