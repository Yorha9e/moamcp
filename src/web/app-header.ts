export type AppSection = 'debate' | 'memory' | 'runs' | 'status' | 'system';

const NAV_ITEMS: ReadonlyArray<{ id: string; section: AppSection; label: string; i18n: string; href: string }> = [
  { id: 'debateNav', section: 'debate', label: 'MOA Debate', i18n: 'app.debate', href: '/' },
  { id: 'memoryNav', section: 'memory', label: 'Workspace Memory', i18n: 'app.memory', href: '/control-plane?section=memory' },
  { id: 'runsNav', section: 'runs', label: 'MoA Runs', i18n: 'app.runs', href: '/control-plane?section=runs' },
  { id: 'statusNav', section: 'status', label: 'Agent Status', i18n: 'app.status', href: '/status-board' },
  { id: 'systemNav', section: 'system', label: 'System Health', i18n: 'app.system', href: '/control-plane?section=system' },
];

/** The single markup source for the application chrome shared by every web page. */
export function renderAppHeader(active: AppSection): string {
  const nav = NAV_ITEMS.map((item) => {
    const current = item.section === active;
    return `<a id="${item.id}"${current ? ' class="active" aria-current="page"' : ''} data-i18n="${item.i18n}" href="${item.href}">${item.label}</a>`;
  }).join('\n      ');

  return `<header class="app-header">
    <div class="brand"><span class="brand-mark"></span><span class="brand-title" data-i18n="app.brand">MOA Workspace</span></div>
    <span class="app-version" id="appVersion"><span data-i18n="system.version">Version</span> <span class="app-version-value" id="appVersionValue">…</span></span>
    <nav class="top-nav" aria-label="Main navigation" data-i18n-aria="app.nav">
      ${nav}
    </nav>
    <span class="locale-picker" id="localePicker" role="group" aria-label="Language" data-i18n-aria="locale.group">
      <button class="locale-pill" type="button" data-locale="zh-CN" data-i18n="locale.zh" aria-pressed="false">中文</button>
      <span class="locale-separator" aria-hidden="true">/</span>
      <button class="locale-pill" type="button" data-locale="en" data-i18n="locale.en" aria-pressed="false">EN</button>
    </span>
    <span class="theme-picker" id="themePicker" role="group" aria-label="Theme" data-i18n-aria="theme.group"></span>
  </header>`;
}
