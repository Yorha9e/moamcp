// Control Plane page fragment: Project Tips view (memory section, tips tab).
// Extracted verbatim from control-plane-page.ts (Step C physical split).
// The assembled CONTROL_PLANE_HTML must stay byte-identical: do not reorder,
// re-indent, or "clean up" these fragments; no innerHTML, no new i18n keys.

export const TIPS_VIEW_HTML = `  <section id="tipsView" class="view" role="tabpanel">
    <div class="toolbar">
      <div class="field"><label for="statusFilter" data-i18n="common.status">Status</label><select id="statusFilter"><option value="" data-i18n="common.allStatuses">All statuses</option><option value="captured">captured</option><option value="exploring">exploring</option><option value="planned">planned</option><option value="implemented">implemented</option><option value="deferred">deferred</option><option value="discarded">discarded</option><option value="archived">archived</option></select></div>
      <div class="field"><label for="moduleFilter" data-i18n="common.module">Module</label><input id="moduleFilter" type="text" placeholder="module" data-i18n-placeholder="common.module"></div>
      <div class="field"><label for="tagFilter" data-i18n="common.tag">Tag</label><input id="tagFilter" type="text" placeholder="tag" data-i18n-placeholder="common.tag"></div>
      <label class="check"><input id="archivedFilter" type="checkbox"> <span data-i18n="memory.includeArchived">Include archived</span></label>
      <div class="field"><label for="tipLimit" data-i18n="common.limit">Limit</label><input id="tipLimit" type="number" min="1" max="1000" value="100"></div>
      <button id="newTip" class="primary" type="button" data-i18n="tips.new">+ New Tip</button>
    </div>
    <div class="tip-layout">
      <div id="tipList" class="list"></div>
      <aside id="tipDrawer" class="drawer" hidden></aside>
      <form id="tipForm" class="form-card" hidden>
        <h2 id="formTitle">New Tip</h2>
        <div class="form-grid">
          <div class="field"><label for="tipTitle" data-i18n="tips.title">Title *</label><input id="tipTitle" required type="text"></div>
          <div class="field"><label for="tipStatus" data-i18n="common.status">Status</label><select id="tipStatus"><option value="captured">captured</option><option value="exploring">exploring</option><option value="planned">planned</option><option value="implemented">implemented</option><option value="deferred">deferred</option><option value="discarded">discarded</option><option value="archived">archived</option></select></div>
          <div class="field full"><label for="tipSummary" data-i18n="tips.summary">Summary *</label><textarea id="tipSummary" required></textarea></div>
          <div class="field full"><label for="tipContext" data-i18n="tips.context">Context</label><textarea id="tipContext"></textarea></div>
          <div class="field"><label for="tipModule" data-i18n="common.module">Module</label><input id="tipModule" type="text"></div>
          <div class="field"><label for="tipNextAction" data-i18n="tips.nextAction">Next action</label><input id="tipNextAction" type="text"></div>
          <div class="field"><label for="tipTags" data-i18n="tips.tags">Tags · comma or newline separated</label><textarea id="tipTags"></textarea></div>
          <div class="field"><label for="tipSourceRefs" data-i18n="tips.sourceRefs">Source refs · comma or newline separated</label><textarea id="tipSourceRefs"></textarea></div>
          <div class="field"><label for="tipRelatedTipIds" data-i18n="tips.relatedTipIds">Related Tip IDs · comma or newline separated</label><textarea id="tipRelatedTipIds"></textarea></div>
          <div class="field"><label for="tipRelatedProjects" data-i18n="tips.relatedProjects">Related projects · comma or newline separated</label><textarea id="tipRelatedProjects"></textarea></div>
          <div class="field"><label for="tipSourceSessionId" data-i18n="tips.sourceSessionId">Source session ID</label><input id="tipSourceSessionId" type="text"></div>
          <div class="field"><label for="tipAuthor" data-i18n="tips.authorCreate">Author · create only</label><input id="tipAuthor" type="text"></div>
          <div class="field full"><label for="tipDocumentRefs" data-i18n="tips.documentRefs">Document refs · safe JSON array</label><textarea id="tipDocumentRefs" placeholder='[{"path":"docs/example.md","section":"Overview"}]'></textarea></div>
        </div>
        <div id="formError" class="form-error" role="alert"></div>
        <div class="form-actions"><button class="primary" type="submit" data-i18n="tips.save">Save Tip</button><button id="cancelForm" class="secondary" type="button" data-i18n="common.cancel">Cancel</button></div>
      </form>
    </div>
  </section>
`;

export const TIPS_PAGE_JS = `  function tipQuery() {
    var query = new URLSearchParams();
    query.set('workspace', currentWorkspace);
    var status = document.getElementById('statusFilter').value;
    var moduleName = document.getElementById('moduleFilter').value.trim();
    var tag = document.getElementById('tagFilter').value.trim();
    var limit = document.getElementById('tipLimit').value;
    if (status) query.set('status', status);
    if (moduleName) query.set('module', moduleName);
    if (tag) query.set('tag', tag);
    if (document.getElementById('archivedFilter').checked) query.set('includeArchived', 'true');
    if (limit) query.set('limit', limit);
    return query.toString();
  }
  function renderTipCard(tip) {
    var article = document.createElement('article');
    article.className = 'tip-card';
    var head = document.createElement('div');
    head.className = 'tip-head';
    var title = document.createElement('button');
    title.className = 'tip-title';
    title.type = 'button';
    title.textContent = tip.title || tip.id;
    title.addEventListener('click', function () { showTip(tip.id); });
    var status = document.createElement('span');
    status.className = 'status st-' + (tip.status || 'captured');
    status.textContent = tip.status || '—';
    head.appendChild(title);
    head.appendChild(status);
    article.appendChild(head);
    var summary = document.createElement('div');
    summary.className = 'tip-summary';
    summary.textContent = tip.summary || '';
    article.appendChild(summary);
    var meta = document.createElement('div');
    meta.className = 'tip-meta';
    if (tip.module) { var module = document.createElement('span'); module.textContent = tip.module; meta.appendChild(module); }
    (tip.tags || []).forEach(function (tag) { var chip = document.createElement('span'); chip.className = 'tag'; chip.textContent = '#' + tag; meta.appendChild(chip); });
    var updated = document.createElement('span');
    updated.textContent = tip.updatedAt || '';
    meta.appendChild(updated);
    article.appendChild(meta);
    var actions = document.createElement('div');
    actions.className = 'tip-actions';
    var details = document.createElement('button');
    details.className = 'secondary'; details.type = 'button'; details.textContent = tr('common.details');
    details.addEventListener('click', function () { showTip(tip.id); });
    actions.appendChild(details);
    if (tip.status !== 'archived') {
      var archive = document.createElement('button');
      archive.className = 'danger'; archive.type = 'button'; archive.textContent = tr('common.archive');
      archive.addEventListener('click', function () { archiveTip(tip.id); });
      actions.appendChild(archive);
    }
    article.appendChild(actions);
    return article;
  }
  function renderTipList(tips) {
    tipList.textContent = '';
    if (!tips.length) { var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('tips.empty'); tipList.appendChild(empty); return; }
    tips.forEach(function (tip) { tipList.appendChild(renderTipCard(tip)); });
  }
  function loadTips() {
    if (!currentWorkspace) return Promise.resolve();
    return api('/api/tips?' + tipQuery()).then(function (data) {
      renderTipList(data && Array.isArray(data.tips) ? data.tips : []);
    });
  }
  function addDetailRow(box, label, value, code) {
    var dt = document.createElement('dt'); dt.textContent = label;
    var dd = document.createElement('dd'); if (code) dd.className = 'code'; dd.textContent = valueText(value);
    box.appendChild(dt); box.appendChild(dd);
  }
  function renderDrawer(tip) {
    tipDrawer.textContent = '';
    var head = document.createElement('div'); head.className = 'drawer-head';
    var title = document.createElement('h2'); title.textContent = tip.title || tip.id;
    var close = document.createElement('button'); close.className = 'close'; close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', tr('common.closeDetails'));
    close.addEventListener('click', function () { tipDrawer.hidden = true; });
    head.appendChild(title); head.appendChild(close); tipDrawer.appendChild(head);
    var details = document.createElement('dl'); details.className = 'details';
    ['id', 'status', 'summary', 'context', 'module', 'tags', 'nextAction', 'documentRefs', 'sourceRefs', 'relatedTipIds', 'relatedProjects', 'sourceSessionId', 'author', 'createdAt', 'updatedAt'].forEach(function (field) {
      if (tip[field] !== undefined) addDetailRow(details, field, tip[field], field === 'documentRefs' || field === 'context');
    });
    tipDrawer.appendChild(details);
    var actions = document.createElement('div'); actions.className = 'tip-actions';
    var edit = document.createElement('button'); edit.className = 'primary'; edit.type = 'button'; edit.textContent = tr('common.edit'); edit.addEventListener('click', function () { openTipForm(tip); }); actions.appendChild(edit);
    var raw = document.createElement('button'); raw.className = 'secondary'; raw.type = 'button'; raw.textContent = tr('tips.boardLink', { id: tip.id }); raw.addEventListener('click', function () { openTipBoardEntry(tip.id); }); actions.appendChild(raw);
    if (tip.status !== 'archived') { var archive = document.createElement('button'); archive.className = 'danger'; archive.type = 'button'; archive.textContent = tr('common.archive'); archive.addEventListener('click', function () { archiveTip(tip.id); }); actions.appendChild(archive); }
    tipDrawer.appendChild(actions);
    tipDrawer.hidden = false;
  }
  function showTip(id) {
    if (!currentWorkspace) return Promise.resolve();
    return api('/api/tips/' + encodeURIComponent(id) + '?workspace=' + encodeURIComponent(currentWorkspace)).then(function (tip) {
      selectedTip = tip; renderDrawer(tip);
    }).catch(function (error) { setNotice(error.message, true); });
  }
  function setField(id, value) { document.getElementById(id).value = value == null ? '' : String(value); }
  function openTipForm(tip) {
    editingId = tip ? tip.id : '';
    document.getElementById('formTitle').textContent = tr(editingId ? 'tips.edit' : 'tips.new').replace(/^\\+\\s*/, '');
    setField('tipTitle', tip && tip.title); setField('tipSummary', tip && tip.summary); setField('tipStatus', (tip && tip.status) || 'captured');
    setField('tipContext', tip && tip.context); setField('tipModule', tip && tip.module); setField('tipNextAction', tip && tip.nextAction);
    setField('tipTags', tip && tip.tags ? tip.tags.join('\\n') : ''); setField('tipSourceRefs', tip && tip.sourceRefs ? tip.sourceRefs.join('\\n') : '');
    setField('tipRelatedTipIds', tip && tip.relatedTipIds ? tip.relatedTipIds.join('\\n') : ''); setField('tipRelatedProjects', tip && tip.relatedProjects ? tip.relatedProjects.join('\\n') : '');
    setField('tipSourceSessionId', tip && tip.sourceSessionId); setField('tipAuthor', tip && tip.author);
    setField('tipDocumentRefs', tip && tip.documentRefs ? JSON.stringify(tip.documentRefs, null, 2) : '');
    setFormError(''); tipForm.hidden = false; tipForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeTipForm() { editingId = ''; tipForm.hidden = true; setFormError(''); }
  function buildTipPayload() {
    var refs = parseDocumentRefs();
    var payload = { workspace: currentWorkspace, title: document.getElementById('tipTitle').value.trim(), summary: document.getElementById('tipSummary').value.trim(), status: document.getElementById('tipStatus').value };
    if (!payload.title || !payload.summary) throw new Error(tr('tips.required'));
    if (editingId) {
      payload.context = optionalText('tipContext'); payload.module = optionalText('tipModule'); payload.nextAction = optionalText('tipNextAction');
      payload.tags = splitArray('tipTags').length ? splitArray('tipTags') : null;
      payload.sourceRefs = splitArray('tipSourceRefs').length ? splitArray('tipSourceRefs') : null;
      payload.relatedTipIds = splitArray('tipRelatedTipIds').length ? splitArray('tipRelatedTipIds') : null;
      payload.relatedProjects = splitArray('tipRelatedProjects').length ? splitArray('tipRelatedProjects') : null;
      payload.sourceSessionId = optionalText('tipSourceSessionId'); payload.documentRefs = refs;
    } else {
      var context = optionalText('tipContext'); var moduleName = optionalText('tipModule'); var nextAction = optionalText('tipNextAction');
      if (context) payload.context = context; if (moduleName) payload.module = moduleName; if (nextAction) payload.nextAction = nextAction;
      var tags = splitArray('tipTags'); var sourceRefs = splitArray('tipSourceRefs'); var relatedTipIds = splitArray('tipRelatedTipIds'); var relatedProjects = splitArray('tipRelatedProjects');
      if (tags.length) payload.tags = tags; if (sourceRefs.length) payload.sourceRefs = sourceRefs; if (relatedTipIds.length) payload.relatedTipIds = relatedTipIds; if (relatedProjects.length) payload.relatedProjects = relatedProjects;
      var sourceSessionId = optionalText('tipSourceSessionId'); var author = optionalText('tipAuthor');
      if (sourceSessionId) payload.sourceSessionId = sourceSessionId; if (author) payload.author = author; if (refs !== null) payload.documentRefs = refs;
    }
    return payload;
  }
  tipForm.addEventListener('submit', function (event) {
    event.preventDefault(); setFormError('');
    var payload;
    try { payload = buildTipPayload(); } catch (error) { setFormError(error.message); return; }
    var method = editingId ? 'PATCH' : 'POST';
    var url = editingId ? '/api/tips/' + encodeURIComponent(editingId) : '/api/tips';
    api(url, { method: method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then(function (tip) {
      selectedTip = tip; closeTipForm(); renderDrawer(tip); return loadTips();
    }).catch(function (error) { setFormError(error.message); });
  });
  function archiveTip(id) {
    if (!currentWorkspace || !window.confirm(tr('tips.archiveConfirm'))) return;
    api('/api/tips/' + encodeURIComponent(id) + '/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: currentWorkspace }) }).then(function (tip) {
      selectedTip = tip; renderDrawer(tip); return loadTips();
    }).catch(function (error) { setNotice(error.message, true); });
  }
`;
