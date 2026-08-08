/**
 * Best-effort auto-open of the Control Plane in the system default browser
 * (MOAMCP_AUTO_OPEN): after this process confirms it owns the Bus, the env
 * switch decides whether to pop the panel and at which URL.
 *
 * Gate semantics (documented in README):
 * - env missing/empty      → never open (default off)
 * - mode !== 'own'         → never open (reuse sessions are served by the
 *                            owning process's tab — the multi-session dedup)
 * - value `1`              → open the default page `http://127.0.0.1:<port>/`
 * - value starting with `/` → open `http://127.0.0.1:<port><value>`
 * - any other value        → ignored (fail-safe: a bad config never pops a
 *                            browser; `0`/`false`/typos all mean "off")
 *
 * The gate (`resolveAutoOpenUrl`) and the per-platform command
 * (`browserOpenCommand`) are pure and unit-tested; the spawn wrapper mirrors
 * daemon-spawn.ts's best-effort discipline — detached, windowsHide, unref'd,
 * never throws — so a failed open can never affect MCP server startup.
 */
import { spawn } from 'node:child_process';

/** Bus ownership after start/takeover (see Bus.startResult). */
export type BusMode = 'own' | 'reuse';

/**
 * Pure gate: the URL to open, or null when nothing should open. `mode` and
 * `port` are the owning Bus's own-mode port (port is validated so a bad
 * caller can never yield a malformed URL).
 */
export function resolveAutoOpenUrl(
  envValue: string | undefined,
  mode: BusMode,
  port: number,
): string | null {
  const value = (envValue ?? '').trim();
  if (mode !== 'own' || value === '') return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (value === '1') return `http://127.0.0.1:${port}/`;
  if (value.startsWith('/')) return `http://127.0.0.1:${port}${value}`;
  return null;
}

/**
 * Per-platform browser-open command: Windows `cmd /c start "" "<url>"` (the
 * empty title arg is required — `start` treats the first quoted token as the
 * window title), macOS `open <url>`, everything else `xdg-open <url>`.
 */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { file: 'open', args: [url] };
  return { file: 'xdg-open', args: [url] };
}

/**
 * Spawn the browser open detached, hidden, and unref'd — best-effort like
 * spawnBusDaemon: synchronous failures are caught and async failures are
 * swallowed, so a missing `xdg-open` or a broken shell never surfaces.
 */
export function spawnBrowserOpen(url: string): void {
  try {
    const { file, args } = browserOpenCommand(process.platform, url);
    const child = spawn(file, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {}); // async spawn errors (ENOENT xdg-open, etc.)
    child.unref();
  } catch {
    // Never throw — auto-open must not affect MCP server startup.
  }
}

/**
 * Entry point for the Bus-ready moment: gate on env + ownership, then open.
 * `open` is injectable so tests never touch a real browser.
 */
export function maybeAutoOpen(
  envValue: string | undefined,
  mode: BusMode,
  port: number,
  open: (url: string) => void = spawnBrowserOpen,
): void {
  const url = resolveAutoOpenUrl(envValue, mode, port);
  if (url !== null) open(url);
}
