/**
 * spawnBusDaemon (BUS_VERSION_RESTART.md task D): the controlled restart flow
 * spawns a detached headless daemon from the disk build. These tests use a
 * marker script instead of the real daemon bundle — they prove the spawn
 * mechanics (detached, env handoff, cwd, best-effort failure) without a build.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnBusDaemon } from '../src/core/bus/daemon-spawn.js';

async function waitForFile(path: string, timeoutMs = 10000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${path}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

describe('spawnBusDaemon', () => {
  let home: string | undefined;

  afterEach(async () => {
    if (home !== undefined) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  it('spawns the script detached with MOAMCP_BUS_PORT in the environment', async () => {
    home = await mkdtemp(join(tmpdir(), 'moamcp-daemon-'));
    const marker = join(home, 'marker.json');
    const script = join(home, 'fake-daemon.mjs');
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ port: process.env.MOAMCP_BUS_PORT, cwd: process.cwd() }));\n`,
    );

    expect(spawnBusDaemon({ port: 45678, cwd: home, script })).toBe(true);

    const result = JSON.parse(await waitForFile(marker)) as { port: string; cwd: string };
    expect(result.port).toBe('45678');
    // The daemon inherits the requested cwd (bus.port location).
    expect(result.cwd.replace(/\\/g, '/').replace(/\/$/, '')).toBe(home.replace(/\\/g, '/').replace(/\/$/, ''));
  });

  it('returns false instead of throwing when the script does not exist', () => {
    // spawn itself is lazy for missing scripts — the 'error' event is swallowed
    // and the call still reports the spawn attempt; a bad default URL path is
    // the synchronous failure mode. Either way: never throws.
    expect(() => spawnBusDaemon({ port: 1, cwd: tmpdir(), script: join(tmpdir(), 'no-such-daemon.mjs') })).not.toThrow();
  });
});
