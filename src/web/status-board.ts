/**
 * Status Board page (0.9.0): cross-home agent monitoring at GET /status-board.
 * Session groups + main→subagent tree + status column, SSE-live via /status/events.
 * Shares the app chrome with every other page (renderAppHeader, tokens,
 * components, lib, i18n) and inlines the pure status model source (D2).
 */
import { TOKENS_CSS, THEME_BOOTSTRAP } from './tokens.js';
import { COMPONENTS_CSS } from './components.js';
import { LIB_JS } from './lib.js';
import { I18N_BOOTSTRAP, I18N_JS } from './i18n.js';
import { renderAppHeader } from './app-header.js';
import { STATUS_MODEL_JS } from './status-model.js';

export const STATUS_BOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title data-i18n="status.title">Agent Status Board</title>
<style>
${TOKENS_CSS}
${COMPONENTS_CSS}

/* Status Board Specific Styles */
.sb-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  padding: 10px 14px;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-1);
}
/* The single allowed page-wide animation: the live dot. Busy rows are static. */
.sb-live {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-green);
  box-shadow: var(--glow-ring);
  animation: sbPulse 2s ease-in-out infinite;
  flex: 0 0 auto;
}
.sb-live.off {
  background: var(--text-faint);
  box-shadow: none;
  animation: none;
}
@keyframes sbPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.5); }
  50% { box-shadow: 0 0 0 5px rgba(52, 211, 153, 0); }
}
.sb-conn {
  color: var(--text-dim);
  font-size: 12px;
  font-family: var(--font-mono);
}
.sb-conn.ok {
  color: var(--accent-green);
}
.sb-counts {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.sb-notready {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  margin-bottom: 14px;
  background: var(--tint-amber);
  border: 1px solid var(--tint-amber-border);
  border-radius: var(--r-md);
  color: var(--accent-amber);
  font-size: 13px;
}
.sb-notready[hidden] {
  display: none;
}
.sb-scan {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  margin: 0 0 10px;
  border-radius: var(--r-pill);
  background: var(--tint-amber);
  color: var(--accent-amber);
  font-size: 11px;
}
.sb-scan[hidden] {
  display: none;
}
.sb-scan .spin {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-amber);
}
/* Long-scroll region: opaque, blur-free (frontend-v3-design.md:72-77 hard rule). */
.sb-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: calc(100vh - 210px);
  overflow-y: auto;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
.sb-session {
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.sb-session.gone .sb-session-head {
  opacity: 0.55;
}
.sb-session-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.sb-session-title {
  font-weight: 600;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 13px;
}
.sb-session-sub {
  color: var(--text-faint);
  font-size: 11px;
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-ended {
  padding: 1px 8px;
  border-radius: var(--r-pill);
  font-size: 10px;
  background: var(--surface-strong);
  color: var(--text-dim);
}
.sb-session-count {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.sb-colhead {
  display: grid;
  grid-template-columns: minmax(180px, 2fr) 56px minmax(120px, 1fr) 104px minmax(110px, 1fr) 66px;
  gap: 10px;
  padding: 6px 14px;
  color: var(--text-faint);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border);
  background: var(--surface-strong);
}
.sb-row {
  display: grid;
  grid-template-columns: minmax(180px, 2fr) 56px minmax(120px, 1fr) 104px minmax(110px, 1fr) 66px;
  gap: 10px;
  align-items: center;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  transition: background var(--dur-fast) var(--ease-out);
}
.sb-row:last-child {
  border-bottom: none;
}
.sb-row:hover {
  background: var(--hover-tint-subtle);
}
/* Static busy highlight: no pulse animation (D5 budget). */
.sb-row.busy {
  background: var(--tint-green-soft);
}
.sb-row.busy .sb-agent {
  color: var(--accent-green);
}
/* E8: stale rows grey out and suppress the busy highlight. */
.sb-row.stale {
  opacity: 0.45;
}
.sb-row.stale .sb-status {
  background: var(--surface-strong);
  color: var(--text-faint);
}
.sb-agent {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-family: var(--font-mono);
  color: var(--accent-blue);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-guide {
  flex: 0 0 auto;
  color: var(--text-faint);
  font-size: 11px;
}
.sb-kind {
  padding: 0 7px;
  border-radius: var(--r-pill);
  font-size: 10px;
  background: var(--surface-strong);
  color: var(--text-dim);
  justify-self: start;
  text-transform: none;
}
.sb-kind.main {
  background: var(--tint-blue);
  color: var(--accent-blue);
}
.sb-kind.sub {
  background: var(--tint-purple);
  color: var(--accent-purple);
}
.sb-model {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-status {
  justify-self: start;
  padding: 1px 9px;
  border-radius: var(--r-pill);
  font-size: 11px;
  line-height: 18px;
  background: var(--surface-strong);
  color: var(--text-dim);
}
.sb-status.st-busy {
  background: var(--tint-green);
  color: var(--accent-green);
}
.sb-status.st-done {
  background: var(--tint-blue);
  color: var(--accent-blue);
}
.sb-status.st-err {
  background: var(--tint-red);
  color: var(--accent-red);
}
.sb-status.st-warn {
  background: var(--tint-amber);
  color: var(--accent-amber);
}
.sb-status.st-stale {
  background: var(--surface-strong);
  color: var(--text-faint);
}
.sb-tool {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-tool.err {
  color: var(--accent-red);
}
.sb-seen {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.sb-empty {
  padding: 22px;
  text-align: center;
  color: var(--text-faint);
}
.sb-empty[hidden] {
  display: none;
}
</style>
${THEME_BOOTSTRAP}
${I18N_BOOTSTRAP}
</head>
<body>
<div class="aurora-bg"></div>
<div class="shell">
  ${renderAppHeader('status')}
  <div class="sb-toolbar">
    <span class="sb-live" id="sbLive"></span>
    <span class="sb-conn" id="sbConn" data-i18n="status.connecting">connecting</span>
    <span class="sb-counts" id="sbCounts"></span>
  </div>
  <div class="sb-notready" id="sbNotReady" hidden data-i18n="status.notReady">Status controller is not running. Start or reuse a session to begin monitoring.</div>
  <div class="sb-scan" id="sbScan" hidden><span class="spin"></span><span data-i18n="status.scanning">Scanning workspaces…</span></div>
  <div class="sb-list" id="sbList"></div>
  <div class="sb-empty" id="sbEmpty" hidden data-i18n="status.empty">No agents observed yet.</div>
</div>
<script>
${I18N_JS}
${LIB_JS}
${STATUS_MODEL_JS}
(function () {
  'use strict';
  var M = window.__moaStatusModel;
  var tr = window.__moaI18n ? window.__moaI18n.t : function (k) { return k; };
  var model = M.newModel();
  var board = document.getElementById('sbList');
  var connEl = document.getElementById('sbConn');
  var liveEl = document.getElementById('sbLive');
  var countsEl = document.getElementById('sbCounts');
  var scanEl = document.getElementById('sbScan');
  var notReadyEl = document.getElementById('sbNotReady');
  var emptyEl = document.getElementById('sbEmpty');
  var rowEls = {};
  var sessionEls = {};
  var pendingFrames = [];
  var flushScheduled = false;

  function setConn(state, msg) {
    if (connEl) {
      connEl.textContent = msg;
      connEl.className = 'sb-conn' + (state === 'open' ? ' ok' : '');
    }
    if (liveEl) liveEl.className = 'sb-live' + (state === 'open' ? '' : ' off');
  }
  function showNotReady() { if (notReadyEl) notReadyEl.hidden = false; }
  function hideNotReady() { if (notReadyEl) notReadyEl.hidden = true; }
  function setScan(scanning) { if (scanEl) scanEl.hidden = !scanning; }
  function updateCounts() {
    if (!countsEl) return;
    var c = M.modelCounts(model);
    countsEl.textContent = tr('status.counts', { agents: c.agents, sessions: c.sessions });
  }
  function updateEmpty() {
    if (emptyEl) emptyEl.hidden = M.modelCounts(model).agents > 0;
  }

  function depthOf(entry) {
    var depth = 0;
    var seen = {};
    var cur = entry.parentKey;
    while (cur && depth < 64) {
      if (seen[cur]) return depth;
      seen[cur] = true;
      var p = model.byKey[cur];
      if (!p) return depth;
      depth++;
      cur = p.parentKey;
    }
    return depth;
  }

  function cellText(row, cls, text) {
    var cell = document.createElement('div');
    cell.className = cls;
    cell.textContent = text;
    row.appendChild(cell);
    return cell;
  }

  function createRowEl(key) {
    var entry = model.byKey[key];
    if (!entry) return null;
    var row = document.createElement('div');
    row.setAttribute('data-key', key);
    row.className = 'sb-row';
    var agentCell = document.createElement('div');
    agentCell.className = 'sb-agent';
    var guide = document.createElement('span');
    guide.className = 'sb-guide';
    var depth = depthOf(entry);
    guide.textContent = depth > 0 ? (depth > 1 ? new Array(depth).join('┆') + '└' : '└') : '';
    agentCell.appendChild(guide);
    var name = document.createElement('span');
    name.textContent = entry.agentId;
    agentCell.appendChild(name);
    row.appendChild(agentCell);
    var isSub = entry.kind === 'sub' || entry.orphan;
    var kindCell = cellText(row, 'sb-kind ' + (isSub ? 'sub' : 'main'), isSub ? tr('status.sub') : tr('status.main'));
    var modelCell = cellText(row, 'sb-model', entry.model || '–');
    var st = M.deriveStatus(entry);
    var statusCell = cellText(row, 'sb-status st-' + st.tone, st.label ? st.label : tr('status.' + st.key));
    // F5 (0.9.0 review): first render must mark error tool calls red like
    // updateRowEl does — the class was previously only set on incremental updates.
    var toolCell = cellText(row, 'sb-tool' + (entry.lastToolCall && entry.lastToolCall.isError ? ' err' : ''), (entry.lastToolCall && entry.lastToolCall.name) ? entry.lastToolCall.name : '–');
    var seenCell = cellText(row, 'sb-seen', window.__moaLib.fmtClock(entry.lastSeen));
    if (entry.stale) row.classList.add('stale');
    if (entry.busy && !entry.stale) row.classList.add('busy');
    if (entry.orphan) row.classList.add('orphan');
    row.__cells = {
      guide: guide,
      name: name,
      kind: kindCell,
      model: modelCell,
      status: statusCell,
      tool: toolCell,
      seen: seenCell,
    };
    return row;
  }

  function updateRowEl(key) {
    var row = rowEls[key];
    var entry = model.byKey[key];
    if (!row || !entry || !row.__cells) return;
    var cells = row.__cells;
    var depth = depthOf(entry);
    cells.guide.textContent = depth > 0 ? (depth > 1 ? new Array(depth).join('┆') + '└' : '└') : '';
    cells.name.textContent = entry.agentId;
    var isSub = entry.kind === 'sub' || entry.orphan;
    cells.kind.className = 'sb-kind ' + (isSub ? 'sub' : 'main');
    cells.kind.textContent = isSub ? tr('status.sub') : tr('status.main');
    cells.model.textContent = entry.model || '–';
    var st = M.deriveStatus(entry);
    cells.status.className = 'sb-status st-' + st.tone;
    cells.status.textContent = st.label ? st.label : tr('status.' + st.key);
    cells.tool.className = 'sb-tool' + (entry.lastToolCall && entry.lastToolCall.isError ? ' err' : '');
    cells.tool.textContent = (entry.lastToolCall && entry.lastToolCall.name) ? entry.lastToolCall.name : '–';
    cells.seen.textContent = window.__moaLib.fmtClock(entry.lastSeen);
    row.classList.toggle('stale', !!entry.stale);
    row.classList.toggle('busy', !!entry.busy && !entry.stale);
    row.classList.toggle('orphan', !!entry.orphan);
  }

  var COLS = ['status.colAgent', 'status.colKind', 'status.colModel', 'status.colStatus', 'status.colTool', 'status.colSeen'];

  function ensureSessionEl(sessionId) {
    if (sessionEls[sessionId]) return sessionEls[sessionId];
    if (!board) return null;
    var group = document.createElement('div');
    group.className = 'sb-session';
    group.setAttribute('data-session', sessionId);
    var head = document.createElement('div');
    head.className = 'sb-session-head';
    var title = document.createElement('span');
    title.className = 'sb-session-title';
    var sub = document.createElement('span');
    sub.className = 'sb-session-sub';
    var ended = document.createElement('span');
    ended.className = 'sb-ended';
    ended.textContent = tr('status.ended');
    ended.hidden = true;
    var count = document.createElement('span');
    count.className = 'sb-session-count';
    head.appendChild(title);
    head.appendChild(sub);
    head.appendChild(ended);
    head.appendChild(count);
    var colhead = document.createElement('div');
    colhead.className = 'sb-colhead';
    var colCells = [];
    for (var i = 0; i < COLS.length; i++) {
      var c = document.createElement('span');
      c.textContent = tr(COLS[i]);
      colhead.appendChild(c);
      colCells.push(c);
    }
    var rows = document.createElement('div');
    rows.className = 'sb-rows';
    group.appendChild(head);
    group.appendChild(colhead);
    group.appendChild(rows);
    var info = { group: group, head: head, title: title, sub: sub, ended: ended, count: count, rows: rows, colCells: colCells };
    sessionEls[sessionId] = info;
    return info;
  }

  function updateSessionEl(sessionId) {
    var info = ensureSessionEl(sessionId);
    if (!info) return;
    var row = model.sessions[sessionId] || {};
    info.title.textContent = row.title || sessionId;
    info.sub.textContent = row.workDir || (row.home || '');
    info.ended.hidden = !row.gone;
    info.group.classList.toggle('gone', !!row.gone);
    var n = 0;
    var keys = Object.keys(model.byKey);
    for (var i = 0; i < keys.length; i++) {
      if (model.byKey[keys[i]].sessionId === sessionId) n++;
    }
    info.count.textContent = tr('status.sessionCount', { count: n });
  }

  /** Re-append this session's rows in DFS tree order (visited-guarded). */
  function resortSession(sessionId, container) {
    container = container || board;
    if (!container) return;
    var order = [];
    var visited = {};
    var stack = [];
    var roots = model.roots[sessionId] || [];
    for (var i = roots.length - 1; i >= 0; i--) stack.push(roots[i]);
    while (stack.length) {
      var key = stack.pop();
      if (visited[key]) continue;
      visited[key] = true;
      order.push(key);
      var entry = model.byKey[key];
      if (!entry) continue;
      var children = entry.children;
      for (var j = children.length - 1; j >= 0; j--) {
        if (!visited[children[j]]) stack.push(children[j]);
      }
    }
    if (order.length === 0) {
      var info0 = sessionEls[sessionId];
      if (info0) {
        if (info0.group.parentNode) info0.group.parentNode.removeChild(info0.group);
        delete sessionEls[sessionId];
      }
      // F4 (0.9.0 review): the group's rows are gone from the DOM with it —
      // drop their rowEls entries too so removed nodes are not retained by the
      // keyed map (a later frame for the session must build fresh rows).
      for (var staleKey in rowEls) {
        if (staleKey.indexOf(sessionId + ':') === 0) delete rowEls[staleKey];
      }
      return;
    }
    var info = ensureSessionEl(sessionId);
    updateSessionEl(sessionId);
    for (var m = 0; m < order.length; m++) {
      var rk = order[m];
      if (!rowEls[rk]) rowEls[rk] = createRowEl(rk);
      else updateRowEl(rk); // refresh content on every flush (E1 reuse, no rebuild)
    }
    for (var n = 0; n < order.length; n++) {
      var rk2 = order[n];
      if (rowEls[rk2]) info.rows.appendChild(rowEls[rk2]);
    }
    container.appendChild(info.group);
  }

  function resortBoardGroups(container) {
    container = container || board;
    if (!container) return;
    for (var i = 0; i < model.sessionOrder.length; i++) {
      var info = sessionEls[model.sessionOrder[i]];
      if (info) container.appendChild(info.group);
    }
  }

  /** Full rebuild from a snapshot (D5: DocumentFragment batch build). */
  function rebuildAll() {
    if (!board) return;
    rowEls = {};
    sessionEls = {};
    var frag = document.createDocumentFragment();
    for (var i = 0; i < model.sessionOrder.length; i++) resortSession(model.sessionOrder[i], frag);
    board.textContent = '';
    // F2 (0.9.0 review): frag.children is a LIVE HTMLCollection — appending a
    // child moves it out and shrinks the collection, so an indexed loop over it
    // skipped every other group (a 323-session snapshot rendered 162 groups).
    // Snapshot-style moves via firstChild are immune.
    while (frag.firstChild) board.appendChild(frag.firstChild);
    updateCounts();
    updateEmpty();
  }

  function handleSnapshot(snap) {
    M.applySnapshot(model, snap);
    rebuildAll();
    hideNotReady();
    setScan(!!(snap && snap.scan && snap.scan.scanning === true));
  }

  function handleGone(data) {
    var sessionId = data && data.sessionId;
    var result = M.removeAgent(model, sessionId, data && data.agentId);
    for (var i = 0; i < result.removed.length; i++) {
      var rk = result.removed[i];
      var row = rowEls[rk];
      if (row) {
        if (row.parentNode) row.parentNode.removeChild(row);
        delete rowEls[rk];
      }
    }
  }

  function queueFrame(data, type) {
    pendingFrames.push({ data: data, type: type });
    if (!flushScheduled) {
      flushScheduled = true;
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(flushFrames);
      } else {
        setTimeout(flushFrames, 0);
      }
    }
  }

  function flushFrames() {
    flushScheduled = false;
    var frames = pendingFrames;
    pendingFrames = [];
    var touched = {};
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var type = f.type;
      var data = f.data;
      if (type === 'snapshot') {
        handleSnapshot(data);
        continue;
      }
      if (type === 'session') {
        if (data && data.gone === true && typeof data.sessionId === 'string') {
          M.removeSession(model, data.sessionId);
          touched[data.sessionId] = true;
        }
        continue;
      }
      if (type === 'agent' && data) {
        var sid = typeof data.sessionId === 'string' ? data.sessionId : null;
        if (data.gone === true) handleGone(data);
        else M.upsertAgent(model, data);
        if (sid) touched[sid] = true;
      }
    }
    // F3 (0.9.0 review): agent/session frames queued after a snapshot in the
    // same batch used to be skipped (the old 'rebuilt' flag short-circuited
    // the resort), so their model updates only rendered on the next flush.
    // Resort every touched session unconditionally — after a snapshot,
    // rebuildAll has already rendered the base state and resort applies the
    // later frames.
    for (var s in touched) resortSession(s);
    // F4 (0.9.0 review): resortSession appends each touched group to the board
    // end, which drifts group order away from sessionOrder — reorder after.
    resortBoardGroups();
    updateCounts();
    updateEmpty();
  }

  var sseUp = false; // last known SSE connection state (guards the probe race)

  function probeStatus() {
    try {
      fetch('/status').then(function (res) {
        var code = res.status;
        var p = typeof res.json === 'function' ? res.json() : Promise.resolve(null);
        return p.catch(function () { return null; }).then(function (data) {
          // D4 race guard: if the SSE recovered while the probe was in flight
          // (open already hid the banner), a late 503 must not re-show it.
          if (sseUp) return;
          if (code === 503 && data && data.error === 'status_not_ready') showNotReady();
          else hideNotReady();
        });
      }).catch(function () { if (!sseUp) hideNotReady(); });
    } catch (_) { if (!sseUp) hideNotReady(); }
  }

  function onSseState(state, msg) {
    setConn(state, msg);
    if (state === 'open') {
      sseUp = true;
      hideNotReady();
    } else if (state === 'error') {
      sseUp = false;
      // EventSource never exposes the HTTP status: probe /status to classify
      // 503 status_not_ready (controller not started / reuse session) from a
      // plain connection failure (D4 E7).
      probeStatus();
    }
  }

  if (window.addEventListener) window.addEventListener('moamcp:localechange', function () {
    tr = window.__moaI18n ? window.__moaI18n.t : function (k) { return k; };
    if (emptyEl) emptyEl.textContent = tr('status.empty');
    if (notReadyEl) notReadyEl.textContent = tr('status.notReady');
    if (scanEl) {
      var label = scanEl.children && scanEl.children[1] ? scanEl.children[1] : null;
      if (label) label.textContent = tr('status.scanning');
    }
    for (var sid in sessionEls) {
      updateSessionEl(sid);
      var info = sessionEls[sid];
      for (var i = 0; i < COLS.length && info.colCells; i++) info.colCells[i].textContent = tr(COLS[i]);
    }
    for (var key in rowEls) updateRowEl(key);
    updateCounts();
  });

  try {
    window.__moaLib.connectSSE('/status/events', queueFrame, onSseState, ['snapshot', 'agent', 'session']);
  } catch (_) {}
})();
</script>
</body>
</html>
`;
