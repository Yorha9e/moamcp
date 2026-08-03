/**
 * Daemon spawner for the controlled restart flow (BUS_VERSION_RESTART.md
 * task D): after the owning process releases the port, a headless bus daemon
 * is spawned from the CURRENT DISK BUILD so the panel comes back on the new
 * code immediately — no waiting for the user to reload a session.
 *
 * The bundle is flat (dist/server.js), so the daemon script resolves as a
 * sibling of the running bundle — same trick as disk-version.ts. Tests inject
 * an explicit script path; the default only holds in the built layout.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface SpawnBusDaemonOptions {
  /** Port the daemon should own (the one just released). */
  port: number;
  /** Working directory for the daemon (bus.port location); the spawner's cwd. */
  cwd: string;
  /** Script override for tests; default is dist/bus-daemon.js next to the bundle. */
  script?: string;
}

function defaultDaemonScript(): string {
  return fileURLToPath(new URL('./bus-daemon.js', import.meta.url));
}

/**
 * Best-effort spawn: returns false (and never throws) when the script is
 * missing or the spawn fails — the caller's passive re-attach watch then
 * simply keeps the old "wait for a fresh session" behaviour.
 */
export function spawnBusDaemon(opts: SpawnBusDaemonOptions): boolean {
  let script: string;
  try {
    script = opts.script ?? defaultDaemonScript();
  } catch {
    return false;
  }
  try {
    const child = spawn(process.execPath, [script], {
      cwd: opts.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, MOAMCP_BUS_PORT: String(opts.port) },
    });
    child.on('error', () => {}); // async spawn errors (ENOENT node, etc.) — best-effort
    child.unref();
    return true;
  } catch {
    return false;
  }
}
