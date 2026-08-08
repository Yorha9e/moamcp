/**
 * auto-open (MOAMCP_AUTO_OPEN, see src/core/bus/auto-open.ts): the gate
 * (`resolveAutoOpenUrl`) and the per-platform command (`browserOpenCommand`)
 * are pure and deterministic, so env parsing, own/reuse dedup, URL assembly
 * and the spawn argv are all covered here without ever touching a real
 * browser — the spawn itself is isolated behind the injectable `open`
 * parameter of `maybeAutoOpen`, and its never-throws contract lives in the
 * wrapper (same best-effort discipline as spawnBusDaemon).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  browserOpenCommand,
  maybeAutoOpen,
  resolveAutoOpenUrl,
} from '../src/core/bus/auto-open.js';

describe('resolveAutoOpenUrl — env gate', () => {
  it('never opens when the env var is missing (default off)', () => {
    expect(resolveAutoOpenUrl(undefined, 'own', 39813)).toBeNull();
  });

  it('never opens when the env var is empty', () => {
    expect(resolveAutoOpenUrl('', 'own', 39813)).toBeNull();
  });

  it('never opens for whitespace-only values', () => {
    expect(resolveAutoOpenUrl('   ', 'own', 39813)).toBeNull();
  });

  it('value 1 opens the default page at the owning port', () => {
    expect(resolveAutoOpenUrl('1', 'own', 39813)).toBe('http://127.0.0.1:39813/');
  });

  it('a /-prefixed path opens the port plus that path', () => {
    expect(resolveAutoOpenUrl('/tower', 'own', 39813)).toBe('http://127.0.0.1:39813/tower');
    expect(resolveAutoOpenUrl('/status', 'own', 1234)).toBe('http://127.0.0.1:1234/status');
  });

  it('reuse mode never opens, even for value 1', () => {
    // Multi-session dedup: the owner's tab already serves the panel.
    expect(resolveAutoOpenUrl('1', 'reuse', 39813)).toBeNull();
  });

  it('reuse mode never opens for a /-prefixed path', () => {
    expect(resolveAutoOpenUrl('/tower', 'reuse', 39813)).toBeNull();
  });

  it('illegal values (non-1, not /-prefixed) are ignored — fail-safe off', () => {
    // Chosen semantics: a bad config never pops a browser; 0/false/typos all
    // mean "off" rather than erroring or opening the default page.
    expect(resolveAutoOpenUrl('0', 'own', 39813)).toBeNull();
    expect(resolveAutoOpenUrl('false', 'own', 39813)).toBeNull();
    expect(resolveAutoOpenUrl('true', 'own', 39813)).toBeNull();
    expect(resolveAutoOpenUrl('tower', 'own', 39813)).toBeNull();
  });
});

describe('resolveAutoOpenUrl — port validation', () => {
  it('rejects an out-of-range port so a bad caller never yields a malformed URL', () => {
    expect(resolveAutoOpenUrl('1', 'own', 0)).toBeNull();
    expect(resolveAutoOpenUrl('1', 'own', -1)).toBeNull();
    expect(resolveAutoOpenUrl('1', 'own', 65536)).toBeNull();
    expect(resolveAutoOpenUrl('1', 'own', NaN)).toBeNull();
    expect(resolveAutoOpenUrl('1', 'own', 3.5)).toBeNull();
  });

  it('accepts the port range boundaries', () => {
    expect(resolveAutoOpenUrl('1', 'own', 1)).toBe('http://127.0.0.1:1/');
    expect(resolveAutoOpenUrl('/tower', 'own', 65535)).toBe('http://127.0.0.1:65535/tower');
  });
});

describe('browserOpenCommand — per-platform argv', () => {
  it('windows opens via cmd /c start with an empty title arg', () => {
    expect(browserOpenCommand('win32', 'http://127.0.0.1:39813/')).toEqual({
      file: 'cmd',
      args: ['/c', 'start', '', 'http://127.0.0.1:39813/'],
    });
  });

  it('macOS opens via `open`', () => {
    expect(browserOpenCommand('darwin', 'http://127.0.0.1:39813/tower')).toEqual({
      file: 'open',
      args: ['http://127.0.0.1:39813/tower'],
    });
  });

  it('linux (and anything else) opens via xdg-open', () => {
    expect(browserOpenCommand('linux', 'http://127.0.0.1:39813/')).toEqual({
      file: 'xdg-open',
      args: ['http://127.0.0.1:39813/'],
    });
  });
});

describe('maybeAutoOpen — gate + injected open', () => {
  it('opens the default page when own and env is 1', () => {
    const open = vi.fn();
    maybeAutoOpen('1', 'own', 39813, open);
    expect(open).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:39813/');
  });

  it('opens the assembled path URL when own and env is /-prefixed', () => {
    const open = vi.fn();
    maybeAutoOpen('/status', 'own', 9000, open);
    expect(open).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:9000/status');
  });

  it('does not open when the env var is missing', () => {
    const open = vi.fn();
    maybeAutoOpen(undefined, 'own', 39813, open);
    expect(open).not.toHaveBeenCalled();
  });

  it('does not open in reuse mode (multi-session dedup)', () => {
    const open = vi.fn();
    maybeAutoOpen('1', 'reuse', 39813, open);
    maybeAutoOpen('/tower', 'reuse', 39813, open);
    expect(open).not.toHaveBeenCalled();
  });

  it('does not open for illegal env values', () => {
    const open = vi.fn();
    maybeAutoOpen('0', 'own', 39813, open);
    maybeAutoOpen('false', 'own', 39813, open);
    expect(open).not.toHaveBeenCalled();
  });
});
