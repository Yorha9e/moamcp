// Control Plane page fragment: Agents & Profiles view (memory section, agents tab).
// Extracted verbatim from control-plane-page.ts (Step C physical split).
// The assembled CONTROL_PLANE_HTML must stay byte-identical: do not reorder,
// re-indent, or "clean up" these fragments; no innerHTML, no new i18n keys.

export const AGENTS_VIEW_HTML = `  <section id="agentsView" class="view" role="tabpanel" hidden>
    <div class="toolbar">
      <span class="section-intro" data-i18n="agent.summary">Agent profiles</span>
      <button id="refreshAgents" class="secondary" type="button" data-i18n="agent.refresh">Refresh Agents</button>
      <button id="newAgent" class="primary" type="button" data-i18n="agent.new">+ New Agent</button>
      <span id="agentResultCount" class="result-count" role="status">0</span>
    </div>
    <p class="section-intro" data-i18n="agent.intro">Manage project-local Agent Markdown and local.toml bindings. Changes are written atomically to disk; the running Session adopts them only after /reload.</p>
    <div id="agentReloadBanner" class="agent-banner" role="status" hidden>
      <span id="agentReloadText" data-i18n="agent.reloadBanner">Saved to disk. The current Session has not adopted this change yet; after the running turn finishes, run /reload. Multiple Sessions must each run /reload.</span>
      <button id="copyAgentReload" class="secondary" type="button" data-i18n="agent.copyReload">Copy /reload</button>
    </div>
    <div class="agent-layout">
      <aside class="management-card">
        <div class="agent-binding-head"><h2 data-i18n="agent.summary">Agent profiles</h2></div>
        <div id="agentList" class="agent-list"></div>
      </aside>
      <section id="agentEditor" class="agent-editor">
        <div id="agentEditorEmpty" class="empty" data-i18n="agent.select">Select an Agent to load its Markdown.</div>
        <form id="agentForm" hidden>
          <div class="agent-editor-head"><h2 id="agentEditorTitle">Agent</h2></div>
          <div class="form-grid">
            <div class="field"><label for="agentName" data-i18n="agent.name">Name *</label><input id="agentName" required type="text" autocomplete="off"></div>
            <div class="field"><label data-i18n="agent.markdown">Agent Markdown</label><span id="agentFileName" class="agent-hash"></span></div>
            <div class="field full"><label for="agentMarkdown" data-i18n="agent.markdown">Agent Markdown</label><textarea id="agentMarkdown" required spellcheck="false"></textarea></div>
          </div>
          <div id="agentMeta" class="details agent-details"></div>
          <div id="agentFormError" class="form-error" role="alert"></div>
          <button id="agentLoadLatest" class="secondary" type="button" hidden data-i18n="agent.reloadLatest">Load latest version</button>
          <div class="form-actions"><button id="saveAgent" class="primary" type="submit" data-i18n="agent.save">Save Agent</button><button id="deleteAgent" class="danger" type="button" data-i18n="agent.delete">Delete Agent</button><button id="useAgentTemplate" class="secondary" type="button" data-i18n="agent.template">Use template</button></div>
        </form>
        <div id="agentConfigPanel" hidden>
          <section class="agent-binding-section">
            <div class="agent-binding-head"><h3 data-i18n="agent.bindings">Per-type bindings</h3><button id="addTypeBinding" class="secondary" type="button" data-i18n="agent.addBinding">Add binding</button></div>
            <div id="typeBindingsList" class="agent-binding-list"></div>
          </section>
          <section class="agent-binding-section">
            <div class="agent-binding-head"><h3 data-i18n="agent.slots">Named slots</h3><button id="addSlotBinding" class="secondary" type="button" data-i18n="agent.addBinding">Add binding</button></div>
            <div id="slotBindingsList" class="agent-binding-list"></div>
          </section>
          <div class="form-actions"><button id="saveAgentBindings" class="primary" type="button" data-i18n="agent.saveBindings">Save bindings</button><span id="agentBindingHash" class="agent-hash"></span></div>
          <details id="agentRawDetails" class="agent-raw-section">
            <summary data-i18n="agent.rawTitle">Raw local.toml</summary>
            <p class="section-intro" data-i18n="agent.rawHint">Complex TOML layouts are not rewritten by the structured editor. Use this validated raw editor instead.</p>
            <div class="agent-raw-actions"><button id="loadAgentRaw" class="secondary" type="button" data-i18n="agent.loadRaw">Load local.toml</button><button id="saveAgentRaw" class="primary" type="button" data-i18n="agent.saveRaw">Save local.toml</button><span id="agentLayoutNote" class="agent-layout-note"></span></div>
            <div class="field"><label for="agentRawToml" data-i18n="agent.rawEditor">local.toml source</label><textarea id="agentRawToml" spellcheck="false"></textarea></div>
            <div id="agentRawError" class="form-error" role="alert"></div>
          </details>
        </div>
      </section>
    </div>
  </section>
`;

export const AGENTS_PAGE_JS = `  function setAgentFormError(message) { document.getElementById('agentFormError').textContent = message || ''; }
  function setAgentRawError(message) { document.getElementById('agentRawError').textContent = message || ''; }
  function showAgentReloadBanner() { agentReloadBanner.hidden = false; }
  function hideAgentLatest() { document.getElementById('agentLoadLatest').hidden = true; }
  function agentRequest(path) { return path + '?workspace=' + encodeURIComponent(currentWorkspace); }
  function renderAgentMeta(agent) {
    var box = document.getElementById('agentMeta'); box.textContent = '';
    if (!agent) return;
    addDetailRow(box, tr('agent.file'), agent.fileName);
    addDetailRow(box, tr('agent.description'), agent.description || '—');
    addDetailRow(box, tr('agent.slot'), agent.slot || '—');
    addDetailRow(box, tr('agent.hash'), agent.hash);
    addDetailRow(box, tr('agent.size'), valueText(agent.size) + ' B');
    addDetailRow(box, tr('agent.valid'), agent.valid ? tr('agent.valid') : tr('agent.invalid'));
  }
  function renderAgentList(agents) {
    agentList.textContent = '';
    var rows = Array.isArray(agents) ? agents : [];
    document.getElementById('agentResultCount').textContent = String(rows.length);
    if (!rows.length) { var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('agent.noAgents'); agentList.appendChild(empty); return; }
    rows.forEach(function (agent) {
      var row = document.createElement('button'); row.type = 'button'; row.className = 'agent-row' + (agent.name === selectedAgentName && !agentIsNew ? ' selected' : '');
      var head = document.createElement('div'); head.className = 'agent-row-head';
      var name = document.createElement('strong'); name.textContent = agent.name; head.appendChild(name);
      var state = document.createElement('span'); state.className = agent.valid ? 'status st-implemented' : 'status st-discarded'; state.textContent = agent.valid ? tr('agent.valid') : tr('agent.invalid'); head.appendChild(state);
      row.appendChild(head);
      var meta = document.createElement('div'); meta.className = 'agent-row-meta'; meta.textContent = (agent.description || agent.fileName) + ' · ' + valueText(agent.size) + ' B'; row.appendChild(meta);
      if (agent.error) { var error = document.createElement('div'); error.className = 'agent-row-error'; error.textContent = agent.error; row.appendChild(error); }
      row.addEventListener('click', function () { loadAgentDetail(agent.name).catch(function (error) { setNotice(tr('agent.error') + error.message, true); }); });
      agentList.appendChild(row);
    });
  }
  function renderAgentLayoutNote() {
    var note = document.getElementById('agentLayoutNote');
    if (!agentSnapshot) { note.textContent = ''; return; }
    note.textContent = tr('agent.layout') + ': ' + (agentSnapshot.layout === 'standard' ? tr('agent.layoutStandard') : tr('agent.layoutComplex'));
  }
  function appendBindingOption(select, value, label) {
    var option = document.createElement('option'); option.value = value; option.textContent = label; select.appendChild(option);
  }
  function appendAgentBindingRow(container, section, rowData) {
    var binding = rowData && rowData.binding ? rowData.binding : {};
    var row = document.createElement('div'); row.className = 'agent-binding-row'; row.dataset.section = section;
    if (rowData && rowData.name) row.dataset.originalName = rowData.name;
    function textField(labelKey, field, value, readOnly) {
      var wrapper = document.createElement('div'); wrapper.className = 'field';
      var label = document.createElement('label'); label.textContent = tr(labelKey); wrapper.appendChild(label);
      var input = document.createElement('input'); input.type = 'text'; input.value = value == null ? '' : String(value); input.dataset.bindingField = field;
      if (readOnly) input.readOnly = true;
      wrapper.appendChild(input); row.appendChild(wrapper);
    }
    textField('agent.bindingName', 'name', rowData ? rowData.name : '', !!(rowData && rowData.name));
    textField('agent.model', 'model', binding.model);
    textField('agent.thinking', 'thinking_effort', binding.thinking_effort);
    var inheritWrapper = document.createElement('div'); inheritWrapper.className = 'field';
    var inheritLabel = document.createElement('label'); inheritLabel.textContent = tr('agent.inherit'); inheritWrapper.appendChild(inheritLabel);
    var inherit = document.createElement('select'); inherit.dataset.bindingField = 'inherit';
    appendBindingOption(inherit, 'unset', tr('agent.unset')); appendBindingOption(inherit, 'true', 'true'); appendBindingOption(inherit, 'false', 'false');
    inherit.value = binding.inherit === true ? 'true' : binding.inherit === false ? 'false' : 'unset'; inheritWrapper.appendChild(inherit); row.appendChild(inheritWrapper);
    var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger remove-binding'; remove.textContent = tr('common.delete');
    remove.addEventListener('click', function () {
      if (row.dataset.originalName) {
        deletedBindings.push({ section: section, name: row.dataset.originalName, binding: null });
      }
      row.remove();
    });
    row.appendChild(remove);
    container.appendChild(row);
  }
  function renderAgentBindingList(id, section, rows) {
    var container = document.getElementById(id); container.textContent = '';
    var list = Array.isArray(rows) ? rows : [];
    if (!list.length) { var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('agent.noBindings'); container.appendChild(empty); return; }
    list.forEach(function (row) { appendAgentBindingRow(container, section, row); });
  }
  function updateBindingRowTranslations() {
    document.getElementById('agentBindingHash').textContent = tr('agent.hash') + ': ' + (agentLocalHash || '—');
    renderAgentLayoutNote();
    var rows = document.querySelectorAll('.agent-binding-row');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var fields = row.querySelectorAll('.field');
      for (var j = 0; j < fields.length; j++) {
        var wrapper = fields[j];
        var input = wrapper.querySelector('input, select');
        var label = wrapper.querySelector('label');
        if (!input || !label) continue;
        var fieldName = input.dataset.bindingField;
        if (fieldName === 'name') label.textContent = tr('agent.bindingName');
        else if (fieldName === 'model') label.textContent = tr('agent.model');
        else if (fieldName === 'thinking_effort') label.textContent = tr('agent.thinking');
        else if (fieldName === 'inherit') {
          label.textContent = tr('agent.inherit');
          var unsetOption = input.querySelector('option[value="unset"]');
          if (unsetOption) unsetOption.textContent = tr('agent.unset');
        }
      }
      var removeBtn = row.querySelector('.remove-binding');
      if (removeBtn) removeBtn.textContent = tr('common.delete');
    }
    ['typeBindingsList', 'slotBindingsList'].forEach(function (id) {
      var emptyEl = document.getElementById(id).querySelector('.empty');
      if (emptyEl) emptyEl.textContent = tr('agent.noBindings');
    });
  }
  function renderAgentBindings() {
    deletedBindings = [];
    var bindings = agentSnapshot && agentSnapshot.bindings ? agentSnapshot.bindings : {};
    renderAgentBindingList('typeBindingsList', 'subagent', bindings.types || (agentSnapshot && agentSnapshot.typeBindings) || []);
    renderAgentBindingList('slotBindingsList', 'subagent-slot', bindings.slots || (agentSnapshot && agentSnapshot.slotBindings) || []);
    document.getElementById('agentBindingHash').textContent = tr('agent.hash') + ': ' + (agentLocalHash || '—');
    renderAgentLayoutNote();
  }
  function clearAgentEditor() {
    selectedAgentName = ''; selectedAgent = null; agentIsNew = false; agentRawLoaded = false;
    agentEditorEmpty.hidden = false; agentForm.hidden = true; agentConfigPanel.hidden = !currentWorkspace;
    document.getElementById('agentMeta').textContent = ''; document.getElementById('agentFormError').textContent = '';
    document.getElementById('agentRawError').textContent = ''; hideAgentLatest();
  }
  function showAgentEditor(agent, isNew) {
    agentIsNew = isNew; agentEditorEmpty.hidden = true; agentForm.hidden = false; agentConfigPanel.hidden = !currentWorkspace;
    document.getElementById('agentEditorTitle').textContent = isNew ? tr('agent.new') : agent.name;
    var name = document.getElementById('agentName'); name.value = isNew ? '' : agent.name; name.readOnly = !isNew;
    document.getElementById('agentFileName').textContent = isNew ? '' : agent.fileName;
    document.getElementById('agentMarkdown').value = isNew ? '' : agent.content;
    document.getElementById('deleteAgent').disabled = isNew;
    document.getElementById('agentFormError').textContent = (!isNew && agent && !agent.valid && agent.error) ? agent.error : ''; setAgentRawError(''); hideAgentLatest();
    renderAgentMeta(agent);
  }
  function loadAgentDetail(name) {
    if (!currentWorkspace) return Promise.resolve();
    return api(agentRequest('/api/agent-config/agents/' + encodeURIComponent(name))).then(function (data) {
      selectedAgentName = name; selectedAgent = data.agent; agentIsNew = false; agentRawLoaded = false;
      showAgentEditor(selectedAgent, false); renderAgentList(agentSnapshot && agentSnapshot.agents);
    });
  }
  function loadAgentSummary(refreshDetail) {
    if (!currentWorkspace) { clearAgentEditor(); return Promise.resolve(); }
    var previousName = selectedAgentName;
    var previousNew = agentIsNew;
    return api(agentRequest('/api/agent-config')).then(function (data) {
      agentSnapshot = data; agentLocalHash = data.localToml ? data.localToml.hash : null;
      renderAgentList(data.agents); renderAgentBindings();
      if (refreshDetail !== false && previousName && !previousNew) return loadAgentDetail(previousName);
      if (!previousName && !previousNew) clearAgentEditor();
      if (selectedAgent && !agentIsNew) renderAgentMeta(selectedAgent);
      return undefined;
    });
  }
  function openNewAgent() {
    selectedAgentName = ''; selectedAgent = null; agentIsNew = true; showAgentEditor(null, true);
    document.getElementById('useAgentTemplate').click();
  }
  function useAgentTemplate() {
    var newline = String.fromCharCode(10);
    var name = document.getElementById('agentName').value.trim() || 'new-agent';
    document.getElementById('agentName').value = name;
    document.getElementById('agentMarkdown').value = '---' + newline + 'name: ' + name + newline + 'description: ' + newline + '---' + newline + newline + 'Describe this Agent\\'s role and constraints here.' + newline;
  }
  function showAgentConflict(error, target) {
    var message = tr('agent.conflict') + (error.currentHash ? ' ' + tr('agent.hash') + ': ' + error.currentHash : '');
    if (target === 'raw') setAgentRawError(message); else setAgentFormError(message);
    document.getElementById('agentLoadLatest').hidden = false;
  }
  function saveAgent(event) {
    event.preventDefault(); setAgentFormError('');
    var name = document.getElementById('agentName').value.trim();
    var content = document.getElementById('agentMarkdown').value;
    if (!name || !content) { setAgentFormError(tr('agent.error') + 'name and Markdown are required'); return; }
    var expectedHash = agentIsNew ? null : (selectedAgent && selectedAgent.hash);
    api('/api/agent-config/agents/' + encodeURIComponent(name), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: currentWorkspace, content: content, expectedHash: expectedHash || null }) }).then(function () {
      selectedAgentName = name; agentIsNew = false; showAgentReloadBanner(); return loadAgentSummary();
    }).catch(function (error) { if (error.status === 409) showAgentConflict(error, 'agent'); else setAgentFormError(tr('agent.error') + error.message); });
  }
  function reloadAgentLatest() {
    var rawWasLoaded = agentRawLoaded;
    hideAgentLatest(); setAgentFormError(''); setAgentRawError('');
    loadAgentSummary().then(function () { if (rawWasLoaded) return loadAgentRaw(); return undefined; }).then(function () { setAgentFormError(tr('agent.reloaded')); }).catch(function (error) { setAgentFormError(tr('agent.error') + error.message); });
  }
  function deleteAgent() {
    if (agentIsNew || !selectedAgent) return;
    if (!window.confirm(tr('agent.deleteConfirm', { name: selectedAgent.name }))) return;
    api('/api/agent-config/agents/' + encodeURIComponent(selectedAgent.name), { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: currentWorkspace, expectedHash: selectedAgent.hash }) }).then(function () {
      clearAgentEditor(); showAgentReloadBanner(); return loadAgentSummary();
    }).catch(function (error) { if (error.status === 409) showAgentConflict(error, 'agent'); else setAgentFormError(tr('agent.error') + error.message); });
  }
  function collectAgentBindings(section) {
    var id = section === 'subagent' ? 'typeBindingsList' : 'slotBindingsList';
    var nodes = document.getElementById(id).querySelectorAll('.agent-binding-row');
    var rows = []; var names = new Set();
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index]; var nameInput = node.querySelector('[data-binding-field="name"]'); var name = nameInput.value.trim();
      if (!name) throw new Error(tr('agent.error') + tr('agent.bindingName'));
      if (names.has(name)) throw new Error(tr('agent.error') + 'duplicate ' + name);
      names.add(name);
      var modelInput = node.querySelector('[data-binding-field="model"]'); var thinkingInput = node.querySelector('[data-binding-field="thinking_effort"]'); var inheritInput = node.querySelector('[data-binding-field="inherit"]');
      var binding = { model: modelInput.value.trim() || null, thinking_effort: thinkingInput.value.trim() || null, inherit: inheritInput.value === 'unset' ? null : inheritInput.value === 'true' };
      rows.push({ section: section, name: name, binding: binding });
    }
    return rows;
  }
  function saveAgentBindings() {
    if (!currentWorkspace) return;
    setAgentFormError(''); setAgentRawError('');
    var activeRows;
    try { activeRows = collectAgentBindings('subagent').concat(collectAgentBindings('subagent-slot')); } catch (error) { setAgentFormError(error.message); return; }
    var activeSet = new Set();
    activeRows.forEach(function (r) { activeSet.add(r.section + ':' + r.name); });
    var changes = deletedBindings.filter(function (d) { return !activeSet.has(d.section + ':' + d.name); }).concat(activeRows);
    if (!changes.length) { setAgentFormError(tr('agent.noBindings')); return; }
    api('/api/agent-config/bindings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: currentWorkspace, changes: changes, expectedHash: agentLocalHash })
    }).then(function (data) {
      agentLocalHash = data.hash || (data.bindings && data.bindings.hash);
      if (agentSnapshot && agentSnapshot.localToml) agentSnapshot.localToml.hash = agentLocalHash;
      deletedBindings = [];
      return loadAgentSummary(false);
    }).then(function () {
      showAgentReloadBanner();
    }).catch(function (error) {
      if (error.status === 409) showAgentConflict(error, 'agent');
      else setAgentFormError(tr('agent.error') + error.message);
    });
  }
  function loadAgentRaw() {
    if (!currentWorkspace) return Promise.resolve();
    return api(agentRequest('/api/agent-config/local-toml')).then(function (data) {
      var local = data.localToml; document.getElementById('agentRawToml').value = local.content || ''; agentLocalHash = local.hash; agentRawLoaded = true;
      if (agentSnapshot && agentSnapshot.localToml) { agentSnapshot.localToml.hash = local.hash; agentSnapshot.localToml.size = local.size; }
      renderAgentLayoutNote(); document.getElementById('agentBindingHash').textContent = tr('agent.hash') + ': ' + (agentLocalHash || '—'); setAgentRawError('');
    });
  }
  function saveAgentRaw() {
    if (!currentWorkspace) return;
    setAgentRawError('');
    var content = document.getElementById('agentRawToml').value;
    api('/api/agent-config/local-toml', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: currentWorkspace, content: content, expectedHash: agentLocalHash }) }).then(function (data) {
      agentLocalHash = data.localToml.hash; agentRawLoaded = true; showAgentReloadBanner(); return loadAgentSummary(false);
    }).catch(function (error) { if (error.status === 409) showAgentConflict(error, 'raw'); else setAgentRawError(tr('agent.error') + error.message); });
  }
`;
