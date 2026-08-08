/**
 * Status Board page (0.10.0): cross-home agent monitoring at GET /status-board.
 * Directory tree (workDir-keyed) -> session groups -> main→subagent tree rows,
 * an SSE-live top active section, and a three-level lazy render state machine:
 * folded dir = zero session DOM; expanded dir + pure-inactive session = head
 * row only; head click -> fold bar; fold bar click -> inactive agent rows.
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
  /* flex-shrink: 0 — .sb-list / .sb-dir-sessions are capped-height flex
     columns; with many sessions the default shrink would squeeze every group
     to ~2px stripes (overflow:hidden makes min-height:auto resolve to 0),
     rendering the board as thin lines (0.9.1 fix). Groups keep natural height;
     the list scrolls. */
  flex-shrink: 0;
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
  cursor: pointer;
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

/* ── 0.10.0: active section (sticky top) ─────────────────────────────────── */
.sb-active {
  /* flex-shrink: 0 — the active section sits in the document flow above the
     capped-height sb-list; both itself and its rows column must resist the
     flex-shrink collapse that squeezed .sb-session groups to 2px stripes. */
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: 6px;
  margin-bottom: 10px;
  padding: 8px 14px 10px;
  background: var(--surface-chrome);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-1);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
.sb-active[hidden] {
  display: none;
}
.sb-active-head {
  color: var(--text-faint);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.sb-active-rows {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  max-height: 28vh;
  overflow-y: auto;
}
.sb-active-rows .sb-row {
  border-bottom: none;
}
.sb-active-rows .sb-row + .sb-row {
  border-top: 1px solid var(--border);
}

/* ── 0.10.0: directory groups (workDir-keyed tree) ───────────────────────── */
.sb-dir {
  flex-shrink: 0;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.sb-dir-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 9px 14px;
  cursor: pointer;
  background: var(--surface);
  user-select: none;
}
.sb-dir-title {
  font-weight: 600;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 13px;
}
.sb-dir-sub {
  color: var(--text-faint);
  font-size: 11px;
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-dir-count {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.sb-dir-sessions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
}
/* Chevron: SELECT_CHEVRON-style data-uri inlined here (components.ts keeps the
   shared const private). Collapsed dirs / closed fold bars rotate it -90deg. */
.sb-chevron {
  flex: 0 0 auto;
  width: 10px;
  height: 6px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%2394a3b8' stroke-width='1.5' stroke-linecap='round'/></svg>");
  background-repeat: no-repeat;
  background-position: center;
  transition: transform var(--dur-fast) var(--ease-out);
}
.sb-dir.collapsed .sb-chevron,
.sb-fold:not(.open) .sb-chevron {
  transform: rotate(-90deg);
}
/* "N inactive" fold bar (pill, sb-ended/sb-session-count style) */
.sb-fold {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  flex-shrink: 0;
  margin: 6px 14px 8px;
  padding: 1px 10px;
  border-radius: var(--r-pill);
  font-size: 11px;
  background: var(--surface-strong);
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
}
.sb-fold[hidden] {
  display: none;
}
.sb-rows-inactive {
  border-top: 1px dashed var(--border);
}

/* ── 0.11.0: nested subtree containers (fourth lazy layer) ─────────────── */
/* .sb-subtree lives INSIDE its parent row (grid-column 1/-1) so a row removal
   takes the subtree with it; the guide glyphs still carry depth, the container
   adds a subtle indent + vertical line. */
.sb-row .sb-subtree {
  grid-column: 1 / -1;
  margin-top: 2px;
  padding-left: 14px;
  border-left: 1px solid var(--border);
}
/* Parent-row chevron (same 0.10.0 inlined data-uri): rotate when the subtree
   is collapsed. */
.sb-row.sb-subtree-parent.collapsed .sb-chevron {
  transform: rotate(-90deg);
}
/* Ancestor rows brought out by a live sub-agent: weak style + badge. */
.sb-row.sb-active-ancestor {
  opacity: 0.72;
}
.sb-row.sb-active-ancestor .sb-status {
  background: var(--surface-strong);
  color: var(--text-faint);
}
.sb-ancestor-badge {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: var(--r-pill);
  font-size: 10px;
  line-height: 15px;
  background: var(--tint-amber);
  color: var(--accent-amber);
  white-space: nowrap;
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
  <div class="sb-active" id="sbActive" hidden>
    <div class="sb-active-rows" id="sbActiveRows"></div>
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
  var activeEl = document.getElementById('sbActive');
  var activeRowsEl = document.getElementById('sbActiveRows');
  var activeHeadEl = null;
  // F3 (0.10.0 review): all sessionId/dirKey-keyed maps are null-prototype so
  // a sessionId/workDirHash of exactly '__proto__'/'constructor' cannot hit the
  // prototype chain (e.g. userExpandedSessions['__proto__'] = true would be a
  // silent no-op on a plain object).
  var rowEls = Object.create(null);
  var sessionEls = Object.create(null);
  var dirEls = Object.create(null);
  var activeRowEls = Object.create(null);
  var userExpandedSessions = Object.create(null);
  // 0.11.0: per-subtree collapse state (fourth lazy layer). Memory-only on
  // purpose — agent keys churn fast, localStorage persistence is meaningless.
  var collapsedSubtrees = Object.create(null);
  var pendingFrames = [];
  var flushScheduled = false;
  var FOLDS_KEY = 'moamcp-status-folds';
  var FOLDS_MAX = 500;
  var folds = loadFolds();
  // F1: one listDirectories result shared by the whole flush /
  // localechange / rebuild (refreshActiveSection, resortDirectory,
  // updateDirEl, dirGroupByKey) — the old code recomputed listDirectories up
  // to 4× per flush, each O(sessions × agents).
  var latestDirs = [];
  var latestDirById = Object.create(null);
  function computeDirState() {
    latestDirs = M.listDirectories(model);
    latestDirById = Object.create(null);
    for (var i = 0; i < latestDirs.length; i++) latestDirById[latestDirs[i].dirKey] = latestDirs[i];
  }

  // ── Active section chrome (title row is JS-created so fake-DOM tests can
  //    drive localechange; the static shell only carries the rows container).
  if (activeEl) {
    activeHeadEl = activeEl.querySelector('.sb-active-head');
    if (!activeHeadEl) {
      activeHeadEl = document.createElement('div');
      activeHeadEl.className = 'sb-active-head';
      activeHeadEl.textContent = tr('status.activeSection');
      activeEl.insertBefore(activeHeadEl, activeRowsEl);
    }
    if (activeRowsEl) {
      activeRowsEl.className = 'sb-active-rows';
      if (activeRowsEl.parentNode !== activeEl) activeEl.appendChild(activeRowsEl);
    }
  }

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

  // ── Dir fold persistence (only stores states opposite the default, FIFO 500)
  function loadFolds() {
    var out = { dirs: Object.create(null) };
    try {
      var raw = localStorage.getItem(FOLDS_KEY);
      if (!raw) return out;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.dirs && typeof parsed.dirs === 'object') {
        var keys = Object.keys(parsed.dirs);
        for (var i = 0; i < keys.length; i++) {
          var v = parsed.dirs[keys[i]];
          if (keys[i] && (v === 0 || v === 1)) out.dirs[keys[i]] = v;
        }
      }
    } catch (_) {}
    return out;
  }
  function persistFolds() {
    try {
      localStorage.setItem(FOLDS_KEY, JSON.stringify({ dirs: folds.dirs }));
    } catch (_) {}
  }
  function hasFoldRecord(dirKey) {
    return Object.prototype.hasOwnProperty.call(folds.dirs, dirKey);
  }
  function saveDirFold(dirKey, collapsed, hasActive) {
    var def = !hasActive;
    if (collapsed === def) {
      delete folds.dirs[dirKey];
    } else {
      folds.dirs[dirKey] = collapsed ? 1 : 0;
      var keys = Object.keys(folds.dirs);
      if (keys.length > FOLDS_MAX) delete folds.dirs[keys[0]];
    }
    persistFolds();
  }

  // ── Agent rows (shared by the tree and the active section) ────────────────
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

  /** M1: whether entry sits on the ACTIVE partition side. Reads the partition's
   *  effActive closure (seeds + ancestor inheritance) stashed on the session
   *  info by renderFullSession/renderHeadOnly; falls back to the raw
   *  isActiveAgent when no partition is stashed yet (defensive only). The side
   *  logic MUST use this (not isActiveAgent) so an effectively-active ancestor
   *  nests like an active row and its busy descendants are not duplicated. */
  function isOnActiveSide(entry) {
    if (!entry) return false;
    var info = sessionEls[entry.sessionId];
    var effActive = info ? info.effActive : null;
    return effActive ? effActive[entry.key] === true : M.isActiveAgent(entry);
  }

  /** Same-partition children of an entry (0.11.0): a row's chevron/subtree only
   *  covers children on its own side (active rows nest active descendants,
   *  inactive rows nest inactive descendants); the other side lives behind the
   *  fold bar and is managed by the master inactiveOpen control. M1: side
   *  membership follows the partition's effActive closure, not raw isActiveAgent. */
  function sameSideChildren(entry, sideActive) {
    var out = [];
    if (!entry || !entry.children) return out;
    var info = sessionEls[entry.sessionId];
    var effActive = info ? info.effActive : null;
    for (var i = 0; i < entry.children.length; i++) {
      var ck = entry.children[i];
      var ce = model.byKey[ck];
      if (!ce) continue;
      var onActive = effActive ? effActive[ck] === true : M.isActiveAgent(ce);
      if (onActive === sideActive) out.push(ck);
    }
    return out;
  }

  function createRowEl(key, opts) {
    var entry = model.byKey[key];
    if (!entry) return null;
    // The active section is a flat list (no nesting, no chevrons) — only the
    // tree render passes opts.tree !== false.
    var isTree = !opts || opts.tree !== false;
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
    if (isTree) {
      // Parent-row chevron (0.10.0 inlined data-uri; components.ts SELECT_CHEVRON
      // is private — do not touch it). Hidden until the row has same-side
      // children; click toggles the subtree (fourth lazy layer).
      var chevron = document.createElement('span');
      chevron.className = 'sb-chevron';
      chevron.setAttribute('aria-label', tr('status.subtreeCollapse'));
      chevron.hidden = true;
      chevron.addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        toggleSubtree(key);
      });
      agentCell.appendChild(chevron);
      row.__chevron = chevron;
    }
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
    if (isTree) {
      // Subtree container INSIDE the row (grid-column 1/-1): removing the row
      // removes the whole subtree; collapse keeps the container empty + drops
      // the subtree keys from rowEls (anti-ghost), expand lazily rebuilds.
      var sideActive = isOnActiveSide(entry);
      var kids = sameSideChildren(entry, sideActive);
      if (kids.length > 0) {
        chevron.hidden = false;
        var subtree = document.createElement('div');
        subtree.className = 'sb-subtree';
        row.appendChild(subtree);
        row.__subtree = subtree;
        row.classList.add('sb-subtree-parent');
        row.classList.toggle('collapsed', !!collapsedSubtrees[key]);
      }
    }
    row.__cells = {
      agentCell: agentCell,
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

  /** In-place refresh of one row inside the given keyed map (tree vs active). */
  function updateRowEl(map, key) {
    var row = map[key];
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
    // 0.11.0: tree chrome sync (chevron visibility/aria, subtree container,
    // collapse class). Skipped for active-section rows (flat, no nesting).
    if (map !== activeRowEls) {
      var sideActive = isOnActiveSide(entry);
      var kids = sameSideChildren(entry, sideActive);
      var hasKids = kids.length > 0;
      if (row.__chevron) {
        row.__chevron.hidden = !hasKids;
        row.__chevron.setAttribute(
          'aria-label',
          collapsedSubtrees[key] ? tr('status.subtreeExpand') : tr('status.subtreeCollapse'),
        );
      }
      row.classList.toggle('sb-subtree-parent', hasKids);
      row.classList.toggle('collapsed', hasKids && !!collapsedSubtrees[key]);
      if (hasKids) {
        if (!row.__subtree) {
          var st2 = document.createElement('div');
          st2.className = 'sb-subtree';
          row.appendChild(st2);
          row.__subtree = st2;
        }
      } else if (row.__subtree) {
        if (row.__subtree.parentNode) row.__subtree.parentNode.removeChild(row.__subtree);
        delete row.__subtree;
      }
    }
  }

  // ── Session groups (three-level lazy state machine, plan §2/§3) ───────────
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
    // Head-only (pure-inactive) sessions: click upgrades to the full render.
    head.addEventListener('click', function () { toggleSessionExpand(sessionId); });
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
    var foldBar = document.createElement('div');
    foldBar.className = 'sb-fold';
    var foldChevron = document.createElement('span');
    foldChevron.className = 'sb-chevron';
    var foldLabel = document.createElement('span');
    foldLabel.className = 'sb-fold-label';
    foldBar.appendChild(foldChevron);
    foldBar.appendChild(foldLabel);
    foldBar.addEventListener('click', function () { toggleInactive(sessionId); });
    var inactiveRows = document.createElement('div');
    inactiveRows.className = 'sb-rows sb-rows-inactive';
    var info = {
      group: group, head: head, title: title, sub: sub, ended: ended, count: count,
      colhead: colhead, colCells: colCells, rows: rows, foldBar: foldBar,
      foldLabel: foldLabel, inactiveRows: inactiveRows, inactiveOpen: false, mode: 'head',
    };
    sessionEls[sessionId] = info;
    // mode 'head' starts with just the head row in the group; applySessionMode
    // only re-parents on a mode change, so the initial head must be appended
    // here (a head-only group is exactly one head element, zero agent rows).
    group.appendChild(head);
    return info;
  }

  /** 'head' = head row only; 'full' = head + colhead + rows + fold bar + inactive rows. */
  function applySessionMode(info, mode) {
    if (info.mode === mode) return;
    info.mode = mode;
    var desired = [info.head];
    if (mode === 'full') desired.push(info.colhead, info.rows, info.foldBar, info.inactiveRows);
    var cur = info.group.children;
    while (cur.length) info.group.removeChild(cur[0]);
    for (var i = 0; i < desired.length; i++) info.group.appendChild(desired[i]);
  }

  /** Max lastSeen over the session's own partition (O(subtree), not a global
   *  byKey scan — the 0.9.1 O(n) per-frame full scan the plan §3 removes). */
  function sessionLastSeen(part) {
    var max = 0;
    var keys = part.active.concat(part.inactive);
    for (var i = 0; i < keys.length; i++) {
      var e = model.byKey[keys[i]];
      if (e && e.lastSeen > max) max = e.lastSeen;
    }
    return window.__moaLib ? window.__moaLib.fmtClock(max) : '';
  }

  function updateFoldBar(info, inactiveCount) {
    if (!info.foldLabel) return;
    if (inactiveCount > 0) {
      info.foldBar.hidden = false;
      info.foldLabel.textContent = tr('status.inactiveCount', { count: inactiveCount });
      info.foldBar.classList.toggle('open', !!info.inactiveOpen);
    } else {
      info.foldBar.hidden = true;
    }
  }

  function updateSessionEl(sessionId, part) {
    var info = sessionEls[sessionId];
    if (!info) return;
    var row = model.sessions[sessionId] || {};
    info.title.textContent = row.title || sessionId;
    info.sub.textContent = row.workDir || (row.home || '');
    // F2 (0.10.0 review): the .sb-ended badge is translated here (not only at
    // creation) so the localechange re-render refreshes it like the column
    // headers; ensureSessionEl only sets it once at build time.
    info.ended.textContent = tr('status.ended');
    info.ended.hidden = !row.gone;
    info.group.classList.toggle('gone', !!row.gone);
    var n = part.active.length + part.inactive.length;
    if (info.mode === 'head') {
      info.count.textContent = tr('status.sessionCount', { count: n }) + ' · ' + tr('status.lastSeen') + ' ' + sessionLastSeen(part);
    } else {
      info.count.textContent = tr('status.sessionCount', { count: n });
    }
    updateFoldBar(info, part.inactive.length);
  }

  /** Remove the group + all of this session's rowEls (extracted from the old
   *  empty-tree branch: no ghost DOM, no stale keyed entries). */
  function teardownSession(sessionId) {
    var info = sessionEls[sessionId];
    if (!info) return;
    if (info.group.parentNode) info.group.parentNode.removeChild(info.group);
    delete sessionEls[sessionId];
    for (var key in rowEls) {
      if (key.indexOf(sessionId + ':') === 0) delete rowEls[key];
    }
  }

  /** Drop a collapsed subtree's keys from rowEls (anti-ghost, the inactiveRows
   *  precedent) — only keys on the collapsed root's own side are rendered
   *  under this container, so only those are removed. */
  function clearSubtreeRowEls(key) {
    var keys = M.subtreeKeys(model, key);
    var sideActive = isOnActiveSide(model.byKey[key]);
    for (var i = 1; i < keys.length; i++) {
      var e = model.byKey[keys[i]];
      if (e && isOnActiveSide(e) === sideActive) delete rowEls[keys[i]];
    }
  }

  /** True when entry is a root of its partition side's tree — i.e. its model
   *  parent is missing or on the OTHER side (active parents nest active
   *  descendants, inactive parents nest inactive ones; the other side lives
   *  behind the fold bar). Roots are appended top-level; non-roots are nested
   *  by appendRowTree's recursion. */
  function isSideRoot(entry, sideActive) {
    if (!entry || !entry.parentKey) return true;
    var p = model.byKey[entry.parentKey];
    if (!p) return true;
    var info = sessionEls[entry.sessionId];
    var effActive = info ? info.effActive : null;
    var parentActive = effActive ? effActive[entry.parentKey] === true : M.isActiveAgent(p);
    return parentActive !== sideActive;
  }

  /** Append key's row into the given container and (when expanded) its
   *  same-side subtree recursively. Collapsed subtrees keep their container
   *  empty and drop their keys from rowEls — the next expand lazily rebuilds
   *  them (fourth lazy layer, C3). */
  function appendRowTree(container, key, sideActive) {
    var row = rowEls[key];
    if (!row) return;
    container.appendChild(row);
    var entry = model.byKey[key];
    if (!entry) return;
    var kids = sameSideChildren(entry, sideActive);
    var subtree = row.__subtree;
    if (kids.length === 0) {
      // Children vanished (or flipped side): clear any stale container so no
      // ghost rows survive inside the parent row.
      if (subtree && subtree.firstChild) {
        while (subtree.firstChild) subtree.removeChild(subtree.firstChild);
      }
      return;
    }
    if (!subtree) return; // defensive: createRowEl/updateRowEl sync it
    if (collapsedSubtrees[key]) {
      if (subtree.firstChild) {
        while (subtree.firstChild) subtree.removeChild(subtree.firstChild);
        clearSubtreeRowEls(key);
      }
      return;
    }
    // Expanded: clear + rebuild the container from rowEls (node identity is
    // reused — the same cost profile as the 0.10.0 clear+reappend of info.rows).
    while (subtree.firstChild) subtree.removeChild(subtree.firstChild);
    for (var i = 0; i < kids.length; i++) {
      var ck = kids[i];
      if (!rowEls[ck]) rowEls[ck] = createRowEl(ck);
      else updateRowEl(rowEls, ck);
      appendRowTree(subtree, ck, sideActive);
    }
  }

  /** Chevron click: toggle one subtree (fourth lazy layer). Collapse = clear
   *  the container + drop its keys from rowEls; expand = lazy rebuild. */
  function toggleSubtree(key) {
    var entry = model.byKey[key];
    var row = rowEls[key];
    if (!entry || !row || !row.__subtree) return;
    collapsedSubtrees[key] = !collapsedSubtrees[key];
    row.classList.toggle('collapsed', !!collapsedSubtrees[key]);
    if (row.__chevron) {
      row.__chevron.setAttribute(
        'aria-label',
        collapsedSubtrees[key] ? tr('status.subtreeExpand') : tr('status.subtreeCollapse'),
      );
    }
    var subtree = row.__subtree;
    var sideActive = isOnActiveSide(entry);
    if (collapsedSubtrees[key]) {
      while (subtree.firstChild) subtree.removeChild(subtree.firstChild);
      clearSubtreeRowEls(key);
    } else {
      while (subtree.firstChild) subtree.removeChild(subtree.firstChild);
      var kids = sameSideChildren(entry, sideActive);
      for (var i = 0; i < kids.length; i++) {
        var ck = kids[i];
        if (!rowEls[ck]) rowEls[ck] = createRowEl(ck);
        else updateRowEl(rowEls, ck);
        appendRowTree(subtree, ck, sideActive);
      }
    }
  }

  /** Attach (or re-attach) a session group at its model-order position inside
   *  the dir's sessionsBox. Plain appendChild on an already-attached group
   *  MOVES it to the bottom — expanding/collapsing a session (or a flush
   *  re-render) used to yank it out of order; anchor on the next attached
   *  sibling in model.sessionOrder instead. */
  function attachSessionGroup(dirInfo, sessionId, group) {
    var box = dirInfo.sessionsBox;
    var order = model.sessionOrder;
    var myIdx = order.indexOf(sessionId);
    if (myIdx !== -1) {
      for (var i = myIdx + 1; i < order.length; i++) {
        var sib = sessionEls[order[i]];
        if (sib && sib.group.parentNode === box) {
          box.insertBefore(group, sib.group);
          return;
        }
      }
    }
    box.appendChild(group);
  }

  function renderFullSession(sessionId, dirInfo) {
    var part = M.partitionSession(model, sessionId);
    var info = ensureSessionEl(sessionId);
    // M1: stash the partition's effective-active closure (seeds + ancestor
    // inheritance) so sameSideChildren/isSideRoot/createRowEl side logic is
    // consistent with the partition this render is built from.
    info.effActive = part.effActive;
    applySessionMode(info, 'full');
    updateSessionEl(sessionId, part);
    var active = part.active;
    // Clear + rebuild the active rows container every pass, then re-append the
    // side roots recursively (nested rows come along via their parent's
    // subtree; rowEls reuse keeps node identity; DFS order preserved).
    while (info.rows.firstChild) info.rows.removeChild(info.rows.firstChild);
    for (var i = 0; i < active.length; i++) {
      var rk = active[i];
      if (!isSideRoot(model.byKey[rk], true)) continue; // nested under an active ancestor
      if (!rowEls[rk]) rowEls[rk] = createRowEl(rk);
      else updateRowEl(rowEls, rk);
      appendRowTree(info.rows, rk, true);
    }
    var inactive = part.inactive;
    updateFoldBar(info, inactive.length);
    if (info.inactiveOpen) {
      // Master "收起全部不活跃子树": opening lazily builds every inactive row
      // (each subtree respecting its collapsedSubtrees state).
      while (info.inactiveRows.firstChild) info.inactiveRows.removeChild(info.inactiveRows.firstChild);
      for (var i = 0; i < inactive.length; i++) {
        var ik = inactive[i];
        if (!isSideRoot(model.byKey[ik], false)) continue; // nested under an inactive ancestor
        if (!rowEls[ik]) rowEls[ik] = createRowEl(ik);
        else updateRowEl(rowEls, ik);
        appendRowTree(info.inactiveRows, ik, false);
      }
    } else {
      // Fold bar closed = all inactive subtrees collapsed: the container holds
      // no DOM and every inactive key is dropped from rowEls (no ghosts).
      while (info.inactiveRows.firstChild) info.inactiveRows.removeChild(info.inactiveRows.firstChild);
      for (var i = 0; i < inactive.length; i++) delete rowEls[inactive[i]];
    }
    if (dirInfo) attachSessionGroup(dirInfo, sessionId, info.group);
  }

  function renderHeadOnly(sessionId, dirInfo) {
    var part = M.partitionSession(model, sessionId);
    var info = ensureSessionEl(sessionId);
    info.effActive = part.effActive; // M1: keep the side closure consistent
    applySessionMode(info, 'head');
    updateSessionEl(sessionId, part);
    if (dirInfo) attachSessionGroup(dirInfo, sessionId, info.group);
  }

  /** Rebuild-path renderer (snapshot / dir expand): inactive sessions get a
   *  head row only, zero agent DOM. */
  function renderSessionAtRebuild(sessionId, dirInfo) {
    var part = M.partitionSession(model, sessionId);
    var n = part.active.length + part.inactive.length;
    if (dirInfo.fold || n === 0) return;
    if (part.active.length > 0 || userExpandedSessions[sessionId] === true) {
      renderFullSession(sessionId, dirInfo);
    } else {
      renderHeadOnly(sessionId, dirInfo);
    }
  }

  /** Incremental-path renderer (flush). Keeps a full render full once built
   *  (E1 reuse / F4 no-drift regressions), keeps head-only head-only, and a
   *  session first seen via a frame renders full — the lazy head-only path is
   *  the snapshot/rebuild one. */
  function resortSession(sessionId) {
    var dirKey = M.sessionDirKey(model, sessionId);
    var dirInfo = ensureDirEl(dirKey);
    if (!dirInfo) return;
    var part = M.partitionSession(model, sessionId);
    var n = part.active.length + part.inactive.length;
    if (dirInfo.fold || n === 0) {
      if (sessionEls[sessionId]) teardownSession(sessionId);
      return;
    }
    var existing = sessionEls[sessionId];
    var full;
    if (existing && existing.mode === 'full') full = true;
    else if (part.active.length > 0 || userExpandedSessions[sessionId] === true) full = true;
    else if (existing && existing.mode === 'head') full = false;
    else full = true;
    if (full) renderFullSession(sessionId, dirInfo);
    else renderHeadOnly(sessionId, dirInfo);
  }

  function toggleSessionExpand(sessionId) {
    var info = sessionEls[sessionId];
    if (!info) return;
    var part = M.partitionSession(model, sessionId);
    if (part.active.length > 0) return; // full sessions are not collapsible via the head
    var dirInfo = dirEls[M.sessionDirKey(model, sessionId)];
    if (!dirInfo) return;
    if (info.mode === 'full') {
      // A full render of an all-inactive session (previously active, or
      // user-expanded): the head click collapses it back to head-only. Without
      // this branch the first click only set userExpandedSessions=true (a
      // visual no-op on an already-full group) and the user needed two clicks.
      userExpandedSessions[sessionId] = false;
      renderHeadOnly(sessionId, dirInfo);
      return;
    }
    userExpandedSessions[sessionId] = !userExpandedSessions[sessionId];
    if (userExpandedSessions[sessionId]) renderFullSession(sessionId, dirInfo);
    else renderHeadOnly(sessionId, dirInfo);
  }

  function toggleInactive(sessionId) {
    var info = sessionEls[sessionId];
    if (!info) return;
    info.inactiveOpen = !info.inactiveOpen;
    var dirInfo = dirEls[M.sessionDirKey(model, sessionId)];
    if (dirInfo) renderFullSession(sessionId, dirInfo);
  }

  // ── Directory layer (plan §2) ─────────────────────────────────────────────
  // F1: group lookup is an O(1) index into the single per-flush listDirectories
  // result (computeDirState) — the old code recomputed listDirectories for
  // every call, e.g. once per dir inside updateDirEl/resortDirSessions.
  function dirGroupByKey(dirKey) {
    return latestDirById[dirKey] || null;
  }

  function ensureDirEl(dirKey) {
    if (dirEls[dirKey]) return dirEls[dirKey];
    if (!board) return null;
    var group = document.createElement('div');
    group.className = 'sb-dir';
    group.setAttribute('data-dir', dirKey);
    var head = document.createElement('div');
    head.className = 'sb-dir-head';
    var chevron = document.createElement('span');
    chevron.className = 'sb-chevron';
    var title = document.createElement('span');
    title.className = 'sb-dir-title';
    var sub = document.createElement('span');
    sub.className = 'sb-dir-sub';
    var count = document.createElement('span');
    count.className = 'sb-dir-count';
    head.appendChild(chevron);
    head.appendChild(title);
    head.appendChild(sub);
    head.appendChild(count);
    var sessionsBox = document.createElement('div');
    sessionsBox.className = 'sb-dir-sessions';
    group.appendChild(head);
    group.appendChild(sessionsBox);
    head.addEventListener('click', function () {
      var info = dirEls[dirKey];
      if (!info) return;
      info.fold = !info.fold;
      var g = dirGroupByKey(dirKey);
      applyDirFold(info);
      saveDirFold(dirKey, info.fold, !!(g && g.hasActive));
    });
    var info = { group: group, head: head, chevron: chevron, title: title, sub: sub, count: count, sessionsBox: sessionsBox, dirKey: dirKey, fold: true };
    dirEls[dirKey] = info;
    var g = dirGroupByKey(dirKey);
    if (g) info.fold = hasFoldRecord(dirKey) ? folds.dirs[dirKey] === 1 : !g.hasActive;
    info.group.classList.toggle('collapsed', !!info.fold);
    return info;
  }

  function applyDirFold(info) {
    info.group.classList.toggle('collapsed', !!info.fold);
    if (info.fold) {
      // Folded dir: internal session groups are torn down (zero session DOM);
      // active agents stay visible in the top active section.
      var kids = [].slice.call(info.sessionsBox.children);
      for (var i = 0; i < kids.length; i++) {
        var sid = kids[i].getAttribute ? kids[i].getAttribute('data-session') : null;
        if (sid) teardownSession(sid);
      }
    } else {
      var g = dirGroupByKey(info.dirKey);
      if (g) {
        for (var j = 0; j < g.sessionIds.length; j++) {
          renderSessionAtRebuild(g.sessionIds[j], info);
        }
      }
    }
  }

  function updateDirEl(dirKey) {
    var info = dirEls[dirKey];
    if (!info) return;
    var g = dirGroupByKey(dirKey);
    if (!g) {
      if (info.group.parentNode) info.group.parentNode.removeChild(info.group);
      delete dirEls[dirKey];
      return;
    }
    var last = g.label.split('/').filter(Boolean).pop();
    info.title.textContent = g.dirKey === '__unknown__' ? tr('status.unknownDir') : (last || g.label);
    info.sub.textContent = g.label;
    info.count.textContent = tr('status.hiddenSessions', { count: g.hiddenSessions }) + ' · ' + tr('status.dirAgents', { count: g.activeAgents });
    if (!hasFoldRecord(dirKey)) {
      // No user preference: follow the default (hasActive ? expanded : folded).
      var def = !g.hasActive;
      if (info.fold !== def) {
        info.fold = def;
        applyDirFold(info);
      }
    }
  }

  function resortDirSessions(dirKey) {
    var info = dirEls[dirKey];
    if (!info || info.fold) return;
    var g = dirGroupByKey(dirKey);
    if (!g) return;
    for (var i = 0; i < g.sessionIds.length; i++) {
      var si = sessionEls[g.sessionIds[i]];
      if (si) info.sessionsBox.appendChild(si.group);
    }
  }

  /** Re-append dir groups in listDirectories order (move semantics, no drift). */
  function resortDirectory() {
    if (!board) return;
    var dirs = latestDirs;
    var present = Object.create(null);
    for (var i = 0; i < dirs.length; i++) present[dirs[i].dirKey] = true;
    for (var d in dirEls) {
      if (!present[d]) {
        var di = dirEls[d];
        if (di.group.parentNode) di.group.parentNode.removeChild(di.group);
        delete dirEls[d];
      }
    }
    for (var i = 0; i < dirs.length; i++) {
      var info = dirEls[dirs[i].dirKey];
      if (info) board.appendChild(info.group);
    }
  }

  // ── Top active section (plan §4) ──────────────────────────────────────────
  // F1: derive the active partition directly from the shared listDirectories
  // result (dirs order -> sessionIds order -> partition DFS), so the section
  // never triggers a second listDirectories (M.activeAgentKeys would).
  function activeKeysFromDirs(dirs) {
    var out = [];
    for (var i = 0; i < dirs.length; i++) {
      var ids = dirs[i].sessionIds;
      for (var j = 0; j < ids.length; j++) {
        var part = M.partitionSession(model, ids[j]);
        for (var k = 0; k < part.active.length; k++) out.push(part.active[k]);
      }
    }
    return out;
  }
  // B1 (0.11.0): ancestor-closure order derived directly from the shared
  // listDirectories result (dirs order -> sessionIds order -> DFS active list).
  // M1: partitionSession.active already carries the seeds + ancestor closure, so
  // the chain-walk below is only a safety net (entries are already seen); the
  // rollup badge follows isActiveAgent — members brought out only by a live
  // descendant keep rollupActive=true (B2). No global reorder — activeAgentKeys
  // is the stable order. The serialized model function
  // activeAgentKeysWithAncestors is the API twin of this page-local derivation
  // (kept in sync by tests / D2).
  function activeKeysWithAncestorsFromDirs(dirs) {
    var seeds = activeKeysFromDirs(dirs);
    var out = []; // { key, rollupActive }
    var seen = Object.create(null);
    for (var i = 0; i < seeds.length; i++) {
      var leaf = seeds[i];
      var ancestors = [];
      var visited = Object.create(null);
      var cur = model.byKey[leaf] ? model.byKey[leaf].parentKey || null : null;
      while (cur && !visited[cur]) {
        visited[cur] = true;
        var ae = model.byKey[cur];
        if (!ae) break; // broken chain: the gap is not rendered as an ancestor
        ancestors.push(cur);
        cur = ae.parentKey || null;
      }
      for (var j = ancestors.length - 1; j >= 0; j--) {
        var ak = ancestors[j];
        if (seen[ak]) continue;
        seen[ak] = true;
        out.push({ key: ak, rollupActive: !M.isActiveAgent(model.byKey[ak]) });
      }
      if (!seen[leaf]) {
        seen[leaf] = true;
        out.push({ key: leaf, rollupActive: !M.isActiveAgent(model.byKey[leaf]) });
      }
    }
    return out;
  }
  /** Ancestor rows get a weak style + a "brought out by sub-agent" badge — the
   *  row itself is not busy, which would otherwise confuse (B2). */
  function setAncestorBadge(row, on) {
    if (!row || !row.__cells) return;
    row.classList.toggle('sb-active-ancestor', !!on);
    var cell = row.__cells.agentCell;
    if (!cell) return;
    if (on) {
      if (!cell.__badge) {
        var badge = document.createElement('span');
        badge.className = 'sb-ancestor-badge';
        cell.appendChild(badge);
        cell.__badge = badge;
      }
      cell.__badge.textContent = tr('status.ancestorBadge');
    } else if (cell.__badge) {
      if (cell.__badge.parentNode) cell.__badge.parentNode.removeChild(cell.__badge);
      delete cell.__badge;
    }
  }
  function refreshActiveSection() {
    if (!activeEl || !activeRowsEl) return;
    var entries = activeKeysWithAncestorsFromDirs(latestDirs);
    var present = Object.create(null);
    for (var i = 0; i < entries.length; i++) present[entries[i].key] = true;
    for (var key in activeRowEls) {
      if (!present[key]) {
        var stale = activeRowEls[key];
        if (stale.parentNode) stale.parentNode.removeChild(stale);
        delete activeRowEls[key];
      }
    }
    for (var i = 0; i < entries.length; i++) {
      var k = entries[i].key;
      if (!activeRowEls[k]) activeRowEls[k] = createRowEl(k, { tree: false });
      else updateRowEl(activeRowEls, k);
      if (activeRowEls[k]) {
        setAncestorBadge(activeRowEls[k], !!entries[i].rollupActive);
        activeRowsEl.appendChild(activeRowEls[k]);
      }
    }
    activeEl.hidden = entries.length === 0;
  }

  // ── Full rebuild from a snapshot (D5: DocumentFragment batch build; F2:
  //    fragment moves use the firstChild loop, never an indexed loop). ──────
  function rebuildAll() {
    if (!board) return;
    rowEls = Object.create(null);
    sessionEls = Object.create(null);
    dirEls = Object.create(null);
    // NOTE: activeRowEls is deliberately NOT reset. Its DOM nodes live in the
    // persistent sbActiveRows container; refreshActiveSection() at the end runs
    // the same reconciliation (drop keys not active, reuse/update the rest) that
    // incremental flushes use. Resetting the map here would orphan the old rows
    // in the container — every snapshot rebuild would stack a second copy of
    // each active row (ghost rows in the top section).
    var frag = document.createDocumentFragment();
    // F1: one listDirectories for the whole rebuild (dirs + dirGroupByKey +
    // refreshActiveSection all read latestDirs/latestDirById).
    computeDirState();
    var dirs = latestDirs;
    for (var i = 0; i < dirs.length; i++) {
      var g = dirs[i];
      var dirInfo = ensureDirEl(g.dirKey);
      if (hasFoldRecord(g.dirKey)) dirInfo.fold = folds.dirs[g.dirKey] === 1;
      else dirInfo.fold = !g.hasActive;
      updateDirEl(g.dirKey);
      if (dirInfo.fold) {
        frag.appendChild(dirInfo.group);
        continue;
      }
      for (var j = 0; j < g.sessionIds.length; j++) {
        renderSessionAtRebuild(g.sessionIds[j], dirInfo);
      }
      frag.appendChild(dirInfo.group);
    }
    board.textContent = '';
    while (frag.firstChild) board.appendChild(frag.firstChild);
    updateCounts();
    updateEmpty();
    refreshActiveSection();
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
      var arow = activeRowEls[rk];
      if (arow) {
        if (arow.parentNode) arow.parentNode.removeChild(arow);
        delete activeRowEls[rk];
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
    var touched = Object.create(null);
    var touchedDirs = Object.create(null);
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
          var sd = data.sessionId;
          var sdOld = M.sessionDirKey(model, sd);
          M.removeSession(model, sd);
          touched[sd] = true;
          touchedDirs[sdOld] = true;
        }
        continue;
      }
      if (type === 'agent' && data) {
        var sid = typeof data.sessionId === 'string' ? data.sessionId : null;
        if (sid) {
          var oldDir = M.sessionDirKey(model, sid);
          if (data.gone === true) {
            handleGone(data);
            touched[sid] = true;
            touchedDirs[oldDir] = true;
            // A gone frame can flip the session's dirKey (e.g. the only agent
            // carrying a workDirHash fallback is removed): the NEW dir must be
            // refreshed too, or a freshly created dir group keeps an empty
            // title/count (ensureDirEl never fills them).
            touchedDirs[M.sessionDirKey(model, sid)] = true;
          } else {
            M.upsertAgent(model, data);
            touched[sid] = true;
            touchedDirs[oldDir] = true;
            touchedDirs[M.sessionDirKey(model, sid)] = true;
          }
        }
      }
    }
    // F3 (0.9.0 review): resort every touched session unconditionally — after a
    // snapshot rebuildAll has rendered the base state and resort applies the
    // later frames in the same batch.
    // F1: ONE listDirectories for the whole flush tail; refreshActiveSection /
    // updateDirEl / resortDirSessions / resortDirectory all read it.
    computeDirState();
    refreshActiveSection();
    for (var s in touched) resortSession(s);
    for (var d in touchedDirs) {
      updateDirEl(d);
      resortDirSessions(d);
    }
    resortDirectory();
    updateCounts();
    updateEmpty();
  }

  // ── Recursive tree refresh (C5, 0.11.0) ──────────────────────────────────
  // localechange must walk the rendered tree recursively — subtree rows are
  // nested inside parent rows' .sb-subtree containers, and collapsed subtrees
  // keep no keys in rowEls, so a flat for-key-in-rowEls loop alone cannot be
  // trusted to cover every visible row.
  function refreshTreeRows(container) {
    if (!container) return;
    for (var i = 0; i < container.children.length; i++) {
      var child = container.children[i];
      if (child.className.split(' ').includes('sb-row')) {
        var key = child.getAttribute('data-key');
        if (key && rowEls[key]) updateRowEl(rowEls, key);
        refreshTreeRows(child.__subtree);
      } else {
        refreshTreeRows(child);
      }
    }
  }
  function refreshVisibleRows() {
    for (var sid in sessionEls) {
      var info = sessionEls[sid];
      if (!info || info.mode !== 'full') continue;
      refreshTreeRows(info.rows);
      refreshTreeRows(info.inactiveRows);
    }
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
    if (activeHeadEl) activeHeadEl.textContent = tr('status.activeSection');
    // F1: one listDirectories for the whole localechange re-render (the critic
    // measured ~1s switching 35 dirs with the old per-dir recomputation).
    computeDirState();
    for (var d in dirEls) updateDirEl(d);
    for (var sid in sessionEls) {
      var info = sessionEls[sid];
      for (var i = 0; i < COLS.length && info.colCells; i++) info.colCells[i].textContent = tr(COLS[i]);
      updateSessionEl(sid, M.partitionSession(model, sid));
    }
    // C5 (0.11.0): recursive tree refresh (covers nested subtree rows), then
    // the active section re-applies ancestor badges + row text with the locale.
    refreshVisibleRows();
    refreshActiveSection();
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
