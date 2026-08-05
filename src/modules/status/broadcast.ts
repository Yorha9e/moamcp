/**
 * Status broadcast merger (0.8.0, batch 1c lower).
 *
 * Pure merge of "which agents changed" for the /status/events SSE fan-out:
 * a dirty set of agent keys coalesces every fold mutation between flush ticks
 * into one per-agent emit — N mutations of the same agent inside one window
 * cost exactly one frame. The module is deliberately fold-agnostic: it tracks
 * opaque agent keys (the fold's `${sessionId}:${agentId}` form); the status
 * controller resolves them to single-agent snapshots at flush time, so the
 * fan-out never pays for a full snapshotAgents() deep copy.
 *
 * - markDirty(agentKey): record a change. No-op while suppressed.
 * - suppress(catchingUp): raise/clear the manual suppression flag. Raising it
 *   drops any pending dirty keys — they are covered by the next full snapshot,
 *   and draining nothing keeps the post-catch-up first flush from flooding
 *   subscribers with every agent that was bulk-loaded by the initial scan.
 *   Suppression is GLOBAL in granularity (accepted trade-off, 0.8.1 F2 doc):
 *   while ANY watcher tail is catching up, dirty marks for ALL agents are
 *   dropped, not just the tail's own. A new SSE connection is compensated by
 *   its opening full-snapshot frame; an already-connected client can re-fetch
 *   the truth at any time via GET /status. Per-agent scoped suppression is
 *   deliberately out of scope — the global gate is a one-liner and the bulk
 *   scan it guards is rare (startup / home re-attach).
 * - flush(): drain the dirty set into onChange(keys). Called on the interval
 *   tick (and directly by unit tests with an injected clock). While
 *   suppressed it drains nothing; otherwise it only drains once at least one
 *   interval has elapsed since the previous drain (tick boundary), so a
 *   burst of marks just before a tick cannot cause a second emission in the
 *   same window.
 * - start()/stop(): own the flush timer. The timer is unref'd, so it never
 *   keeps the process alive on its own.
 */
export interface StatusBroadcasterOptions {
  /** Flush cadence (default 50ms). */
  intervalMs?: number;
  /** Clock (default Date.now); injectable for deterministic tick-boundary tests. */
  now?: () => number;
  /** Extra suppression predicate; the controller feeds watcher catch-up here. */
  isSuppressed?: () => boolean;
  /** Called with the drained, deduped agent keys in arrival order. */
  onChange: (agentKeys: readonly string[]) => void;
}

export class StatusBroadcaster {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onChange: (agentKeys: readonly string[]) => void;
  private readonly isSuppressed?: () => boolean;
  private readonly pending = new Set<string>();
  private manualSuppressed = false;
  private timer: NodeJS.Timeout | null = null;
  private lastFlush = 0;

  constructor(opts: StatusBroadcasterOptions) {
    this.intervalMs = opts.intervalMs ?? 50;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange;
    this.isSuppressed = opts.isSuppressed;
  }

  private suppressed(): boolean {
    if (this.manualSuppressed) return true;
    return this.isSuppressed?.() ?? false;
  }

  /** Arm the flush timer (idempotent). */
  start(): void {
    if (this.timer !== null) return;
    this.lastFlush = this.now();
    this.timer = setInterval(() => this.flush(), this.intervalMs);
    this.timer.unref();
  }

  /** Disarm the flush timer and drop any pending dirty keys (idempotent). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    this.manualSuppressed = false;
  }

  /** Record a change for one agent; no-op while suppressed. */
  markDirty(agentKey: string): void {
    if (this.suppressed()) return;
    this.pending.add(agentKey);
  }

  /**
   * Raise (true) / clear (false) the manual suppression flag — the watcher
   * catch-up gate. Raising it clears pending dirty keys so the end of a bulk
   * load cannot flush every freshly-scanned agent in one frame storm.
   */
  suppress(catchingUp: boolean): void {
    this.manualSuppressed = catchingUp;
    if (catchingUp) this.pending.clear();
  }

  /** Pending dirty keys not yet drained (test/audit seam). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Drain the dirty set into onChange — at most once per intervalMs, and
   * never while suppressed. Safe to call directly with an injected clock.
   */
  flush(): void {
    const now = this.now();
    if (this.suppressed()) {
      this.pending.clear();
      this.lastFlush = now;
      return;
    }
    if (now - this.lastFlush < this.intervalMs) return;
    this.lastFlush = now;
    if (this.pending.size === 0) return;
    const keys = [...this.pending];
    this.pending.clear();
    this.onChange(keys);
  }
}
