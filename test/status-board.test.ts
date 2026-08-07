/**
 * Status Board page tests (0.10.0):
 *  - backend: GET /status-board serves the page (200 + text/html + markers);
 *  - page behavior: run the page's inline <script> in a vm with a fake DOM +
 *    FakeEventSource (bus.test.ts runCardScript pattern) and drive
 *    snapshot/agent/session frames, gone re-roots, session-gone, the SSE
 *    error + /status 503 probe first-class state, and reconnect-keeps-rows;
 *  - 0.10.0: directory tree (workDir-keyed), top active section, three-level
 *    lazy rendering (folded dir / head-only session / fold-bar inactive rows),
 *    dir-fold localStorage persistence, and the localechange re-render path.
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
  'sbList', 'sbActive', 'sbActiveRows', 'sbConn', 'sbLive', 'sbCounts', 'sbScan', 'sbNotReady', 'sbEmpty',
  'appVersionValue', 'themePicker', 'localePicker',
];

interface StatusPage {
  el: (id: string) => El;
  sse: FakeEventSource;
  dispatch: (type: string, data: unknown) => void;
  failSse: () => void;
  openSse: () => void;
  docListeners: Record<string, Array<(ev: any) => void>>;
  sandbox: Record<string, unknown>;
  getStored: (k: string) => string | null;
}

/** localStorage seed seam: pre-populate persisted state (e.g. dir folds). */
function runStatusPage(html: string, fetchImpl: (url: string, init?: any) => Promise<any>, storedSeed?: Record<string, string>): StatusPage {
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
  const stored = new Map<string, string>(Object.entries(storedSeed ?? {}));
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
    sandbox,
    getStored: (k: string) => stored.get(k) ?? null,
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
      { sessionId: 's1', title: 'Session One', workDir: '/wd/s1', workDirHash: 'h1', home: 'omkc' },
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

/** Click the first registered click listener (fake DOM has no dispatchEvent). */
function click(el: El | null): void {
  expect(el).not.toBeNull();
  const h = el!.listeners['click']?.[0];
  expect(h).toBeDefined();
  h!({});
}

/** Switch the i18n runtime locale, then fire every localechange listener
 *  (the page's re-render handler plus lib's theme-label sync). */
function setLocale(page: StatusPage, locale: string): void {
  (page.sandbox as { __moaI18n: { setLocale: (l: string, persist?: boolean) => void } }).__moaI18n.setLocale(locale, false);
  for (const h of page.docListeners['moamcp:localechange'] ?? []) h({ detail: { locale } });
}

/** Directory groups under the board (top-level children with .sb-dir). */
function dirGroups(board: El): El[] {
  return board.children.filter((c) => c.className.split(' ').includes('sb-dir'));
}

/** Session groups anywhere under a container (dirs nest session groups). */
function sessionGroups(container: El): El[] {
  const out: El[] = [];
  const walk = (el: El) => {
    for (const c of el.children) {
      if (c.className.split(' ').includes('sb-session')) out.push(c);
      walk(c);
    }
  };
  walk(container);
  return out;
}

/** Every rendered row in a session group: active container rows + (when the
 *  fold bar is open) inactive container rows, in DOM order. 0.11.0: recursive
 *  — rows nest inside .sb-subtree containers under their parent row. */
function rowsOf(group: El): El[] {
  const out: El[] = [];
  const walk = (el: El) => {
    for (const c of el.children) {
      if (c.className.split(' ').includes('sb-row')) out.push(c);
      walk(c);
    }
  };
  for (const c of group.children) {
    if (c.className.split(' ').includes('sb-rows')) walk(c);
  }
  return out;
}

function rowIds(group: El): string[] {
  return rowsOf(group).map((r) => r.getAttribute('data-key') ?? '');
}

/** A row's .sb-subtree container (0.11.0: nested INSIDE the row element). */
function subtreeOf(row: El): El | null {
  return row.children.find((c) => c.className.split(' ').includes('sb-subtree')) ?? null;
}

/** Rows rendered in the top active section container. */
function activeRows(activeEl: El): El[] {
  const rows = activeEl.children.find((c) => c.className.split(' ').includes('sb-active-rows'));
  return rows ? rows.children : [];
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

    const dir = dirGroups(page.el('sbList'))[0];
    expect(dir.getAttribute('data-dir')).toBe('/wd/s1');
    const groups = sessionGroups(dir);
    expect(groups.length).toBe(1);
    const group = groups[0];
    expect(group.getAttribute('data-session')).toBe('s1');
    expect(group.textContent).toContain('Session One');
    // Active rows are built; the inactive child is behind the fold bar (lazy).
    expect(rowIds(group)).toEqual(['s1:main']);
    click(group.querySelector('.sb-fold')!);
    expect(rowIds(group)).toEqual(['s1:main', 's1:child']);
    // DFS order: main (root) then child.
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
    // Two sessions share one workDir: when s1:main goes idle the dir stays
    // expanded because s2 is still active — otherwise the dir would auto-fold
    // (default: hasActive ? expanded : folded) and the group would vanish
    // before the reuse assertion.
    page.dispatch('snapshot', snap({
      sessions: [
        { sessionId: 's1', title: 'Session One', workDir: '/wd/shared', workDirHash: 'h1', home: 'omkc' },
        { sessionId: 's2', title: 'Session Two', workDir: '/wd/shared', workDirHash: 'h2', home: 'omkc' },
      ],
      agents: [
        { sessionId: 's1', agentId: 'main', kind: 'main', busy: true, stale: false, lastSeen: 1000, firstSeen: 100, subagents: [], model: 'kimi-k2' },
        { sessionId: 's1', agentId: 'child', kind: 'sub', parentAgentId: 'main', busy: false, stale: false, lastSeen: 900, firstSeen: 200, subagents: [], model: 'kimi-k2', lastTurnReason: 'completed' },
        agentFrame('s2', 'other', { kind: 'main', busy: true }),
      ],
    }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    const mainRowBefore = rowsOf(group)[0];
    // open the fold bar so the inactive child row exists (lazy rendering)
    click(group.querySelector('.sb-fold')!);
    expect(rowIds(group)).toEqual(['s1:main', 's1:child']);

    page.dispatch('agent', agentFrame('s1', 'main', { busy: false, stale: false, lastSeen: 2000, model: 'kimi-k3' }));
    await flush();
    const groupAfter = sessionGroups(page.el('sbList'))[0];
    const mainRowAfter = rowsOf(groupAfter)[0];
    expect(mainRowAfter).toBe(mainRowBefore); // same node reused (moved to the inactive side)
    expect(mainRowAfter.querySelector('.sb-model')!.textContent).toBe('kimi-k3');
    expect(mainRowAfter.querySelector('.sb-status')!.textContent).toBe('idle');
    expect(mainRowAfter.classList.contains('busy')).toBe(false);
  });

  it('renders the last tool column from the model (reviewer fix)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    // keep the agent busy so the session renders without manual expansion
    // (inactive sessions are lazily folded / head-only)
    page.dispatch('agent', agentFrame('s1', 'main', { kind: 'main', busy: true, lastToolCall: { name: 'read_file', ts: 5, isError: false } }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    const mainRow = rowsOf(group)[0];
    expect(mainRow.querySelector('.sb-tool')!.textContent).toBe('read_file');
    // isError marks the cell
    page.dispatch('agent', agentFrame('s1', 'main', { kind: 'main', busy: true, lastToolCall: { name: 'run', ts: 6, isError: true } }));
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
    // open the fold bar: the inactive child row is lazy-rendered
    click(group.querySelector('.sb-fold')!);
    expect(rowIds(group)).toEqual(['s1:main', 's1:child']);

    // Empty snapshot -> board cleared, no groups.
    page.dispatch('snapshot', snap({ agents: [] }));
    await flush();
    expect(sessionGroups(page.el('sbList')).length).toBe(0);
    // The dir defaults to folded for an inactive session: expand it so the
    // incremental frames below render (folded dir = zero session DOM).
    const dir = dirGroups(page.el('sbList'))[0];
    click(dir.querySelector('.sb-dir-head')!);
    expect(dir.classList.contains('collapsed')).toBe(false);

    // Child frame arrives while its parent is absent -> pending root.
    page.dispatch('agent', agentFrame('s1', 'child', { parentAgentId: 'main', kind: 'sub' }));
    await flush();
    group = sessionGroups(page.el('sbList'))[0];
    click(group.querySelector('.sb-fold')!);
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
    // All agents inactive -> the dir defaults to folded and the session is
    // head-only. Expand, then upgrade to the full render to inspect rows.
    const dir = dirGroups(page.el('sbList'))[0];
    click(dir.querySelector('.sb-dir-head')!);
    let group = sessionGroups(page.el('sbList'))[0];
    click(group.querySelector('.sb-session-head')!); // head-only -> full (fold bar)
    click(group.querySelector('.sb-fold')!);         // build the inactive rows
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
    click(group.querySelector('.sb-fold')!);
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
    // empty snapshot -> no group at all; the dir is folded (no active agents),
    // so expand it before incremental frames (folded dir = zero session DOM)
    const dir = dirGroups(page.el('sbList'))[0];
    click(dir.querySelector('.sb-dir-head')!);
    expect(sessionGroups(page.el('sbList')).length).toBe(0);
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
    expect(rowsOf(group).length).toBe(1); // active row kept; the child is lazy
    page.openSse();
    await flush();

    // new snapshot arrives -> wholesale replace. The agent stays busy so the
    // dir stays expanded (inactive sessions are lazily folded / head-only).
    page.dispatch('snapshot', snap({ agents: [agentFrame('s1', 'main', { kind: 'main', busy: true })] }));
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
        { sessionId: 's1', title: 'One', workDir: '/wd/s1', workDirHash: 'h1', home: 'omkc' },
        { sessionId: 's2', title: 'Two', workDir: '/wd/s2', workDirHash: 'h2', home: 'omkc' },
        { sessionId: 's3', title: 'Three', workDir: '/wd/s3', workDirHash: 'h3', home: 'omkc' },
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
    // All three sessions share one workDir: with dir grouping an individual
    // session losing activity no longer reorders the tree (the dir stays
    // expanded while any session in it is active). This still exercises the F4
    // regression — resortSession appends a touched group to its dir's end,
    // which used to drift the board order to s1,s3,s2.
    page.dispatch('snapshot', snap({
      sessions: [
        { sessionId: 's1', title: 'One', workDir: '/wd/shared', workDirHash: 'h1', home: 'omkc' },
        { sessionId: 's2', title: 'Two', workDir: '/wd/shared', workDirHash: 'h2', home: 'omkc' },
        { sessionId: 's3', title: 'Three', workDir: '/wd/shared', workDirHash: 'h3', home: 'omkc' },
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

    // Touch the middle group incrementally.
    page.dispatch('agent', agentFrame('s2', 'b1', { kind: 'main', busy: false, lastTurnReason: 'completed' }));
    await flush();
    expect(order()).toEqual(['s1', 's2', 's3']);

    // Touch the first group too — still aligned.
    page.dispatch('agent', agentFrame('s1', 'a1', { kind: 'main', busy: false, lastTurnReason: 'completed' }));
    await flush();
    expect(order()).toEqual(['s1', 's2', 's3']);
  });

  it('drops a session group once its last agent is gone and rebuilds fresh rows on revive (F4)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap());
    await flush();
    const mainRowBefore = rowsOf(sessionGroups(page.el('sbList'))[0])[0];

    // Gone frames remove both agents incrementally -> the group is dropped.
    // (handleGone deletes each row's rowEls entry as its agent goes; the F4
    // empty-branch sweep in resortSession additionally clears entries for
    // removal paths that never pass through handleGone.)
    page.dispatch('agent', { sessionId: 's1', agentId: 'main', gone: true });
    await flush();
    page.dispatch('agent', { sessionId: 's1', agentId: 'child', gone: true });
    await flush();
    expect(sessionGroups(page.el('sbList')).length).toBe(0);

    // An agent frame revives the session without a snapshot; the group and its
    // rows must be freshly built, never stale nodes resurrected from rowEls.
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
    // main stays busy so the session renders fully; the inactive child is
    // revealed by opening the fold bar
    page.dispatch('snapshot', snap({ agents: [
      agentFrame('s1', 'main', { kind: 'main', busy: true, lastToolCall: { name: 'run', ts: 6, isError: true } }),
      agentFrame('s1', 'child', { parentAgentId: 'main', kind: 'sub', lastToolCall: { name: 'grep', ts: 4, isError: false } }),
    ] }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    const mainRow = rowsOf(group)[0];
    expect(mainRow.querySelector('.sb-tool')!.textContent).toBe('run');
    expect(mainRow.querySelector('.sb-tool')!.className).toContain('err');
    // Non-error tool stays unstyled; incremental updates still work after.
    click(group.querySelector('.sb-fold')!);
    const childRow = rowsOf(group)[1];
    expect(childRow.querySelector('.sb-tool')!.textContent).toBe('grep');
    expect(childRow.querySelector('.sb-tool')!.className).not.toContain('err');
    page.dispatch('agent', agentFrame('s1', 'child', { parentAgentId: 'main', kind: 'sub', lastToolCall: { name: 'write', ts: 7, isError: true } }));
    await flush();
    const childAfter = rowsOf(sessionGroups(page.el('sbList'))[0])[1];
    expect(childAfter.querySelector('.sb-tool')!.className).toContain('err');
  });
});

describe('Status Board 0.10.0: directory tree, active section and lazy rendering', () => {
  it('renders snapshot into dir groups -> session groups -> agent rows, active dirs first', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      sessions: [
        { sessionId: 's1', title: 'Active Sess', workDir: '/wd/active', workDirHash: 'h1' },
        { sessionId: 's2', title: 'Idle Sess', workDir: '/wd/idle', workDirHash: 'h2' },
      ],
      agents: [
        agentFrame('s1', 'main', { kind: 'main', busy: true }),
        agentFrame('s2', 'lone', { kind: 'main', busy: false, lastSeen: 700 }),
      ],
    }));
    await flush();
    const dirs = dirGroups(page.el('sbList'));
    // active dir first, then the inactive one (default folded)
    expect(dirs.map((d) => d.getAttribute('data-dir'))).toEqual(['/wd/active', '/wd/idle']);
    const dActive = dirs[0];
    expect(dActive.classList.contains('collapsed')).toBe(false);
    expect(dActive.querySelector('.sb-dir-count')!.textContent).toContain('1 active');
    const activeGroups = sessionGroups(dActive);
    expect(activeGroups.map((g) => g.getAttribute('data-session'))).toEqual(['s1']);
    expect(rowIds(activeGroups[0])).toEqual(['s1:main']);
    const dIdle = dirs[1];
    expect(dIdle.classList.contains('collapsed')).toBe(true);
    expect(dIdle.querySelector('.sb-dir-count')!.textContent).toContain('1 past session');
    expect(sessionGroups(dIdle)).toEqual([]); // folded dir: zero session DOM
  });

  it('lazy rendering: inactive session builds only a head; folded dir builds zero session DOM', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      sessions: [
        { sessionId: 's1', title: 'Busy', workDir: '/wd/mixed', workDirHash: 'h1' },
        { sessionId: 's2', title: 'Quiet', workDir: '/wd/mixed', workDirHash: 'h2' },
      ],
      agents: [
        agentFrame('s1', 'main', { kind: 'main', busy: true }),
        agentFrame('s2', 'lone', { kind: 'main', busy: false, lastSeen: 500 }),
      ],
    }));
    await flush();
    const dirs = dirGroups(page.el('sbList'));
    expect(dirs.length).toBe(1); // both sessions share /wd/mixed
    const dir = dirs[0];
    expect(dir.classList.contains('collapsed')).toBe(false); // s1 is active
    const groups = sessionGroups(dir);
    expect(groups.length).toBe(2);
    const s1 = groups.find((g) => g.getAttribute('data-session') === 's1')!;
    const s2 = groups.find((g) => g.getAttribute('data-session') === 's2')!;
    // s2 is pure-inactive -> head only, zero agent DOM
    expect(rowIds(s2)).toEqual([]);
    expect(s2.querySelector('.sb-session-head')).not.toBeNull();
    expect(s2.querySelector('.sb-rows')).toBeNull();
    // s1 is full: head + colhead + rows
    expect(rowIds(s1)).toEqual(['s1:main']);
    expect(s1.querySelector('.sb-rows')).not.toBeNull();
    // fold the dir -> internal session DOM is torn down
    click(dir.querySelector('.sb-dir-head')!);
    expect(dir.classList.contains('collapsed')).toBe(true);
    expect(sessionGroups(dir)).toEqual([]);
  });

  it('first build: a hidden session renders fully + joins the active section on its first busy frame', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    // s1 is inactive -> its dir defaults to folded -> zero session DOM
    page.dispatch('snapshot', snap({
      sessions: [{ sessionId: 's1', title: 'Dormant', workDir: '/wd/dormant', workDirHash: 'h1' }],
      agents: [agentFrame('s1', 'main', { kind: 'main', busy: false, lastSeen: 100 })],
    }));
    await flush();
    expect(page.el('sbActive').hidden).toBe(true);
    expect(sessionGroups(page.el('sbList'))).toEqual([]);
    expect(dirGroups(page.el('sbList'))[0].classList.contains('collapsed')).toBe(true);

    // busy frame -> dir auto-expands (default follows hasActive), the session
    // is fully built, and the agent joins the top active section
    page.dispatch('agent', agentFrame('s1', 'main', { kind: 'main', busy: true, lastSeen: 200 }));
    await flush();
    const dir = dirGroups(page.el('sbList'))[0];
    expect(dir.classList.contains('collapsed')).toBe(false);
    const group = sessionGroups(page.el('sbList'))[0];
    expect(group.getAttribute('data-session')).toBe('s1');
    expect(rowIds(group)).toEqual(['s1:main']);
    expect(page.el('sbActive').hidden).toBe(false);
    expect(activeRows(page.el('sbActive')).map((r) => r.getAttribute('data-key'))).toEqual(['s1:main']);
  });

  it('teardown: an active session losing every agent removes group + rows without ghosts', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap());
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    expect(rowIds(group)).toEqual(['s1:main']);
    expect(page.el('sbActive').hidden).toBe(false);
    expect(activeRows(page.el('sbActive')).map((r) => r.getAttribute('data-key'))).toEqual(['s1:main']);

    page.dispatch('agent', { sessionId: 's1', agentId: 'child', gone: true });
    await flush();
    page.dispatch('agent', { sessionId: 's1', agentId: 'main', gone: true });
    await flush();
    // no session group remains and no ghost rows survive under the board
    expect(sessionGroups(page.el('sbList'))).toEqual([]);
    expect(page.el('sbList').querySelector('.sb-row')).toBeNull();
    expect(dirGroups(page.el('sbList'))).toEqual([]);
    expect(page.el('sbActive').hidden).toBe(true);
    expect(activeRows(page.el('sbActive'))).toEqual([]);
  });

  it('active section mirrors tree row content; an agent going idle leaves the section', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      agents: [
        agentFrame('s1', 'main', { kind: 'main', busy: true, model: 'kimi-k2', lastSeen: 1000, phase: 'thinking' }),
        agentFrame('s1', 'child', { parentAgentId: 'main', kind: 'sub', busy: true, model: 'kimi-k2', lastSeen: 900 }),
      ],
    }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    const activeEl = page.el('sbActive');
    expect(activeEl.hidden).toBe(false);
    const activeKeys = () => activeRows(activeEl).map((r) => r.getAttribute('data-key'));
    expect(activeKeys()).toEqual(['s1:main', 's1:child']);
    // tree rows (active) and active-section rows share content
    const treeMain = rowsOf(group)[0];
    const activeMain = activeRows(activeEl)[0];
    expect(activeMain.querySelector('.sb-agent')!.textContent).toBe(treeMain.querySelector('.sb-agent')!.textContent);
    expect(activeMain.querySelector('.sb-model')!.textContent).toBe('kimi-k2');
    // incremental frame updates BOTH DOMs (same content, two keyed maps)
    page.dispatch('agent', agentFrame('s1', 'main', { kind: 'main', busy: true, model: 'kimi-k9', lastSeen: 1100 }));
    await flush();
    const treeMain2 = rowsOf(sessionGroups(page.el('sbList'))[0])[0];
    const activeMain2 = activeRows(activeEl)[0];
    expect(treeMain2.querySelector('.sb-model')!.textContent).toBe('kimi-k9');
    expect(activeMain2.querySelector('.sb-model')!.textContent).toBe('kimi-k9');
    // child goes idle -> leaves the active section (stays in the tree inactive)
    page.dispatch('agent', agentFrame('s1', 'child', { parentAgentId: 'main', kind: 'sub', busy: false, lastSeen: 910 }));
    await flush();
    expect(activeKeys()).toEqual(['s1:main']);
    // the tree still shows the child once the fold bar is opened
    click(sessionGroups(page.el('sbList'))[0].querySelector('.sb-fold')!);
    expect(rowIds(sessionGroups(page.el('sbList'))[0])).toEqual(['s1:main', 's1:child']);
  });

  it('a gone frame for a never-rendered session does not crash and updates dir counts', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      sessions: [
        { sessionId: 's1', title: 'One', workDir: '/wd/x', workDirHash: 'h1' },
        { sessionId: 's2', title: 'Two', workDir: '/wd/x', workDirHash: 'h2' },
      ],
      agents: [
        agentFrame('s1', 'main', { kind: 'main', busy: false, lastSeen: 1 }),
        agentFrame('s2', 'other', { kind: 'main', busy: false, lastSeen: 2 }),
      ],
    }));
    await flush();
    // dir defaults to folded (no active) -> zero session DOM
    expect(sessionGroups(page.el('sbList'))).toEqual([]);
    const dir = dirGroups(page.el('sbList'))[0];
    expect(dir.getAttribute('data-dir')).toBe('/wd/x');
    expect(dir.querySelector('.sb-dir-count')!.textContent).toContain('2 past sessions');

    // gone frame for a session that was never rendered
    page.dispatch('agent', { sessionId: 's2', agentId: 'other', gone: true });
    await flush();
    expect(sessionGroups(page.el('sbList'))).toEqual([]);
    expect(dirGroups(page.el('sbList'))[0].querySelector('.sb-dir-count')!.textContent).toContain('1 past session');
    expect(page.el('sbActive').hidden).toBe(true);
  });

  it('dir ordering is stable across flushes and unknown sessions aggregate into __unknown__', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      sessions: [
        { sessionId: 's1', title: 'One', workDir: '/a', workDirHash: 'ha' },
        { sessionId: 's2', title: 'Two', workDir: '/b', workDirHash: 'hb' },
        { sessionId: 'u1', title: 'Uno' },
        { sessionId: 'u2', title: 'Due' },
      ],
      agents: [
        agentFrame('s1', 'a1', { kind: 'main', busy: true }),
        agentFrame('s2', 'b1', { kind: 'main', busy: true }),
        agentFrame('s2', 'b2', { kind: 'main', busy: true }),
        agentFrame('u1', 'x1', { kind: 'main', busy: true }),
        agentFrame('u2', 'x2', { kind: 'main', busy: false }),
      ],
    }));
    await flush();
    const keys = () => dirGroups(page.el('sbList')).map((d) => d.getAttribute('data-dir'));
    // /b (2 active) first, then /a and __unknown__ (1 active each, dirKey asc)
    expect(keys()).toEqual(['/b', '/a', '__unknown__']);
    // u1 (active) + u2 (inactive) aggregate into the __unknown__ dir
    const unknown = dirGroups(page.el('sbList'))[2];
    expect(unknown.classList.contains('collapsed')).toBe(false); // hasActive -> expanded
    expect(sessionGroups(unknown).map((g) => g.getAttribute('data-session')).sort()).toEqual(['u1', 'u2']);
    // touch s1 (still active) -> order unchanged across flush
    page.dispatch('agent', agentFrame('s1', 'a1', { kind: 'main', busy: true, model: 'k2' }));
    await flush();
    expect(keys()).toEqual(['/b', '/a', '__unknown__']);
  });

  it('a session moving dirs (hash backfill) relocates its group and updates both dir counts', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      sessions: [
        { sessionId: 's1', title: 'One' },
        { sessionId: 's2', title: 'Two', workDir: '/wd/two', workDirHash: 'h2' },
      ],
      agents: [
        agentFrame('s2', 'other', { kind: 'main', busy: true }),
        agentFrame('s1', 'main', { kind: 'main', busy: false, lastSeen: 100 }),
      ],
    }));
    await flush();
    expect(dirGroups(page.el('sbList')).map((d) => d.getAttribute('data-dir'))).toEqual(['/wd/two', '__unknown__']);
    // expand the __unknown__ dir so s1's head-only group exists before the move
    const unknownDir = dirGroups(page.el('sbList')).find((d) => d.getAttribute('data-dir') === '__unknown__')!;
    click(unknownDir.querySelector('.sb-dir-head')!);
    const s1Group = sessionGroups(unknownDir)[0];
    expect(s1Group.getAttribute('data-session')).toBe('s1');

    // s1's agent frame backfills its workDirHash -> the dirKey flips to hash:...
    page.dispatch('agent', agentFrame('s1', 'main', { kind: 'main', busy: true, workDirHash: '0123456789abcdef' }));
    await flush();
    const dirKeys = dirGroups(page.el('sbList')).map((d) => d.getAttribute('data-dir'));
    expect(dirKeys).toContain('hash:0123456789abcdef');
    expect(dirKeys).not.toContain('__unknown__');
    const hashDir = dirGroups(page.el('sbList')).find((d) => d.getAttribute('data-dir') === 'hash:0123456789abcdef')!;
    const moved = sessionGroups(hashDir);
    expect(moved.length).toBe(1);
    expect(moved[0]).toBe(s1Group); // the same DOM node moved across dirs
    expect(rowIds(moved[0])).toEqual(['s1:main']);
    // both dirs' counts updated: /wd/two unchanged, hash dir 1 active
    expect(dirGroups(page.el('sbList')).find((d) => d.getAttribute('data-dir') === '/wd/two')!.querySelector('.sb-dir-count')!.textContent).toContain('1 active');
    expect(hashDir.querySelector('.sb-dir-count')!.textContent).toContain('1 active');
  });

  it('localechange refreshes dir rows, fold bars, active section and inactive session heads', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      sessions: [
        { sessionId: 's1', title: 'One', workDir: '/wd/one', workDirHash: 'h1' },
        { sessionId: 's2', title: 'Two' },
      ],
      agents: [
        agentFrame('s1', 'main', { kind: 'main', busy: true }),
        agentFrame('s1', 'child', { parentAgentId: 'main', kind: 'sub', busy: false, lastSeen: 4 }),
        agentFrame('s2', 'lone', { kind: 'main', busy: false, lastSeen: 5 }),
      ],
    }));
    await flush();
    // expand the unknown dir (default folded) so s2's head-only group exists
    const unknownDir = dirGroups(page.el('sbList')).find((d) => d.getAttribute('data-dir') === '__unknown__')!;
    click(unknownDir.querySelector('.sb-dir-head')!);
    // open s1's fold bar so the inactive-count pill exists
    const s1Group = sessionGroups(page.el('sbList')).find((g) => g.getAttribute('data-session') === 's1')!;
    click(s1Group.querySelector('.sb-fold')!);

    // English baseline
    expect(unknownDir.querySelector('.sb-dir-title')!.textContent).toBe('Unknown directory');
    expect(s1Group.querySelector('.sb-fold')!.textContent).toContain('1 inactive');
    expect(page.el('sbActive').children[0].textContent).toBe('Active');

    // switch to zh-CN and fire the page's localechange listener
    setLocale(page, 'zh-CN');
    expect(dirGroups(page.el('sbList')).find((d) => d.getAttribute('data-dir') === '/wd/one')!.querySelector('.sb-dir-count')!.textContent).toContain('1 个活跃');
    const unknownDir2 = dirGroups(page.el('sbList')).find((d) => d.getAttribute('data-dir') === '__unknown__')!;
    expect(unknownDir2.querySelector('.sb-dir-title')!.textContent).toBe('未知目录');
    const s1Group2 = sessionGroups(page.el('sbList')).find((g) => g.getAttribute('data-session') === 's1')!;
    expect(s1Group2.querySelector('.sb-fold')!.textContent).toContain('1 个不活跃');
    expect(page.el('sbActive').children[0].textContent).toBe('活跃');
    const s2Group = sessionGroups(page.el('sbList')).find((g) => g.getAttribute('data-session') === 's2')!;
    expect(s2Group.querySelector('.sb-session-count')!.textContent).toContain('最后活跃');
  });

  it('localechange re-translates the .sb-ended badge (F2)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap());
    await flush();
    // session-gone keeps the live rows and marks the group ended -> badge visible
    page.dispatch('session', { sessionId: 's1', gone: true });
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    const ended = group.querySelector('.sb-ended')!;
    expect(ended.hidden).toBe(false);
    expect(ended.textContent).toBe('session ended');
    // the localechange re-render must retranslate the badge (it was set only
    // once at element creation before the F2 fix)
    setLocale(page, 'zh-CN');
    expect(ended.textContent).toBe('会话已结束');
    expect(ended.hidden).toBe(false);
  });

  it('fold interactions: dir head toggles + persists, fold bar lazily builds inactive rows, session head upgrades', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap());
    await flush();
    const dir = dirGroups(page.el('sbList'))[0];
    const dirHead = dir.querySelector('.sb-dir-head')!;
    expect(dir.getAttribute('data-dir')).toBe('/wd/s1');
    // default: expanded (hasActive)
    expect(dir.classList.contains('collapsed')).toBe(false);
    expect(sessionGroups(dir).length).toBe(1);
    // collapse -> sessions torn down, persisted as the opposite of default
    click(dirHead);
    expect(dir.classList.contains('collapsed')).toBe(true);
    expect(sessionGroups(dir)).toEqual([]);
    const stored = JSON.parse(page.getStored('moamcp-status-folds')!);
    expect(stored.dirs['/wd/s1']).toBe(1);
    // expand again -> sessions restored, record removed (matches default)
    click(dirHead);
    expect(dir.classList.contains('collapsed')).toBe(false);
    expect(sessionGroups(dir).length).toBe(1);
    const stored2 = JSON.parse(page.getStored('moamcp-status-folds')!);
    expect(stored2.dirs['/wd/s1']).toBeUndefined();

    // fold bar: inactive rows are lazily built on click, removed on collapse
    let s1Group = sessionGroups(dir)[0];
    expect(rowIds(s1Group)).toEqual(['s1:main']);
    click(s1Group.querySelector('.sb-fold')!);
    expect(rowIds(s1Group)).toEqual(['s1:main', 's1:child']);
    click(s1Group.querySelector('.sb-fold')!);
    expect(rowIds(s1Group)).toEqual(['s1:main']);

    // head-only upgrade: a pure-inactive session shows just a head; clicking
    // it builds the fold bar; clicking the fold bar builds the inactive rows
    page.dispatch('snapshot', snap({
      sessions: [{ sessionId: 's9', title: 'Idle', workDir: '/wd/idle', workDirHash: 'h9' }],
      agents: [agentFrame('s9', 'lone', { kind: 'main', busy: false, lastSeen: 1 })],
    }));
    await flush();
    const idleDir = dirGroups(page.el('sbList'))[0];
    expect(idleDir.classList.contains('collapsed')).toBe(true); // default folded
    click(idleDir.querySelector('.sb-dir-head')!);
    const idleGroup = sessionGroups(page.el('sbList'))[0];
    expect(rowIds(idleGroup)).toEqual([]);
    expect(idleGroup.querySelector('.sb-rows')).toBeNull(); // head only
    click(idleGroup.querySelector('.sb-session-head')!);    // upgrade to full
    expect(idleGroup.querySelector('.sb-fold')).not.toBeNull();
    expect(idleGroup.querySelector('.sb-fold')!.textContent).toContain('1 inactive');
    expect(rowIds(idleGroup)).toEqual([]);                  // still no active rows
    click(idleGroup.querySelector('.sb-fold')!);
    expect(rowIds(idleGroup)).toEqual(['s9:lone']);
  });

  it('expanding or collapsing a session keeps its position among sibling sessions', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      sessions: [
        { sessionId: 's1', title: 'One', workDir: '/wd/pos', workDirHash: 'hp1' },
        { sessionId: 's2', title: 'Two', workDir: '/wd/pos', workDirHash: 'hp1' },
        { sessionId: 's3', title: 'Three', workDir: '/wd/pos', workDirHash: 'hp1' },
      ],
      agents: [
        agentFrame('s1', 'main', { kind: 'main', busy: false, lastSeen: 1 }),
        agentFrame('s2', 'main', { kind: 'main', busy: false, lastSeen: 1 }),
        agentFrame('s3', 'main', { kind: 'main', busy: false, lastSeen: 1 }),
      ],
    }));
    await flush();
    const dir = dirGroups(page.el('sbList')).find((d) => d.getAttribute('data-dir') === '/wd/pos')!;
    // all-inactive dir is default folded: expand it to build the head-only groups
    click(dir.querySelector('.sb-dir-head')!);
    const order = () => sessionGroups(dir).map((g) => g.getAttribute('data-session'));
    expect(order()).toEqual(['s1', 's2', 's3']);
    // regression: renderFullSession/renderHeadOnly used plain appendChild,
    // which MOVED the touched group to the bottom of sessionsBox
    click(sessionGroups(dir)[0].querySelector('.sb-session-head')!); // s1 head-only -> full
    expect(order()).toEqual(['s1', 's2', 's3']);
    click(sessionGroups(dir)[0].querySelector('.sb-session-head')!); // s1 full -> head-only
    expect(order()).toEqual(['s1', 's2', 's3']);
    // middle session too (insertBefore anchor must not drift past it)
    click(sessionGroups(dir)[1].querySelector('.sb-session-head')!);
    expect(order()).toEqual(['s1', 's2', 's3']);
  });

  it('persists dir folds across page rebuilds; user state overrides the default auto-expand', async () => {
    const seed = { 'moamcp-status-folds': JSON.stringify({ dirs: { '/wd/active': 1, '/wd/idle': 0 } }) };
    const page = runStatusPage(await fetchPage(), offlineFetch, seed);
    page.dispatch('snapshot', snap({
      sessions: [
        { sessionId: 's1', title: 'Active', workDir: '/wd/active', workDirHash: 'h1' },
        { sessionId: 's2', title: 'Idle', workDir: '/wd/idle', workDirHash: 'h2' },
      ],
      agents: [
        agentFrame('s1', 'main', { kind: 'main', busy: true }),
        agentFrame('s2', 'lone', { kind: 'main', busy: false, lastSeen: 1 }),
      ],
    }));
    await flush();
    const dirs = dirGroups(page.el('sbList'));
    const active = dirs.find((d) => d.getAttribute('data-dir') === '/wd/active')!;
    const idle = dirs.find((d) => d.getAttribute('data-dir') === '/wd/idle')!;
    // seeded user state wins over the defaults (active -> expanded, idle -> folded)
    expect(active.classList.contains('collapsed')).toBe(true);
    expect(sessionGroups(active)).toEqual([]);
    expect(idle.classList.contains('collapsed')).toBe(false);
    const idleGroup = sessionGroups(idle)[0];
    expect(idleGroup.getAttribute('data-session')).toBe('s2');
    expect(rowIds(idleGroup)).toEqual([]); // head-only
    // untouched: the persisted record is exactly what was injected
    expect(JSON.parse(page.getStored('moamcp-status-folds')!).dirs).toEqual({ '/wd/active': 1, '/wd/idle': 0 });
  });

  it('a gone frame that flips the session dirKey updates the NEW dir label/count (reviewer fix)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    // s1 has no session workDir; its dirKey comes from main's workDirHash fallback
    page.dispatch('snapshot', snap({
      sessions: [{ sessionId: 's1', title: 'One' }],
      agents: [
        agentFrame('s1', 'main', { kind: 'main', workDirHash: '0123456789abcdef', lastSeen: 1 }),
        agentFrame('s1', 'child', { parentAgentId: 'main', kind: 'sub', lastSeen: 2 }),
      ],
    }));
    await flush();
    expect(dirGroups(page.el('sbList'))[0].getAttribute('data-dir')).toBe('hash:0123456789abcdef');
    // main gone -> child remains -> dirKey flips to __unknown__; the new dir must
    // show its label + count (a freshly created dir group has empty title/count)
    page.dispatch('agent', { sessionId: 's1', agentId: 'main', gone: true });
    await flush();
    const dirs = dirGroups(page.el('sbList'));
    expect(dirs.map((d) => d.getAttribute('data-dir'))).toEqual(['__unknown__']);
    expect(dirs[0].querySelector('.sb-dir-title')!.textContent).toBe('Unknown directory');
    expect(dirs[0].querySelector('.sb-dir-count')!.textContent).toContain('1 past session');
  });

  it('a head click collapses a full all-inactive session in one click (reviewer fix)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      sessions: [
        { sessionId: 's1', title: 'One', workDir: '/wd/shared', workDirHash: 'h1' },
        { sessionId: 's2', title: 'Two', workDir: '/wd/shared', workDirHash: 'h2' },
      ],
      agents: [
        agentFrame('s1', 'main', { kind: 'main', busy: true }),
        agentFrame('s1', 'child', { parentAgentId: 'main', kind: 'sub', busy: false, lastSeen: 1 }),
        agentFrame('s2', 'other', { kind: 'main', busy: true }),
      ],
    }));
    await flush();
    const dir = dirGroups(page.el('sbList'))[0];
    // s1 goes all-inactive; the dir stays expanded (s2 is still active), so the
    // incremental path keeps s1's full render (coder deviation 1 is accepted)
    page.dispatch('agent', agentFrame('s1', 'main', { kind: 'main', busy: false, lastSeen: 2 }));
    await flush();
    const s1 = sessionGroups(dir).find((g) => g.getAttribute('data-session') === 's1')!;
    expect(s1.querySelector('.sb-rows')).not.toBeNull();
    // ONE head click collapses to head-only (previously this needed two clicks:
    // the first only set userExpandedSessions=true, a no-op on an already-full group)
    click(s1.querySelector('.sb-session-head')!);
    const collapsed = sessionGroups(dir).find((g) => g.getAttribute('data-session') === 's1')!;
    expect(collapsed.querySelector('.sb-rows')).toBeNull();
    // and it expands again on the next click
    click(collapsed.querySelector('.sb-session-head')!);
    expect(sessionGroups(dir).find((g) => g.getAttribute('data-session') === 's1')!.querySelector('.sb-rows')).not.toBeNull();
  });

  it('a snapshot rebuild does not duplicate the active-section rows (reviewer fix)', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap());
    await flush();
    expect(activeRows(page.el('sbActive')).length).toBe(1);
    // fresh snapshot, same content -> wholesale rebuild must not stack a second row
    page.dispatch('snapshot', snap());
    await flush();
    const rows = activeRows(page.el('sbActive'));
    expect(rows.map((r) => r.getAttribute('data-key'))).toEqual(['s1:main']);
    expect(rows.length).toBe(1);
    // an agent leaving the active set on the next snapshot is dropped too
    page.dispatch('snapshot', snap({ agents: [agentFrame('s1', 'child', { parentAgentId: 'main', kind: 'sub', busy: false })] }));
    await flush();
    expect(page.el('sbActive').hidden).toBe(true);
    expect(activeRows(page.el('sbActive'))).toEqual([]);
  });
});

describe('Status Board 0.11.0: ancestor rollup + tree rendering', () => {
  it('active section brings out inactive ancestors with the rollup badge and weak style', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      agents: [
        agentFrame('s1', 'main', { kind: 'main', busy: false, lastSeen: 1 }),
        agentFrame('s1', 'parent', { parentAgentId: 'main', kind: 'sub', busy: false, lastSeen: 2 }),
        agentFrame('s1', 'child', { parentAgentId: 'parent', kind: 'sub', busy: true, lastSeen: 3 }),
      ],
    }));
    await flush();
    const activeEl = page.el('sbActive');
    expect(activeEl.hidden).toBe(false);
    const rows = activeRows(activeEl);
    // ancestor chain (main -> parent) precedes the active leaf child
    expect(rows.map((r) => r.getAttribute('data-key'))).toEqual(['s1:main', 's1:parent', 's1:child']);
    // ancestors: weak style + badge; the active leaf itself: neither
    expect(rows[0].classList.contains('sb-active-ancestor')).toBe(true);
    expect(rows[1].classList.contains('sb-active-ancestor')).toBe(true);
    expect(rows[2].classList.contains('sb-active-ancestor')).toBe(false);
    expect(rows[0].querySelector('.sb-ancestor-badge')).not.toBeNull();
    expect(rows[1].querySelector('.sb-ancestor-badge')).not.toBeNull();
    expect(rows[2].querySelector('.sb-ancestor-badge')).toBeNull();
    expect(rows[0].querySelector('.sb-ancestor-badge')!.textContent).toBe('via sub-agent');
    // a later frame going idle drops the whole chain from the section
    page.dispatch('agent', agentFrame('s1', 'child', { parentAgentId: 'parent', kind: 'sub', busy: false, lastSeen: 4 }));
    await flush();
    expect(page.el('sbActive').hidden).toBe(true);
    expect(activeRows(page.el('sbActive'))).toEqual([]);
  });

  it('active section order stays stable across multiple leaves sharing an ancestor', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      agents: [
        agentFrame('s1', 'main', { kind: 'main', busy: false, lastSeen: 1 }),
        agentFrame('s1', 'p1', { parentAgentId: 'main', kind: 'sub', busy: false, lastSeen: 2 }),
        agentFrame('s1', 'a', { parentAgentId: 'p1', kind: 'sub', busy: true, lastSeen: 3 }),
        agentFrame('s1', 'p2', { parentAgentId: 'main', kind: 'sub', busy: false, lastSeen: 4 }),
        agentFrame('s1', 'b', { parentAgentId: 'p2', kind: 'sub', busy: true, lastSeen: 5 }),
      ],
    }));
    await flush();
    const keys = () => activeRows(page.el('sbActive')).map((r) => r.getAttribute('data-key'));
    // seeds = [a, b] (DFS); each leaf's chain inserted before it, deduped.
    expect(keys()).toEqual(['s1:main', 's1:p1', 's1:a', 's1:p2', 's1:b']);
    // a repeat flush must not reorder (stable across flushes)
    page.dispatch('agent', agentFrame('s1', 'a', { parentAgentId: 'p1', kind: 'sub', busy: true, lastSeen: 6 }));
    await flush();
    expect(keys()).toEqual(['s1:main', 's1:p1', 's1:a', 's1:p2', 's1:b']);
  });

  it('tree renders nested .sb-subtree containers; a parent chevron folds the subtree lazily', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      agents: [
        agentFrame('s1', 'main', { kind: 'main', busy: true }),
        agentFrame('s1', 'mid', { parentAgentId: 'main', kind: 'sub', busy: false, lastSeen: 2 }),
        agentFrame('s1', 'leaf', { parentAgentId: 'mid', kind: 'sub', busy: false, lastSeen: 3 }),
      ],
    }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    // main (active) renders; mid+leaf are inactive behind the master fold bar
    expect(rowIds(group)).toEqual(['s1:main']);
    click(group.querySelector('.sb-fold')!);
    expect(rowIds(group)).toEqual(['s1:main', 's1:mid', 's1:leaf']); // DFS nested
    const midRow = rowsOf(group).find((r) => r.getAttribute('data-key') === 's1:mid')!;
    const midSubtree = subtreeOf(midRow);
    expect(midSubtree).not.toBeNull();
    expect(midSubtree!.children.length).toBe(1); // leaf row nested inside
    const leafRow = rowsOf(group).find((r) => r.getAttribute('data-key') === 's1:leaf')!;
    // collapse mid's subtree via its chevron: container cleared + key dropped
    const chevron = midRow.querySelector('.sb-chevron')!;
    click(chevron);
    expect(midSubtree!.children.length).toBe(0);
    expect(leafRow.parentNode).toBeNull(); // no ghost DOM survives
    expect(rowIds(group)).toEqual(['s1:main', 's1:mid']);
    // re-expand lazily rebuilds the subtree rows
    click(chevron);
    expect(rowIds(group)).toEqual(['s1:main', 's1:mid', 's1:leaf']);
    expect(rowsOf(group).find((r) => r.getAttribute('data-key') === 's1:leaf')).toBeDefined();
  });

  it('the fold bar is the master "collapse all inactive subtrees" control', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      agents: [
        agentFrame('s1', 'main', { kind: 'main', busy: true }),
        agentFrame('s1', 'mid', { parentAgentId: 'main', kind: 'sub', busy: false, lastSeen: 2 }),
        agentFrame('s1', 'leaf', { parentAgentId: 'mid', kind: 'sub', busy: false, lastSeen: 3 }),
      ],
    }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    click(group.querySelector('.sb-fold')!); // open: all inactive rows built
    expect(rowIds(group)).toEqual(['s1:main', 's1:mid', 's1:leaf']);
    // individual subtree fold survives a master close + reopen
    const midRow = rowsOf(group).find((r) => r.getAttribute('data-key') === 's1:mid')!;
    click(midRow.querySelector('.sb-chevron')!);
    expect(rowIds(group)).toEqual(['s1:main', 's1:mid']);
    click(group.querySelector('.sb-fold')!); // close: everything inactive gone
    expect(rowIds(group)).toEqual(['s1:main']);
    click(group.querySelector('.sb-fold')!); // reopen: lazily rebuilt, fold kept
    expect(rowIds(group)).toEqual(['s1:main', 's1:mid']);
  });

  it('a fully-rooted session (no lineage) degrades to flat rows with no subtree containers', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      agents: [
        agentFrame('s1', 'a1', { kind: 'main', busy: true }),
        agentFrame('s1', 'a2', { kind: 'main', busy: false, lastSeen: 1 }),
        agentFrame('s1', 'a3', { kind: 'main', busy: false, lastSeen: 2 }),
      ],
    }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    expect(rowIds(group)).toEqual(['s1:a1']);
    click(group.querySelector('.sb-fold')!);
    expect(rowIds(group)).toEqual(['s1:a1', 's1:a2', 's1:a3']);
    expect(page.el('sbList').querySelector('.sb-subtree')).toBeNull();
  });

  it('a pending-root child (missing parent) renders flat at the session top', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      agents: [agentFrame('s1', 'child', { parentAgentId: 'ghost', kind: 'sub', busy: true })],
    }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    expect(rowIds(group)).toEqual(['s1:child']);
    expect(page.el('sbList').querySelector('.sb-subtree')).toBeNull();
  });

  it('a would-be cycle renders every row flat without crashing', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      agents: [
        agentFrame('s1', 'a', { parentAgentId: 'b', busy: false, lastSeen: 1 }),
        agentFrame('s1', 'b', { parentAgentId: 'c', busy: false, lastSeen: 2 }),
        agentFrame('s1', 'c', { parentAgentId: 'a', busy: true, lastSeen: 3 }),
      ],
    }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    click(group.querySelector('.sb-fold')!);
    expect(rowIds(group).sort()).toEqual(['s1:a', 's1:b', 's1:c']);
  });

  it('a 1-agent session renders a single flat row', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      agents: [agentFrame('s1', 'only', { kind: 'main', busy: true })],
    }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    expect(rowIds(group)).toEqual(['s1:only']);
    expect(page.el('sbList').querySelector('.sb-subtree')).toBeNull();
    expect(page.el('sbActive').hidden).toBe(false);
  });

  it('localechange re-translates ancestor badges and subtree chevron aria labels recursively', async () => {
    const page = runStatusPage(await fetchPage(), offlineFetch);
    page.dispatch('snapshot', snap({
      agents: [
        agentFrame('s1', 'main', { kind: 'main', busy: false, lastSeen: 1 }),
        agentFrame('s1', 'mid', { parentAgentId: 'main', kind: 'sub', busy: false, lastSeen: 2 }),
        agentFrame('s1', 'leaf', { parentAgentId: 'mid', kind: 'sub', busy: true, lastSeen: 3 }),
      ],
    }));
    await flush();
    const group = sessionGroups(page.el('sbList'))[0];
    click(group.querySelector('.sb-fold')!);
    const midRow = rowsOf(group).find((r) => r.getAttribute('data-key') === 's1:mid')!;
    const chevron = midRow.querySelector('.sb-chevron')!;
    expect(chevron.getAttribute('aria-label')).toBe('Collapse subtree');
    const ancestorBadge = activeRows(page.el('sbActive'))[0].querySelector('.sb-ancestor-badge')!;
    expect(ancestorBadge.textContent).toBe('via sub-agent');
    setLocale(page, 'zh-CN');
    expect(chevron.getAttribute('aria-label')).toBe('收起子树');
    expect(ancestorBadge.textContent).toBe('经子 agent 带出');
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
