/**
 * Tower Workflow page (B4): a self-contained full page at GET /tower (static
 * route in control-plane.ts, same precedent as /status-board).
 *
 * Content: repo selector (booted towers probed via /api/tower/state per
 * /api/workspaces entry), missions table (status + CI badge + review gate),
 * roster (verified marks; the tower row shows a masked placeholder — the
 * route already omits its agentId, B4 携带项 F1), the last 100 activity-log
 * lines, and collapsible findings/reviews panels fed by the B4 route faces.
 * Polls every TOWER_POLL_MS (lib.ts, 5s) through the shared startPoll.
 *
 * Shares the app chrome with every other page (renderAppHeader, tokens,
 * components, lib, i18n); no new dependencies.
 */
import { TOKENS_CSS, THEME_BOOTSTRAP } from '../tokens.js';
import { COMPONENTS_CSS } from '../components.js';
import { LIB_JS } from '../lib.js';
import { I18N_BOOTSTRAP, I18N_JS } from '../i18n.js';
import { renderAppHeader } from '../app-header.js';

export const TOWER_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title data-i18n="tower.title">Tower Workflow</title>
<style>
${TOKENS_CSS}
${COMPONENTS_CSS}

/* Tower Workflow page specific styles (status-board design language). */
.tw-toolbar {
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
.tw-live {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-green);
  box-shadow: var(--glow-ring);
  animation: twPulse 2s ease-in-out infinite;
  flex: 0 0 auto;
}
.tw-live.off {
  background: var(--text-faint);
  box-shadow: none;
  animation: none;
}
@keyframes twPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.5); }
  50% { box-shadow: 0 0 0 5px rgba(52, 211, 153, 0); }
}
.tw-conn {
  color: var(--text-dim);
  font-size: 12px;
  font-family: var(--font-mono);
}
.tw-conn.ok { color: var(--accent-green); }
.tw-conn.err { color: var(--accent-red); }
.tw-counts {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.tw-scan {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: var(--r-pill);
  background: var(--tint-amber);
  color: var(--accent-amber);
  font-size: 11px;
}
.tw-scan[hidden] { display: none; }
.tw-scan .spin {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-amber);
}
.tw-notready {
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
.tw-notready[hidden] { display: none; }
.tw-panel {
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-1);
  overflow: hidden;
  margin-bottom: 14px;
}
.tw-panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 9px 14px;
  background: var(--surface);
  cursor: pointer;
  user-select: none;
}
.tw-panel-title {
  font-weight: 600;
  color: var(--text);
  font-size: 13px;
}
.tw-panel-sub {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.tw-chevron {
  flex: 0 0 auto;
  width: 10px;
  height: 6px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%2394a3b8' stroke-width='1.5' stroke-linecap='round'/></svg>");
  background-repeat: no-repeat;
  background-position: center;
  transition: transform var(--dur-fast) var(--ease-out);
}
.tw-panel.collapsed .tw-chevron { transform: rotate(-90deg); }
.tw-panel-body { padding: 4px 14px 12px; }
.tw-panel.collapsed .tw-panel-body { display: none; }
.tw-colhead {
  display: grid;
  grid-template-columns: 64px minmax(160px, 2fr) 72px 90px 90px minmax(150px, 1.5fr) 90px minmax(170px, 1.5fr);
  gap: 10px;
  padding: 6px 14px;
  color: var(--text-faint);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border);
  background: var(--surface-strong);
}
.tw-colhead.tw-colhead-roster {
  grid-template-columns: minmax(140px, 1.5fr) 80px 110px minmax(130px, 1fr) minmax(160px, 1.5fr);
}
.tw-colhead.tw-colhead-findings,
.tw-row.tw-row-findings {
  grid-template-columns: 90px 72px 80px minmax(120px, 1fr) minmax(120px, 1fr) minmax(180px, 2fr);
}
.tw-colhead.tw-colhead-reviews,
.tw-row.tw-row-reviews {
  grid-template-columns: 56px minmax(120px, 1fr) 110px 110px 80px 90px;
}
.tw-row {
  display: grid;
  grid-template-columns: 64px minmax(160px, 2fr) 72px 90px 90px minmax(150px, 1.5fr) 90px minmax(170px, 1.5fr);
  gap: 10px;
  align-items: center;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  transition: background var(--dur-fast) var(--ease-out);
}
.tw-row.tw-row-roster {
  grid-template-columns: minmax(140px, 1.5fr) 80px 110px minmax(130px, 1fr) minmax(160px, 1.5fr);
}
.tw-row:last-child { border-bottom: none; }
.tw-row:hover { background: var(--hover-tint-subtle); }
.tw-cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tw-cell.tw-agent { font-family: var(--font-mono); color: var(--accent-blue); }
.tw-mono { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-dim); }
.tw-status { justify-self: start; padding: 1px 9px; border-radius: var(--r-pill); font-size: 11px; line-height: 18px; background: var(--surface-strong); color: var(--text-dim); }
.tw-badge { display: inline-flex; align-items: center; gap: 6px; padding: 1px 9px; border-radius: var(--r-pill); font-size: 11px; line-height: 18px; background: var(--surface-strong); color: var(--text-dim); }
.tw-badge.tw-ci-ok { background: var(--tint-green); color: var(--accent-green); }
.tw-badge.tw-ci-fail { background: var(--tint-red); color: var(--accent-red); }
.tw-badge.tw-ci-skip { background: var(--tint-amber); color: var(--accent-amber); }
.tw-badge-sub { font-family: var(--font-mono); font-size: 10.5px; opacity: 0.8; }
.tw-verified { color: var(--accent-green); }
.tw-log {
  max-height: 260px;
  overflow-y: auto;
  padding: 8px 14px;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-dim);
}
.tw-log-line { white-space: pre-wrap; word-break: break-all; }
.tw-empty { padding: 16px 14px; text-align: center; color: var(--text-faint); }
.tw-body[hidden] { display: none; }
</style>
${THEME_BOOTSTRAP}
${I18N_BOOTSTRAP}
</head>
<body>
<div class="aurora-bg"></div>
<div class="shell">
  ${renderAppHeader('tower')}
  <div class="tw-toolbar">
    <span class="tw-live" id="twLive"></span>
    <span class="tw-conn" id="twConn" data-i18n="tower.connecting">connected</span>
    <label for="twRepo" class="tw-repo-label" data-i18n="tower.repo">Repo</label>
    <select id="twRepo" aria-label="Booted tower repo"></select>
    <span class="tw-scan" id="twScan" hidden><span class="spin"></span><span data-i18n="tower.scanning">Scanning workspaces…</span></span>
    <span class="tw-counts" id="twCounts"></span>
  </div>
  <div class="tw-notready" id="twNotReady" hidden data-i18n="tower.noBooted">No booted tower found in any registered workspace. Boot one with moa_tower_boot, then reload.</div>
  <div class="tw-panel" id="twMissionsPanel">
    <div class="tw-panel-head">
      <span class="tw-chevron"></span>
      <span class="tw-panel-title" data-i18n="tower.missions">Missions</span>
      <span class="tw-panel-sub" id="twMissionsCount"></span>
    </div>
    <div class="tw-colhead">
      <span data-i18n="tower.colMission">Mission</span>
      <span data-i18n="tower.colTitle">Title</span>
      <span data-i18n="tower.colKind">Kind</span>
      <span data-i18n="tower.colStatus">Status</span>
      <span data-i18n="tower.colOwner">Owner</span>
      <span data-i18n="tower.colBranch">Branch</span>
      <span data-i18n="tower.colCi">CI</span>
      <span data-i18n="tower.colReview">Review gate</span>
    </div>
    <div id="twMissionsBody"></div>
  </div>
  <div class="tw-panel" id="twRosterPanel">
    <div class="tw-panel-head">
      <span class="tw-chevron"></span>
      <span class="tw-panel-title" data-i18n="tower.roster">Roster</span>
      <span class="tw-panel-sub" id="twRosterCount"></span>
    </div>
    <div class="tw-colhead tw-colhead-roster">
      <span data-i18n="tower.colName">Name</span>
      <span data-i18n="tower.colRole">Role</span>
      <span data-i18n="tower.colVerified">Verified</span>
      <span data-i18n="tower.colAgentId">Agent id</span>
      <span data-i18n="tower.colDetail">Detail</span>
    </div>
    <div id="twRosterBody"></div>
  </div>
  <div class="tw-panel" id="twLogPanel">
    <div class="tw-panel-head">
      <span class="tw-chevron"></span>
      <span class="tw-panel-title" data-i18n="tower.activity">Activity log</span>
      <span class="tw-panel-sub" id="twLogCount"></span>
    </div>
    <div class="tw-log" id="twLog"></div>
  </div>
  <div class="tw-panel collapsed" id="twFindingsPanel">
    <div class="tw-panel-head">
      <span class="tw-chevron"></span>
      <span class="tw-panel-title" data-i18n="tower.findings">Findings</span>
      <span class="tw-panel-sub" id="twFindingsCount"></span>
    </div>
    <div class="tw-panel-body" id="twFindingsBody"></div>
  </div>
  <div class="tw-panel collapsed" id="twReviewsPanel">
    <div class="tw-panel-head">
      <span class="tw-chevron"></span>
      <span class="tw-panel-title" data-i18n="tower.reviews">Reviews</span>
      <span class="tw-panel-sub tw-reviews-branch" id="twReviewsBranchLabel"></span>
      <span class="tw-panel-sub" id="twReviewsCount"></span>
    </div>
    <div class="tw-panel-body" id="twReviewsBody"></div>
  </div>
</div>
<script>
${I18N_JS}
${LIB_JS}
(function () {
  'use strict';
  var tr = window.__moaI18n ? window.__moaI18n.t : function (k) { return k; };
  var lib = window.__moaLib;
  var api = lib.api;
  var POLL_MS = (lib.POLL_MS && lib.POLL_MS.tower) || 5000;
  var REPO_KEY = 'moamcp-tower-repo';

  var STATUS_EMOJI = { planned: '🟡', active: '🔵', completed: '🟢', blocked: '🔴', paused: '⏸️', merged: '✅' };

  var liveEl = document.getElementById('twLive');
  var connEl = document.getElementById('twConn');
  var countsEl = document.getElementById('twCounts');
  var scanEl = document.getElementById('twScan');
  var notReadyEl = document.getElementById('twNotReady');
  var repoSelect = document.getElementById('twRepo');
  var missionsBody = document.getElementById('twMissionsBody');
  var rosterBody = document.getElementById('twRosterBody');
  var logEl = document.getElementById('twLog');
  var findingsPanel = document.getElementById('twFindingsPanel');
  var findingsBody = document.getElementById('twFindingsBody');
  var reviewsPanel = document.getElementById('twReviewsPanel');
  var reviewsBody = document.getElementById('twReviewsBody');
  var reviewsBranchLabel = document.getElementById('twReviewsBranchLabel');

  var bootedRepos = [];
  var current = null; // { cwd, name }
  var lastState = null;
  var lastMissions = null;
  var lastLog = null;
  var findingsOpen = false;
  var reviewsOpen = false;
  var poll = null;

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(iso) { return lib.fmtClock ? lib.fmtClock(iso) : (iso || '–'); }
  function setConn(state, msg) {
    connEl.textContent = msg;
    connEl.className = 'tw-conn' + (state === 'open' ? ' ok' : (state === 'error' ? ' err' : ''));
    liveEl.className = 'tw-live' + (state === 'open' ? '' : ' off');
  }
  function setScan(on) { if (scanEl) scanEl.hidden = !on; }
  function makeCell(text, cls) {
    var cell = document.createElement('div');
    cell.className = 'tw-cell' + (cls ? ' ' + cls : '');
    cell.textContent = text;
    return cell;
  }
  function appendEmpty(container, key) {
    var none = document.createElement('div');
    none.className = 'tw-empty';
    none.textContent = tr(key);
    container.appendChild(none);
  }
  function stateUrl() { return '/api/tower/state?workspace=' + encodeURIComponent(current.cwd); }

  // ── Roster (tower row's agentId is masked by the route; the page never
  //    falls back to rendering a real id). ─────────────────────────────────
  function renderRoster() {
    rosterBody.textContent = '';
    var rows = (lastState && lastState.roster) || [];
    if (!rows.length) { appendEmpty(rosterBody, 'tower.noRoster'); return; }
    for (var i = 0; i < rows.length; i++) {
      var a = rows[i];
      var row = document.createElement('div');
      row.className = 'tw-row tw-row-roster';
      var isTower = a.kind === 'tower' || a.name === 'tower';
      row.appendChild(makeCell(a.name, 'tw-agent'));
      row.appendChild(makeCell(a.kind));
      var verified = document.createElement('div');
      verified.className = 'tw-cell' + (a.verified ? ' tw-verified' : '');
      verified.textContent = (a.verified ? '✓ ' : '') + (a.verified ? tr('tower.verifiedYes') : tr('tower.verifiedNo'));
      row.appendChild(verified);
      row.appendChild(makeCell(isTower ? tr('tower.masked') : (a.agentId === undefined || a.agentId === null ? '—' : a.agentId), 'tw-mono'));
      var detail = a.missionId ? 'mission ' + a.missionId : (a.reviewTarget ? 'review ' + a.reviewTarget : '—');
      row.appendChild(makeCell(detail, 'tw-mono'));
      rosterBody.appendChild(row);
    }
  }

  // ── Missions table with CI badge + review gate. ─────────────────────────
  function ciBadge(ci) {
    var badge = document.createElement('span');
    badge.className = 'tw-badge';
    if (!ci) { badge.textContent = tr('tower.ciNone'); return badge; }
    if (ci.exitCode === 0) { badge.className += ' tw-ci-ok'; badge.textContent = tr('tower.ciPass'); }
    else if (ci.exitCode === null) { badge.className += ' tw-ci-skip'; badge.textContent = tr('tower.ciSkip'); }
    else { badge.className += ' tw-ci-fail'; badge.textContent = tr('tower.ciFail'); }
    var sub = document.createElement('span');
    sub.className = 'tw-badge-sub';
    sub.textContent = tr('tower.ciAt', { commit: String(ci.commit).slice(0, 7), time: fmt(ci.ranAt) });
    badge.appendChild(sub);
    return badge;
  }
  function reviewGateText(g) {
    if (!g || g.review === 'none') return tr('tower.reviewNone');
    return 'r' + g.round + ' · ' + g.status + ' · ' + g.sync;
  }
  function renderMissions() {
    missionsBody.textContent = '';
    var missions = (lastMissions && lastMissions.missions) || [];
    if (!missions.length) { appendEmpty(missionsBody, 'tower.noMissions'); return; }
    for (var i = 0; i < missions.length; i++) {
      var m = missions[i];
      var row = document.createElement('div');
      row.className = 'tw-row';
      row.appendChild(makeCell(m.id, 'tw-mono'));
      row.appendChild(makeCell(m.title));
      row.appendChild(makeCell(m.kind));
      var status = document.createElement('div');
      status.className = 'tw-cell';
      var badge = document.createElement('span');
      badge.className = 'tw-status';
      badge.textContent = (STATUS_EMOJI[m.status] || '') + ' ' + m.status;
      status.appendChild(badge);
      row.appendChild(status);
      row.appendChild(makeCell(m.owner || '—'));
      row.appendChild(makeCell(m.branch, 'tw-mono'));
      var ciCell = document.createElement('div');
      ciCell.className = 'tw-cell';
      ciCell.appendChild(ciBadge(m.ci));
      row.appendChild(ciCell);
      row.appendChild(makeCell(reviewGateText(m.review_gate), 'tw-mono'));
      missionsBody.appendChild(row);
    }
  }
  function renderLog() {
    logEl.textContent = '';
    var lines = (lastLog && lastLog.lines) || [];
    if (!lines.length) { appendEmpty(logEl, 'tower.noLog'); return; }
    for (var i = 0; i < lines.length; i++) {
      var line = document.createElement('div');
      line.className = 'tw-log-line';
      line.textContent = lines[i];
      logEl.appendChild(line);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }
  function renderCounts() {
    var missions = (lastMissions && lastMissions.missions) || [];
    var roster = (lastState && lastState.roster) || [];
    var updated = new Date().toISOString();
    countsEl.textContent = missions.length + ' ' + tr('tower.countsMissions') + ' · ' + roster.length + ' ' + tr('tower.countsAgents') + ' · ' + tr('tower.updatedAt', { time: fmt(updated) });
  }
  function renderAll() {
    renderRoster();
    renderMissions();
    renderLog();
    renderCounts();
  }

  // ── Findings / reviews panels (B4 route faces; loaded when expanded). ───
  function loadFindings() {
    if (!current) return;
    api('/api/tower/findings?workspace=' + encodeURIComponent(current.cwd)).then(function (data) {
      var findings = (data && data.findings) || [];
      var count = document.getElementById('twFindingsCount');
      if (count) count.textContent = findings.length ? findings.length + '' : '';
      if (!findingsOpen) return;
      findingsBody.textContent = '';
      if (!findings.length) { appendEmpty(findingsBody, 'tower.noFindings'); return; }
      var table = document.createElement('div');
      table.className = 'tw-colhead tw-colhead-findings';
      [tr('tower.colDate'), tr('tower.colKind'), tr('tower.colSeverity'), tr('tower.colAgent'), tr('tower.colMission'), tr('tower.colTitle')].forEach(function (h) {
        var span = document.createElement('span');
        span.textContent = h;
        table.appendChild(span);
      });
      findingsBody.appendChild(table);
      for (var i = 0; i < findings.length; i++) {
        var f = findings[i];
        var row = document.createElement('div');
        row.className = 'tw-row tw-row-findings';
        row.appendChild(makeCell(f.date || '—', 'tw-mono'));
        row.appendChild(makeCell(f.type || '—'));
        row.appendChild(makeCell(f.severity || '—'));
        row.appendChild(makeCell(f.agent || '—', 'tw-mono'));
        row.appendChild(makeCell(f.mission || '—', 'tw-mono'));
        row.appendChild(makeCell(f.title || '—'));
        findingsBody.appendChild(row);
      }
    }).catch(function () {
      findingsBody.textContent = '';
      appendEmpty(findingsBody, 'tower.noFindings');
    });
  }
  function reviewBranches() {
    var branches = [];
    var missions = (lastMissions && lastMissions.missions) || [];
    for (var i = 0; i < missions.length; i++) {
      if (missions[i].status !== 'merged') branches.push(missions[i].branch);
    }
    return branches;
  }
  function loadReviews() {
    if (!current) return;
    var branches = reviewBranches();
    var branch = branches.length ? branches[0] : '';
    if (reviewsBranchLabel) reviewsBranchLabel.textContent = branch ? tr('tower.reviewsFor', { branch: branch }) : '';
    if (!branch) {
      reviewsBody.textContent = '';
      appendEmpty(reviewsBody, 'tower.noReviews');
      return;
    }
    api('/api/tower/reviews?workspace=' + encodeURIComponent(current.cwd) + '&branch=' + encodeURIComponent(branch)).then(function (data) {
      var reviews = (data && data.reviews) || [];
      var count = document.getElementById('twReviewsCount');
      if (count) count.textContent = reviews.length ? reviews.length + '' : '';
      if (!reviewsOpen) return;
      reviewsBody.textContent = '';
      if (!reviews.length) { appendEmpty(reviewsBody, 'tower.noReviews'); return; }
      var table = document.createElement('div');
      table.className = 'tw-colhead tw-colhead-reviews';
      [tr('tower.colRound'), tr('tower.colReviewer'), tr('tower.colStatus'), tr('tower.colMerge'), tr('tower.colCommit'), tr('tower.colDate')].forEach(function (h) {
        var span = document.createElement('span');
        span.textContent = h;
        table.appendChild(span);
      });
      reviewsBody.appendChild(table);
      for (var i = 0; i < reviews.length; i++) {
        var r = reviews[i];
        var row = document.createElement('div');
        row.className = 'tw-row tw-row-reviews';
        row.appendChild(makeCell('r' + r.round, 'tw-mono'));
        row.appendChild(makeCell(r.reviewer, 'tw-agent'));
        row.appendChild(makeCell(r.status, 'tw-mono'));
        row.appendChild(makeCell(r.merge, 'tw-mono'));
        row.appendChild(makeCell(r.reviewedCommit ? String(r.reviewedCommit).slice(0, 7) : '—', 'tw-mono'));
        row.appendChild(makeCell(r.date || '—', 'tw-mono'));
        reviewsBody.appendChild(row);
      }
    }).catch(function () {
      reviewsBody.textContent = '';
      appendEmpty(reviewsBody, 'tower.noReviews');
    });
  }

  // ── Refresh + polling (shared startPoll, TOWER_POLL_MS). ────────────────
  function refresh() {
    if (!current) return;
    var ws = encodeURIComponent(current.cwd);
    setConn('open', '● ' + tr('tower.connecting'));
    Promise.all([
      api('/api/tower/state?workspace=' + ws),
      api('/api/tower/missions?workspace=' + ws),
      api('/api/tower/log?workspace=' + ws + '&lines=100')
    ]).then(function (results) {
      lastState = results[0];
      lastMissions = results[1];
      lastLog = results[2];
      renderAll();
      setConn('open', '● ' + tr('tower.connecting'));
      if (findingsOpen) loadFindings();
      if (reviewsOpen) loadReviews();
    }).catch(function (err) {
      setConn('error', '✗ ' + (err && err.message ? err.message : 'error'));
    });
  }
  function startPolling() {
    if (poll) poll.stop();
    poll = lib.startPoll(refresh, POLL_MS);
  }

  // ── Repo discovery: /api/workspaces + per-workspace boot probe. ─────────
  function fillRepoOptions() {
    repoSelect.textContent = '';
    if (!bootedRepos.length) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = tr('tower.noBooted');
      repoSelect.appendChild(opt);
      repoSelect.disabled = true;
      return;
    }
    repoSelect.disabled = false;
    var saved = '';
    try { saved = localStorage.getItem(REPO_KEY) || ''; } catch (_) {}
    var foundSaved = false;
    for (var i = 0; i < bootedRepos.length; i++) {
      var o = document.createElement('option');
      o.value = bootedRepos[i].cwd;
      o.textContent = bootedRepos[i].name;
      repoSelect.appendChild(o);
      if (saved && bootedRepos[i].cwd === saved) foundSaved = true;
    }
    var pick = foundSaved ? saved : bootedRepos[0].cwd;
    repoSelect.value = pick;
    selectRepo(pick);
  }
  function selectRepo(cwd) {
    current = { cwd: cwd };
    try { localStorage.setItem(REPO_KEY, cwd); } catch (_) {}
    lastState = lastMissions = lastLog = null;
    findingsOpen = reviewsOpen = false;
    findingsPanel.className = 'tw-panel collapsed';
    reviewsPanel.className = 'tw-panel collapsed';
    notReadyEl.hidden = true;
    setConn('open', '● ' + tr('tower.connecting'));
    refresh();
  }
  function discover() {
    setScan(true);
    api('/api/workspaces').then(function (data) {
      var workspaces = (data && data.workspaces) || [];
      var found = [];
      var probes = workspaces.map(function (w) {
        return api('/api/tower/state?workspace=' + encodeURIComponent(w.cwd))
          .then(function (st) {
            if (st && st.booted) found.push({ cwd: w.cwd, name: w.name || w.cwd });
          })
          .catch(function () {});
      });
      return Promise.all(probes).then(function () { return found; });
    }).then(function (found) {
      bootedRepos = found;
      setScan(false);
      if (!bootedRepos.length) {
        notReadyEl.hidden = false;
        setConn('connecting', '○ ' + tr('tower.noBooted'));
        return;
      }
      fillRepoOptions();
      startPolling();
    }).catch(function () {
      setScan(false);
      notReadyEl.hidden = false;
      setConn('error', '✗ ' + tr('tower.notReady'));
    });
  }

  if (repoSelect) repoSelect.addEventListener('change', function () {
    if (repoSelect.value) selectRepo(repoSelect.value);
  });
  if (findingsPanel) findingsPanel.querySelector('.tw-panel-head').addEventListener('click', function () {
    findingsOpen = !findingsOpen;
    findingsPanel.className = 'tw-panel' + (findingsOpen ? '' : ' collapsed');
    if (findingsOpen) loadFindings();
  });
  if (reviewsPanel) reviewsPanel.querySelector('.tw-panel-head').addEventListener('click', function () {
    reviewsOpen = !reviewsOpen;
    reviewsPanel.className = 'tw-panel' + (reviewsOpen ? '' : ' collapsed');
    if (reviewsOpen) loadReviews();
  });
  if (window.addEventListener) window.addEventListener('moamcp:localechange', function () {
    tr = window.__moaI18n ? window.__moaI18n.t : function (k) { return k; };
    renderAll();
  });

  discover();
})();
</script>
</body>
</html>
`;
