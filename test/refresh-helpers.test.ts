/**
 * Shared refresh layer in lib.ts (panel polish batch 2): the POLL_MS
 * cadence constants plus the startPoll / subscribeWithPoll helpers that
 * replaced the per-page setInterval/EventSource wiring (board SSE + 15s
 * fallback, runs 5s poll, system 10s poll, debate OMKC health poll).
 *
 * Runs LIB_JS in a bare vm sandbox (bus.test.ts runCardScript pattern)
 * with vitest fake timers injected, so interval behavior is asserted
 * deterministically without touching the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { LIB_JS, RUNS_POLL_MS, SSE_FALLBACK_POLL_MS, SYSTEM_POLL_MS } from '../src/web/lib.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: ((ev?: any) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

/** Run LIB_JS headlessly; fake timers are injected so intervals are ours. */
function runLib(options: { withEventSource?: boolean } = {}) {
  FakeEventSource.instances = [];
  const sandbox: Record<string, unknown> = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    // Enough document for LIB_JS's load-time inits to no-op safely.
    document: { getElementById: () => null },
  };
  if (options.withEventSource !== false) sandbox.EventSource = FakeEventSource;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(LIB_JS, sandbox, { timeout: 5000 });
  return sandbox as { __moaLib: any };
}

describe('shared refresh layer (lib.ts POLL_MS / startPoll / subscribeWithPoll)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the historical cadences: TS exports match the inlined __moaLib.POLL_MS', () => {
    // The convergence is on shared constants — the page behaviors must not
    // drift, so the values stay exactly what each view shipped with.
    expect(SSE_FALLBACK_POLL_MS).toBe(15000);
    expect(RUNS_POLL_MS).toBe(5000);
    expect(SYSTEM_POLL_MS).toBe(10000);
    const lib = runLib().__moaLib;
    expect(lib.POLL_MS).toEqual({
      sseFallback: SSE_FALLBACK_POLL_MS,
      runs: RUNS_POLL_MS,
      system: SYSTEM_POLL_MS,
    });
  });

  it('startPoll ticks on the interval and stop() tears the timer down', () => {
    const lib = runLib().__moaLib;
    let ticks = 0;
    const poll = lib.startPoll(() => {
      ticks += 1;
    }, RUNS_POLL_MS);
    vi.advanceTimersByTime(RUNS_POLL_MS * 3);
    expect(ticks).toBe(3);
    poll.stop();
    vi.advanceTimersByTime(RUNS_POLL_MS * 3);
    expect(ticks).toBe(3);
    poll.stop(); // idempotent, like the historical clearInterval(null) no-op
  });

  it('subscribeWithPoll wires the SSE stream and keeps the poll as fallback', () => {
    const lib = runLib().__moaLib;
    const frames: unknown[] = [];
    let polls = 0;
    const sub = lib.subscribeWithPoll(
      '/subscribe?task_id=chan',
      (event: { data: string }) => frames.push(JSON.parse(event.data)),
      () => {
        polls += 1;
      },
      SSE_FALLBACK_POLL_MS,
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe('/subscribe?task_id=chan');
    // SSE frames reach the page handler untouched (page still parses/filters).
    FakeEventSource.instances[0].emit({ type: 'board_updated' });
    expect(frames).toEqual([{ type: 'board_updated' }]);

    // The fallback poll runs unconditionally, on the shared cadence.
    vi.advanceTimersByTime(SSE_FALLBACK_POLL_MS * 2);
    expect(polls).toBe(2);

    // close() releases both the stream and the poll timer.
    sub.close();
    expect(FakeEventSource.instances[0].closed).toBe(true);
    vi.advanceTimersByTime(SSE_FALLBACK_POLL_MS * 2);
    expect(polls).toBe(2);
    sub.close(); // idempotent
  });

  it('subscribeWithPoll degrades to poll-only where EventSource is unavailable', () => {
    const lib = runLib({ withEventSource: false }).__moaLib;
    let polls = 0;
    const sub = lib.subscribeWithPoll(
      '/subscribe?task_id=chan',
      () => {},
      () => {
        polls += 1;
      },
      SSE_FALLBACK_POLL_MS,
    );
    expect(FakeEventSource.instances).toHaveLength(0);
    vi.advanceTimersByTime(SSE_FALLBACK_POLL_MS);
    expect(polls).toBe(1);
    sub.close();
  });
});
