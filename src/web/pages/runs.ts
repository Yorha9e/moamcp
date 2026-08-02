// Control Plane page fragment: MoA Runs section (live runs + archives).
// Extracted verbatim from control-plane-page.ts (Step C physical split).
// The assembled CONTROL_PLANE_HTML must stay byte-identical: do not reorder,
// re-indent, or "clean up" these fragments; no innerHTML, no new i18n keys.

export const RUNS_SECTION_HTML = `  <main id="runsSection" class="section" hidden>
    <p class="section-intro" data-i18n="runs.intro">The run model is an in-memory event projection of the owner Bus. After a Bus restart, use Archives as the source of truth.</p>
    <div class="tabs section-tabs" role="tablist" aria-label="MoA Runs" data-i18n-aria="runs.tabs">
      <button id="liveRunsTab" class="tab active" role="tab" type="button" data-i18n="runs.live">Live &amp; Recent</button>
      <button id="archivesTab" class="tab" role="tab" type="button" data-i18n="runs.archives">Archives</button>
    </div>
    <section id="liveRunsView" class="subview" role="tabpanel">
      <div class="toolbar">
        <div class="field"><label for="runStatusFilter" data-i18n="common.status">Status</label><select id="runStatusFilter"><option value="" data-i18n="common.allStatuses">All statuses</option><option value="initialized">initialized</option><option value="debating">debating</option><option value="complete">complete</option><option value="closed">closed</option></select></div>
        <div class="field wide"><label for="runQuery" data-i18n="runs.query">Query</label><input id="runQuery" type="search" placeholder="task id, agent, binding slot" data-i18n-placeholder="runs.queryPlaceholder"></div>
        <button id="refreshRuns" class="secondary" type="button" data-i18n="common.refresh">Refresh</button>
        <span id="runResultCount" class="result-count" role="status">0 results</span>
      </div>
      <div id="runList" class="management-list"></div>
    </section>
    <section id="archivesView" class="subview" role="tabpanel" hidden>
      <div class="toolbar"><button id="refreshArchives" class="secondary" type="button" data-i18n="common.refresh">Refresh</button><span id="archiveResultCount" class="result-count" role="status">0 results</span></div>
      <div id="archiveList" class="management-list"></div>
    </section>
  </main>
`;

export const RUNS_PAGE_JS = `  function appendMeta(grid, label, value) {
    var item = document.createElement('div'); item.className = 'meta-item';
    var key = document.createElement('span'); key.className = 'meta-label'; key.textContent = label;
    var text = document.createElement('span'); text.textContent = valueText(value);
    item.appendChild(key); item.appendChild(text); grid.appendChild(item);
  }
  function makeButton(label, className, handler) {
    var button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; button.addEventListener('click', handler); return button;
  }
  function renderRunCard(task) {
    var card = document.createElement('article'); card.className = 'management-card';
    var head = document.createElement('div'); head.className = 'management-head';
    var title = document.createElement('h2'); title.textContent = task.taskId || 'unknown task';
    var status = document.createElement('span'); status.className = 'status'; status.textContent = task.status || 'unknown';
    head.appendChild(title); head.appendChild(status); card.appendChild(head);
    var roster = document.createElement('div'); roster.className = 'run-roster';
    var specs = Array.isArray(task.agentSpecs) ? task.agentSpecs : [];
    if (!specs.length && Array.isArray(task.agents)) specs = task.agents.map(function (id) { return { id: id }; });
    specs.forEach(function (agent) { var chip = document.createElement('span'); chip.className = 'run-agent'; chip.textContent = valueText(agent.id) + (agent.binding_slot ? ' · ' + agent.binding_slot : ''); roster.appendChild(chip); });
    card.appendChild(roster);
    var grid = document.createElement('div'); grid.className = 'meta-grid';
    appendMeta(grid, tr('runs.roundConfigured'), valueText(task.round) + ' / ' + valueText(task.roundsConfigured));
    appendMeta(grid, tr('runs.turn'), task.turn); appendMeta(grid, tr('runs.speaker'), task.currentSpeaker);
    appendMeta(grid, tr('runs.turnsSignoffs'), valueText(task.turnCount) + ' / ' + valueText(task.signoffCount));
    appendMeta(grid, tr('runs.lastEvent'), task.lastEvent); appendMeta(grid, tr('runs.updated'), task.updatedAt);
    if (task.early !== undefined || task.reason) appendMeta(grid, tr('runs.earlyReason'), (task.early ? 'early · ' : '') + valueText(task.reason));
    card.appendChild(grid);
    var actions = document.createElement('div'); actions.className = 'management-actions';
    actions.appendChild(makeButton(tr('common.details'), 'secondary', function () { showRunDetails(card, task.taskId); }));
    actions.appendChild(makeButton(tr('runs.copyTask'), 'secondary', function () { copyBoardText(task.taskId, 'task id'); }));
    actions.appendChild(makeButton(tr('runs.openLive'), 'primary', function () { openLiveCard(task.taskId); }));
    card.appendChild(actions); return card;
  }
  function showRunDetails(card, taskId) {
    api('/api/tasks/' + encodeURIComponent(taskId)).then(function (data) {
      var detail = card.querySelector('.run-detail');
      if (!detail) { detail = document.createElement('pre'); detail.className = 'run-detail'; card.appendChild(detail); }
      detail.textContent = JSON.stringify(data && data.task ? data.task : data, null, 2);
    }).catch(function (error) { setNotice(tr('runs.detailsError') + error.message, true); });
  }
  function safeCardUrl(value) {
    try {
      var url = new URL(value, location.href);
      var loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
      return url.protocol === 'http:' && loopback && url.port === location.port ? url.href : '';
    } catch (_) { return ''; }
  }
  function openLiveCard(taskId) {
    api('/api/tasks/' + encodeURIComponent(taskId)).then(function (data) {
      var target = safeCardUrl(data && data.cardUrl);
      if (!target) throw new Error('invalid cardUrl');
      window.open(target, '_blank', 'noopener');
    }).catch(function (error) { setNotice(tr('runs.openError') + error.message, true); });
  }
  function loadRuns() {
    var query = new URLSearchParams();
    var status = document.getElementById('runStatusFilter').value;
    var text = document.getElementById('runQuery').value.trim();
    if (status) query.set('status', status); if (text) query.set('query', text);
    return api('/api/tasks?' + query.toString()).then(function (data) {
      var tasks = data && Array.isArray(data.tasks) ? data.tasks : [];
      document.getElementById('runResultCount').textContent = tr(tasks.length === 1 ? 'board.result' : 'board.results', { count: tasks.length });
      var list = document.getElementById('runList'); list.textContent = '';
      if (!tasks.length) { var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('runs.empty'); list.appendChild(empty); return; }
      tasks.forEach(function (task) { list.appendChild(renderRunCard(task)); });
    });
  }
  function archiveUrl(taskId, file) {
    if (ARCHIVE_FILES.indexOf(file) < 0) return '';
    var query = new URLSearchParams(); query.set('task_id', taskId); query.set('file', file); return '/archive?' + query.toString();
  }
  function showArchiveFile(card, taskId, file) {
    var url = archiveUrl(taskId, file); if (!url) return;
    fetchText(url).then(function (raw) {
      var detail = card.querySelector('.archive-detail');
      if (!detail) { detail = document.createElement('pre'); detail.className = 'archive-detail'; card.appendChild(detail); }
      var shown = raw;
      if (file.slice(-5) === '.json') { try { shown = JSON.stringify(JSON.parse(raw), null, 2); } catch (_) {} }
      detail.textContent = shown;
      var oldActions = card.querySelector('.archive-detail-actions'); if (oldActions) oldActions.remove();
      var actions = document.createElement('div'); actions.className = 'management-actions archive-detail-actions';
      actions.appendChild(makeButton(tr('archives.copy', { file: file }), 'secondary', function () { copyBoardText(shown, file); }));
      var download = document.createElement('a'); download.className = 'secondary'; download.textContent = tr('archives.download', { file: file }); download.href = url; download.download = taskId + '-' + file; actions.appendChild(download);
      card.appendChild(actions);
    }).catch(function (error) { setNotice(tr('archives.fileError') + error.message, true); });
  }
  function renderArchiveCard(entry) {
    var card = document.createElement('article'); card.className = 'management-card';
    var head = document.createElement('div'); head.className = 'management-head';
    var title = document.createElement('h2'); title.textContent = entry.taskId || 'unknown task'; head.appendChild(title);
    var state = document.createElement('span'); state.className = entry.degraded ? 'degraded' : 'status'; state.textContent = tr(entry.degraded ? 'archives.degraded' : 'archives.available'); head.appendChild(state); card.appendChild(head);
    var grid = document.createElement('div'); grid.className = 'meta-grid'; appendMeta(grid, tr('archives.updated'), entry.updatedAt); appendMeta(grid, tr('archives.summary'), entry.summary || '—'); card.appendChild(grid);
    if (entry.degraded || (Array.isArray(entry.errors) && entry.errors.length)) {
      var errors = document.createElement('details'); var summary = document.createElement('summary'); summary.textContent = tr('archives.errors', { count: (entry.errors || []).length }); errors.appendChild(summary);
      var errorText = document.createElement('pre'); errorText.className = 'archive-detail'; errorText.textContent = JSON.stringify(entry.errors || [], null, 2); errors.appendChild(errorText); card.appendChild(errors);
    }
    var files = document.createElement('div'); files.className = 'file-grid';
    ARCHIVE_FILES.forEach(function (file) {
      var info = entry.files && entry.files[file];
      var item = document.createElement('div'); item.className = 'file-item';
      var name = document.createElement('strong'); name.textContent = file; item.appendChild(name);
      var meta = document.createElement('div'); meta.className = 'file-meta'; meta.textContent = info && info.exists ? valueText(info.size) + ' B · ' + valueText(info.mtime) : tr('archives.notPresent'); item.appendChild(meta);
      if (info && info.exists) item.appendChild(makeButton(tr('archives.view'), 'secondary', function () { showArchiveFile(card, entry.taskId, file); }));
      files.appendChild(item);
    });
    card.appendChild(files); return card;
  }
  function loadArchives() {
    return api('/api/archives').then(function (data) {
      var archives = data && Array.isArray(data.archives) ? data.archives : [];
      document.getElementById('archiveResultCount').textContent = tr(archives.length === 1 ? 'board.result' : 'board.results', { count: archives.length });
      var list = document.getElementById('archiveList'); list.textContent = '';
      if (!archives.length) { var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('archives.empty'); list.appendChild(empty); return; }
      archives.forEach(function (entry) { list.appendChild(renderArchiveCard(entry)); });
    });
  }
`;
