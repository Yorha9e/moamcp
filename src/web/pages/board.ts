// Control Plane page fragment: Shared Board view + entry modal (memory section, board tab).
// Extracted verbatim from control-plane-page.ts (Step C physical split).
// The assembled CONTROL_PLANE_HTML must stay byte-identical: do not reorder,
// re-indent, or "clean up" these fragments; no innerHTML, no new i18n keys.

export const BOARD_VIEW_HTML = `  <section id="boardView" class="view" role="tabpanel" hidden>
    <div class="board-toolbar">
      <div class="field"><label for="boardScope" data-i18n="board.scope">Scope</label><select id="boardScope"><option value="workspace">workspace</option><option value="global">global</option></select></div>
      <div class="field wide"><label for="boardKey" data-i18n="board.keySearch">Key namespace / key</label><input id="boardKey" type="search" placeholder="key namespace / key" data-i18n-placeholder="board.keySearch"></div>
      <div class="field"><label for="boardTag" data-i18n="common.tag">Tag</label><input id="boardTag" type="search" placeholder="tag" data-i18n-placeholder="common.tag"></div>
      <div class="field"><label for="boardSort" data-i18n="board.sort">Sort</label><select id="boardSort"><option value="updated-desc" data-i18n="board.updatedDesc">Recently updated</option><option value="updated-asc" data-i18n="board.updatedAsc">Oldest updated</option><option value="key-asc" data-i18n="board.keyAsc">key A–Z</option><option value="key-desc" data-i18n="board.keyDesc">key Z–A</option></select></div>
      <div class="field"><label for="boardLimit" data-i18n="common.limit">Limit</label><input id="boardLimit" type="number" min="1" max="1000" value="100"></div>
      <button id="refreshBoard" class="secondary" type="button" data-i18n="common.refresh">Refresh</button>
      <button id="newBoardEntry" class="primary" type="button" data-i18n="board.new">+ New Entry</button>
      <span id="boardResultCount" class="board-toolbar-status" role="status">0 results</span>
    </div>
    <div class="board-layout">
      <div id="boardList" class="board-list"></div>
      <aside id="boardDetail" class="board-detail"><div class="empty" data-i18n="board.select">Select a Board entry to view its full value.</div></aside>
    </div>
  </section>
`;

export const BOARD_MODAL_HTML = `<div id="boardModal" class="board-modal" role="dialog" aria-modal="true" aria-labelledby="boardFormTitle" hidden>
  <form id="boardForm" class="form-card board-form-card">
    <div class="board-form-head"><h2 id="boardFormTitle">New Board Entry</h2><button id="closeBoardForm" class="close" type="button" aria-label="Close Board form" data-i18n-aria="board.closeForm">×</button></div>
    <div class="form-grid">
      <div class="field"><label for="boardFormScope" data-i18n="board.scope">Scope *</label><select id="boardFormScope"><option value="workspace">workspace</option><option value="global">global</option></select></div>
      <div class="field"><label for="boardFormKey">key *</label><input id="boardFormKey" required type="text" autocomplete="off"></div>
      <div class="field full"><label for="boardFormValue" data-i18n="board.value">Markdown value</label><textarea id="boardFormValue"></textarea><div id="boardByteLine" class="byte-line"><span data-i18n="board.valueSize">UTF-8 value size</span><span id="boardValueBytes"></span></div></div>
      <div class="field"><label for="boardFormTags" data-i18n="tips.tags">Tags · comma or newline separated</label><textarea id="boardFormTags"></textarea></div>
      <div class="field"><label for="boardFormAuthor" data-i18n="board.author">Author</label><input id="boardFormAuthor" type="text"></div>
    </div>
    <div id="boardExternalWarning" class="external-warning" role="status" hidden data-i18n="board.external">Updated externally: your draft is preserved. Saving will confirm again and use the version stamp from when the form opened.</div>
    <div id="boardFormError" class="form-error" role="alert"></div>
    <button id="boardConflictReload" class="secondary" type="button" hidden data-i18n="board.reload">Reload current version</button>
    <div class="form-actions"><button id="saveBoardEntry" class="primary" type="submit" data-i18n="board.save">Save Entry</button><button id="cancelBoardForm" class="secondary" type="button" data-i18n="common.cancel">Cancel</button></div>
  </form>
</div>
`;

export const BOARD_LIST_JS = `  function boardQuery() {
    var query = new URLSearchParams();
    var scope = document.getElementById('boardScope').value;
    query.set('scope', scope);
    if (scope === 'workspace' && currentWorkspace) query.set('workspace', currentWorkspace);
    var key = document.getElementById('boardKey').value.trim();
    var tag = document.getElementById('boardTag').value.trim();
    var limit = document.getElementById('boardLimit').value;
    if (key) query.set('key', key);
    if (tag) query.set('tag', tag);
    if (limit) query.set('limit', limit);
    return query.toString();
  }
  function boardRequestBody(scope, workspace, key) {
    var payload = { scope: scope, key: key };
    if (scope === 'workspace') payload.workspace = workspace;
    return payload;
  }
  function sortBoardEntries(entries) {
    var mode = document.getElementById('boardSort').value;
    return entries.slice().sort(function (a, b) {
      if (mode === 'key-asc') return String(a.key).localeCompare(String(b.key));
      if (mode === 'key-desc') return String(b.key).localeCompare(String(a.key));
      var compared = String(a.ts).localeCompare(String(b.ts));
      return mode === 'updated-asc' ? compared : -compared;
    });
  }
  function copyBoardText(text, label) {
    var value = String(text == null ? '' : text);
    var copied = null;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') copied = navigator.clipboard.writeText(value);
    else {
      copied = new Promise(function (resolve, reject) {
        var area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'fixed'; area.style.opacity = '0';
        document.body.appendChild(area); area.select();
        try { if (!document.execCommand('copy')) throw new Error('copy unavailable'); resolve(); } catch (error) { reject(error); }
        document.body.removeChild(area);
      });
    }
    copied.then(function () { setNotice(tr('common.copied', { label: label }), false); }).catch(function () { setNotice(tr('common.copyFailed'), true); });
  }
  function openTipBoardEntry(id) {
    tipDrawer.hidden = true;
    document.getElementById('boardScope').value = 'workspace';
    document.getElementById('boardKey').value = 'tips/' + id;
    document.getElementById('boardTag').value = '';
    selectedBoardKey = 'tips/' + id;
    switchView('board');
  }
  function openTypedTipFromBoard(key) {
    if (key.indexOf('tips/') !== 0 || key.length <= 'tips/'.length) return;
    var id = key.slice('tips/'.length);
    switchView('tips');
    showTip(id);
  }
  function makeBoardAction(label, className, handler) {
    var button = document.createElement('button');
    button.type = 'button'; button.className = className; button.textContent = label;
    button.addEventListener('click', handler);
    return button;
  }
  function renderBoardDetail(entry) {
    var box = document.getElementById('boardDetail'); box.textContent = '';
    var heading = document.createElement('h2'); heading.textContent = entry ? entry.key : tr('memory.board'); box.appendChild(heading);
    if (!entry) { var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('board.select'); box.appendChild(empty); return; }
    var meta = document.createElement('div'); meta.className = 'tip-meta'; meta.textContent = valueText(entry.author) + ' · ' + valueText(entry.ts) + ' · ' + (entry.bytes == null ? utf8Bytes(entry.value || '') : entry.bytes) + ' B'; box.appendChild(meta);
    var tags = document.createElement('div'); tags.className = 'tip-meta'; tags.textContent = (entry.tags || []).map(function (tag) { return '#' + tag; }).join(' '); box.appendChild(tags);
    var actions = document.createElement('div'); actions.className = 'board-detail-actions';
    actions.appendChild(makeBoardAction(tr('common.edit'), 'primary', function () { openBoardForm(entry); }));
    actions.appendChild(makeBoardAction(tr('board.copyKey'), 'secondary', function () { copyBoardText(entry.key, 'key'); }));
    actions.appendChild(makeBoardAction(tr('board.copyValue'), 'secondary', function () { copyBoardText(entry.value, 'value'); }));
    if (entry.key.indexOf('tips/') === 0 && entry.key.length > 'tips/'.length) actions.appendChild(makeBoardAction(tr('board.backToTip'), 'secondary', function () { openTypedTipFromBoard(entry.key); }));
    actions.appendChild(makeBoardAction(tr('common.delete'), 'danger', function () { deleteBoardEntry(entry); }));
    box.appendChild(actions);
    var value = document.createElement('pre'); value.className = 'board-value'; value.textContent = entry.value || ''; box.appendChild(value);
  }
  function renderBoardDetailMissing(key) {
    // The exact-key fetch found no live entry (deleted, or shadowed by a
    // descendant key in namespace searches). Never render the summary row as
    // if it were the full entry — that would open an empty Edit form and let a
    // save overwrite the real value with an empty one. Show a not-found state
    // with Edit disabled instead.
    var box = document.getElementById('boardDetail'); box.textContent = '';
    var heading = document.createElement('h2'); heading.textContent = key; box.appendChild(heading);
    var actions = document.createElement('div'); actions.className = 'board-detail-actions';
    var edit = makeBoardAction(tr('common.edit'), 'primary', function () {});
    edit.disabled = true;
    actions.appendChild(edit);
    box.appendChild(actions);
    var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('board.missing'); box.appendChild(empty);
  }
  function renderBoardList(entries) {
    boardEntries = sortBoardEntries(entries || []);
    document.getElementById('boardResultCount').textContent = tr(boardEntries.length === 1 ? 'board.result' : 'board.results', { count: boardEntries.length });
    var list = document.getElementById('boardList'); list.textContent = '';
    if (!boardEntries.length) { selectedBoardKey = ''; var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('board.empty'); list.appendChild(empty); renderBoardDetail(null); return; }
    var selectedIndex = boardEntries.findIndex(function (entry) { return entry.key === selectedBoardKey; });
    if (selectedIndex < 0) selectedIndex = 0;
    selectedBoardKey = boardEntries[selectedIndex].key;
    boardEntries.forEach(function (entry, index) {
      var row = document.createElement('button'); row.type = 'button'; row.className = 'board-row' + (index === selectedIndex ? ' selected' : '');
      var key = document.createElement('span'); key.className = 'board-key'; key.textContent = entry.key;
      var author = document.createElement('span'); author.className = 'board-small'; author.textContent = entry.author || 'anonymous';
      var ts = document.createElement('span'); ts.className = 'board-small'; ts.textContent = entry.ts + ' · ' + entry.bytes + ' B';
      row.appendChild(key); row.appendChild(author); row.appendChild(ts);
      row.addEventListener('click', function () {
        selectedBoardKey = entry.key;
        var children = list.children;
        for (var i = 0; i < children.length; i++) children[i].classList.remove('selected');
        row.classList.add('selected');
        viewBoardEntry(entry);
      });
      list.appendChild(row);
    });
    viewBoardEntry(boardEntries[selectedIndex]);
  }
  function fetchBoardEntry(key) {
    var query = new URLSearchParams();
    var scope = document.getElementById('boardScope').value;
    query.set('scope', scope);
    if (scope === 'workspace' && currentWorkspace) query.set('workspace', currentWorkspace);
    query.set('key', key);
    query.set('exact', '1');
    query.set('limit', '1');
    query.set('values', '1');
    return api('/api/board?' + query.toString()).then(function (data) {
      var rows = data && Array.isArray(data.entries) ? data.entries : [];
      return rows.filter(function (entry) { return entry.key === key; })[0] || null;
    });
  }
  function viewBoardEntry(entry) {
    if (!entry) { renderBoardDetail(null); return; }
    // List rows come back in summary mode (metadata only, no value): fetch the
    // full entry by key before rendering the detail pane / edit form.
    if (entry.value != null) { renderBoardDetail(entry); return; }
    var box = document.getElementById('boardDetail');
    box.textContent = '';
    var loading = document.createElement('div'); loading.className = 'empty'; loading.textContent = '…';
    box.appendChild(loading);
    fetchBoardEntry(entry.key).then(function (full) {
      if (selectedBoardKey !== entry.key) return; // superseded by a newer selection
      if (full) renderBoardDetail(full);
      else renderBoardDetailMissing(entry.key);
    }).catch(function (error) { setNotice(error.message, true); });
  }
  function loadBoard() {
    var scope = document.getElementById('boardScope').value;
    if (scope === 'workspace' && !currentWorkspace) {
      renderBoardList([]);
      setNotice(tr('board.scopeNotice'), false);
      return Promise.resolve();
    }
    var list = document.getElementById('boardList');
    showListLoading(list);
    return api('/api/board?' + boardQuery()).then(function (data) { renderBoardList(data && Array.isArray(data.entries) ? data.entries : []); }).catch(function (error) { clearListLoading(list); throw error; });
  }
`;

export const BOARD_FORM_JS = `  function setBoardFormError(message) { boardFormError.textContent = message || ''; }
  function updateBoardValueBytes() {
    var bytes = utf8Bytes(document.getElementById('boardFormValue').value);
    document.getElementById('boardValueBytes').textContent = bytes + ' / ' + BOARD_VALUE_MAX_BYTES + ' bytes';
    document.getElementById('boardByteLine').className = 'byte-line' + (bytes > BOARD_VALUE_MAX_BYTES ? ' over-limit' : '');
    boardSaveButton.disabled = bytes > BOARD_VALUE_MAX_BYTES;
    return bytes;
  }
  function openBoardForm(entry) {
    var editing = !!entry;
    var scope = document.getElementById('boardScope').value;
    boardEditing = { mode: editing ? 'edit' : 'new', scope: scope, workspace: currentWorkspace, key: editing ? entry.key : '', expectedTs: editing ? entry.ts : null, external: false };
    document.getElementById('boardFormTitle').textContent = tr(editing ? 'board.editTitle' : 'board.newTitle');
    var scopeField = document.getElementById('boardFormScope'); scopeField.value = scope; scopeField.disabled = editing;
    var keyField = document.getElementById('boardFormKey'); keyField.value = editing ? entry.key : ''; keyField.readOnly = editing;
    document.getElementById('boardFormValue').value = editing ? (entry.value || '') : '';
    document.getElementById('boardFormTags').value = editing && entry.tags ? entry.tags.join('\\n') : '';
    document.getElementById('boardFormAuthor').value = editing ? (entry.author || '') : '';
    document.getElementById('boardExternalWarning').hidden = true;
    document.getElementById('boardConflictReload').hidden = true;
    setBoardFormError(''); updateBoardValueBytes(); boardModal.hidden = false;
    setTimeout(function () { (editing ? document.getElementById('boardFormValue') : keyField).focus(); }, 0);
  }
  function closeBoardForm() {
    boardEditing = null; boardModal.hidden = true; setBoardFormError('');
    document.getElementById('boardConflictReload').hidden = true;
  }
  function handleBoardEvent(event) {
    if (!boardEditing || boardEditing.mode !== 'edit') return;
    if (event.scope === boardEditing.scope && event.key === boardEditing.key && event.ts !== boardEditing.expectedTs) {
      boardEditing.external = true;
      document.getElementById('boardExternalWarning').hidden = false;
    }
  }
  function buildBoardPayload() {
    if (!boardEditing) throw new Error(tr('board.formClosed'));
    var scope = document.getElementById('boardFormScope').value;
    var key = document.getElementById('boardFormKey').value.trim();
    var value = document.getElementById('boardFormValue').value;
    if (!key) throw new Error(tr('board.keyRequired'));
    if (utf8Bytes(value) > BOARD_VALUE_MAX_BYTES) throw new Error(tr('board.tooLarge', { max: BOARD_VALUE_MAX_BYTES }));
    if (scope === 'workspace' && !boardEditing.workspace) throw new Error(tr('board.workspaceRequired'));
    var payload = boardRequestBody(scope, boardEditing.workspace, key);
    payload.value = value;
    payload.tags = splitArray('boardFormTags');
    var author = document.getElementById('boardFormAuthor').value.trim();
    if (author) payload.author = author;
    payload.expectedTs = boardEditing.mode === 'new' ? null : boardEditing.expectedTs;
    return payload;
  }
  function saveBoardEntry(event) {
    event.preventDefault(); setBoardFormError('');
    if (!boardEditing) return;
    if (updateBoardValueBytes() > BOARD_VALUE_MAX_BYTES) { setBoardFormError(tr('board.tooLarge', { max: BOARD_VALUE_MAX_BYTES })); return; }
    if (boardEditing.external && !window.confirm(tr('board.externalConfirm'))) return;
    var payload;
    try { payload = buildBoardPayload(); } catch (error) { setBoardFormError(error.message); return; }
    boardSaveButton.disabled = true;
    api('/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then(function (data) {
      var entry = data.entry;
      selectedBoardKey = entry.key;
      document.getElementById('boardScope').value = payload.scope;
      document.getElementById('boardKey').value = entry.key;
      document.getElementById('boardTag').value = '';
      closeBoardForm(); connectBoardSubscription(); setNotice(tr('board.saved'), false);
      return loadBoard();
    }).catch(function (error) {
      boardSaveButton.disabled = false;
      if (error.status === 409) {
        var current = error.currentTs ? error.currentTs : tr('board.missing');
        setBoardFormError(tr('board.conflict', { current: current }));
        document.getElementById('boardConflictReload').hidden = false;
      } else setBoardFormError(error.message);
    });
  }
  function reloadBoardConflict() {
    if (!boardEditing) return;
    var query = new URLSearchParams(); query.set('scope', boardEditing.scope); query.set('key', boardEditing.key); query.set('exact', '1'); query.set('limit', '1000'); query.set('values', '1');
    if (boardEditing.scope === 'workspace') query.set('workspace', boardEditing.workspace);
    api('/api/board?' + query.toString()).then(function (data) {
      var rows = data && Array.isArray(data.entries) ? data.entries : [];
      var current = rows.filter(function (entry) { return entry.key === boardEditing.key; })[0];
      if (!current) { setBoardFormError(tr('board.currentMissing')); return; }
      boardEditing.expectedTs = current.ts; boardEditing.external = false;
      document.getElementById('boardFormValue').value = current.value || '';
      document.getElementById('boardFormTags').value = (current.tags || []).join('\\n');
      document.getElementById('boardFormAuthor').value = current.author || '';
      document.getElementById('boardExternalWarning').hidden = true;
      document.getElementById('boardConflictReload').hidden = true;
      setBoardFormError(tr('board.reloaded', { current: current.ts })); updateBoardValueBytes();
    }).catch(function (error) { setBoardFormError(error.message); });
  }
  function deleteBoardEntry(entry) {
    var scope = document.getElementById('boardScope').value;
    if (!window.confirm(tr('board.deleteConfirm', { key: entry.key }))) return;
    var payload = boardRequestBody(scope, currentWorkspace, entry.key); payload.expectedTs = entry.ts;
    api('/api/board', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then(function () {
      selectedBoardKey = ''; setNotice(tr('board.deleted'), false); return loadBoard();
    }).catch(function (error) {
      if (error.status === 409) setNotice(tr('board.deleteConflict', { current: error.currentTs || tr('board.missing') }), true);
      else setNotice(error.message, true);
    });
  }
`;
