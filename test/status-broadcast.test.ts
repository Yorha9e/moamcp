/**
 * 0.8.0 P1: the StatusBroadcaster dirty-set merger. All tests drive the
 * merger with an injected fake clock (deterministic tick boundaries) — a
 * frozen clock also makes any accidental real timer a no-op, so there is no
 * wall-clock flake in this file; the real 50ms flush cadence is exercised by
 * the /status/events integration tests.
 */
import { describe, expect, it } from 'vitest';
import { StatusBroadcaster } from '../src/modules/status/broadcast.js';

describe('StatusBroadcaster (0.8.0)', () => {
  it('coalesces duplicate marks within one window into a single emit', () => {
    let t = 0;
    const emitted: string[][] = [];
    const b = new StatusBroadcaster({
      intervalMs: 50,
      now: () => t,
      onChange: (keys) => emitted.push([...keys]),
    });
    b.markDirty('s1:main');
    b.markDirty('s1:main'); // same agent twice -> still one entry
    b.markDirty('s2:sub');
    t = 50;
    b.flush();
    expect(emitted).toEqual([['s1:main', 's2:sub']]);
    expect(b.pendingCount).toBe(0);
  });

  it('only drains once a tick boundary has elapsed (coalescing window)', () => {
    let t = 0;
    const emitted: string[][] = [];
    const b = new StatusBroadcaster({
      intervalMs: 50,
      now: () => t,
      onChange: (keys) => emitted.push([...keys]),
    });
    b.start(); // lastFlush = t = 0
    b.markDirty('s1:main');
    b.flush(); // t=0: inside the window -> nothing
    t = 30;
    b.flush(); // still inside the window -> nothing
    expect(emitted).toEqual([]);
    t = 50;
    b.flush(); // boundary reached -> drained
    expect(emitted).toEqual([['s1:main']]);
    b.flush(); // same boundary, nothing pending -> no second emit
    expect(emitted).toEqual([['s1:main']]);
    // next boundary with a fresh mark
    t = 100;
    b.markDirty('s3:x');
    b.flush();
    expect(emitted).toEqual([['s1:main'], ['s3:x']]);
    b.stop();
  });

  it('suppress(true) blocks marks and drops pending keys; suppress(false) resumes', () => {
    let t = 0;
    const emitted: string[][] = [];
    const b = new StatusBroadcaster({
      intervalMs: 50,
      now: () => t,
      onChange: (keys) => emitted.push([...keys]),
    });
    b.suppress(true);
    b.markDirty('s1:main'); // suppressed: not added
    t = 50;
    b.flush(); // suppressed: drains nothing
    expect(emitted).toEqual([]);
    b.suppress(false);
    b.markDirty('s1:main');
    b.markDirty('s2:sub');
    t = 100;
    b.flush();
    expect(emitted).toEqual([['s1:main', 's2:sub']]);
  });

  it('suppress(true) clears keys marked before suppression (post-catch-up flood guard)', () => {
    let t = 0;
    const emitted: string[][] = [];
    const b = new StatusBroadcaster({
      intervalMs: 50,
      now: () => t,
      onChange: (keys) => emitted.push([...keys]),
    });
    b.markDirty('s1:main'); // marked before catch-up begins
    b.suppress(true); // catch-up: the pending mark is dropped
    expect(b.pendingCount).toBe(0);
    t = 50;
    b.flush();
    expect(emitted).toEqual([]);
  });

  it('honors an injectable isSuppressed predicate at both mark and flush time', () => {
    let t = 0;
    let suppressed = false;
    const emitted: string[][] = [];
    const b = new StatusBroadcaster({
      intervalMs: 50,
      now: () => t,
      isSuppressed: () => suppressed,
      onChange: (keys) => emitted.push([...keys]),
    });
    suppressed = true;
    b.markDirty('s1:main'); // predicate suppresses the mark
    t = 50;
    b.flush(); // ...and the flush
    expect(emitted).toEqual([]);
    suppressed = false;
    b.markDirty('s1:main');
    t = 100;
    b.flush();
    expect(emitted).toEqual([['s1:main']]);
  });

  it('flush while suppressed drops pending keys instead of emitting them later', () => {
    let t = 0;
    const emitted: string[][] = [];
    const b = new StatusBroadcaster({
      intervalMs: 50,
      now: () => t,
      onChange: (keys) => emitted.push([...keys]),
    });
    b.markDirty('s1:main'); // pre-catch-up mark
    b.suppress(true);
    t = 50;
    b.flush(); // suppressed drain clears it; nothing is emitted after catch-up
    expect(emitted).toEqual([]);
    expect(b.pendingCount).toBe(0);
  });

  it('start()/stop() are idempotent; stop() clears pending state', () => {
    let t = 0; // frozen clock: the real timer (if it ever fired) is a no-op
    const emitted: string[][] = [];
    const b = new StatusBroadcaster({
      intervalMs: 50,
      now: () => t,
      onChange: (keys) => emitted.push([...keys]),
    });
    b.start();
    b.start(); // idempotent
    b.markDirty('s1:main');
    expect(b.pendingCount).toBe(1);
    b.stop();
    b.stop(); // idempotent
    expect(b.pendingCount).toBe(0);
    expect(emitted).toEqual([]);
  });
});
