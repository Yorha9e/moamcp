import { TOKENS_CSS, THEME_BOOTSTRAP } from './tokens.js';
import { COMPONENTS_CSS } from './components.js';
import { LIB_JS } from './lib.js';
import { I18N_BOOTSTRAP, I18N_JS } from './i18n.js';
import { renderAppHeader } from './app-header.js';

export const DEBATE_CARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title data-i18n="debate.title">MOA Debate</title>
<style>
${TOKENS_CSS}
${COMPONENTS_CSS}

/* Debate Card Specific Styles */
.debate-context {
  display: flex;
  align-items: center;
  gap: var(--sp3);
  flex-wrap: wrap;
  margin-bottom: var(--sp4);
  padding: 9px 13px;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-1);
}
.debate-context .badge { margin-left: auto; }
.debate-content {
  max-width: 960px;
  margin: 0 auto;
}
#configBody {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  color: var(--text-dim);
  font-size: 13px;
}
#configBody b {
  color: var(--text);
  font-weight: 600;
}

#meta {
  display: flex;
  gap: 20px;
  color: var(--text-dim);
  font-size: 13px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
  font-variant-numeric: tabular-nums;
}
#meta b {
  color: var(--text);
  font-weight: 600;
}

#agents {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.agent {
  padding: 6px 13px;
  border-radius: var(--r-sm);
  background: var(--surface-strong);
  border: 1px solid var(--border-strong);
  font-family: var(--font-mono);
  font-size: 13px;
  transition: border-color var(--dur-med) var(--ease-out), color var(--dur-med) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.agent .sub {
  color: var(--text-faint);
  margin-left: 6px;
  font-size: 12px;
}
.agent.speaking {
  border-color: var(--accent-green);
  color: var(--accent-green);
  background: var(--tint-green);
  box-shadow: var(--glow-green);
  transform: translateY(-1px);
}
.agent.speaking .sub {
  color: var(--accent-green);
}
#empty {
  color: var(--text-faint);
  padding: 4px 0;
}

.omkc-scan {
  padding: 2px 9px;
  border-radius: var(--r-pill);
  background: var(--tint-amber);
  color: var(--accent-amber);
  font-size: 11px;
  letter-spacing: 0;
  text-transform: none;
}
.omkc-list {
  max-height: 280px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 6px;
}
.omkc-row {
  display: grid;
  grid-template-columns: minmax(110px, 1.1fr) minmax(130px, 1.4fr) 86px 100px minmax(120px, 1.5fr);
  gap: 10px;
  align-items: center;
  padding: 4px 9px;
  border-radius: var(--r-sm);
  transition: opacity var(--dur-med) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.omkc-row:hover {
  background: var(--hover-tint);
}
.omkc-row.stale {
  opacity: 0.4;
}
.omkc-row > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.omkc-row .omkc-id {
  color: var(--accent-blue);
}
.omkc-st {
  justify-self: start;
  padding: 1px 9px;
  border-radius: var(--r-pill);
  font-size: 11px;
  line-height: 18px;
}
.omkc-st.on {
  background: var(--tint-green);
  color: var(--accent-green);
}
.omkc-st.off {
  background: var(--surface-strong);
  color: var(--text-dim);
}
.omkc-tok {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.omkc-tool {
  color: var(--text-dim);
}
.omkc-tool.err {
  color: var(--accent-red);
}

.tool-log {
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 6px;
}
.tool-row {
  display: flex;
  gap: 10px;
  padding: 3px 9px;
  border-radius: var(--r-sm);
}
.tool-row:hover {
  background: var(--hover-tint);
}
.tool-ts {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.tool-agent {
  color: var(--accent-blue);
  min-width: 72px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-name {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-err {
  color: var(--accent-red);
  white-space: nowrap;
}
.tool-empty {
  color: var(--text-faint);
  padding: 4px 9px;
}

.round-sep {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-faint);
  font-size: 12px;
  margin: 18px 0 6px;
}
.round-sep:first-child {
  margin-top: 0;
}
.round-sep::before, .round-sep::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}
.turn {
  border-left: 3px solid var(--border-strong);
  padding: 9px 13px;
  margin: 10px 0;
  border-radius: 0 8px 8px 0;
  transition: background var(--dur-fast) var(--ease-out);
}
.turn:hover {
  background: var(--hover-tint-subtle);
}
.turn.signoff {
  border-left-color: var(--accent-green);
  background: var(--tint-green-soft);
}
.turn .head {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 5px;
}
.turn .who {
  color: var(--accent-blue);
  font-family: var(--font-mono);
}
.turn .text {
  white-space: pre-wrap;
  word-break: break-word;
}
.signoff-badge {
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--tint-green);
  color: var(--accent-green);
  font-size: 11px;
  border: 1px solid var(--tint-green-border);
  white-space: nowrap;
}
.transcript-empty {
  color: var(--text-faint);
  font-size: 13px;
}
.early-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: var(--r-pill);
  background: var(--tint-blue);
  color: var(--accent-blue);
  font-size: 12px;
  margin-right: 8px;
}

#verdict {
  border-color: var(--tint-green-border);
  background: var(--solid);
  box-shadow: var(--glow-green-verdict), var(--shadow-2);
}
#verdict h2 {
  font-size: 13px;
  color: var(--accent-green);
  margin-bottom: 10px;
  letter-spacing: 0.14em;
  font-weight: 700;
}
#verdict .row {
  font-size: 13px;
  color: var(--text-dim);
  margin-bottom: 4px;
}
#verdict .row b {
  color: var(--text);
  font-weight: 600;
}
#verdictFindings {
  margin: 10px 0;
  border-top: 1px dashed var(--tint-green-border-soft);
  padding-top: 10px;
}
.findings-head {
  font-size: 12px;
  color: var(--accent-green);
  font-family: var(--font-mono);
  margin-bottom: 5px;
}
.findings-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  color: var(--text-dim);
  max-height: 240px;
  overflow-y: auto;
  background: var(--solid-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 10px;
}
#fullBtn {
  margin-top: 10px;
  padding: 5px 15px;
  border-radius: var(--r-sm);
  border: 1px solid var(--tint-green-border);
  background: transparent;
  color: var(--accent-green);
  font-size: 12px;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
#fullBtn:hover {
  background: var(--tint-green);
  box-shadow: var(--glow-green-btn);
}

#picker h2 {
  font-size: 14px;
  color: var(--text);
  margin-bottom: 10px;
}
.task-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 9px 13px;
  margin: 6px 0;
  border-radius: var(--r-sm);
  border: 1px solid var(--border-strong);
  background: var(--surface-strong);
  color: var(--accent-blue);
  font-family: var(--font-mono);
  font-size: 13px;
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.task-item:hover {
  border-color: var(--tint-green-border-strong);
  color: var(--accent-green);
  transform: translateY(-1px);
}
</style>
${THEME_BOOTSTRAP}
${I18N_BOOTSTRAP}
</head>
<body>
<div class="aurora-bg"></div>
<div class="shell">
  ${renderAppHeader('debate')}
  <div class="debate-context" aria-label="Current debate context" data-i18n-aria="debate.context">
    <span class="task" id="taskId"></span>
    <span id="conn"></span>
    <span class="badge" id="badge" data-i18n="debate.connecting">connecting</span>
  </div>
  <div class="debate-content">
  <div class="card" id="picker" hidden>
    <h2 data-i18n="debate.activeTasks">Active tasks</h2>
    <div id="pickerList"><span class="hint" data-i18n="debate.loading">Loading…</span></div>
  </div>
  <div class="card" id="progressCard">
    <div class="sec-title"><span data-i18n="debate.progress">Stage Progress</span><span class="aux hint" id="stageHint" data-i18n="debate.waitInit">Waiting for task initialization…</span></div>
    <div id="progress">
      <span class="step" id="st0" data-tip="Consensus — prepare file consensus · Select for details" data-i18n-tip="debate.stage.consensusTip" data-i18n-aria="debate.stage.consensusTip" aria-label="Consensus — prepare file consensus · Select for details" role="button" tabindex="0" aria-controls="stageDetail" aria-expanded="false"><span class="dot"></span><span class="lb" data-i18n="debate.stage.consensus">Consensus</span></span><span class="link" id="lk0"></span>
      <span class="step" id="st1" data-tip="Reference — reference pool · Select for details" data-i18n-tip="debate.stage.referenceTip" data-i18n-aria="debate.stage.referenceTip" aria-label="Reference — reference pool · Select for details" role="button" tabindex="0" aria-controls="stageDetail" aria-expanded="false"><span class="dot"></span><span class="lb" data-i18n="debate.stage.reference">Reference</span></span><span class="link" id="lk1"></span>
      <span class="step" id="st2" data-tip="Debate — debaters take turns · Select for details" data-i18n-tip="debate.stage.debateTip" data-i18n-aria="debate.stage.debateTip" aria-label="Debate — debaters take turns · Select for details" role="button" tabindex="0" aria-controls="stageDetail" aria-expanded="false"><span class="dot"></span><span class="lb" id="st2lb">Debate</span></span><span class="link" id="lk2"></span>
      <span class="step" id="st3" data-tip="Aggregate — synthesize the verdict · Select for details" data-i18n-tip="debate.stage.aggregateTip" data-i18n-aria="debate.stage.aggregateTip" aria-label="Aggregate — synthesize the verdict · Select for details" role="button" tabindex="0" aria-controls="stageDetail" aria-expanded="false"><span class="dot"></span><span class="lb" data-i18n="debate.stage.aggregate">Aggregate</span></span><span class="link" id="lk3"></span>
      <span class="step" id="st4" data-tip="Verdict — VERDICT output · Select for details" data-i18n-tip="debate.stage.verdictTip" data-i18n-aria="debate.stage.verdictTip" aria-label="Verdict — VERDICT output · Select for details" role="button" tabindex="0" aria-controls="stageDetail" aria-expanded="false"><span class="dot"></span><span class="lb" data-i18n="debate.stage.verdict">Verdict</span></span>
    </div>
    <div id="stageDetail" role="region" aria-live="polite" hidden></div>
  </div>
  <div class="card" id="config">
    <div class="sec-title" data-i18n="debate.modeConfig">Mode / Configuration</div>
    <div id="configBody"><span class="hint" data-i18n="debate.waitTaskEvent">Waiting for task_initialized…</span></div>
    <div id="meta">
      <span><span data-i18n="debate.round">Round</span> <b id="round">–</b> / <b id="rounds">–</b></span>
      <span><span data-i18n="debate.speaker">Speaker</span> <b id="speaker">–</b></span>
      <span><span data-i18n="debate.turns">Turns</span> <b id="turns">0</b></span>
    </div>
  </div>
  <div class="card" id="agentsCard">
    <div class="sec-title" data-i18n="debate.debaters">Debaters</div>
    <div id="agents"></div>
  </div>
  <div class="card" id="omkcCard" hidden>
    <div class="sec-title"><span data-i18n="debate.agentStatus">Agent Status</span><span class="omkc-scan" id="omkcScan" hidden></span><span class="aux hint" id="omkcCount"></span></div>
    <div class="omkc-list" id="omkcAgents"></div>
  </div>
  <div class="card" id="transcriptCard">
    <div class="sec-title" data-i18n="debate.transcript">Debate Transcript</div>
    <div id="transcript"><span class="transcript-empty" data-i18n="debate.noTurns">No turns yet. Waiting for the debate to start…</span></div>
  </div>
  <div class="card" id="verdict" hidden>
    <h2>VERDICT</h2>
    <div class="row" id="verdictBody"></div>
    <div id="verdictFindings"></div>
    <div class="row" id="verdictStats"></div>
    <button id="fullBtn" hidden data-i18n="debate.fullTranscript">Load Full Transcript</button>
  </div>
  <div class="card" id="omkcToolsCard" hidden>
    <div class="sec-title"><span data-i18n="debate.toolLog">Tool Call Log</span><span class="aux hint" id="toolCount"></span></div>
    <div class="tool-log" id="toolLog"><span class="tool-empty" data-i18n="debate.waitTools">Waiting for tool calls…</span></div>
  </div>
  </div>
</div>
<script>
${I18N_JS}
${LIB_JS}
(function () {
  'use strict';
  var tr = window.__moaI18n ? window.__moaI18n.t : function (key) { return key; };
  var taskId = new URLSearchParams(location.search).get('task_id') || '';
  document.getElementById('taskId').textContent = taskId || tr('debate.noTask');
  var agents = [], turns = 0, rounds = '–', curRound = '–', lastRound = 0, speaking = null;
  var badge = document.getElementById('badge');
  var curBadgeKey = 'debate.connecting', curBadgeCls = '';
  function setBadge(text, cls, key) {
    if (key) curBadgeKey = key;
    badge.textContent = text;
    if (cls != null) { curBadgeCls = cls; badge.className = 'badge ' + cls; }
  }

  var STEPS = 5;
  var STAGE_KEYS = ['debate.stage.consensus', 'debate.stage.reference', 'debate.stage.debate', 'debate.stage.aggregate', 'debate.stage.verdict'];
  var stageNow = 0;
  var stageEnteredAt = [null, null, null, null, null];
  function setStage(n, ts) {
    stageNow = n;
    var entered = ts || new Date().toISOString();
    if (n >= STEPS) { if (!stageEnteredAt[STEPS - 1]) stageEnteredAt[STEPS - 1] = entered; }
    else if (!stageEnteredAt[n]) stageEnteredAt[n] = entered;
    for (var i = 0; i < STEPS; i++) {
      document.getElementById('st' + i).className = 'step' + (i < n ? ' done' : i === n ? ' active' : '');
      if (i < STEPS - 1) document.getElementById('lk' + i).className = 'link' + (i < n ? ' done' : '');
    }
    document.getElementById('stageHint').textContent =
      n >= STEPS ? tr('debate.allComplete') : tr('debate.currentStage', { stage: tr(STAGE_KEYS[n]) });
    if (detailOpen >= 0) renderStageDetail(detailOpen);
  }
  function setDebateLabel() {
    var label = tr('debate.stage.debate');
    document.getElementById('st2lb').textContent = rounds === '–' ? label : label + ' ' + curRound + '/' + rounds;
  }

  var STAGE_NAMES = STAGE_KEYS;
  var STAGE_TARGETS = ['config', 'agentsCard', 'transcriptCard', 'verdict', 'verdict'];
  var initExtras = null;
  var verdictSummary = '';
  var detailOpen = -1;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtClock(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function refSnippet() {
    var rr = initExtras ? initExtras.reference_results : null;
    if (rr == null) return null;
    var s = typeof rr === 'string' ? rr : JSON.stringify(rr);
    if (s == null) return null;
    return s.length > 500 ? s.slice(0, 500) + '…' : s;
  }
  function stageDetail(i) {
    var state = i < stageNow ? 'done' : (i === stageNow ? 'active' : 'pending');
    var at = tr('debate.enteredAt', { time: fmtClock(stageEnteredAt[i]) });
    if (state === 'pending') return { state: 'pending', text: tr('debate.notStarted', { reason: tr('debate.pending.' + i) }) };
    if (i === 0) return { state: state, text: at + ' · ' + tr(state === 'done' ? 'debate.consensusDone' : 'debate.consensusActive') };
    if (i === 1) {
      var ref = refSnippet();
      return { state: state, text: at + ' · ' + (ref != null ? tr('debate.referenceSummary', { value: ref }) : tr('debate.referenceMissing')) };
    }
    if (i === 2) return { state: state, text: tr('debate.roundDetail', { round: curRound, rounds: rounds, speaker: speaking || '–', turns: turns }) };
    if (i === 3) return { state: state, text: at + ' (debate_complete) · ' + tr(state === 'done' ? 'debate.aggregateDone' : 'debate.aggregateActive') };
    return { state: state, text: verdictSummary || (at + ' · ' + tr('debate.verdictLoading')) };
  }
  function renderStageDetail(i) {
    var box = document.getElementById('stageDetail');
    box.textContent = '';
    var info = stageDetail(i);
    var name = document.createElement('span');
    name.className = 'sd-name';
    name.textContent = tr(STAGE_NAMES[i]);
    var chip = document.createElement('span');
    chip.className = 'sd-state ' + info.state;
    chip.textContent = tr('debate.state.' + info.state);
    var text = document.createElement('span');
    text.className = 'sd-text';
    text.textContent = info.text;
    box.appendChild(name);
    box.appendChild(chip);
    box.appendChild(text);
  }
  function syncStepAria() {
    for (var i = 0; i < STEPS; i++) {
      document.getElementById('st' + i).setAttribute('aria-expanded', detailOpen === i ? 'true' : 'false');
    }
  }
  function closeStageDetail() {
    if (detailOpen < 0) return;
    detailOpen = -1;
    document.getElementById('stageDetail').hidden = true;
    syncStepAria();
  }
  function refreshDetailIfOpen(i) { if (detailOpen === i) renderStageDetail(i); }
  function flashCard(el) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    el.addEventListener('animationend', function done() {
      el.classList.remove('flash');
      el.removeEventListener('animationend', done);
    });
  }
  function toggleStage(i) {
    if (detailOpen === i) { closeStageDetail(); return; }
    detailOpen = i;
    renderStageDetail(i);
    document.getElementById('stageDetail').hidden = false;
    syncStepAria();
    var target = document.getElementById(STAGE_TARGETS[i]);
    if (target && !target.hidden) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      flashCard(target);
    }
  }
  for (var si = 0; si < STEPS; si++) {
    (function (i) {
      var el = document.getElementById('st' + i);
      el.addEventListener('click', function () { toggleStage(i); });
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleStage(i); }
      });
    })(si);
  }
  function isStepOrDetail(t) {
    var p = t;
    var detail = document.getElementById('stageDetail');
    while (p && p !== document.body) {
      if (p === detail) return true;
      if (p.className && typeof p.className === 'string' && p.className.indexOf('step') !== -1) return true;
      p = p.parentNode;
    }
    return false;
  }
  document.addEventListener('click', function (ev) {
    if (detailOpen < 0) return;
    if (!isStepOrDetail(ev.target)) closeStageDetail();
  });

  function renderConfig(extras) {
    var box = document.getElementById('configBody');
    box.textContent = '';
    function row(k, v) {
      var s = document.createElement('span');
      s.appendChild(document.createTextNode(k + ' '));
      var b = document.createElement('b');
      b.textContent = v;
      s.appendChild(b);
      box.appendChild(s);
    }
    row('agents', String(agents.length));
    row('rounds', String(rounds));
    if (extras) {
      for (var k in extras) {
        if (extras[k] == null) continue;
        var v = typeof extras[k] === 'string' ? extras[k] : JSON.stringify(extras[k]);
        if (v.length > 80) v = v.slice(0, 80) + '…';
        row(k, v);
      }
    }
  }
  function renderAgents() {
    var box = document.getElementById('agents');
    box.textContent = '';
    if (!agents.length) {
      var empty = document.createElement('span');
      empty.id = 'empty';
      empty.textContent = tr('debate.waitTaskEvent');
      box.appendChild(empty);
      return;
    }
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      var chip = document.createElement('span');
      chip.className = 'agent' + (a.id === speaking ? ' speaking' : '');
      chip.appendChild(document.createTextNode(a.id));
      var sub = document.createElement('span');
      sub.className = 'sub';
      var label = a.id === speaking ? tr('debate.speaking') : (a.turns > 0 ? tr(a.turns === 1 ? 'debate.turnCount' : 'debate.turnCountPlural', { count: a.turns }) : tr('debate.waiting'));
      sub.textContent = (a.tag ? a.tag + ' · ' : '') + label;
      chip.appendChild(sub);
      box.appendChild(chip);
    }
  }
  function setMeta(round, speaker) {
    document.getElementById('round').textContent = round;
    document.getElementById('rounds').textContent = rounds;
    document.getElementById('speaker').textContent = speaker || '–';
    document.getElementById('turns').textContent = String(turns);
  }

  function clearTranscriptEmpty() {
    var box = document.getElementById('transcript');
    var placeholder = box.querySelector('.transcript-empty');
    if (placeholder) box.removeChild(placeholder);
  }
  function addRoundSep(round) {
    var div = document.createElement('div');
    div.className = 'round-sep';
    div.textContent = 'Round ' + round;
    document.getElementById('transcript').appendChild(div);
  }
  function addTurn(who, round, turn, text, ts, signoff) {
    clearTranscriptEmpty();
    if (round !== lastRound) { lastRound = round; addRoundSep(round); }
    var div = document.createElement('div');
    div.className = 'turn' + (signoff ? ' signoff' : '');
    var head = document.createElement('div');
    head.className = 'head';
    var w = document.createElement('span');
    w.className = 'who';
    w.textContent = who == null ? '–' : String(who);
    if (signoff) {
      var sb = document.createElement('span');
      sb.className = 'signoff-badge';
      sb.textContent = tr('debate.signoff');
      head.appendChild(w);
      head.appendChild(sb);
    } else {
      head.appendChild(w);
    }
    var meta = document.createElement('span');
    meta.textContent = 'round ' + round + ' · turn ' + turn;
    head.appendChild(meta);
    if (ts) {
      var t = document.createElement('span');
      t.textContent = String(ts);
      head.appendChild(t);
    }
    var body = document.createElement('div');
    body.className = 'text';
    body.textContent = text || '';
    div.appendChild(head);
    div.appendChild(body);
    document.getElementById('transcript').appendChild(div);
    div.scrollIntoView({ block: 'nearest' });
  }
  function bumpAgent(id) {
    for (var i = 0; i < agents.length; i++) if (agents[i].id === id) agents[i].turns++;
  }

  function loadArchive(file, cb) {
    fetch('/archive?task_id=' + encodeURIComponent(taskId) + '&file=' + file)
      .then(function (r) { return r.ok ? r.text() : Promise.reject(r.status); })
      .then(cb)
      .catch(function () {});
  }
  function putStat(box, k, v) {
    box.appendChild(document.createTextNode(k + ' '));
    var b = document.createElement('b');
    b.textContent = v;
    box.appendChild(b);
    box.appendChild(document.createTextNode(' · '));
  }
  function onClosed(e) {
    speaking = null; renderAgents(); setBadge(tr('debate.closed'), 'closed', 'debate.closed');
    verdictSummary = tr('debate.archiveWritten', { archive: e.archive || 'logs/' + taskId });
    setStage(STEPS, e.ts);
    document.getElementById('verdict').hidden = false;
    loadArchive('result.json', function (text) {
      var r;
      try { r = JSON.parse(text); } catch (_) { return; }
      var vb = document.getElementById('verdictBody');
      vb.textContent = '';
      if (r.early === true) {
        var eb = document.createElement('span');
        eb.className = 'early-badge';
        eb.textContent = tr('debate.earlyClose') + ' · ' + (r.reason || 'unanimous_signoff');
        vb.appendChild(eb);
      }
      putStat(vb, tr('common.status'), r.status || '–');
      putStat(vb, tr('debate.roundsLabel'), (r.rounds_completed != null ? r.rounds_completed : '–') + ' / ' + (r.rounds_configured != null ? r.rounds_configured : '–'));
      putStat(vb, tr('debate.turnsLabel'), r.turns != null ? String(r.turns) : '–');
      var statsText = tr('debate.finishedAt') + ' ' + (r.finished_at || '–') + ' · ' + tr('debate.archive') + ': ' + (e.archive || 'logs/' + taskId);
      if (r.signoffs && typeof r.signoffs === 'object') {
        var signers = Object.keys(r.signoffs);
        if (signers.length) statsText += ' · ✍ ' + tr('debate.signers') + ': ' + signers.join(', ');
      }
      document.getElementById('verdictStats').textContent = statsText;
      document.getElementById('fullBtn').hidden = false;
      verdictSummary = (r.early === true ? tr('debate.earlyClose') + ' · ' : 'VERDICT · ') + tr('common.status') + ' ' + (r.status || '–') + ' · ' + tr('debate.roundsLabel') + ' ' +
        (r.rounds_completed != null ? r.rounds_completed : '–') + '/' +
        (r.rounds_configured != null ? r.rounds_configured : '–') + ' · ' + tr('debate.turnsLabel') + ' ' +
        (r.turns != null ? r.turns : '–');
      refreshDetailIfOpen(4);
    });
    loadArchive('events.jsonl', function (text) {
      var lines = text.split('\\n');
      for (var i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        var t;
        try { t = JSON.parse(lines[i]); } catch (_) { continue; }
        var box = document.getElementById('verdictFindings');
        box.textContent = '';
        var h = document.createElement('div');
        h.className = 'findings-head';
        h.textContent = 'FINDINGS · ' + (t.speaker || '–') + ' · round ' + (t.round != null ? t.round : '–');
        var c = document.createElement('div');
        c.className = 'findings-text';
        var content = String(t.content || '');
        c.textContent = content.length > 1200 ? content.slice(0, 1200) + '…' : content;
        box.appendChild(h);
        box.appendChild(c);
        break;
      }
    });
  }
  document.getElementById('fullBtn').addEventListener('click', function () {
    this.hidden = true;
    loadArchive('events.jsonl', function (text) {
      document.getElementById('transcript').textContent = '';
      lastRound = 0;
      var lines = text.split('\\n');
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        try {
          var t = JSON.parse(lines[i]);
          addTurn(t.speaker, t.round, t.turn, t.content, t.timestamp, t.signoff === true);
        } catch (_) {}
      }
    });
  });

  function onEvent(e) {
    if (e.type === 'task_initialized') {
      var specs = e.agent_specs || (e.agents || []).map(function (id) { return { id: id }; });
      agents = specs.map(function (s) {
        return { id: s.id, tag: s.role || s.model || s.binding_slot || '', turns: 0 };
      });
      rounds = e.rounds || '–';
      curRound = '–';
      speaking = null;
      initExtras = e.extras || null;
      renderAgents(); renderConfig(e.extras); setMeta('–', null);
      setDebateLabel(); setStage(1, e.ts); setBadge(tr('debate.initialized'), 'live', 'debate.initialized');
    } else if (e.type === 'debate_started') {
      rounds = e.rounds || rounds;
      curRound = 1;
      setDebateLabel(); setMeta(1, null); setStage(2, e.ts); setBadge(tr('debate.debating'), 'live', 'debate.debating');
    } else if (e.type === 'turn_submitted') {
      turns++; bumpAgent(e.agent_id); speaking = null;
      addTurn(e.agent_id, e.round, e.turn, e.content || e.excerpt, e.ts, e.signoff === true);
      renderAgents();
      curRound = e.round; setDebateLabel(); setMeta(e.round, null);
      refreshDetailIfOpen(2);
    } else if (e.type === 'turn_advanced') {
      speaking = e.speaker;
      renderAgents();
      curRound = e.round; setDebateLabel(); setMeta(e.round, e.speaker);
      refreshDetailIfOpen(2);
    } else if (e.type === 'debate_complete') {
      speaking = null; renderAgents(); setStage(3, e.ts); setBadge(tr('debate.debateComplete'), 'done', 'debate.debateComplete');
      document.getElementById('verdict').hidden = false;
      var vbLive = document.getElementById('verdictBody');
      vbLive.textContent = '';
      if (e.early === true) {
        var ebLive = document.createElement('span');
        ebLive.className = 'early-badge';
        ebLive.textContent = tr('debate.earlyClose');
        vbLive.appendChild(ebLive);
      }
      vbLive.appendChild(document.createTextNode(
        tr('debate.roundsLabel') + ': ' + (e.rounds || '–') + ' · ' + tr('debate.turnsLabel') + ': ' + (e.turns || turns) +
        (e.early === true ? ' · reason: ' + (e.reason || 'unanimous_signoff') : '') +
        ' — ' + tr('debate.archivedAfterComplete')));
    } else if (e.type === 'signoff_reset') {
      document.getElementById('stageHint').textContent = tr('debate.signoffReset', { agent: e.agent_id || '–' });
      refreshDetailIfOpen(2);
    } else if (e.type === 'task_closed') {
      onClosed(e);
    }
  }

  var pickerSig = null, pickerErrShown = false;
  function renderPickerList(tasks) {
    var list = document.getElementById('pickerList');
    list.textContent = '';
    if (!tasks.length) {
      var hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = tr('debate.noActiveTasks');
      list.appendChild(hint);
      return;
    }
    tasks.forEach(function (id) {
      var btn = document.createElement('button');
      btn.className = 'task-item';
      btn.textContent = id;
      btn.addEventListener('click', function () {
        location.href = '/?task_id=' + encodeURIComponent(id);
      });
      list.appendChild(btn);
    });
  }
  function refreshTasks() {
    fetch('/tasks')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var tasks = (data && data.tasks) || [];
        var sig = JSON.stringify(tasks);
        if (sig === pickerSig && !pickerErrShown) return;
        pickerSig = sig;
        pickerErrShown = false;
        renderPickerList(tasks);
      })
      .catch(function () {
        if (pickerErrShown) return;
        pickerErrShown = true;
        var list = document.getElementById('pickerList');
        list.textContent = '';
        var hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = tr('debate.tasksError');
        list.appendChild(hint);
      });
  }
  function showPicker() {
    ['progressCard', 'config', 'agentsCard', 'transcriptCard', 'verdict'].forEach(function (id) {
      document.getElementById(id).hidden = true;
    });
    document.getElementById('picker').hidden = false;
    refreshTasks();
    setInterval(refreshTasks, 3000);
  }

  var OMKC = 'http://127.0.0.1:39627';
  var omkcRows = new Map();
  var toolSeen = new Map();
  var omkcEs = null, omkcFails = 0, omkcReprobe = null, omkcHealthPoll = null;

  function fetchWithTimeout(url, ms) {
    return new Promise(function (resolve, reject) {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); reject(new Error('timeout')); }, ms);
      fetch(url, { signal: ctrl.signal }).then(function (r) {
        clearTimeout(timer);
        resolve(r);
      }, function (err) {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
  function probeOmkc() {
    return fetchWithTimeout(OMKC + '/health', 500).then(function (r) {
      if (!r.ok) throw new Error('health HTTP ' + r.status);
      return r.json();
    }).then(function (h) {
      if (!h || h.ok !== true) throw new Error('not omkc-status');
      return h;
    });
  }
  function omkcShow(on) {
    document.getElementById('omkcCard').hidden = !on;
    document.getElementById('omkcToolsCard').hidden = !on;
  }
  function setOmkcScan(scanning) {
    var chip = document.getElementById('omkcScan');
    chip.hidden = !scanning;
    chip.textContent = tr('debate.scanning');
  }
  function omkcKey(a) { return (a.sessionId || '') + ':' + (a.agentId || ''); }
  function fmtTok(n) {
    n = Number(n);
    if (!isFinite(n)) return '–';
    return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n);
  }
  function fillAgentRow(el, a) {
    var cells = el.children;
    cells[0].textContent = String(a.agentId || '?') + (a.kind === 'sub' ? ' ⤷' : '');
    cells[0].title = (a.sessionId || '') + (a.home ? ' @ ' + a.home : '');
    cells[1].textContent = a.model || '–';
    var busyish = a.busy === true || (!!a.phase && a.phase !== 'idle' && a.phase !== 'completed' && a.phase !== 'suspended');
    cells[2].textContent = a.phase || (a.busy ? 'busy' : 'idle');
    cells[2].className = 'omkc-st ' + (busyish ? 'on' : 'off');
    cells[3].textContent = a.contextTokens != null
      ? fmtTok(a.contextTokens) + ' / ' + fmtTok(a.maxContextTokens)
      : '–';
    var tc = a.lastToolCall;
    if (tc && tc.name) {
      cells[4].textContent = String(tc.name) + (tc.isError ? ' ✗' : '');
      cells[4].className = 'omkc-tool' + (tc.isError ? ' err' : '');
    } else {
      cells[4].textContent = '–';
      cells[4].className = 'omkc-tool';
    }
    if (a.stale) el.classList.add('stale'); else el.classList.remove('stale');
  }
  function newRow() {
    var el = document.createElement('div');
    el.className = 'omkc-row';
    for (var i = 0; i < 5; i++) {
      var c = document.createElement('span');
      if (i === 0) c.className = 'omkc-id';
      if (i === 3) c.className = 'omkc-tok';
      el.appendChild(c);
    }
    return el;
  }
  function upsertAgent(a) {
    if (!a || typeof a !== 'object' || !a.agentId) return;
    var key = omkcKey(a);
    var el = omkcRows.get(key);
    if (!el) {
      el = newRow();
      omkcRows.set(key, el);
      var box = document.getElementById('omkcAgents');
      box.insertBefore(el, box.firstChild);
    }
    fillAgentRow(el, a);
    maybeLogTool(key, a, false);
  }
  function applyOmkcSnapshot(snap) {
    var list = (snap && snap.agents) || [];
    if (!list.length) return;
    omkcRows.clear();
    var box = document.getElementById('omkcAgents');
    box.textContent = '';
    var sorted = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a && typeof a === 'object' && a.agentId) sorted.push(a);
    }
    sorted.sort(function (x, y) { return (y.lastSeen || 0) - (x.lastSeen || 0); });
    var frag = document.createDocumentFragment();
    for (var j = 0; j < sorted.length; j++) {
      var el = newRow();
      omkcRows.set(omkcKey(sorted[j]), el);
      fillAgentRow(el, sorted[j]);
      frag.appendChild(el);
      maybeLogTool(omkcKey(sorted[j]), sorted[j], true);
    }
    box.appendChild(frag);
    document.getElementById('omkcCount').textContent = tr('debate.agentCount', { count: sorted.length });
    setOmkcScan(!!(snap.scan && snap.scan.scanning === true));
  }
  function maybeLogTool(key, a, seed) {
    var tc = a.lastToolCall;
    if (!tc || !tc.name || !tc.ts) return;
    var last = toolSeen.get(key) || 0;
    if (tc.ts <= last) return;
    if (seed && Date.now() - Number(tc.ts) > 5 * 60 * 1000) return;
    toolSeen.set(key, Number(tc.ts));
    addToolRow(a, tc, seed);
  }
  function addToolRow(a, tc, seed) {
    var box = document.getElementById('toolLog');
    var placeholder = box.querySelector('.tool-empty');
    if (placeholder) box.removeChild(placeholder);
    var row = document.createElement('div');
    row.className = 'tool-row';
    var t = document.createElement('span');
    t.className = 'tool-ts';
    var d = new Date(Number(tc.ts));
    t.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    var who = document.createElement('span');
    who.className = 'tool-agent';
    who.textContent = String(a.agentId || '?');
    var name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = String(tc.name) + (tc.description ? ' — ' + String(tc.description) : '');
    row.appendChild(t);
    row.appendChild(who);
    row.appendChild(name);
    if (tc.isError) {
      var err = document.createElement('span');
      err.className = 'tool-err';
      err.textContent = tr('debate.error');
      row.appendChild(err);
    }
    if (seed) box.appendChild(row);
    else box.insertBefore(row, box.firstChild);
    while (box.children.length > 150) box.removeChild(box.lastChild);
    document.getElementById('toolCount').textContent = tr('debate.toolCount', { count: box.children.length });
  }
  function omkcConnect() {
    if (omkcEs) { omkcEs.close(); omkcEs = null; }
    omkcEs = new EventSource(OMKC + '/events');
    omkcEs.addEventListener('snapshot', function (m) {
      omkcFails = 0;
      try { applyOmkcSnapshot(JSON.parse(m.data)); } catch (_) {}
    });
    omkcEs.addEventListener('agent', function (m) {
      omkcFails = 0;
      try { upsertAgent(JSON.parse(m.data)); } catch (_) {}
    });
    omkcEs.onerror = function () {
      if (omkcEs) { omkcEs.close(); omkcEs = null; }
      omkcFails++;
      if (omkcFails < 3) { setTimeout(omkcConnect, 1000); return; }
      omkcShow(false);
      setOmkcScan(false);
      if (!omkcReprobe) {
        omkcReprobe = setInterval(function () {
          probeOmkc().then(function () {
            clearInterval(omkcReprobe);
            omkcReprobe = null;
            omkcFails = 0;
            omkcShow(true);
            omkcConnect();
          }, function () {});
        }, 30000);
      }
    };
  }

  probeOmkc().then(function () {
    omkcShow(true);
    omkcConnect();
    if (!omkcHealthPoll) {
      omkcHealthPoll = window.__moaLib.startPoll(function () {
        if (!omkcEs) return;
        probeOmkc().then(function (h) { setOmkcScan(h.scanning === true); }, function () {});
      }, window.__moaLib.POLL_MS.sseFallback);
    }
  }, function () {});

  var gotAny = false, waitingShown = false;
  function setConn(text) { document.getElementById('conn').textContent = text; }
  function showWaitingHint(force) {
    if (waitingShown && !force) return;
    waitingShown = true;
    setBadge(tr('debate.waitingBadge'), '', 'debate.waitingBadge');
    var box = document.getElementById('configBody');
    box.textContent = '';
    var span = document.createElement('span');
    span.className = 'hint';
    span.appendChild(document.createTextNode(tr('debate.connectedNoEventsBefore')));
    var b = document.createElement('b');
    b.textContent = taskId;
    span.appendChild(b);
    span.appendChild(document.createTextNode(tr('debate.connectedNoEventsAfter') + ' '));
    var a = document.createElement('a');
    a.href = '/';
    a.style.color = 'var(--link-soft)';
    a.textContent = tr('debate.backToTasks');
    span.appendChild(a);
    box.appendChild(span);
  }
  if (window.addEventListener) window.addEventListener('moamcp:localechange', function () {
    tr = window.__moaI18n.t;
    if (!taskId) {
      setBadge(tr('debate.pickTask'), '', 'debate.pickTask');
      if (pickerSig) { try { renderPickerList(JSON.parse(pickerSig)); } catch (_) {} }
    } else {
      setDebateLabel(); setStage(stageNow); renderAgents();
      if (curBadgeKey) setBadge(tr(curBadgeKey), curBadgeCls, curBadgeKey);
      if (waitingShown && !gotAny) showWaitingHint(true);
      var signoffs = document.querySelectorAll('.signoff-badge');
      for (var i = 0; i < signoffs.length; i++) signoffs[i].textContent = tr('debate.signoff');
      var errors = document.querySelectorAll('.tool-err');
      for (var j = 0; j < errors.length; j++) errors[j].textContent = tr('debate.error');
    }
  });
  if (!taskId) { setBadge(tr('debate.pickTask'), '', 'debate.pickTask'); showPicker(); return; }

  renderAgents();
  setStage(0);
  setDebateLabel();
  /* Shared lib.ts connectSSE: the same 3-fail backoff reconnect this page
     used to hand-roll; the waiting hint still arms 3s after every open.
     'connecting' is skipped so #conn stays empty until the stream opens
     or errors, exactly as with the hand-rolled version. */
  window.__moaLib.connectSSE('/subscribe?task_id=' + encodeURIComponent(taskId), function (data) {
    gotAny = true;
    onEvent(data);
  }, function (state, msg) {
    if (state === 'connecting') return;
    setConn(msg);
    if (state === 'open') {
      setTimeout(function () {
        if (!gotAny) showWaitingHint();
      }, 3000);
    }
  });
})();
</script>
</body>
</html>
`;
