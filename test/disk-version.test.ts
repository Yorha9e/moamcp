import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDiskVersion, resetDiskVersionCache } from '../src/core/bus/disk-version.js';

const ENV_KEY = 'MOAMCP_PACKAGE_JSON';
let dir: string | undefined;

afterEach(async () => {
  delete process.env[ENV_KEY];
  resetDiskVersionCache();
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('readDiskVersion (BUS_VERSION_RESTART.md task A)', () => {
  it('reads the injected package.json version from disk', async () => {
    dir = await mkdtemp(join(tmpdir(), 'moamcp-disk-version-'));
    const pkg = join(dir, 'package.json');
    await writeFile(pkg, JSON.stringify({ name: 'moamcp', version: '9.9.9' }));
    process.env[ENV_KEY] = pkg;
    expect(await readDiskVersion()).toBe('9.9.9');
  });

  it('serves the cached value without touching the disk again within the cache window', async () => {
    dir = await mkdtemp(join(tmpdir(), 'moamcp-disk-version-'));
    const pkg = join(dir, 'package.json');
    await writeFile(pkg, JSON.stringify({ version: '1.0.0' }));
    process.env[ENV_KEY] = pkg;
    expect(await readDiskVersion()).toBe('1.0.0');
    // Remove the file: the cached value must still be served.
    await rm(pkg);
    expect(await readDiskVersion()).toBe('1.0.0');
  });

  it('re-reads the disk after resetDiskVersionCache', async () => {
    dir = await mkdtemp(join(tmpdir(), 'moamcp-disk-version-'));
    const pkg = join(dir, 'package.json');
    await writeFile(pkg, JSON.stringify({ version: '1.0.0' }));
    process.env[ENV_KEY] = pkg;
    expect(await readDiskVersion()).toBe('1.0.0');
    await writeFile(pkg, JSON.stringify({ version: '1.1.0' }));
    resetDiskVersionCache();
    expect(await readDiskVersion()).toBe('1.1.0');
  });

  it('returns null for a malformed package.json', async () => {
    dir = await mkdtemp(join(tmpdir(), 'moamcp-disk-version-'));
    const pkg = join(dir, 'package.json');
    await writeFile(pkg, '{ not json');
    process.env[ENV_KEY] = pkg;
    expect(await readDiskVersion()).toBeNull();
  });

  it('returns null without an injectable path (source-mode resolution has no root package.json)', async () => {
    // No MOAMCP_PACKAGE_JSON: createRequire resolves src/core/../package.json
    // which does not exist in source mode → undefined path → null. Never a
    // throw, never a failed request.
    expect(await readDiskVersion()).toBeNull();
  });
});
