import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renderAppHeader } from '../src/web/app-header.js';
import { CONTROL_PLANE_HTML } from '../src/web/control-plane-page.js';
import { DEBATE_CARD_HTML } from '../src/web/debate-card.js';
import { STATUS_BOARD_HTML } from '../src/web/status-board.js';
import {
  I18N_DICTIONARIES,
  I18N_JS,
  LOCALE_STORAGE_KEY,
  translate,
} from '../src/web/i18n.js';

class FakeNode {
  children: FakeNode[] = [];
  className = '';
  textContent = '';
  value = '';
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<() => void>> = {};

  constructor(attrs: Record<string, string> = {}, text = '') {
    this.attrs = { ...attrs };
    this.textContent = text;
  }

  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  setAttribute(name: string, value: string): void { this.attrs[name] = String(value); }
  addEventListener(type: string, listener: () => void): void { (this.listeners[type] ??= []).push(listener); }
  click(): void { for (const listener of this.listeners.click ?? []) listener.call(this); }
}

function runRuntime(options: { languages?: string[]; saved?: string | null } = {}) {
  const stored = new Map<string, string>([['moamcp-theme', 'editorial']]);
  if (options.saved !== undefined && options.saved !== null) stored.set(LOCALE_STORAGE_KEY, options.saved);
  const zh = new FakeNode({ 'data-locale': 'zh-CN', 'data-i18n': 'locale.zh' }, '中文');
  const separator = new FakeNode({}, '/');
  const en = new FakeNode({ 'data-locale': 'en', 'data-i18n': 'locale.en' }, 'EN');
  const picker = new FakeNode({ 'data-i18n-aria': 'locale.group' });
  picker.children = [zh, separator, en];
  const label = new FakeNode({ 'data-i18n': 'app.debate' }, 'MOA Debate');
  const nav = new FakeNode({ 'data-i18n-aria': 'app.nav' });
  const draft = new FakeNode(); draft.value = 'unsaved draft';
  const documentElement = new FakeNode();
  const bySelector: Record<string, FakeNode[]> = {
    '[data-i18n]': [zh, en, label],
    '[data-i18n-aria]': [picker, nav],
    '[data-i18n-placeholder]': [],
    '[data-i18n-title]': [],
    '[data-i18n-tip]': [],
  };
  const events: string[] = [];
  const sandbox: any = {
    document: {
      documentElement,
      getElementById: (id: string) => id === 'localePicker' ? picker : id === 'draft' ? draft : null,
      querySelectorAll: (selector: string) => bySelector[selector] ?? [],
      createEvent: () => ({ initEvent(type: string) { this.type = type; } }),
    },
    navigator: { languages: options.languages ?? ['en-US'], language: (options.languages ?? ['en-US'])[0] },
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, init: any) { this.type = type; this.detail = init.detail; } },
    addEventListener: () => {},
    dispatchEvent: (event: any) => { events.push(event.type); },
    location: { href: 'http://127.0.0.1/control-plane?section=runs&task_id=task-7' },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(I18N_JS, sandbox);
  return { sandbox, stored, documentElement, picker, zh, en, label, nav, draft, events };
}

describe('shared Web i18n', () => {
  it('has complete Chinese coverage for the shared English source and a safe fallback', () => {
    expect(Object.keys(I18N_DICTIONARIES.en).length).toBeGreaterThan(150);
    expect(Object.keys(I18N_DICTIONARIES.en).filter((key) => !I18N_DICTIONARIES['zh-CN'][key])).toEqual([]);
    expect(Object.keys(I18N_DICTIONARIES['zh-CN']).filter((key) => !I18N_DICTIONARIES.en[key])).toEqual([]);
    expect(translate('zh-CN', 'app.debate')).toBe('MOA 辩论');
    expect(translate('en', 'app.debate')).toBe('MOA Debate');
    expect(translate('zh-CN', 'debate.connecting')).toBe('连接中…');
    expect(translate('en', 'common.loading')).toBe('Loading…');
    expect(translate('zh-CN', 'common.loading')).toBe('加载中…');
    expect(translate('zh-CN', 'missing.key')).toBe('missing.key');
    expect(translate('zh-CN', 'common.copied', { label: 'key' })).toContain('key');
  });

  it('uses browser language by default and valid localStorage as an override', () => {
    expect(runRuntime({ languages: ['zh-Hans-CN'] }).sandbox.__moaI18n.getLocale()).toBe('zh-CN');
    expect(runRuntime({ languages: ['en-US'], saved: 'zh-CN' }).sandbox.__moaI18n.getLocale()).toBe('zh-CN');
    expect(runRuntime({ languages: ['zh-CN'], saved: 'en' }).sandbox.__moaI18n.getLocale()).toBe('en');
  });

  it('falls back from stale storage, switches immediately, and persists lang/aria/active without touching URL or drafts', () => {
    const runtime = runRuntime({ languages: ['zh-CN'], saved: 'stale-locale' });
    expect(runtime.sandbox.__moaI18n.getLocale()).toBe('zh-CN');
    expect((runtime.documentElement as any).lang).toBe('zh-CN');
    expect(runtime.zh.className).toContain('active');
    expect(runtime.zh.attrs['aria-pressed']).toBe('true');
    expect(runtime.label.textContent).toBe('MOA 辩论');

    const originalUrl = runtime.sandbox.location.href;
    runtime.en.click();
    expect(runtime.sandbox.__moaI18n.getLocale()).toBe('en');
    expect(runtime.stored.get(LOCALE_STORAGE_KEY)).toBe('en');
    expect(runtime.stored.get('moamcp-theme')).toBe('editorial');
    expect((runtime.documentElement as any).lang).toBe('en');
    expect(runtime.en.className).toContain('active');
    expect(runtime.en.attrs['aria-pressed']).toBe('true');
    expect(runtime.zh.attrs['aria-pressed']).toBe('false');
    expect(runtime.picker.attrs['aria-label']).toBe('Language');
    expect(runtime.nav.attrs['aria-label']).toBe('Main navigation');
    expect(runtime.label.textContent).toBe('MOA Debate');
    expect(runtime.events).toContain('moamcp:localechange');
    expect(runtime.sandbox.location.href).toBe(originalUrl);
    expect(runtime.draft.value).toBe('unsaved draft');
  });

  it('shares one selector and one dictionary runtime across the single-markup pages', () => {
    const header = renderAppHeader('runs');
    for (const html of [header, DEBATE_CARD_HTML, CONTROL_PLANE_HTML, STATUS_BOARD_HTML]) {
      expect(html).toContain('id="localePicker"');
      expect(html).toContain('data-locale="zh-CN"');
      expect(html).toContain('data-locale="en"');
    }
    for (const html of [DEBATE_CARD_HTML, CONTROL_PLANE_HTML, STATUS_BOARD_HTML]) {
      expect(html).toContain(LOCALE_STORAGE_KEY);
      expect(html).toContain('window.__moaI18n');
      expect(html).toContain("moamcp:localechange");
      expect(html).toContain("document.documentElement.lang = locale");
    }
    expect(DEBATE_CARD_HTML).toContain('data-i18n="debate.connecting"');
    expect(CONTROL_PLANE_HTML).toContain('data-i18n-placeholder="common.module"');
    expect(CONTROL_PLANE_HTML).toContain('data-i18n-placeholder="common.tag"');
    expect(CONTROL_PLANE_HTML).toContain('data-i18n="board.keyAsc"');
    expect(STATUS_BOARD_HTML).toContain('data-i18n="status.scanning"');
    expect(STATUS_BOARD_HTML).toContain('data-i18n="status.notReady"');
    expect(CONTROL_PLANE_HTML).toContain("new URLSearchParams(location.search).get('section')");
    expect(DEBATE_CARD_HTML).toContain("new URLSearchParams(location.search).get('task_id')");
    // The shared lib must never force a page reload; the control-plane page
    // may, but only inside the deliberate bus-restart flow (task B/C of
    // BUS_VERSION_RESTART.md: banner → POST /api/bus/restart → reload when
    // the served version catches up to the installed disk version).
    expect(DEBATE_CARD_HTML).not.toContain('location.reload');
    expect(CONTROL_PLANE_HTML).toContain("api('/api/bus/restart'");
    expect(CONTROL_PLANE_HTML).toContain('busUpdate.banner');
    expect(CONTROL_PLANE_HTML).toContain('busUpdate.stale');
    expect(CONTROL_PLANE_HTML.match(/location\.reload/g) || []).toHaveLength(1);
  });
});
