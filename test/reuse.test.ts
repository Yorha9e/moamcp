/**
 * Reuse-mode integration (port-discovery design §3.3/§3.4): two REAL server
 * processes (`dist/server.js`) sharing one `MOAMCP_HOME`. Instance 1 binds the
 * contested port (own mode); instance 2 detects it, drops its own registry
 * entry, and forwards events to instance 1's Bus via `POST /publish` —
 * asserted end-to-end over instance 1's SSE stream, including `card_url`,
 * the shared `MOAMCP_LOGS_DIR` archive, and the task picker page. Also covers
 * the concurrent-startup race and `card_url` encoding.
 *
 * The servers are spawned from the compiled `dist/` (built in beforeAll):
 * registry entries are keyed by pid, so the reuse detection can only be
 * exercised across real processes — two in-process Bus instances share a pid
 * and are excluded from each other's reuse lookup by design.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer, get, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from '../src/registry.js';
import { cardUrl } from '../src/server.js';
import { DebateHub } from '../src/state.js';

const root = fileURLToPath(new URL('..', import.meta.url));

// ---- helpers ----

function listenOn(server: HttpServer, port: number): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolveListen((server.address() as AddressInfo).port));
  });
}

async function freePort(): Promise<number> {
  const probe = createHttpServer();
  const port = await listenOn(probe, 0);
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** Poll `fn` until it returns non-undefined (local event arrays, no I/O). */
async function waitFor<T>(fn: () => T | undefined, what: string, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Open an SSE subscription on a Bus; resolves once headers arrive. */
function subscribe(port: number, taskId: string): Promise<{ events: any[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = get(
      { host: '127.0.0.1', port, path: `/subscribe?task_id=${encodeURIComponent(taskId)}` },
      (res) => {
        const events: any[] = [];
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (line) events.push(JSON.parse(line.slice(6)));
          }
        });
        resolve({ events, close: () => req.destroy() });
      },
    );
    req.on('error', reject);
  });
}

/**
 * Minimal MCP-over-stdio client: newline-delimited JSON-RPC (the SDK's stdio
 * framing). Just enough for initialize + tools/call against dist/server.js.
 */
class McpStdio {
  private readonly child: ChildProcess;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(child: ChildProcess) {
    this.child = child;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.onData(chunk));
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === undefined || !this.pending.has(msg.id)) continue; // notifications: ignore
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }

  request(method: string, params: unknown, timeoutMs = 15000): Promise<any> {
    const id = this.nextId++;
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return promise;
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'reuse-test', version: '0.0.0' },
    });
    this.notify('notifications/initialized');
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const res = (await this.request('tools/call', { name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    if (res.isError) throw new Error(`tool ${name} failed: ${JSON.stringify(res.content)}`);
    return JSON.parse(res.content[0].text);
  }
}

interface ServerChild {
  readonly child: ChildProcess;
  readonly rpc: McpStdio;
  stderr(): string;
  waitStderr(match: string, timeoutMs?: number): Promise<void>;
  kill(): void;
}

const spawned: ServerChild[] = [];

/** Spawn `dist/server.js` with an isolated home/logs/cwd and a contested port. */
function spawnServer(opts: { port: number; home: string; logs: string; cwd: string }): ServerChild {
  const child = spawn(process.execPath, [join(root, 'dist', 'server.js')], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      MOAMCP_HOME: opts.home,
      MOAMCP_LOGS_DIR: opts.logs,
      MOAMCP_BUS_PORT: String(opts.port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderrBuf = '';
  let exitInfo = 'running';
  const waiters: Array<{ match: string; resolve: () => void }> = [];
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderrBuf += chunk;
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (stderrBuf.includes(waiters[i].match)) {
        waiters.splice(i, 1)[0].resolve();
      }
    }
  });
  child.on('exit', (code, signal) => {
    exitInfo = `exited (code=${code}, signal=${signal})`;
  });
  const api: ServerChild = {
    child,
    rpc: new McpStdio(child),
    stderr: () => stderrBuf,
    waitStderr(match, timeoutMs = 25000) {
      if (stderrBuf.includes(match)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timeout waiting for "${match}" on stderr; child ${exitInfo}; stderr: ${stderrBuf}`));
        }, timeoutMs);
        waiters.push({
          match,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    kill() {
      child.kill('SIGKILL');
    },
  };
  spawned.push(api);
  return api;
}

// Safety net: never leak server children if the worker dies mid-test.
process.on('exit', () => {
  for (const s of spawned) {
    try {
      s.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
});

// ---- build dist/ once (the tests spawn the compiled server) ----

beforeAll(() => {
  try {
    execFileSync(
      process.execPath,
      [join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'), '-p', join(root, 'tsconfig.json')],
      { cwd: root, timeout: 120000, stdio: 'pipe' },
    );
  } catch (err) {
    const e = err as { stderr?: Buffer; message?: string };
    throw new Error(`tsc build failed: ${e.stderr?.toString() ?? e.message}`);
  }
}, 150000);

// ---- integration: two real server processes on one contested port ----

describe('reuse mode (two real server processes sharing MOAMCP_HOME)', () => {
  let home: string;
  let logs: string;
  let ownerCwd: string;
  let reuserCwd: string;
  let port: number;
  let owner: ServerChild;
  let reuser: ServerChild;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'moamcp-reuse-home-'));
    logs = await mkdtemp(join(tmpdir(), 'moamcp-reuse-logs-'));
    ownerCwd = await mkdtemp(join(tmpdir(), 'moamcp-reuse-cwd1-'));
    reuserCwd = await mkdtemp(join(tmpdir(), 'moamcp-reuse-cwd2-'));
    port = await freePort();
    owner = spawnServer({ port, home, logs, cwd: ownerCwd });
    await owner.waitStderr('[moamcp] bus:'); // instance 1 bound the port (own mode)
    reuser = spawnServer({ port, home, logs, cwd: reuserCwd });
    await reuser.waitStderr('[moamcp] reuse:'); // instance 2 entered reuse mode
  }, 60000);

  afterAll(async () => {
    owner.kill();
    reuser.kill();
    for (const dir of [home, logs, ownerCwd, reuserCwd]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('instance 2 reuses: own entry deleted, no bind, no bus.port of its own', async () => {
    const live = await createRegistry({ instancesDir: join(home, 'instances') }).listLive();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ pid: owner.child.pid, port });
    expect(live.find((e) => e.pid === reuser.child.pid)).toBeUndefined();
    // Only the owner wrote bus.port; the reuser never bound.
    expect(await readFile(join(ownerCwd, 'bus.port'), 'utf8')).toBe(String(port));
    await expect(readFile(join(reuserCwd, 'bus.port'), 'utf8')).rejects.toThrow();
  });

  it('instance 2 events reach instance 1 SSE via POST /publish; card_url points at instance 1', async () => {
    const sub = await subscribe(port, 'reuse-task');
    await reuser.rpc.initialize();
    const init = await reuser.rpc.callTool('moa_init', {
      task_id: 'reuse-task',
      preset_config: { agents: ['a1', 'a2'], debate: { rounds: 1 } },
    });
    expect(init).toMatchObject({ ok: true, card_url: `http://127.0.0.1:${port}/?task_id=reuse-task` });

    // The event emitted by instance 2's hub was forwarded to instance 1's Bus.
    const ev = await waitFor(
      () => sub.events.find((e) => e.type === 'task_initialized'),
      'task_initialized on the owner SSE',
    );
    expect(ev).toMatchObject({ task_id: 'reuse-task', agents: ['a1', 'a2'], rounds: 1 });

    // Instance 1's /tasks sees the forwarded task.
    const tasks = (await (await fetch(`http://127.0.0.1:${port}/tasks`)).json()) as { tasks: string[] };
    expect(tasks.tasks).toContain('reuse-task');
    sub.close();
  }, 30000);

  it('archives land in the shared MOAMCP_LOGS_DIR and are served by the owner /archive', async () => {
    const sub = await subscribe(port, 'reuse-task'); // late subscriber: replay + live
    const done = await reuser.rpc.callTool('moa_complete', { task_id: 'reuse-task' });
    expect(done).toMatchObject({ ok: true, archive: join(logs, 'reuse-task') });

    // task_closed was forwarded too, with the archive path under the shared root.
    const closed = await waitFor(
      () => sub.events.find((e) => e.type === 'task_closed'),
      'task_closed forwarded to the owner SSE',
    );
    expect(closed).toMatchObject({ task_id: 'reuse-task', archive: join(logs, 'reuse-task') });
    sub.close();

    // On disk under the shared root...
    const probe = JSON.parse(await readFile(join(logs, 'reuse-task', 'probe.json'), 'utf8'));
    expect(Object.keys(probe.agents)).toEqual(['a1', 'a2']);
    // ...and served by the OWNER's /archive endpoint (same root, design §3.3).
    const res = await fetch(`http://127.0.0.1:${port}/archive?task_id=reuse-task&file=result.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ task_id: 'reuse-task', turns: 0 });
  }, 30000);

  it('serves the task picker at GET / when no task_id is given', async () => {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain('id="picker"');
    expect(html).toContain("fetch('/tasks')");
    expect(html).toContain("location.href = '/?task_id=' + encodeURIComponent(id)");
    // The task view is intact when task_id IS given.
    expect(html).toContain("EventSource('/subscribe?task_id=");
  });
});

// ---- concurrency: two processes start on the same port at the same time ----

describe('concurrent startup race', () => {
  it('exactly one owner; the other reuses or walks to port+1; no dirty entries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'moamcp-race-home-'));
    const logs = await mkdtemp(join(tmpdir(), 'moamcp-race-logs-'));
    const cwdA = await mkdtemp(join(tmpdir(), 'moamcp-race-cwdA-'));
    const cwdB = await mkdtemp(join(tmpdir(), 'moamcp-race-cwdB-'));
    const racePort = await freePort();
    const a = spawnServer({ port: racePort, home, logs, cwd: cwdA });
    const b = spawnServer({ port: racePort, home, logs, cwd: cwdB });
    try {
      await Promise.all([a.waitStderr('[moamcp]'), b.waitStderr('[moamcp]')]);
      const live = await createRegistry({ instancesDir: join(home, 'instances') }).listLive();
      const pids = new Set([a.child.pid, b.child.pid]);

      // Every entry belongs to one of the two children, on a distinct port.
      expect(live.length).toBeGreaterThanOrEqual(1);
      expect(live.length).toBeLessThanOrEqual(2);
      for (const e of live) expect(pids.has(e.pid)).toBe(true);
      expect(new Set(live.map((e) => e.port)).size).toBe(live.length);

      // Someone owns the contested port; any extra entry is the port+1 fallback.
      const ownerEntry = live.find((e) => e.port === racePort);
      expect(ownerEntry).toBeDefined();
      for (const e of live.filter((x) => x !== ownerEntry)) expect(e.port).toBe(racePort + 1);

      // Banners agree with the registry: own-mode processes keep their entry,
      // reusers delete theirs — so listener count == entry count, and every
      // process printed exactly one banner.
      const banners = [a, b].map((s) => ({
        own: s.stderr().includes('[moamcp] bus:'),
        reuse: s.stderr().includes('[moamcp] reuse:'),
      }));
      expect(banners.every((x) => Number(x.own) + Number(x.reuse) === 1)).toBe(true);
      expect(banners.filter((x) => x.own).length).toBe(live.length);
    } finally {
      a.kill();
      b.kill();
      for (const dir of [home, logs, cwdA, cwdB]) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }, 60000);
});

// ---- card_url: encoding + moa_init integration ----

describe('card_url', () => {
  it('percent-encodes task_id so special characters cannot inject query params', () => {
    const raw = cardUrl(8913, 'a&b?c#d e/f');
    expect(raw.startsWith('http://127.0.0.1:8913/?task_id=')).toBe(true);
    const url = new URL(raw);
    expect(url.pathname).toBe('/');
    expect([...url.searchParams.keys()]).toEqual(['task_id']);
    expect(url.searchParams.get('task_id')).toBe('a&b?c#d e/f');
  });

  it('moa_init returns the agents dispatch map, plus card_url only when a factory is set', () => {
    const weird = 'weird&id?x#y';
    const hub = new DebateHub({ cardUrlFactory: (id) => cardUrl(9999, id) });
    const withUrl = hub.init(weird, { agents: ['a'] });
    expect(withUrl).toEqual({
      ok: true,
      agents: [{ id: 'a' }],
      card_url: `http://127.0.0.1:9999/?task_id=${encodeURIComponent(weird)}`,
    });
    expect(new URL(withUrl.card_url as string).searchParams.get('task_id')).toBe(weird);

    const plain = new DebateHub().init('plain-task', { agents: ['a'] });
    expect(plain).toEqual({ ok: true, agents: [{ id: 'a' }] });
    expect('card_url' in plain).toBe(false);
  });
});
