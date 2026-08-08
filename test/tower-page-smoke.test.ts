/**
 * Tower page inline-JS smoke (B4): the /tower page inlines LIB_JS + I18N_JS +
 * a page IIFE inside its single <script> block. There is no page test harness,
 * so this mirrors the status-board-bundle.test.ts vm pattern: extract the
 * inline script and run it in a fake-DOM sandbox to catch load-time syntax /
 * runtime errors, and assert the shared chrome mounts (i18n + lib, incl. the
 * tower poll cadence).
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { TOWER_PAGE_HTML } from '../src/web/pages/tower.js';

function fakeEl() {
  return {
    textContent: '', className: '', hidden: false, value: '', scrollTop: 0, scrollHeight: 0,
    children: [] as unknown[],
    appendChild(c: unknown) { this.children.push(c); },
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
  };
}

describe('tower page inline JS smoke', () => {
  it('loads and mounts i18n + lib + the page IIFE without error', () => {
    // The main page script is the LAST <script> block (I18N_BOOTSTRAP ships an
    // earlier one in <head>).
    const script = TOWER_PAGE_HTML.slice(
      TOWER_PAGE_HTML.lastIndexOf('<script>') + 8,
      TOWER_PAGE_HTML.lastIndexOf('</script>'),
    );
    const elements: Record<string, ReturnType<typeof fakeEl>> = {};
    const sandbox: any = {
      console,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { languages: ['en-US'] },
      document: {
        documentElement: { lang: 'en', dataset: {} },
        getElementById: (id: string) => (elements[id] ??= fakeEl()),
        querySelectorAll: () => [],
        createElement: () => fakeEl(),
        createEvent: () => ({ initEvent() {} }),
      },
      fetch: () => new Promise(() => {}), // never resolves — no network in the smoke
      Promise, setTimeout, clearTimeout,
      setInterval: () => 0, clearInterval: () => {},
      requestAnimationFrame: (f: () => void) => { setTimeout(f, 0); return 0; },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    expect(() => vm.runInContext(script, sandbox, { timeout: 5000 })).not.toThrow();
    expect(typeof sandbox.__moaI18n.t).toBe('function');
    expect(typeof sandbox.__moaLib.startPoll).toBe('function');
    expect(sandbox.__moaLib.POLL_MS.tower).toBe(5000);
    expect(sandbox.__moaI18n.t('tower.title')).toBe('Tower Workflow');
  });
});
