import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** omkc (community fork) home: OMKC_HOME > KIMI_CODE_HOME > ~/.omkc. */
export function omkcHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMKC_HOME ?? env.KIMI_CODE_HOME ?? path.join(os.homedir(), '.omkc');
}

/** Official kimi-code home: KIMI_CODE_HOME > ~/.kimi-code. */
export function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.KIMI_CODE_HOME ?? path.join(os.homedir(), '.kimi-code');
}

export type HomeLabel = 'omkc' | 'kimi-code';

export interface HomeSpec {
  label: HomeLabel;
  home: string;
}

/**
 * Resolve the homes to watch, omkc first. KIMI_CODE_HOME is honored by both
 * CLIs, so when it is set both labels resolve to the same directory — the
 * list is deduped by path and the omkc label wins. Callers decide which of
 * the returned homes actually exist before watching.
 */
export function resolveHomes(env: NodeJS.ProcessEnv = process.env): HomeSpec[] {
  const specs: HomeSpec[] = [
    { label: 'omkc', home: omkcHome(env) },
    { label: 'kimi-code', home: kimiHome(env) },
  ];
  const seen = new Set<string>();
  return specs.filter((s) => {
    const key = path.resolve(s.home).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Where sessions live: <home>/sessions/<workDirHash>/<sessionId>/. */
export function sessionsRoot(home: string): string {
  return path.join(home, 'sessions');
}

/**
 * Where this service writes its single discovery file (allowed write):
 * the omkc home wins (omkc is the primary consumer), ~/.omkc/status by
 * default.
 */
export function statusDir(home = omkcHome()): string {
  return path.join(home, 'status');
}

/** Identity of one agent's wire log inside the sessions tree. */
export interface WireRef {
  /** Which CLI home this wire belongs to. */
  home: HomeLabel;
  workDirHash: string;
  sessionId: string;
  agentId: string;
}

/** One parsed wire.jsonl record (see agent-core records/types.ts). */
export interface WireRecord {
  type: string;
  time?: number;
  [key: string]: unknown;
}

/** Parsed state.json of a session (agents table + metadata). */
export interface SessionState {
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  workDir?: string;
  agents?: Record<
    string,
    { homedir?: string; type?: string; parentAgentId?: string | null }
  >;
}

/** Parsed agents/<agentId>/tasks/<taskId>.json. */
export interface TaskFile {
  taskId: string;
  description?: string;
  status?: string;
  kind?: string;
  agentId?: string;
  subagentType?: string;
  modelAlias?: string;
  startedAt?: number;
  endedAt?: number;
  stopReason?: string;
}

export interface WireWatcherOptions {
  /** Home label stamped onto every WireRef this watcher emits. */
  home: HomeLabel;
  /** Sessions root to watch (e.g. sessionsRoot(home)). */
  root: string;
  /** Directory rescan interval (default 5000ms); fs.watch is the fast path. */
  scanIntervalMs?: number;
  /** Fallback tail poll interval (default 1000ms). */
  pollIntervalMs?: number;
  /** Every complete wire.jsonl line, parsed (null when unparseable). */
  onRecord: (ref: WireRef, raw: string, record: WireRecord | null) => void;
  /** state.json (re-)read: first sight and on every mtime change. */
  onSessionState?: (ref: Omit<WireRef, 'agentId'>, state: SessionState) => void;
  /** tasks/<taskId>.json (re-)read: first sight and on every mtime change. */
  onTask?: (ref: WireRef & { taskId: string }, task: TaskFile) => void;
}

/** Live progress of the (initial or periodic) scan + tail catch-up. */
export interface WatchProgress {
  /** A directory scan pass is currently running. */
  scanning: boolean;
  /** Tails still catching up to EOF (initial bulk read). */
  catchingUp: number;
  sessions: number;
  agents: number;
  records: number;
  lastScanMs: number;
}

interface TailState {
  ref: WireRef;
  file: string;
  offset: number;
  /** Incomplete trailing line carried over between reads. */
  pending: string;
  /** File size at last stat; offset < size means catch-up in progress. */
  size: number;
}

/** Read chunk for tail pumping; each chunk is followed by an event-loop yield. */
const PUMP_CHUNK = 256 * 1024;
/** Yield every N file operations inside a scan pass. */
const SCAN_YIELD_EVERY = 16;

function yieldNow(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function readdirSafe(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statSafe(file: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(file);
  } catch {
    return null;
  }
}

/**
 * Read-only watcher over the session tree the CLI itself persists:
 *
 *   sessions/<workDirHash>/<sessionId>/state.json
 *   sessions/<workDirHash>/<sessionId>/agents/<agentId>/wire.jsonl
 *   sessions/<workDirHash>/<sessionId>/agents/<agentId>/tasks/<taskId>.json
 *
 * Never writes, truncates, or deletes anything under the tree.
 *
 * Non-blocking design (production data: ~400MB of wire.jsonl across hundreds
 * of agents — a naive synchronous scan froze the event loop for minutes):
 *  - all filesystem work is async (fs.promises) and chunked, yielding to the
 *    event loop every SCAN_YIELD_EVERY operations / every PUMP_CHUNK bytes;
 *  - directory scans are serialized (one pass at a time, re-entry collapses
 *    into a single follow-up pass) and fs.watch triggers are debounced, so
 *    watch-event storms cannot stack rescans back-to-back;
 *  - tails pump in bounded chunks with yields, so the initial catch-up of
 *    multi-MB wire files never monopolizes the loop;
 *  - truncate handling: size < offset re-reads from the start; partial
 *    trailing lines (concurrent append) are buffered and retried.
 */
export class WireWatcher {
  private readonly root: string;
  private readonly scanMs: number;
  private readonly pollMs: number;
  private readonly tails = new Map<string, TailState>();
  private readonly stateMtimes = new Map<string, string>();
  private readonly taskMtimes = new Map<string, string>();
  private readonly dirWatchers = new Map<string, fs.FSWatcher>();
  private scanTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pumpDebounce: NodeJS.Timeout | null = null;
  private scanning = false;
  private scanAgain = false;
  private pumping = false;
  private stopped = false;
  private started = false;
  private records = 0;
  private sessionCount = 0;
  private lastScanMs = 0;

  constructor(private readonly opts: WireWatcherOptions) {
    this.root = opts.root;
    this.scanMs = opts.scanIntervalMs ?? 5000;
    this.pollMs = opts.pollIntervalMs ?? 1000;
  }

  start(): void {
    // Idempotency guard: a second start() must not create a second timer set
    // (the first one would leak forever — stop() only clears the referenced
    // timers, so a leaked set would keep rescanning for the process lifetime).
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    void this.scan();
    this.scanTimer = setInterval(() => this.scheduleScan(0), this.scanMs);
    this.scanTimer.unref();
    this.pollTimer = setInterval(() => this.schedulePump(0), this.pollMs);
    this.pollTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    for (const t of [this.scanTimer, this.pollTimer, this.debounceTimer, this.pumpDebounce]) {
      if (t) clearInterval(t as NodeJS.Timeout);
    }
    this.scanTimer = this.pollTimer = this.debounceTimer = this.pumpDebounce = null;
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
  }

  get tailCount(): number {
    return this.tails.size;
  }

  getProgress(): WatchProgress {
    let catchingUp = 0;
    for (const tail of this.tails.values()) {
      if (tail.offset < tail.size) catchingUp++;
    }
    return {
      scanning: this.scanning,
      catchingUp,
      sessions: this.sessionCount,
      agents: this.tails.size,
      records: this.records,
      lastScanMs: this.lastScanMs,
    };
  }

  /** Debounced scan scheduling: collapses fs.watch event bursts. */
  private scheduleScan(debounceMs: number): void {
    if (this.stopped) return;
    if (debounceMs <= 0) {
      void this.scan();
      return;
    }
    if (this.debounceTimer) return; // one pending debounce is enough
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.scan();
    }, debounceMs);
    this.debounceTimer.unref();
  }

  private schedulePump(debounceMs: number): void {
    if (this.stopped) return;
    if (debounceMs <= 0) {
      void this.pumpAll();
      return;
    }
    if (this.pumpDebounce) return;
    this.pumpDebounce = setTimeout(() => {
      this.pumpDebounce = null;
      void this.pumpAll();
    }, debounceMs);
    this.pumpDebounce.unref();
  }

  /** One serialized, chunked scan pass over the whole sessions tree. */
  private async scan(): Promise<void> {
    if (this.scanning) {
      this.scanAgain = true; // collapse re-entry into one follow-up pass
      return;
    }
    this.scanning = true;
    const started = Date.now();
    try {
      let ops = 0;
      const tick = async () => {
        if (++ops % SCAN_YIELD_EVERY === 0) await yieldNow();
      };
      let sessions = 0;
      // Files actually seen this pass; anything tracked but not seen (deleted
      // agent dirs / sessions / state.json / task files) is evicted afterwards.
      // This keeps tailCount / progress().agents truthful on long runs and
      // stops stateMtimes/taskMtimes from growing without bound.
      const live = { state: new Set<string>(), tasks: new Set<string>(), tails: new Set<string>() };
      for (const wd of await readdirSafe(this.root)) {
        if (this.stopped) return;
        if (!wd.isDirectory()) continue;
        const wdPath = path.join(this.root, wd.name);
        this.watchDir(wdPath);
        for (const s of await readdirSafe(wdPath)) {
          if (this.stopped) return;
          if (!s.isDirectory()) continue;
          sessions++;
          await this.scanSession(wd.name, s.name, path.join(wdPath, s.name), tick, live);
          await yieldNow(); // one session per slice at most
        }
      }
      for (const f of this.tails.keys()) if (!live.tails.has(f)) this.tails.delete(f);
      for (const f of this.stateMtimes.keys()) if (!live.state.has(f)) this.stateMtimes.delete(f);
      for (const f of this.taskMtimes.keys()) if (!live.tasks.has(f)) this.taskMtimes.delete(f);
      this.sessionCount = sessions;
    } finally {
      this.lastScanMs = Date.now() - started;
      this.scanning = false;
      if (this.scanAgain && !this.stopped) {
        this.scanAgain = false;
        this.scheduleScan(50);
      }
      // Newly discovered tails start catching up right after the pass.
      this.schedulePump(0);
    }
  }

  private async scanSession(
    workDirHash: string,
    sessionId: string,
    sessionPath: string,
    tick: () => Promise<void>,
    live: { state: Set<string>; tasks: Set<string>; tails: Set<string> },
  ): Promise<void> {
    this.watchDir(sessionPath);
    // state.json
    const stateFile = path.join(sessionPath, 'state.json');
    const stateStat = await statSafe(stateFile);
    await tick();
    if (stateStat) {
      live.state.add(stateFile);
      // Dual key (mtimeMs + size) instead of mtimeMs alone: an in-place
      // rewrite that lands inside the same mtime window (coarse filesystem
      // granularity such as exFAT/FAT's 2s tick, or a same-ms rewrite) would
      // be missed by an mtime-only comparison; a size change under an
      // unchanged mtime is still caught by the size component.
      const stateKey = `${stateStat.mtimeMs}:${stateStat.size}`;
      if (this.stateMtimes.get(stateFile) !== stateKey) {
        this.stateMtimes.set(stateFile, stateKey);
        try {
          const raw = await fs.promises.readFile(stateFile, 'utf8');
          const state = JSON.parse(raw) as SessionState;
          this.opts.onSessionState?.({ home: this.opts.home, workDirHash, sessionId }, state);
        } catch {
          // mid-write or corrupt: retry next pass
        }
      }
    }
    // agents/*/
    const agentsPath = path.join(sessionPath, 'agents');
    this.watchDir(agentsPath);
    for (const a of await readdirSafe(agentsPath)) {
      if (this.stopped) return;
      if (!a.isDirectory()) continue;
      await tick();
      const agentPath = path.join(agentsPath, a.name);
      this.watchDir(agentPath); // wire.jsonl appends fire here
      const ref: WireRef = { home: this.opts.home, workDirHash, sessionId, agentId: a.name };
      const wireFile = path.join(agentPath, 'wire.jsonl');
      live.tails.add(wireFile);
      if (!this.tails.has(wireFile)) {
        this.tails.set(wireFile, { ref, file: wireFile, offset: 0, pending: '', size: 0 });
      }
      // tasks/*.json
      const tasksPath = path.join(agentPath, 'tasks');
      this.watchDir(tasksPath);
      for (const t of await readdirSafe(tasksPath)) {
        if (!t.isFile() || !t.name.endsWith('.json')) continue;
        await tick();
        const taskFile = path.join(tasksPath, t.name);
        const taskStat = await statSafe(taskFile);
        if (!taskStat) continue;
        live.tasks.add(taskFile);
        // Same dual-key rationale as state.json above.
        const taskKey = `${taskStat.mtimeMs}:${taskStat.size}`;
        if (this.taskMtimes.get(taskFile) === taskKey) continue;
        this.taskMtimes.set(taskFile, taskKey);
        try {
          const raw = await fs.promises.readFile(taskFile, 'utf8');
          const task = JSON.parse(raw) as TaskFile;
          this.opts.onTask?.({ ...ref, taskId: t.name.slice(0, -5) }, task);
        } catch {
          // mid-write: retry next pass
        }
      }
    }
  }

  private watchDir(dir: string): void {
    // An in-flight scan can outlive stop() (final critic, 1a): never arm a new
    // watcher once stopped — the handles would leak until process exit.
    if (this.stopped) return;
    if (this.dirWatchers.has(dir)) return;
    try {
      const w = fs.watch(dir, () => {
        // Debounced: a burst of directory events collapses into one
        // scan pass and one pump pass.
        this.scheduleScan(500);
        this.schedulePump(100);
      });
      w.on('error', () => {
        w.close();
        this.dirWatchers.delete(dir);
      });
      this.dirWatchers.set(dir, w);
    } catch {
      // dir may not exist yet; rescan covers it
    }
  }

  /** Pump every tail sequentially, yielding between files. */
  private async pumpAll(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const tail of this.tails.values()) {
        if (this.stopped) return;
        await this.pump(tail);
        await yieldNow();
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Read new content of one wire file in bounded chunks, yielding to the
   * event loop after every chunk, so a 20MB initial catch-up never blocks.
   */
  private async pump(tail: TailState): Promise<void> {
    const st = await statSafe(tail.file);
    if (!st) return; // wire.jsonl may not exist yet
    if (st.size < tail.offset) {
      // Rewritten/truncated: restart from the beginning.
      tail.offset = 0;
      tail.pending = '';
    }
    tail.size = Number(st.size);
    if (tail.size === tail.offset) return;
    let fd: fs.promises.FileHandle;
    try {
      fd = await fs.promises.open(tail.file, 'r');
    } catch {
      return;
    }
    try {
      while (tail.offset < tail.size && !this.stopped) {
        const len = Math.min(PUMP_CHUNK, tail.size - tail.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fd.read(buf, 0, len, tail.offset);
        if (bytesRead <= 0) break;
        tail.offset += bytesRead;
        const text = tail.pending + buf.toString('utf8', 0, bytesRead);
        const lines = text.split('\n');
        tail.pending = lines.pop() ?? '';
        for (const line of lines) {
          const raw = line.trim();
          if (!raw) continue;
          let parsed: WireRecord | null = null;
          try {
            parsed = JSON.parse(raw) as WireRecord;
          } catch {
            // skip malformed line, still count the offset
          }
          this.records++;
          this.opts.onRecord(tail.ref, raw, parsed);
        }
        await yieldNow(); // one chunk per slice
      }
    } finally {
      await fd.close().catch(() => undefined);
    }
  }
}
