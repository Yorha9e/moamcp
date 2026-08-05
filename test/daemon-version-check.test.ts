/**
 * Batch 1c P4: the bus daemon's version self-check decision, unit-tested
 * without spawning a process. The daemon re-reads the installed disk build
 * version every DAEMON_VERSION_CHECK_MS and exits(0) on a mismatch — handing
 * the port back to the next release chain. The exit decision is the pure
 * predicate `diskVersionMismatch`; the interval wiring lives in bus-daemon.ts
 * and is exercised end-to-end by test/bus-daemon-e2e.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { diskVersionMismatch } from '../src/core/bus/daemon-version-check.js';
import { VERSION } from '../src/core/bus/registry.js';

describe('diskVersionMismatch (bus daemon version self-check, batch 1c P4)', () => {
  it('serves the running build: a matching disk version never triggers an exit', () => {
    expect(diskVersionMismatch(VERSION)).toBe(false);
  });

  it('exits on a newer (or any different) disk version', () => {
    expect(diskVersionMismatch('9.9.9')).toBe(true);
    expect(diskVersionMismatch('0.0.1')).toBe(true);
    expect(diskVersionMismatch('0.7.0-something')).toBe(true);
  });

  it('never exits on an unreadable/malformed disk version (null is not proof of a newer build)', () => {
    expect(diskVersionMismatch(null)).toBe(false);
  });
});
