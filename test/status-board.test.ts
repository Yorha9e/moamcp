/**
 * Status Board page tests (0.9.0):
 *  - backend: GET /status-board serves the page (200 + text/html + markers);
 *  - page behavior: run the page's inline <script> in a vm with a fake DOM +
 *    FakeEventSource (bus.test.ts runCardScript pattern) and drive
 *    snapshot/agent/session frames, gone re-roots, session-gone, the SSE
 *    error + /status 503 probe first-class state, and reconnect-keeps-rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { Bus } from '../src/core/bus/bus.js';

// ---------------------------------------------------------------- fake DOM

class El {
  tag: string;
  children: El[] = [];
  parent: El | null = null;
  text = '';
  className = '';
  hidden = false;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(ev: any) => void>> = {};
  dataset: Record<string, string> = {};
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
  /** Real DOM property used by the page (move/remove operations). */
  get parentNode(): El | null {
    return this.parent;
  }
  get firstChild(): El | null {
    return this.children[0] ?? null;
  }
  get lastChild(): El | null {
    return this.children[this.children.length - 1] ?? null;
  }
  get classList() {
    const self = this;
    return {
      add: (c: string) => {
        const parts = self.className.split(' ').filter(Boolean);
        if (!parts.includes(c)) parts.push(c);
        self.className = parts.join(' ');
      },
      remove: (c: string) => {
        self.className = self.className.split(' ').filter((p) => p && p !== c).join(' ');
      },
      contains: (c: string): boolean => self.className.split(' ').includes(c),
      toggle: (c: string, force?: boolean): boolean => {
        const parts = self.className.split(' ').filter(Boolean);
        const has = parts.includes(c);
        const on = force === undefined ? !has : !!force;
        if (on && !has) parts.push(c);
        if (!on && has) self.className = parts.filter((p) => p !== c).join(' ');
        if (on) self.className = parts.join(' ');
        return on;
      },
    };
  }
  /** Real-DOM semantics: appending an already-parented node moves it. */
  appendChild(c: El): El {
    if (c.parent) {
      const i = c.parent.children.indexOf(c);
      if (i >= 0) c.parent.children.splice(i, 1);
    }
    c.parent = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: El, ref: El | null): El {
    if (c.parent) {
      const i = c.parent.children.indexOf(c);
      if (i >= 0) c.parent.children.splice(i, 1);
    }
    c.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c: El): El {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parent = null;
    return c;
  }
  replaceChildren(...children: El[]): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    for (const c of children) {
      c.parent = this;
      this.children.push(c);
    }
  }
  remove(): void {
    if (this.parent) this.parent.removeChild(this);
  }
  contains(node: El | null): boolean {
    let cur: El | null = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parent;
    }
    return false;
  }
  querySelector(sel: string): El | null {
    const idSel = sel.startsWith('#') ? sel.slice(1) : null;
    const cls = !idSel && sel.startsWith('.') ? sel.slice(1) : null;
    const walk = (el: El): El | null => {
      for (const c of el.children) {
        if (idSel ? c.attrs.id === idSel : cls ? c.className.split(' ').includes(cls) : c.tag === sel) return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }
  querySelectorAll(sel: string): El[] {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    const out: El[] = [];
    const walk = (el: El) => {
      for (const c of el.children) {
        if (cls ? c.className.split(' ').includes(cls) : c.tag === sel) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
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
  open(): void {
    this.onopen?.({});
  }
  fail(): void {
    this.onerror?.({});
  }
  /** Mirror real EventSource: typed events go to listeners, not onmessage. */
  dispatch(type: string, data: unknown): void {
    const msg = { data: JSON.stringify(data) };
    if (type === 'message') {
      this.onmessage?.(msg);
      return;
    }
    for (const h of this.listeners[type] ?? []) h(msg);
  }
}

const PAGE_IDS = [
  'sbList', 'sbConn', 'sbLive', 'sbCounts', 'sbScan', 'sbNotReady', 'sbEmpty',
  'appVersionValue', 'themePicker', 'localePicker',
];

function runStatusPage(html: string, fetchImpl: (url: string, init?: any) => Promise<any>) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  expect(scripts.length).toBeGreaterThan(0);

  const byId = new Map<string, El>();
  for (const id of PAGE_IDS) {
    const el = new El('div');
    el.attrs.id = id;
    byId.set(id, el);
  }
  // Initial markup state: not-ready banner and empty state hidden.
  byId.get('sbNotReady')!.hidden = true;
  byId.get('sbEmpty')!.hidden = true;
  byId.get('sbScan')!.hidden = true;

  const docListeners: Record<string, Array<(ev: any) => void>> = {};
  const bodyEl = new El('body');
  bodyEl.attrs.id = 'body';
  const document = {
    body: bodyEl,
    documentElement: new El('html'),
    head: new El('head'),
    getElementById: (id: string) => byId.get(id) as El | undefined,
    createElement: (tag: string) => new El(tag),
    createTextNode: (text: string) => new El('#text', text),
    createDocumentFragment: () => new El('#fragment'),
    querySelectorAll: () => [] as El[],
    addEventListener: (type: string, h: (ev: any) => void) => {
      (docListeners[type] ??= []).push(h);
    },
    removeEventListener: (type: string, h: (ev: any) => void) => {
      const l = docListeners[type] ?? [];
      const i = l.indexOf(h);
      if (i >= 0) l.splice(i, 1);
    },
  };
  FakeEventSource.instances = [];
  const stored = new Map<string, string>();
  const sandbox: Record<string, unknown> = {
    document,
    location: { search: '', href: 'http://127.0.0.1/status-board' },
    history: { replaceState: () => {} },
    fetch: fetchImpl,
    EventSource: FakeEventSource,
    URLSearchParams,
    AbortController,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    navigator: { languages: ['en-US'], language: 'en-US' },
    localStorage: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => stored.set(k, String(v)),
    },
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init: any) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    addEventListener: (type: string, h: (ev: any) => void) => {
      (docListeners[type] ??= []).push(h);
    },
    removeEventListener: (type: string, h: (ev: any) => void) => {
      const l = docListeners[type] ?? [];
      const i = l.indexOf(h);
      if (i >= 0) l.splice(i, 1);
    },
    dispatchEvent: () => true,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scripts, sandbox, { timeout: 5000 });

  const sse = FakeEventSource.instances[0];
  return {
    el: (id: string) => byId.get(id)!,
    sse,
    dispatch: (type: string, data: unknown) => sse.dispatch(type, data),
    failSse: () => sse.fail(),
    openSse: () => sse.open(),
    docListeners,
  };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  await tick();
  await tick();
};

/** Snapshot fixture with a small session tree. */
function snap(over: Record<string, unknown> = {}) {
  return {
    server: { pid: 1, port: 1, started_at: 'x', uptime: 1 },
    scan: { scanning: false, homes: [] },
    sources: { wire: { sessions: 1, agents: 3 }, omkc: { connected: false } },
    sessions: [
      { sessionId: 's1', title: 'Session One', workDir: '/wd/s1', home: 'omkc' },
    ],
    agents: [
      {
        sessionId: 's1', agentId: 'main', kind: 'main', busy: true, stale: false,
        lastSeen: 1000, firstSeen: 100, subagents: [], model: 'kimi-k2',
      },
      {
        sessionId: 's1', agentId: 'child', kind: 'sub', parentAgentId: 'main',
        busy: false, stale: false, lastSeen: 900, firstSeen: 200, subagents: [],
        model: 'kimi-k2', lastTurnReason: 'completed',
      },
    ],
    ...over,
  };
}

function agentFrame(sessionId: string, agentId: string, over: Record<string, unknown> = {}) {
  return {
    sessionId, agentId, busy: false, stale: false, lastSeen: 0, firstSeen: 0,
    subagents: [], ...over,
  };
}

function sessionGroups(board: El): El[] {
  return board.children.filter((c) => c.className.split(' ').includes('sb-session'));
}

function rowsOf(group: El): El[] {
  const rows = group.children.find((c) => c.className.split(' ').includes('sb-rows'));
  return rows ? rows.children : [];
}

function rowIds(group: El): string[] {
  return rowsOf(group).map((r) => r.getAttribute('data-key') ?? '');
}

const offlineFetch = () => Promise.reject(new Error('offline'));

describe('Status Board backend', () => {
  let home: string;
  let bus: Bus;
  let port: number;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'moamcp-status-board-'));
    bus = new Bus({ port: 0, cwd: home, instancesDir: join(home, 'instances'), logsDir: join(home, 'logs') });
    port = await bus.start();
  });

  afterEach(async () => {
    await bus.stop();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('GET /status-board serves the page (200 + text/html + key markers)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status-board`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Agent Status Board');
    expect(html).toContain('data-i18n="status.title"');
    expect(html).toContain("connectSSE('/status/events'");
    expect(html).toContain("['snapshot', 'agent', 'session']");
    expect(html).toContain('id="statusNav" class="active" aria-current="page"');
    expect(html).toContain('href="/status-board"');
    // Shared chrome deep-links stay intact.
    expect(html).toContain('href="/control-plane?section=memory"');
    expect(html).toContain('href="/control-plane?section=system"');
    expect(html).not.toContain('innerHTML');
  });

  it('rejects non-GET methods with 405', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status-board`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

describe('Status Board page behavior (vm + fake DOM)', () => {
  it('renders a snapshot into session groups with tree rows and status column', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap());
    await flush();

    const groups = sessionGroups(page.el('sbList'));
    expect(groups.length).toBe(1);
    const group = groups[0];
    expect(group.getAttribute('data-session')).toBe('s1');
    expect(group.textContent).toContain('Session One');
    // DFS order: main (root) then child.
    const ids = rowIds(group);
    expect(ids).toEqual(['s1:main', 's1:child']);
    // status column: busy main -> st-busy pill + busy row; child completed -> st-done.
    const mainRow = rowsOf(group)[0];
    expect(mainRow.querySelector('.sb-status')!.className).toContain('st-busy');
    expect(mainRow.classList.contains('busy')).toBe(true);
    const childRow = rowsOf(group)[1];
    expect(childRow.querySelector('.sb-status')!.textContent).toBe('completed');
    expect(childRow.classList.contains('busy')).toBe(false);
    // counts chip
    expect(page.el('sbCounts').textContent).toContain('2 agents');
  });

  it('shows the scanning bar when snapshot.scan.scanning is true (E6)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    expect(page.el('sbScan').hidden).toBe(true);
    page.dispatch('snapshot', snap({ scan: { scanning: true, homes: [] } }));
    await flush();
    expect(page.el('sbScan').hidden).toBe(false);
  });

  it('upserts an agent frame reusing the row element (E1 keyed map)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap());
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    const mainRowBefore = rowsOf(group)[0];

    page.dispatch('agent', agentFrame('s1', 'main', { busy: false, stale: false, lastSeen: 2000, model: 'kimi-k3' }));
    await flush();
    const groupAfter = sessionGroups(page.el('sbList'))[0];
    const mainRowAfter = rowsOf(groupAfter)[0];
    expect(mainRowAfter).toBe(mainRowBefore); // same node reused
    expect(mainRowAfter.querySelector('.sb-model')!.textContent).toBe('kimi-k3');
    expect(mainRowAfter.querySelector('.sb-status')!.textContent).toBe('idle');
    expect(mainRowAfter.classList.contains('busy')).toBe(false);
  });

  it('renders the last tool column from the model (reviewer fix)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('agent', agentFrame('s1', 'main', { kind: 'main', lastToolCall: { name: 'read_file', ts: 5, isError: false } }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    const mainRow = rowsOf(group)[0];
    expect(mainRow.querySelector('.sb-tool')!.textContent).toBe('read_file');
    // isError marks the cell
    page.dispatch('agent', agentFrame('s1', 'main', { kind: 'main', lastToolCall: { name: 'run', ts: 6, isError: true } }));
    await flush();
    const rowAfter = rowsOf(sessionGroups(page.el('sbList'))[0])[0];
    expect(rowAfter.querySelector('.sb-tool')!.textContent).toBe('run');
    expect(rowAfter.querySelector('.sb-tool')!.className).toContain('err');
  });

  it('adopts a late parent frame: pending child row moves under the parent (reparent)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap());
    await flush();
    let group = sessionGroups(page.el('sbList'))[0];
    expect(rowIds(group)).toEqual(['s1:main', 's1:child']);

    // Empty snapshot -> board cleared, no groups.
    page.dispatch('snapshot', snap({ agents: [] }));
    await flush();
    expect(sessionGroups(page.el('sbList')).length).toBe(0);

    // Child frame arrives while its parent is absent -> pending root.
    page.dispatch('agent', agentFrame('s1', 'child', { parentAgentId: 'main', kind: 'sub' }));
    await flush();
    group = sessionGroups(page.el('sbList'))[0];
    expect(rowIds(group)).toEqual(['s1:child']);

    // Parent frame arrives later -> child row moves under the parent.
    page.dispatch('agent', agentFrame('s1', 'main', { kind: 'main', busy: true }));
    await flush();
    group = sessionGroups(page.el('sbList'))[0];
    expect(rowIds(group)).toEqual(['s1:main', 's1:child']);
  });

  it('gone removes the row + orphan leaves and re-roots independent children', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      agents: [
        agentFrame('s1', 'main', { kind: 'main', subagents: [{ subagentId: 'leaf', status: 'running', ts: 5 }] }),
        agentFrame('s1', 'child', { parentAgentId: 'main', kind: 'sub' }),
      ],
    }));
    await flush();
    let group = sessionGroups(page.el('sbList'))[0];
    expect(rowIds(group).sort()).toEqual(['s1:child', 's1:leaf', 's1:main']);
    const leafRow = rowsOf(group).find((r) => r.getAttribute('data-key') === 's1:leaf')!;

    page.dispatch('agent', { sessionId: 's1', agentId: 'main', gone: true });
    await flush();
    group = sessionGroups(page.el('sbList'))[0];
    expect(rowIds(group)).toEqual(['s1:child']); // orphan leaf died, child re-rooted
    expect(rowsOf(group).find((r) => r.getAttribute('data-key') === 's1:leaf')).toBeUndefined();
    expect(leafRow.parentNode).toBeNull();
  });

  it('session-gone marks the group ended while retaining live rows; a frame revives it', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap());
    await flush();
    let group = sessionGroups(page.el('sbList'))[0];
    expect(group.classList.contains('gone')).toBe(false);
    expect(rowIds(group).length).toBe(2);

    page.dispatch('session', { sessionId: 's1', gone: true });
    await flush();
    group = sessionGroups(page.el('sbList'))[0];
    expect(group.classList.contains('gone')).toBe(true);
    expect(rowIds(group).length).toBe(2); // rows retained (仍在收帧)

    // an agent frame for the session revives the group
    page.dispatch('agent', agentFrame('s1', 'main', { busy: true }));
    await flush();
    group = sessionGroups(page.el('sbList'))[0];
    expect(group.classList.contains('gone')).toBe(false);
  });

  it('session-gone drops the group entirely when it has no live agents', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({ agents: [] }));
    await flush();
    // empty snapshot -> no group at all; add one agent then remove it via gone
    page.dispatch('agent', agentFrame('s1', 'only', {}));
    await flush();
    expect(sessionGroups(page.el('sbList')).length).toBe(1);
    page.dispatch('agent', { sessionId: 's1', agentId: 'only', gone: true });
    await flush();
    expect(sessionGroups(page.el('sbList')).length).toBe(0);
  });

  it('SSE error + /status 503 probe renders the not-ready first-class state (E7)', async () => {
    const fetchImpl = (url: string) =>
      url === '/status'
        ? Promise.resolve({ status: 503, ok: false, json: () => Promise.resolve({ error: 'status_not_ready', started: false }), text: () => Promise.resolve('') })
        : Promise.reject(new Error('offline'));
    const page = runStatusPage(await fetchPage(), fetchImpl);
    page.dispatch('snapshot', snap());
    await flush();
    expect(page.el('sbNotReady').hidden).toBe(true);

    page.failSse();
    await flush();
    await flush();
    expect(page.el('sbNotReady').hidden).toBe(false);
    expect(page.el('sbConn').textContent).toContain('interruption');
  });

  it('a slow 503 probe resolving after SSE recovery must not re-show the banner (D4 race)', async () => {
    let resolveProbe: (r: any) => void = () => {};
    const probePromise = new Promise((r) => { resolveProbe = r; });
    const fetchImpl = (url: string) =>
      url === '/status'
        ? probePromise
        : Promise.reject(new Error('offline'));
    const page = runStatusPage(await fetchPage(), fetchImpl);
    page.dispatch('snapshot', snap());
    await flush();
    expect(page.el('sbNotReady').hidden).toBe(true);

    // SSE drops -> probe fires and hangs; SSE recovers before it answers.
    page.failSse();
    await flush();
    page.openSse();
    await flush();
    expect(page.el('sbNotReady').hidden).toBe(true);

    // The in-flight probe finally answers 503 — it must be ignored now.
    resolveProbe({ status: 503, ok: false, json: () => Promise.resolve({ error: 'status_not_ready', started: false }), text: () => Promise.resolve('') });
    await flush();
    await flush();
    expect(page.el('sbNotReady').hidden).toBe(true);
  });

  it('connection failure (non-503 probe) shows the backoff state, not the not-ready banner', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.failSse();
    await flush();
    await flush();
    expect(page.el('sbNotReady').hidden).toBe(true);
    expect(page.el('sbConn').textContent).toContain('interruption');
  });

  it('reconnect keeps rendered rows until a new snapshot replaces them (E1)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap());
    await flush();
    let group = sessionGroups(page.el('sbList'))[0];
    const rowBefore = rowsOf(group)[0];

    // connection drops and reopens (connectSSE error path) — no snapshot yet
    page.failSse();
    await flush();
    group = sessionGroups(page.el('sbList'))[0];
    expect(rowsOf(group).length).toBe(2); // rows kept across the drop
    page.openSse();
    await flush();

    // new snapshot arrives -> wholesale replace
    page.dispatch('snapshot', snap({ agents: [agentFrame('s1', 'main', { kind: 'main', busy: false })] }));
    await flush();
    group = sessionGroups(page.el('sbList'))[0];
    expect(rowIds(group)).toEqual(['s1:main']);
    const rowAfter = rowsOf(group)[0];
    // after a snapshot the board is rebuilt wholesale — node identity may change,
    // but the keyed rows are exactly the snapshot content.
    expect(rowAfter.getAttribute('data-key')).toBe('s1:main');
    expect(rowBefore).not.toBeUndefined();
    expect(page.el('sbNotReady').hidden).toBe(true);
  });

  it('opens the SSE connection to /status/events with typed event names', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    expect(page.sse.url).toBe('/status/events');
    expect(page.sse.listeners['snapshot']?.length).toBeGreaterThan(0);
    expect(page.sse.listeners['agent']?.length).toBeGreaterThan(0);
    expect(page.sse.listeners['session']?.length).toBeGreaterThan(0);
    expect(page.sse.closed).toBe(false);
  });

  it('renders ALL session groups on the first snapshot frame (F2 live HTMLCollection)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    // >= 3 groups: the old `for (j...) board.appendChild(frag.children[j])`
    // loop moved nodes out of the live collection while iterating, dropping
    // every other group (a 323-session snapshot rendered 162 groups).
    page.dispatch('snapshot', snap({
      sessions: [
        { sessionId: 's1', title: 'One', workDir: '/wd/s1', home: 'omkc' },
        { sessionId: 's2', title: 'Two', workDir: '/wd/s2', home: 'omkc' },
        { sessionId: 's3', title: 'Three', workDir: '/wd/s3', home: 'omkc' },
      ],
      agents: [
        agentFrame('s1', 'a1', { kind: 'main', busy: true }),
        agentFrame('s2', 'b1', { kind: 'main', busy: true }),
        agentFrame('s3', 'c1', { kind: 'main', busy: true }),
      ],
    }));
    await flush();
    const groups = sessionGroups(page.el('sbList'));
    expect(groups.map((g) => g.getAttribute('data-session'))).toEqual(['s1', 's2', 's3']);
    expect(rowIds(groups[0])).toEqual(['s1:a1']);
    expect(rowIds(groups[1])).toEqual(['s2:b1']);
    expect(rowIds(groups[2])).toEqual(['s3:c1']);
    expect(page.el('sbCounts').textContent).toContain('3 agents');
  });

  it('renders agent frames queued in the same batch as a snapshot (F3 no DOM lag)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    // Snapshot + agent frame for the same session land in ONE flush batch.
    // The old `rebuilt` short-circuit skipped the post-snapshot resort, so the
    // model update only appeared on the next flush.
    page.dispatch('snapshot', snap({ agents: [agentFrame('s1', 'main', { kind: 'main', busy: false })] }));
    page.dispatch('agent', agentFrame('s1', 'main', { kind: 'main', busy: true, model: 'kimi-k9' }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    const row = rowsOf(group)[0];
    expect(row.getAttribute('data-key')).toBe('s1:main');
    expect(row.querySelector('.sb-model')!.textContent).toBe('kimi-k9');
    expect(row.querySelector('.sb-status')!.textContent).toBe('busy');
    expect(row.classList.contains('busy')).toBe(true);
  });

  it('keeps session group order aligned with sessionOrder across incremental frames (F4)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      sessions: [
        { sessionId: 's1', title: 'One', workDir: '/wd/s1', home: 'omkc' },
        { sessionId: 's2', title: 'Two', workDir: '/wd/s2', home: 'omkc' },
        { sessionId: 's3', title: 'Three', workDir: '/wd/s3', home: 'omkc' },
      ],
      agents: [
        agentFrame('s1', 'a1', { kind: 'main', busy: true }),
        agentFrame('s2', 'b1', { kind: 'main', busy: true }),
        agentFrame('s3', 'c1', { kind: 'main', busy: true }),
      ],
    }));
    await flush();
    const order = () => sessionGroups(page.el('sbList')).map((g) => g.getAttribute('data-session'));
    expect(order()).toEqual(['s1', 's2', 's3']);

    // Touch the middle group incrementally: resortSession appends it to the
    // board end, which used to drift the order to s1,s3,s2.
    page.dispatch('agent', agentFrame('s2', 'b1', { kind: 'main', busy: false, lastTurnReason: 'completed' }));
    await flush();
    expect(order()).toEqual(['s1', 's2', 's3']);

    // Touch the first group too — still aligned.
    page.dispatch('agent', agentFrame('s1', 'a1', { kind: 'main', busy: false, lastTurnReason: 'completed' }));
    await flush();
    expect(order()).toEqual(['s1', 's2', 's3']);
  });

  it('rebuilds fresh rows after a session loses all agents and is revived (F4 rowEls residue)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap());
    await flush();
    const mainRowBefore = rowsOf(sessionGroups(page.el('sbList'))[0])[0];

    // Gone frames remove both agents incrementally -> the group is dropped.
    page.dispatch('agent', { sessionId: 's1', agentId: 'main', gone: true });
    await flush();
    page.dispatch('agent', { sessionId: 's1', agentId: 'child', gone: true });
    await flush();
    expect(sessionGroups(page.el('sbList')).length).toBe(0);

    // An agent frame revives the session without a snapshot; rows must be
    // freshly built, not stale nodes resurrected from rowEls.
    page.dispatch('agent', agentFrame('s1', 'main', { kind: 'main', busy: true }));
    await flush();
    const revived = sessionGroups(page.el('sbList'))[0];
    const revivedRow = rowsOf(revived)[0];
    expect(revivedRow.getAttribute('data-key')).toBe('s1:main');
    expect(revivedRow).not.toBe(mainRowBefore);
    expect(revivedRow.querySelector('.sb-status')!.textContent).toBe('busy');
  });

  it('first render marks error tool calls red (F5 createRowEl)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    // Snapshot full render (first frame) with an error tool call: the old
    // createRowEl omitted the `err` class (only updateRowEl applied it).
    page.dispatch('snapshot', snap({ agents: [
      agentFrame('s1', 'main', { kind: 'main', lastToolCall: { name: 'run', ts: 6, isError: true } }),
      agentFrame('s1', 'child', { parentAgentId: 'main', kind: 'sub', lastToolCall: { name: 'grep', ts: 4, isError: false } }),
    ] }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    const mainRow = rowsOf(group)[0];
    expect(mainRow.querySelector('.sb-tool')!.textContent).toBe('run');
    expect(mainRow.querySelector('.sb-tool')!.className).toContain('err');
    // Non-error tool stays unstyled; incremental updates still work after.
    const childRow = rowsOf(group)[1];
    expect(childRow.querySelector('.sb-tool')!.textContent).toBe('grep');
    expect(childRow.querySelector('.sb-tool')!.className).not.toContain('err');
    page.dispatch('agent', agentFrame('s1', 'child', { parentAgentId: 'main', kind: 'sub', lastToolCall: { name: 'write', ts: 7, isError: true } }));
    await flush();
    const childAfter = rowsOf(sessionGroups(page.el('sbList'))[0])[1];
    expect(childAfter.querySelector('.sb-tool')!.className).toContain('err');
  });
});

let cachedHtml: string | undefined;
async function fetchPage(): Promise<string> {
  if (cachedHtml === undefined) {
    const { STATUS_BOARD_HTML } = await import('../src/web/status-board.js');
    cachedHtml = STATUS_BOARD_HTML;
  }
  return cachedHtml;
}
