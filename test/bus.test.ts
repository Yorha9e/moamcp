/**
 * Bus test: real HTTP/SSE against an in-process Bus wired to the hub's event
 * emitter. Asserts event order, the frontend card at /, the bus.port file,
 * replay to late subscribers, and POST /publish fan-out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer, get, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { DebateHub } from '../src/state.js';
import { Bus, type BusStartResult } from '../src/bus.js';
import { createRegistry, type InstanceRegistration } from '../src/registry.js';

let bus: Bus;
let port: number;
let cwd: string;
let logsDir: string;
let client: Client;

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
}

/** Open an SSE subscription; resolves once headers arrive (server has registered us). */
function subscribe(taskId: string): Promise<{ events: any[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = get(`http://127.0.0.1:${port}/subscribe?task_id=${taskId}`, (res) => {
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
    });
    req.on('error', reject);
  });
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'moamcp-bus-'));
  // Shared archive root: the hub writes it, the Bus serves it at /archive.
  logsDir = await mkdtemp(join(tmpdir(), 'moamcp-bus-logs-'));
  bus = new Bus({ port: 0, cwd, logsDir }); // port 0 = OS-assigned, avoids clobbering a real 8913
  port = await bus.start();
  const hub = new DebateHub({ logsDir, emit: (taskId, event) => bus.publish(taskId, event) });
  const server = createServer(hub);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'bus-test', version: '0.0.1' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await bus.stop();
  await rm(cwd, { recursive: true, force: true });
  await rm(logsDir, { recursive: true, force: true });
});

it('writes the actual port to {cwd}/bus.port on startup', async () => {
  expect(await readFile(join(cwd, 'bus.port'), 'utf8')).toBe(String(port));
});

it('serves the frontend card at GET /', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
  const html = await res.text();
  expect(html).toContain('MOA Debate');
  expect(html).toContain("EventSource('/subscribe?task_id=");
});

// ---- frontend card DOM stub: run the card's inline <script> headlessly and
// drive the clickable-stage interactions (click → scroll + flash + detail row).

class El {
  tag: string;
  children: El[] = [];
  parent: El | null = null;
  text: string;
  className = '';
  hidden = false;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(ev: any) => void>> = {};
  scrollCalls: any[] = [];
  constructor(tag: string, text = '') {
    this.tag = tag;
    this.text = text;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.text = String(v);
  }
  get firstChild(): El | null {
    return this.children[0] ?? null;
  }
  get lastChild(): El | null {
    return this.children[this.children.length - 1] ?? null;
  }
  get classList() {
    return {
      add: (c: string) => {
        const parts = this.className.split(' ').filter(Boolean);
        if (!parts.includes(c)) parts.push(c);
        this.className = parts.join(' ');
      },
      remove: (c: string) => {
        this.className = this.className.split(' ').filter((p) => p && p !== c).join(' ');
      },
    };
  }
  appendChild(c: El): El {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: El, ref: El | null): El {
    c.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c: El): El {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    return c;
  }
  querySelector(sel: string): El | null {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    const walk = (el: El): El | null => {
      for (const c of el.children) {
        if (cls ? c.className.split(' ').includes(cls) : c.tag === sel) return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }
  closest(sel: string): El | null {
    const id = sel.startsWith('#') ? sel.slice(1) : null;
    const cls = id == null ? (sel.startsWith('.') ? sel.slice(1) : sel) : null;
    let cur: El | null = this;
    while (cur) {
      if (id != null ? cur.attrs.id === id : cur.className.split(' ').includes(cls as string)) return cur;
      cur = cur.parent;
    }
    return null;
  }
  addEventListener(type: string, h: (ev: any) => void): void {
    (this.listeners[type] ??= []).push(h);
  }
  removeEventListener(type: string, h: (ev: any) => void): void {
    const l = this.listeners[type] ?? [];
    const i = l.indexOf(h);
    if (i >= 0) l.splice(i, 1);
  }
  scrollIntoView(opts?: any): void {
    this.scrollCalls.push(opts ?? null);
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: ((ev?: any) => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: ((ev?: any) => void) | null = null;
  listeners: Record<string, Array<(m: any) => void>> = {};
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, h: (m: any) => void): void {
    (this.listeners[type] ??= []).push(h);
  }
  close(): void {
    this.closed = true;
  }
}

/** Run the card's inline script in a vm sandbox; returns stub-DOM handles + SSE controls. */
function runCardScript(script: string, taskId: string) {
  const ids = [
    'taskId', 'conn', 'badge', 'picker', 'pickerList', 'progressCard', 'stageHint',
    'progress', 'st0', 'st1', 'st2', 'st3', 'st4', 'lk0', 'lk1', 'lk2', 'lk3', 'st2lb',
    'stageDetail', 'config', 'configBody', 'meta', 'round', 'rounds', 'speaker', 'turns',
    'agentsCard', 'agents', 'omkcCard', 'omkcScan', 'omkcCount', 'omkcAgents',
    'transcriptCard', 'transcript', 'verdict', 'verdictBody', 'verdictFindings',
    'verdictStats', 'fullBtn', 'omkcToolsCard', 'toolCount', 'toolLog',
  ];
  const byId = new Map<string, El>();
  for (const id of ids) {
    const el = new El('div');
    el.attrs.id = id;
    byId.set(id, el);
  }
  // Initial state as per the markup: sections that only appear later start hidden.
  for (const id of ['stageDetail', 'picker', 'omkcCard', 'omkcToolsCard', 'verdict', 'fullBtn']) {
    byId.get(id)!.hidden = true;
  }
  const docListeners: Record<string, Array<(ev: any) => void>> = {};
  const document = {
    getElementById: (id: string) => byId.get(id) as El,
    createElement: (tag: string) => new El(tag),
    createTextNode: (text: string) => new El('#text', text),
    createDocumentFragment: () => new El('#fragment'),
    addEventListener: (type: string, h: (ev: any) => void) => {
      (docListeners[type] ??= []).push(h);
    },
  };
  FakeEventSource.instances = [];
  const sandbox: Record<string, unknown> = {
    document,
    location: { search: '?task_id=' + encodeURIComponent(taskId), href: '' },
    fetch: () => Promise.reject(new Error('stub: offline')), // omkc-status / archive fetches fail clean
    EventSource: FakeEventSource,
    URLSearchParams, AbortController, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { timeout: 5000 });
  const sse = FakeEventSource.instances[0];
  const click = (el: El) => {
    for (const h of el.listeners.click ?? []) h({ target: el });
  };
  const docClick = (target: El) => {
    for (const h of docListeners.click ?? []) h({ target });
  };
  return {
    el: (id: string) => byId.get(id)!,
    emit: (e: Record<string, unknown>) => sse.onmessage?.({ data: JSON.stringify(e) }),
    click,
    docClick, // simulate a click bubbling up to document (e.g. from a pill)
    outsideClick: () => docClick(new El('div')),
  };
}

it('frontend card: stage pills click through to their section and toggle a detail row', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const html = await res.text();
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(match).toBeTruthy();
  const card = runCardScript(match![1], 'ui-1');
  const detail = card.el('stageDetail');

  // Bootstrap: stage 0 (共识) active, detail row closed.
  expect(card.el('st0').className).toContain('active');
  expect(detail.hidden).toBe(true);

  // Drive the lifecycle: init → start → first speaker.
  card.emit({ type: 'task_initialized', agents: ['a1', 'a2'], agent_specs: [{ id: 'a1' }, { id: 'a2' }], rounds: 2, extras: { reference_results: 'R'.repeat(600) }, ts: '2026-07-23T10:00:00.000Z' });
  card.emit({ type: 'debate_started', agents: ['a1', 'a2'], rounds: 2, ts: '2026-07-23T10:00:01.000Z' });
  card.emit({ type: 'turn_advanced', round: 1, speaker: 'a1', ts: '2026-07-23T10:00:02.000Z' });

  // 辩论 pill → detail row opens, transcript card scrolls in with an outline flash.
  const st2 = card.el('st2');
  const transcript = card.el('transcriptCard');
  card.click(st2);
  expect(detail.hidden).toBe(false);
  expect(detail.textContent).toContain('Round 1/2');
  expect(detail.textContent).toContain('a1');
  expect(detail.textContent).toContain('已提交 0 个 turn');
  expect(transcript.scrollCalls).toHaveLength(1);
  expect(transcript.className).toContain('flash');
  expect(st2.getAttribute('aria-expanded')).toBe('true');
  // The flash cleans itself up when the outline animation ends.
  transcript.listeners.animationend?.[0]?.({});
  expect(transcript.className).not.toContain('flash');

  // Live refresh: a submitted turn updates the open detail row.
  card.emit({ type: 'turn_submitted', agent_id: 'a1', round: 1, turn: 1, content: 'a1 argues', ts: '2026-07-23T10:00:03.000Z' });
  expect(detail.textContent).toContain('已提交 1 个 turn');

  // Clicking the same pill again closes the row.
  card.click(st2);
  expect(detail.hidden).toBe(true);
  expect(st2.getAttribute('aria-expanded')).toBe('false');

  // Reference pill: snapshot summary truncated at 500 chars.
  card.click(card.el('st1'));
  expect(detail.hidden).toBe(false);
  expect(detail.textContent).toContain('reference_results 摘要');
  expect(detail.textContent).toContain('R'.repeat(500));
  expect(detail.textContent).not.toContain('R'.repeat(501));

  // A click elsewhere closes the row…
  card.outsideClick();
  expect(detail.hidden).toBe(true);

  // …but a pill's own click bubbling up to document must not close it.
  card.click(card.el('st0'));
  card.docClick(card.el('st0'));
  expect(detail.hidden).toBe(false);
  expect(detail.textContent).toContain('任务已初始化');
  card.outsideClick();

  // Pending stages are clickable too: VERDICT card still hidden → no scroll,
  // the row explains why the stage has not started.
  const verdict = card.el('verdict');
  card.click(card.el('st4'));
  expect(detail.hidden).toBe(false);
  expect(detail.textContent).toContain('该阶段尚未开始');
  expect(detail.textContent).toContain('moa_complete');
  expect(verdict.scrollCalls).toHaveLength(0);
  card.outsideClick();

  // Keyboard works as well: Enter on 聚合 opens its row (done by then).
  card.emit({ type: 'debate_complete', rounds: 2, turns: 1, ts: '2026-07-23T10:00:04.000Z' });
  card.emit({ type: 'task_closed', archive: 'logs/ui-1', turns: 1, ts: '2026-07-23T10:00:05.000Z' });
  expect(verdict.hidden).toBe(false);
  const st3 = card.el('st3');
  st3.listeners.keydown?.[0]?.({ key: 'Enter', preventDefault: () => {} });
  expect(detail.hidden).toBe(false);
  expect(detail.textContent).toContain('归档已写入，裁决已输出');
  expect(verdict.scrollCalls).toHaveLength(1);
  expect(card.el('st4').getAttribute('aria-expanded')).toBe('false');

  // 结论 pill now scrolls to the revealed VERDICT card and quotes the summary
  // (second scroll on the card: Enter on 聚合 already landed there once).
  card.click(card.el('st4'));
  expect(detail.textContent).toContain('归档已写入 · logs/ui-1');
  expect(verdict.scrollCalls).toHaveLength(2);
  expect(card.el('st4').getAttribute('aria-expanded')).toBe('true');
  expect(st3.getAttribute('aria-expanded')).toBe('false');
});

it('fans out turn_submitted/turn_advanced in order over real SSE', async () => {
  const sub = await subscribe('bus-1');
  await call('moa_init', { task_id: 'bus-1', preset_config: { agents: ['a1', 'a2'], debate: { rounds: 1 } } });
  await call('moa_start_debate', { task_id: 'bus-1', reference_results: ['r1'] });
  const a1 = await call('moa_wait_turn', { task_id: 'bus-1', agent_id: 'a1' });
  expect(a1.status).toBe('your_turn');
  await call('moa_submit_turn', { task_id: 'bus-1', agent_id: 'a1', content: 'a1 speaks' });
  const a2 = await call('moa_wait_turn', { task_id: 'bus-1', agent_id: 'a2' });
  expect(a2.status).toBe('your_turn');
  await call('moa_submit_turn', { task_id: 'bus-1', agent_id: 'a2', content: 'a2 speaks' });
  await call('moa_complete', { task_id: 'bus-1' });
  await tick();
  sub.close();

  const types = sub.events.map((e) => e.type);
  expect(types).toEqual([
    'task_initialized',
    'debate_started',
    'turn_submitted',
    'turn_advanced',
    'turn_submitted',
    'debate_complete',
    'task_closed',
  ]);
  expect(sub.events[2]).toMatchObject({ task_id: 'bus-1', agent_id: 'a1', round: 1, turn: 1, excerpt: 'a1 speaks' });
  expect(sub.events[3]).toMatchObject({ round: 1, speaker: 'a2' });
  expect(sub.events[5]).toMatchObject({ rounds: 1, turns: 2 });
  expect(sub.events[0]).toMatchObject({ agents: ['a1', 'a2'], rounds: 1 });
  expect(sub.events[0].agent_specs).toEqual([{ id: 'a1' }, { id: 'a2' }]);
  expect(sub.events.every((e) => typeof e.ts === 'string')).toBe(true);

  // Late subscriber gets the per-task log replayed from the beginning.
  const late = await subscribe('bus-1');
  await tick();
  late.close();
  expect(late.events.map((e) => e.type)).toEqual(types);
});

it('POST /publish fans a custom event out to subscribers', async () => {
  const sub = await subscribe('bus-2');
  const res = await fetch(`http://127.0.0.1:${port}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_id: 'bus-2', event: { type: 'hub_note', msg: 'hello' } }),
  });
  expect(res.status).toBe(200);
  await tick();
  sub.close();
  expect(sub.events).toHaveLength(1);
  expect(sub.events[0]).toMatchObject({ type: 'hub_note', msg: 'hello', task_id: 'bus-2' });
});

it('serves archived files at GET /archive after moa_complete', async () => {
  // bus-1 was completed (and archived to {logsDir}/bus-1) in the SSE test above.
  const res = await fetch(`http://127.0.0.1:${port}/archive?task_id=bus-1&file=result.json`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/json');
  const json = (await res.json()) as Record<string, unknown>;
  expect(json).toMatchObject({ task_id: 'bus-1', status: 'complete', turns: 2 });

  const jsonl = await fetch(`http://127.0.0.1:${port}/archive?task_id=bus-1&file=events.jsonl`);
  expect(jsonl.status).toBe(200);
  expect(await jsonl.text()).toContain('"speaker":"a1"');

  // Whitelist + traversal guards.
  const badFile = await fetch(`http://127.0.0.1:${port}/archive?task_id=bus-1&file=../../package.json`);
  expect(badFile.status).toBe(400);
  const badTask = await fetch(`http://127.0.0.1:${port}/archive?task_id=..&file=result.json`);
  expect(badTask.status).toBe(400);
  const missing = await fetch(`http://127.0.0.1:${port}/archive?task_id=nope&file=result.json`);
  expect(missing.status).toBe(404);
});

it('deletes bus.port on clean shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moamcp-bus-stop-'));
  const b = new Bus({ port: 0, cwd: dir });
  await b.start();
  await b.stop();
  await expect(readFile(join(dir, 'bus.port'), 'utf8')).rejects.toThrow();
  await rm(dir, { recursive: true, force: true });
});

// ---- port discovery: instance registry + port rules (design §3.2/§3.3) ----

function listenOn(server: HttpServer, port: number): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    // Bind loopback explicitly: the Bus binds 127.0.0.1 only, so blockers
    // must occupy the same address to force the port+1 walk deterministically.
    server.listen(port, '127.0.0.1', () => resolveListen((server.address() as AddressInfo).port));
  });
}

async function freePort(): Promise<number> {
  const probe = createHttpServer();
  const port = await listenOn(probe, 0);
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** Occupy `count` consecutive ports (re-probing until a free run is found). */
async function occupyRun(count: number): Promise<{ base: number; release: () => Promise<void> }> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const base = await freePort();
    const servers: HttpServer[] = [];
    let ok = true;
    for (let i = 0; i < count; i++) {
      const s = plainBlocker();
      try {
        await listenOn(s, base + i);
        servers.push(s);
      } catch {
        ok = false;
        break;
      }
    }
    if (ok) {
      return {
        base,
        release: async () => {
          for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
        },
      };
    }
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  }
  throw new Error(`could not find a free run of ${count} ports`);
}

/** A live child process whose pid we can plant in a registry entry. */
function liveChild(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
}

/** Non-moamcp listener: answers /tasks with 404. */
function plainBlocker(): HttpServer {
  return createHttpServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
}

/** moamcp-like listener: answers /tasks with 200 (would satisfy the reuse probe). */
function moamcpLikeBlocker(): HttpServer {
  return createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"tasks":[]}');
  });
}

/** Accepts TCP but never responds — the reuse probe must time out. */
function hangingBlocker(): HttpServer {
  return createHttpServer(() => {});
}

async function tmpBusDir(): Promise<{ cwd: string; instancesDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'moamcp-bus-reg-'));
  return { cwd, instancesDir: join(cwd, 'instances') };
}

describe('port discovery: instance registry + port rules', () => {
  it('yields port+1 past a non-moamcp listener and writes the bound port back', async () => {
    const base = await freePort();
    const blocker = plainBlocker();
    await listenOn(blocker, base);
    const { cwd, instancesDir } = await tmpBusDir();
    const bus = new Bus({ port: base, cwd, instancesDir });
    try {
      const port = await bus.start();
      expect(port).toBe(base + 1);
      expect(bus.mode).toBe('own');
      expect(bus.startResult).toEqual({ mode: 'own', port: base + 1 });
      // Registry write-back: the entry carries the actually-bound port, not the intended one.
      const live = await createRegistry({ instancesDir }).listLive();
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ pid: process.pid, port: base + 1 });
      // Compat bus.port also records the winner.
      expect(await readFile(join(cwd, 'bus.port'), 'utf8')).toBe(String(base + 1));
    } finally {
      await bus.stop();
      await new Promise<void>((r) => blocker.close(() => r()));
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('excludes its own pid entry from reuse detection', async () => {
    const base = await freePort();
    // 200 on /tasks: without self-exclusion the probe would pass and wrongly signal reuse.
    const blocker = moamcpLikeBlocker();
    await listenOn(blocker, base);
    const { cwd, instancesDir } = await tmpBusDir();
    const bus = new Bus({ port: base, cwd, instancesDir });
    try {
      const port = await bus.start();
      expect(bus.mode).toBe('own');
      expect(port).toBe(base + 1);
    } finally {
      await bus.stop();
      await new Promise<void>((r) => blocker.close(() => r()));
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('live entry but failing probe → treated as non-moamcp, port+1 (pid-recycle guard)', async () => {
    const base = await freePort();
    const blocker = plainBlocker(); // 404 on /tasks
    await listenOn(blocker, base);
    const child = liveChild();
    const { cwd, instancesDir } = await tmpBusDir();
    try {
      await tick(100);
      const fake = await createRegistry({ instancesDir }).register({ pid: child.pid as number, port: base });
      const bus = new Bus({ port: base, cwd, instancesDir });
      try {
        const port = await bus.start();
        expect(bus.mode).toBe('own');
        expect(port).toBe(base + 1);
      } finally {
        await bus.stop();
      }
      await fake.release();
    } finally {
      child.kill();
      await new Promise<void>((r) => blocker.close(() => r()));
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('live entry + hanging listener → probe times out (200ms), port+1', async () => {
    const base = await freePort();
    const blocker = hangingBlocker();
    await listenOn(blocker, base);
    const child = liveChild();
    const { cwd, instancesDir } = await tmpBusDir();
    try {
      await tick(100);
      const fake = await createRegistry({ instancesDir }).register({ pid: child.pid as number, port: base });
      const bus = new Bus({ port: base, cwd, instancesDir });
      try {
        const port = await bus.start();
        expect(bus.mode).toBe('own');
        expect(port).toBe(base + 1);
      } finally {
        await bus.stop();
      }
      await fake.release();
    } finally {
      child.kill();
      await new Promise<void>((r) => blocker.close(() => r()));
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('signals reuse when a live moamcp holds the port, and drops its own entry', async () => {
    const base = await freePort();
    // The "old" Bus really bound to `base` (separate registry dir).
    const oldDir = await tmpBusDir();
    const oldBus = new Bus({ port: base, cwd: oldDir.cwd, instancesDir: oldDir.instancesDir });
    expect(await oldBus.start()).toBe(base);
    const child = liveChild();
    const { cwd, instancesDir } = await tmpBusDir();
    try {
      await tick(100);
      // Registry entry owned by another live pid, pointing at the old Bus's port.
      const fake = await createRegistry({ instancesDir }).register({ pid: child.pid as number, port: base });
      const bus = new Bus({ port: base, cwd, instancesDir });
      try {
        const port = await bus.start();
        expect(bus.mode).toBe('reuse');
        expect(port).toBe(base);
        expect(bus.startResult).toEqual({ mode: 'reuse', port: base });
        // Its own entry was deleted on entering reuse; the foreign entry remains.
        const live = await createRegistry({ instancesDir }).listLive();
        expect(live.find((e) => e.pid === process.pid)).toBeUndefined();
        expect(live.find((e) => e.pid === child.pid)).toBeDefined();
        // Reuse mode does not write bus.port.
        await expect(readFile(join(cwd, 'bus.port'), 'utf8')).rejects.toThrow();
      } finally {
        await bus.stop();
      }
      await fake.release();
    } finally {
      child.kill();
      await oldBus.stop();
      await rm(oldDir.cwd, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('throws when the port walk is exhausted and leaves no registry entry behind', async () => {
    const { base, release } = await occupyRun(3);
    const { cwd, instancesDir } = await tmpBusDir();
    const bus = new Bus({ port: base, cwd, instancesDir, portRetryLimit: 2 });
    try {
      await expect(bus.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      // The failed start released the entry — nothing stale left behind.
      expect(await createRegistry({ instancesDir }).listLive()).toHaveLength(0);
    } finally {
      await bus.stop();
      await release();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ephemeral port (0) skips the registry but still writes bus.port', async () => {
    const { cwd, instancesDir } = await tmpBusDir();
    const bus = new Bus({ port: 0, cwd, instancesDir });
    const port = await bus.start();
    try {
      expect(port).toBeGreaterThan(0);
      expect(bus.mode).toBe('own');
      expect(await readFile(join(cwd, 'bus.port'), 'utf8')).toBe(String(port));
      expect(await createRegistry({ instancesDir }).listLive()).toHaveLength(0);
    } finally {
      await bus.stop();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('stop() releases the registry entry', async () => {
    const base = await freePort();
    const { cwd, instancesDir } = await tmpBusDir();
    const bus = new Bus({ port: base, cwd, instancesDir });
    await bus.start();
    expect(await createRegistry({ instancesDir }).listLive()).toHaveLength(1);
    await bus.stop();
    expect(await createRegistry({ instancesDir }).listLive()).toHaveLength(0);
    await rm(cwd, { recursive: true, force: true });
  });

  it('reuse mode watches the host Bus and takes over the port when it dies', async () => {
    const base = await freePort();
    // The "old" Bus really bound to `base` (separate registry dir).
    const oldDir = await tmpBusDir();
    const oldBus = new Bus({ port: base, cwd: oldDir.cwd, instancesDir: oldDir.instancesDir });
    expect(await oldBus.start()).toBe(base);
    const child = liveChild();
    const { cwd, instancesDir } = await tmpBusDir();
    const takeovers: BusStartResult[] = [];
    let fake: InstanceRegistration | undefined;
    let watcher: Bus | undefined;
    try {
      await tick(100);
      fake = await createRegistry({ instancesDir }).register({ pid: child.pid as number, port: base });
      watcher = new Bus({
        port: base,
        cwd,
        instancesDir,
        reuseWatchIntervalMs: 40,
        reuseWatchTimeoutMs: 150,
        reuseWatchFailThreshold: 3,
      });
      watcher.onTakeover = (r) => takeovers.push(r);
      expect(await watcher.start()).toBe(base); // reuse under oldBus
      expect(watcher.mode).toBe('reuse');

      // Host dies: the port is released, probes fail, three consecutive
      // strikes → the watcher re-runs the start flow and wins the port.
      await oldBus.stop();
      const deadline = Date.now() + 10000;
      while (takeovers.length === 0 && Date.now() < deadline) await tick(20);
      expect(takeovers).toEqual([{ mode: 'own', port: base }]);
      expect(watcher.mode).toBe('own');
      expect(watcher.actualPort).toBe(base);
      // Its registry entry was restored on the contested port.
      const live = await createRegistry({ instancesDir }).listLive();
      expect(live.find((e) => e.pid === process.pid)).toMatchObject({ port: base });
      // The taken-over Bus serves /tasks.
      const res = await fetch(`http://127.0.0.1:${base}/tasks`);
      expect(res.status).toBe(200);
    } finally {
      await watcher?.stop();
      await oldBus.stop();
      await fake?.release();
      child.kill();
      await rm(oldDir.cwd, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20000);

  it('GET /tasks lists active tasks derived from the event log', async () => {
    bus.publish('tasks-a', { type: 'hub_note' });
    bus.publish('tasks-b', { type: 'hub_note' });
    const res = await fetch(`http://127.0.0.1:${port}/tasks`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = (await res.json()) as { tasks: string[] };
    expect(json.tasks).toEqual(expect.arrayContaining(['tasks-a', 'tasks-b']));
  });
});
