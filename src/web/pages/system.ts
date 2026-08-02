// Control Plane page fragment: System Health section.
// Extracted verbatim from control-plane-page.ts (Step C physical split).
// The assembled CONTROL_PLANE_HTML must stay byte-identical: do not reorder,
// re-indent, or "clean up" these fragments; no innerHTML, no new i18n keys.

export const SYSTEM_SECTION_HTML = `  <main id="systemSection" class="section" hidden>
    <div class="toolbar">
      <button id="refreshSystem" class="secondary" type="button" data-i18n="common.refresh">Refresh</button>
      <button id="copyControlPlaneUrl" class="secondary" type="button" data-i18n="system.copyUrl">Copy Control Plane URL</button>
      <a class="secondary" href="/" data-i18n="system.openDebate">Open MOA Debate</a>
    </div>
    <p class="section-intro" data-i18n="system.intro">Bus listener entries do not represent every Kimi Session or MCP process. This page is read-only and provides no dangerous mutations.</p>
    <div id="systemHealth" class="health-grid"></div>
  </main>
`;

export const SYSTEM_PAGE_JS = `  function renderHealthCard(container, title, value) {
    var card = document.createElement('article'); card.className = 'card health-card';
    var heading = document.createElement('h2'); heading.textContent = title; card.appendChild(heading);
    var dl = document.createElement('dl');
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.keys(value).forEach(function (key) { var dt = document.createElement('dt'); dt.textContent = key; var dd = document.createElement('dd'); dd.textContent = valueText(value[key]); dl.appendChild(dt); dl.appendChild(dd); });
    else { var dt = document.createElement('dt'); dt.textContent = tr('system.value'); var dd = document.createElement('dd'); dd.textContent = valueText(value); dl.appendChild(dt); dl.appendChild(dd); }
    card.appendChild(dl); container.appendChild(card);
  }
  function loadSystem() {
    return api('/api/system').then(function (data) {
      var box = document.getElementById('systemHealth'); box.textContent = '';
      ['process', 'bus', 'runs', 'sse', 'archives', 'reuseWatch'].forEach(function (key) { renderHealthCard(box, key, data ? data[key] : undefined); });
      renderHealthCard(box, 'registry listenerEntries', data && data.registry ? data.registry.listenerEntries : undefined);
    }).catch(function (error) {
      var box = document.getElementById('systemHealth'); box.textContent = '';
      var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('system.unavailable') + error.message; box.appendChild(empty);
    });
  }
`;
