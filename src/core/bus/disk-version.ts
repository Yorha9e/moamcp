/**
 * Disk truth for the version banner (tip_c7eced84 / BUS_VERSION_RESTART.md).
 *
 * The running process's own VERSION is fixed at startup, but installs update
 * the plugin-root package.json on disk without touching live processes. This
 * module re-reads the file per request (short cache) so the Control Plane can
 * tell the user "a newer build is installed — restart the backend".
 *
 * Path resolution mirrors VERSION's createRequire trick: relative to this
 * module in the esbuild bundle it lands on the plugin root's package.json.
 * Under vitest the relative path resolves into src/ and fails, so tests
 * inject MOAMCP_PACKAGE_JSON (documented, never set in production).
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

export const DISK_VERSION_CACHE_MS = 5000;

let cached: { at: number; value: string | null } | null = null;

function packageJsonPath(): string | undefined {
  const override = process.env.MOAMCP_PACKAGE_JSON;
  if (typeof override === 'string' && override.length > 0) return override;
  try {
    const require = createRequire(import.meta.url);
    return require.resolve('../package.json');
  } catch {
    return undefined;
  }
}

/** Latest installed version on disk, or null when unreadable/absent. */
export async function readDiskVersion(): Promise<string | null> {
  const now = Date.now();
  if (cached !== null && now - cached.at < DISK_VERSION_CACHE_MS) return cached.value;
  let value: string | null = null;
  const path = packageJsonPath();
  if (path !== undefined) {
    try {
      const pkg = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown };
      value = typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : null;
    } catch {
      value = null; // unreadable/malformed disk state never fails the request
    }
  }
  cached = { at: now, value };
  return value;
}

/** Test hook: force the next read to hit the disk again. */
export function resetDiskVersionCache(): void {
  cached = null;
}
