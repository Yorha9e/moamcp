/**
 * Bus-daemon version self-check (batch 1c P4): a daemon can run indefinitely
 * on a disk build, so a release that updates the installed package.json
 * afterwards would leave stale code serving the panel. Every
 * DAEMON_VERSION_CHECK_MS the daemon re-reads the disk version (the same
 * readDiskVersion mechanism the Control Plane uses) and exits(0) on a
 * mismatch — handing the port back to the next release chain / a fresh
 * session rebuild. The check is deliberately a standalone function so the
 * exit decision is unit-testable without spawning the daemon.
 */
import { VERSION } from './registry.js';

/** Daemon self-check cadence: 60s (matches the Control Plane's banner poll). */
export const DAEMON_VERSION_CHECK_MS = 60_000;

/**
 * True when the daemon should exit: a readable disk version that differs from
 * the running VERSION. A null (unreadable/malformed) disk version never
 * triggers an exit — a version we cannot compare is not proof of a newer
 * build, so the daemon keeps serving rather than self-terminating on noise.
 */
export function diskVersionMismatch(diskVersion: string | null): boolean {
  return diskVersion !== null && diskVersion !== VERSION;
}
