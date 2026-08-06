// Control Plane page fragment: Handoff Inbox view (memory section, inbox tab).
// Lists directed handoffs addressed to the current workspace's project
// (state filter, detail expansion, consume/archive) with an outbox toggle
// (mailbox task 4). Same fragment contract as the other ./pages/*: safe DOM
// construction only (no innerHTML), i18n through the shared tr() helper,
// `ho-` class prefix.

export const INBOX_VIEW_HTML = `  <section id="inboxView" class="view" role="tabpanel" hidden>
    <div class="ho-toolbar">
      <div class="field"><label for="inboxState" data-i18n="common.status">Status</label><select id="inboxState">
        <option value="pending" data-i18n="inbox.state.pending">pending</option>
        <option value="consumed" data-i18n="inbox.state.consumed">consumed</option>
        <option value="archived" data-i18n="inbox.state.archived">archived</option>
        <option value="pending,consumed,archived" data-i18n="inbox.state.all">all</option>
      </select></div>
      <button id="refreshInbox" class="secondary" type="button" data-i18n="common.refresh">Refresh</button>
      <div class="ho-toggle" role="group" aria-label="Handoff view" data-i18n-aria="inbox.viewAria">
        <button id="inboxViewButton" class="secondary active" type="button" data-i18n="inbox.inboxView">Inbox</button>
        <button id="outboxViewButton" class="secondary" type="button" data-i18n="inbox.outboxView">Outbox</button>
      </div>
    </div>
    <div id="inboxList" class="ho-list"></div>
  </section>
`;

export const INBOX_PAGE_JS = `  var inboxMode = 'inbox';
  function inboxQuery() {
    var query = new URLSearchParams();
    query.set('workspace', currentWorkspace);
    var state = document.getElementById('inboxState').value;
    if (state) query.set('state', state);
    return query.toString();
  }
  function renderHandoffRow(handoff) {
    var row = document.createElement('article');
    row.className = 'ho-row';
    var head = document.createElement('div');
    head.className = 'ho-head';
    var title = document.createElement('button');
    title.className = 'ho-title';
    title.type = 'button';
    title.textContent = handoff.title || handoff.id;
    title.addEventListener('click', function () { toggleHandoffDetail(row, handoff); });
    var status = document.createElement('span');
    status.className = 'status ho-' + (handoff.state || 'pending');
    status.textContent = handoff.state || '—';
    head.appendChild(title);
    head.appendChild(status);
    row.appendChild(head);
    var summary = document.createElement('div');
    summary.className = 'ho-summary';
    summary.textContent = handoff.summary || '';
    row.appendChild(summary);
    var meta = document.createElement('div');
    meta.className = 'ho-meta';
    var from = document.createElement('span');
    from.textContent = tr('inbox.from', { from: handoff.fromProject || '—' });
    meta.appendChild(from);
    var to = document.createElement('span');
    to.textContent = tr('inbox.to', { to: handoff.toProject || '—' });
    meta.appendChild(to);
    var updated = document.createElement('span');
    updated.textContent = handoff.updatedAt || '';
    meta.appendChild(updated);
    row.appendChild(meta);
    var actions = document.createElement('div');
    actions.className = 'ho-actions';
    var details = document.createElement('button');
    details.className = 'secondary'; details.type = 'button'; details.textContent = tr('common.details');
    details.addEventListener('click', function () { toggleHandoffDetail(row, handoff); });
    actions.appendChild(details);
    if (handoff.state === 'pending') {
      var consume = document.createElement('button');
      consume.className = 'primary'; consume.type = 'button'; consume.textContent = tr('inbox.consume');
      consume.addEventListener('click', function () { consumeHandoff(handoff.id); });
      actions.appendChild(consume);
      var archive = document.createElement('button');
      archive.className = 'danger'; archive.type = 'button'; archive.textContent = tr('inbox.archive');
      archive.addEventListener('click', function () { archiveHandoff(handoff.id); });
      actions.appendChild(archive);
    }
    row.appendChild(actions);
    return row;
  }
  function toggleHandoffDetail(row, handoff) {
    var existing = row.querySelector('.ho-detail');
    if (existing) { row.removeChild(existing); return; }
    var detail = document.createElement('div');
    detail.className = 'ho-detail';
    var dl = document.createElement('dl');
    dl.className = 'details';
    ['id', 'fromProject', 'toProject', 'state', 'author', 'createdAt', 'updatedAt', 'consumedAt'].forEach(function (field) {
      if (handoff[field] !== undefined) addDetailRow(dl, field, handoff[field], false);
    });
    detail.appendChild(dl);
    row.appendChild(detail);
  }
  function renderInboxList(handoffs) {
    var list = document.getElementById('inboxList');
    list.textContent = '';
    if (!handoffs.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = tr('inbox.empty');
      list.appendChild(empty);
      return;
    }
    handoffs.forEach(function (handoff) { list.appendChild(renderHandoffRow(handoff)); });
  }
  function loadInbox() {
    if (!currentWorkspace) return Promise.resolve();
    var url = inboxMode === 'outbox' ? '/api/handoff/outbox?' + inboxQuery() : '/api/handoff/inbox?' + inboxQuery();
    var list = document.getElementById('inboxList');
    showListLoading(list);
    return api(url).then(function (data) {
      renderInboxList(data && Array.isArray(data.handoffs) ? data.handoffs : []);
    }).catch(function (error) { clearListLoading(list); throw error; });
  }
  function switchInboxMode(mode) {
    if (mode !== 'inbox' && mode !== 'outbox') mode = 'inbox';
    inboxMode = mode;
    document.getElementById('inboxViewButton').className = 'secondary' + (mode === 'inbox' ? ' active' : '');
    document.getElementById('outboxViewButton').className = 'secondary' + (mode === 'outbox' ? ' active' : '');
    return loadInbox();
  }
  function consumeHandoff(id) {
    if (!currentWorkspace || !window.confirm(tr('inbox.consumeConfirm'))) return;
    api('/api/handoff/' + encodeURIComponent(id) + '/consume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: currentWorkspace }) }).then(function () {
      return loadInbox();
    }).catch(function (error) { setNotice(error.message, true); });
  }
  function archiveHandoff(id) {
    if (!currentWorkspace || !window.confirm(tr('inbox.archiveConfirm'))) return;
    api('/api/handoff/' + encodeURIComponent(id) + '/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: currentWorkspace }) }).then(function () {
      return loadInbox();
    }).catch(function (error) { setNotice(error.message, true); });
  }
  document.getElementById('refreshInbox').addEventListener('click', function () { loadInbox().catch(function (error) { setNotice(error.message, true); }); });
  document.getElementById('inboxState').addEventListener('change', function () { loadInbox().catch(function (error) { setNotice(error.message, true); }); });
  document.getElementById('inboxViewButton').addEventListener('click', function () { switchInboxMode('inbox').catch(function (error) { setNotice(error.message, true); }); });
  document.getElementById('outboxViewButton').addEventListener('click', function () { switchInboxMode('outbox').catch(function (error) { setNotice(error.message, true); }); });
`;
