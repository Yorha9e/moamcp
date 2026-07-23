/**
 * Instance registry — discovery mechanism for moamcp Bus instances sharing
 * one home directory (port-discovery design §3.1/§3.2).
 *
 * Trimmed from kimi-code `packages/kap-server/src/instanceRegistry.ts`:
 * same mkdir→sweep→write transaction chain, same `kill(pid, 0)` liveness
 * probe, same rename-based atomic writes — minus heartbeat (moamcp has no
 * periodic rewrite, so `release()` also drops kap-server's inflight-write
 * drain; the release/write race window is tiny by design, documented as an
 * accepted simplification in §3.1).
 *
 * Every Bus instance writes `<home>/instances/<pid>.json` with
 * `{ id, pid, port, started_at, version }`. Files are single-writer (only
 * the owning process rewrites its own), so no locking is needed. Stale
 * entries left by a killed process (Windows does not deliver SIGTERM) are
 * swept lazily inside `register` / `listLive` — sweep is a private step,
 * never a public operation, so callers cannot interleave sweep→register
 * into a TOCTOU gap. Sweep discipline: an entry is unlinked ONLY when
 * `pidAlive` is positively false (ESRCH); unparseable entries and
 * non-ESRCH probe errors are conservatively kept.
 *
 * The ULID `id` is redundant with the pid file name on purpose: once the OS
 * recycles a pid, a fresh process and a stale entry share a pid but differ
 * by ULID, which identifies the stale entry.
 *
 * File-name note: entries are keyed by pid, so a second `register` from the
 * same pid overwrites the previous entry (non-monotonic). Acceptable for
 * the current one-Bus-per-process model (kap-server uses the ULID as the
 * file name to guarantee uniqueness).
 */
import { randomInt } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** moamcp version stamped into every entry (diagnostics for cross-version reuse). */
export const VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Home root: `~/.moamcp` unless `MOAMCP_HOME` overrides it. Read at call time so tests can redirect. */
export function moamcpHome(): string {
  return process.env.MOAMCP_HOME || join(homedir(), '.moamcp');
}

/** Registry directory: `<home>/instances`. */
export function defaultInstancesDir(): string {
  return join(moamcpHome(), 'instances');
}

/** In-memory shape of a registered instance. */
export interface InstanceInfo {
  readonly id: string;
  readonly pid: number;
  readonly port: number;
  readonly startedAt: number;
  readonly version: string;
}

/** On-disk JSON shape. snake_case to match the design doc. */
interface InstanceDisk {
  id: string;
  pid: number;
  port: number;
  started_at: number;
  version: string;
}

export interface InstanceRegistration {
  readonly id: string;
  readonly pid: number;
  /** Rewrite this instance's file with a new port. Idempotent: an unchanged port rewrites identical content. */
  update(patch: { port?: number }): Promise<void>;
  /** Remove the instance file. Idempotent, best-effort on shutdown. */
  release(): Promise<void>;
}

export interface IInstanceRegistry {
  /**
   * Register this process: mkdir → sweep stale (dead-pid) entries as a
   * private side effect → atomically write the instance file.
   */
  register(info: { pid: number; port: number; startedAt?: number }): Promise<InstanceRegistration>;
  /** List live instances; dead-pid entries are filtered and lazily unlinked. */
  listLive(): Promise<readonly InstanceInfo[]>;
}

export interface InstanceRegistryOptions {
  /** Directory holding `<pid>.json` files. Defaults to `<MOAMCP_HOME|~/.moamcp>/instances`. */
  readonly instancesDir?: string;
}

/**
 * `kill(pid, 0)` liveness probe, three-way (mirrors instanceRegistry.ts:82-94):
 * ESRCH → dead; EPERM → alive (other user's process, exists but unsignalable);
 * any other error → conservatively alive so a live entry is never clobbered.
 */
export function pidAliveWith(
  pid: number,
  kill: (pid: number, signal: number) => void = process.kill,
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true; // EPERM and anything else: assume alive
  }
}

/** `pidAlive` against the real process table. */
export function pidAlive(pid: number): boolean {
  return pidAliveWith(pid);
}

// ---- minimal ULID (no dependency): 48-bit ms timestamp + 80-bit randomness, Crockford base32 ----

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 26-char ULID: 10 chars timestamp (lexicographically sortable) + 16 chars randomness. */
export function ulid(now: number = Date.now()): string {
  let ts = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[randomInt(32)];
  return time + rand;
}

// ---- encode / decode ----

function encode(info: InstanceInfo): string {
  const disk: InstanceDisk = {
    id: info.id,
    pid: info.pid,
    port: info.port,
    started_at: info.startedAt,
    version: info.version,
  };
  return JSON.stringify(disk);
}

function decode(raw: string): InstanceInfo | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<InstanceDisk>;
    if (
      typeof parsed.id === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.port === 'number' &&
      typeof parsed.started_at === 'number' &&
      typeof parsed.version === 'string'
    ) {
      return {
        id: parsed.id,
        pid: parsed.pid,
        port: parsed.port,
        startedAt: parsed.started_at,
        version: parsed.version,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isInstanceFile(name: string): boolean {
  return name.endsWith('.json');
}

/** Read + decode one instance file; undefined on missing/unparseable input. */
async function readInstanceFile(filePath: string): Promise<InstanceInfo | undefined> {
  try {
    return decode(await readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Replace-rename with a short retry on Windows: right after a previous write
 * lands, antivirus real-time scanning (Windows Defender) can briefly hold the
 * destination without FILE_SHARE_DELETE, making the overwrite rename fail
 * with EPERM/EACCES. The scan releases the handle quickly, so a few retries
 * with a small backoff ride it out.
 */
const RENAME_RETRY_LIMIT = 5;
const RENAME_RETRY_DELAY_MS = 50;

async function renameReplace(tmpPath: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmpPath, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_RETRY_LIMIT || (code !== 'EPERM' && code !== 'EACCES')) throw err;
      await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
}

/** Atomic (rename-based) write. Single-writer per file, so no lock is needed. */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomInt(0x1_0000_0000).toString(16)}`;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
    } finally {
      await fh.close();
    }
    await renameReplace(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      // Write failed: never leave a half-written temp behind.
      try {
        await unlink(tmpPath);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Unlink dead-pid entries in the directory. Best-effort; ENOENT races are
 * ignored. Discipline: only unlink when the entry parses AND pidAlive is
 * false — unparseable files may belong to a live peer mid-write, and
 * non-ESRCH probe errors count as alive.
 */
async function sweepStale(instancesDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(instancesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  await Promise.all(
    names.filter(isInstanceFile).map(async (name) => {
      const filePath = join(instancesDir, name);
      const info = await readInstanceFile(filePath);
      if (info === undefined || pidAlive(info.pid)) return;
      try {
        await unlink(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }),
  );
}

/**
 * Read every live instance, lazily unlinking dead-pid entries. Sorted by
 * `startedAt` ascending so the longest-running instance comes first —
 * deterministic for consumers that pick one (e.g. the reuse target).
 */
async function listLiveInternal(instancesDir: string): Promise<readonly InstanceInfo[]> {
  let names: string[];
  try {
    names = await readdir(instancesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const live: InstanceInfo[] = [];
  await Promise.all(
    names.filter(isInstanceFile).map(async (name) => {
      const filePath = join(instancesDir, name);
      const info = await readInstanceFile(filePath);
      if (info === undefined) return; // conservative: leave unparseable files alone
      if (!pidAlive(info.pid)) {
        try {
          await unlink(filePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        return;
      }
      live.push(info);
    }),
  );
  live.sort((a, b) => a.startedAt - b.startedAt);
  return live;
}

export function createRegistry(options: InstanceRegistryOptions = {}): IInstanceRegistry {
  const instancesDir = options.instancesDir ?? defaultInstancesDir();

  return {
    async register(info) {
      const id = ulid();
      const filePath = join(instancesDir, `${info.pid}.json`);
      const startedAt = info.startedAt ?? Date.now();

      // Transaction chain: mkdir → sweep → write. mkdir failure skips the
      // rest; sweep is best-effort (its failure must not block registration);
      // a write failure leaves nothing behind (writeFileAtomic cleans its temp).
      await mkdir(instancesDir, { recursive: true });
      try {
        await sweepStale(instancesDir);
      } catch {
        // best-effort sweep; registration proceeds
      }

      // Per-registration mutable state so `update` rewrites the latest port
      // without re-reading the file.
      const state: { port: number; released: boolean } = { port: info.port, released: false };

      const write = async (): Promise<void> => {
        if (state.released) return;
        const full: InstanceInfo = {
          id,
          pid: info.pid,
          port: state.port,
          startedAt,
          version: VERSION,
        };
        await writeFileAtomic(filePath, encode(full));
      };

      await write();

      return {
        id,
        pid: info.pid,
        async update(patch) {
          if (state.released) return;
          if (patch.port !== undefined) state.port = patch.port;
          await write(); // idempotent: unchanged port rewrites identical content
        },
        async release() {
          if (state.released) return;
          state.released = true;
          try {
            await unlink(filePath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
        },
      };
    },

    listLive() {
      return listLiveInternal(instancesDir);
    },
  };
}
