import { TOKENS_CSS, THEME_BOOTSTRAP } from './tokens.js';
import { COMPONENTS_CSS } from './components.js';
import { LIB_JS } from './lib.js';
import { I18N_BOOTSTRAP, I18N_JS } from './i18n.js';
import { renderAppHeader } from './app-header.js';
import { STATUS_MODEL_JS } from './status-model.js';

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
/* Live dot: mirrors status-board's .sb-live (pulse when open, static grey when off). */
.dc-live {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-green);
  box-shadow: var(--glow-ring);
  animation: dcPulse 2s ease-in-out infinite;
  flex: 0 0 auto;
}
.dc-live.off {
  background: var(--text-faint);
  box-shadow: none;
  animation: none;
}
@keyframes dcPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.5); }
  50% { box-shadow: 0 0 0 5px rgba(52, 211, 153, 0); }
}
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
  gap: 2px;
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 6px;
}
/* Session group head: home badge + workDir / short session id. */
.omkc-session {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 3px 0 1px;
  padding: 3px 9px;
  border-bottom: 1px dashed var(--border);
  font-size: 11px;
  color: var(--text-faint);
}
.omkc-session:first-child {
  margin-top: 0;
}
.omkc-home {
  flex: 0 0 auto;
  padding: 0 8px;
  border-radius: var(--r-pill);
  font-size: 10px;
  line-height: 16px;
  background: var(--surface-strong);
  color: var(--text-dim);
}
.omkc-session-dir {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* F7: session-gone marker on the group head (ended sessions keep their rows). */
.omkc-ended {
  flex: 0 0 auto;
  padding: 0 7px;
  border-radius: var(--r-pill);
  font-size: 10px;
  line-height: 16px;
  background: var(--tint-red);
  color: var(--accent-red);
  white-space: nowrap;
}
.omkc-row {
  display: grid;
  grid-template-columns: minmax(170px, 1.5fr) minmax(120px, 1.2fr) 86px 100px minmax(120px, 1.4fr);
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
/* Debate-mapped sub row: accent highlight (spec chip rides in the id cell). */
.omkc-row.matched {
  background: var(--tint-green-soft);
}
.omkc-row > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.omkc-row .omkc-id {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: visible;
  color: var(--accent-blue);
}
.omkc-row.matched .omkc-id {
  color: var(--accent-green);
}
.omkc-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Sub rows: indent + CSS tree connector (vertical line + └ glyph). */
.omkc-row.sub {
  position: relative;
  padding-left: 22px;
}
.omkc-row.sub::before {
  content: '';
  position: absolute;
  left: 10px;
  top: 4px;
  bottom: 4px;
  border-left: 1px solid var(--border);
}
.omkc-guide {
  flex: 0 0 auto;
  color: var(--text-faint);
  font-size: 10px;
}
.omkc-badge {
  flex: 0 0 auto;
  padding: 0 7px;
  border-radius: var(--r-pill);
  font-size: 10px;
  line-height: 16px;
  background: var(--tint-blue);
  color: var(--accent-blue);
  white-space: nowrap;
}
.omkc-badge.orchestrator {
  background: var(--tint-green);
  color: var(--accent-green);
}
/* Subagent type name (resolved from the parent's subagents[] list). */
.omkc-type {
  flex: 0 0 auto;
  max-width: 110px;
  padding: 0 7px;
  border-radius: var(--r-pill);
  font-size: 10px;
  line-height: 16px;
  background: var(--tint-purple);
  color: var(--accent-purple);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* spec.id chip on matched rows. */
.omkc-chip {
  flex: 0 0 auto;
  max-width: 90px;
  padding: 0 6px;
  border-radius: var(--r-pill);
  font-size: 10px;
  line-height: 15px;
  background: var(--tint-amber);
  color: var(--accent-amber);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.omkc-st {
  justify-self: start;
  padding: 1px 9px;
  border-radius: var(--r-pill);
  font-size: 11px;
  line-height: 18px;
}
.omkc-st.st-busy {
  background: var(--tint-green);
  color: var(--accent-green);
}
.omkc-st.st-done {
  background: var(--tint-blue);
  color: var(--accent-blue);
}
.omkc-st.st-err {
  background: var(--tint-red);
  color: var(--accent-red);
}
.omkc-st.st-warn {
  background: var(--tint-amber);
  color: var(--accent-amber);
}
.omkc-st.st-idle {
  background: var(--surface-strong);
  color: var(--text-dim);
}
.omkc-st.st-stale {
  background: var(--surface-strong);
  color: var(--text-faint);
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
/* Status controller still starting: placeholder body instead of the list. */
.omkc-starting {
  padding: 10px 14px;
  margin-bottom: 6px;
  border: 1px dashed var(--border);
  border-radius: var(--r-md);
  color: var(--text-dim);
  font-size: 12px;
}
.omkc-starting[hidden] {
  display: none;
}
/* Debaters chips: live-match status dot (busy green / idle gray). */
.omkc-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 5px;
  border-radius: 50%;
  vertical-align: 1px;
}
.omkc-dot.busy {
  background: var(--accent-green);
  box-shadow: var(--glow-ring);
}
.omkc-dot.idle {
  background: var(--text-faint);
}
.omkc-dot[hidden] {
  display: none;
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
    <span class="dc-live off" id="dcLive"></span>
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
    <div class="omkc-starting" id="omkcStarting" hidden data-i18n="debate.starting">starting…</div>
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
${STATUS_MODEL_JS}
(function () {
  'use strict';
  var M = window.__moaStatusModel;
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
    // Every render recomputes the debate-spec mapping (C): the Debaters dots
    // must reflect the current model as soon as the debate context is known.
    recomputeSpecHits();
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
      chip.setAttribute('data-spec-id', a.id);
      // Live-match status dot: filled by updateDebaterDots after model updates.
      var dot = document.createElement('span');
      dot.className = 'omkc-dot idle';
      dot.hidden = true;
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(a.id));
      var sub = document.createElement('span');
      sub.className = 'sub';
      var label = a.id === speaking ? tr('debate.speaking') : (a.turns > 0 ? tr(a.turns === 1 ? 'debate.turnCount' : 'debate.turnCountPlural', { count: a.turns }) : tr('debate.waiting'));
      sub.textContent = (a.tag ? a.tag + ' · ' : '') + label;
      chip.appendChild(sub);
      box.appendChild(chip);
    }
    updateDebaterDots();
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

  // ── Agent Status card: same-origin bus /status + /status/events ─────────
  // Consumes the same status model as the Status Board page: one
  // window.__moaStatusModel instance fed by /status snapshots and the
  // /status/events SSE stream, rendered as a per-session main→sub tree.
  var model = M.newModel();
  var specHits = Object.create(null);   // spec.id -> matched agent keys (narrowed, F3)
  var toolSeen = new Map();
  var omkcSse = null, omkcFails = 0, omkcReprobe = null, omkcStartingTimer = null, omkcPoll = null;
  // F1: rAF frame batching (mirrors status-board.ts queueFrame/flushFrames) —
  // agent/session frames only mutate the model; one render per animation frame
  // instead of one full render per frame. omkcRenderedOnce marks the first
  // paint so the first snapshot can still render synchronously.
  var omkcPendingFrames = [], omkcFlushScheduled = false, omkcRenderedOnce = false;
  // F2: the 3-strike rule hides the card deliberately; an in-flight 503 must
  // not re-show it (only 200 / a snapshot frame re-shows).
  var omkcHidden = false;

  function omkcShow(on) {
    document.getElementById('omkcCard').hidden = !on;
    document.getElementById('omkcToolsCard').hidden = !on;
  }
  function setOmkcScan(scanning) {
    var chip = document.getElementById('omkcScan');
    chip.hidden = !scanning;
    chip.textContent = tr('debate.scanning');
  }
  function setOmkcStarting(on) {
    var el = document.getElementById('omkcStarting');
    if (el) {
      el.hidden = !on;
      if (on) document.getElementById('omkcCount').textContent = tr('debate.agentCount', { count: 0 });
    }
  }
  function stopOmkcSse() {
    if (omkcSse) { omkcSse.close(); omkcSse = null; }
  }
  function stopScanPoll() {
    if (omkcPoll) { omkcPoll.stop(); omkcPoll = null; }
  }
  function fmtTok(n) {
    n = Number(n);
    if (!isFinite(n)) return '–';
    return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n);
  }
  function shortId(s) {
    s = String(s || '');
    return s.length > 24 ? s.slice(0, 24) + '…' : s;
  }
  /** F3: cross-session narrowing — the debate lives in ONE session, but global
   *  matchDebateSpecs hits can span concurrent sessions (two debates running
   *  the same type names). Group every hit key by sessionId, keep the session
   *  with the most hits (tie: newest lastSeen among its hit entries), and
   *  return only that session's hits. No hits at all -> behave as today. */
  function narrowSpecHits(global) {
    var per = Object.create(null);        // sessionId -> { count, maxSeen }
    var bySession = Object.create(null);  // sessionId -> hit keys
    for (var specId in global) {
      var ks = global[specId];
      for (var i = 0; i < ks.length; i++) {
        var k = ks[i];
        var e = model.byKey[k];
        if (!e) continue;
        var sid = e.sessionId;
        var rec = per[sid];
        if (!rec) {
          rec = per[sid] = { count: 0, maxSeen: 0 };
          bySession[sid] = [];
        }
        rec.count++;
        if (e.lastSeen > rec.maxSeen) rec.maxSeen = e.lastSeen;
        bySession[sid].push(k);
      }
    }
    var best = null, bestSid = null;
    for (var sid in per) {
      var r = per[sid];
      if (!best || r.count > best.count || (r.count === best.count && r.maxSeen > best.maxSeen)) {
        best = r;
        bestSid = sid;
      }
    }
    if (!bestSid) return global;
    var allow = Object.create(null);
    var keep = bySession[bestSid];
    for (var j = 0; j < keep.length; j++) allow[keep[j]] = true;
    var out = Object.create(null);
    for (var specId in global) {
      var gks = global[specId];
      var hits = [];
      for (var i = 0; i < gks.length; i++) if (allow[gks[i]]) hits.push(gks[i]);
      out[specId] = hits;
    }
    return out;
  }
  function recomputeSpecHits() {
    specHits = narrowSpecHits(M.matchDebateSpecs(model, agents));
  }
  /** spec ids whose hits include this key. */
  function matchedSpecsOf(key) {
    var out = [];
    for (var specId in specHits) {
      var ks = specHits[specId];
      for (var i = 0; i < ks.length; i++) {
        if (ks[i] === key) { out.push(specId); break; }
      }
    }
    return out;
  }
  /** True when any debate-matched key lives in this session (hit-first ordering). */
  function sessionHasHits(sessionId) {
    for (var specId in specHits) {
      var ks = specHits[specId];
      for (var i = 0; i < ks.length; i++) {
        var e = model.byKey[ks[i]];
        if (e && e.sessionId === sessionId) return true;
      }
    }
    return false;
  }
  /** True when a debate-matched SUB lives in this session (orchestrator badge:
   *  only sessions with a hit sub get it — a rule-1 main-only hit does not). */
  function sessionHasSubHits(sessionId) {
    for (var specId in specHits) {
      var ks = specHits[specId];
      for (var i = 0; i < ks.length; i++) {
        var e = model.byKey[ks[i]];
        if (e && e.sessionId === sessionId && (e.kind === 'sub' || e.orphan)) return true;
      }
    }
    return false;
  }
  /** Session rows: main entries first, subs after, each by lastSeen desc. */
  function sessionEntries(sessionId) {
    var mains = [], subs = [];
    var keys = Object.keys(model.byKey);
    for (var i = 0; i < keys.length; i++) {
      var e = model.byKey[keys[i]];
      if (e.sessionId !== sessionId) continue;
      if (e.kind === 'sub' || e.orphan) subs.push(e);
      else mains.push(e);
    }
    function bySeenDesc(x, y) { return (y.lastSeen || 0) - (x.lastSeen || 0); }
    mains.sort(bySeenDesc);
    subs.sort(bySeenDesc);
    return { mains: mains, subs: subs };
  }
  function sessionMaxSeen(sessionId) {
    var max = 0;
    var keys = Object.keys(model.byKey);
    for (var i = 0; i < keys.length; i++) {
      var e = model.byKey[keys[i]];
      if (e.sessionId === sessionId && e.lastSeen > max) max = e.lastSeen;
    }
    return max;
  }
  /** Sessions with debate hits first, then by newest lastSeen (stable tie-break). */
  function orderedSessionIds() {
    var ids = model.sessionOrder.slice();
    ids.sort(function (a, b) {
      var ha = sessionHasHits(a), hb = sessionHasHits(b);
      if (ha !== hb) return ha ? -1 : 1;
      var ma = sessionMaxSeen(a), mb = sessionMaxSeen(b);
      if (mb !== ma) return mb - ma;
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
    return ids;
  }
  /** Subagent type name: parent's subagents[].name by subagentId; orphan uses subName. */
  function subTypeName(entry) {
    var parentKey = entry.parentKey;
    var parent = parentKey ? model.byKey[parentKey] : null;
    if (parent && Array.isArray(parent.subagents)) {
      for (var i = 0; i < parent.subagents.length; i++) {
        var s = parent.subagents[i];
        if (s && typeof s === 'object' && s.subagentId === entry.agentId && typeof s.name === 'string' && s.name) {
          return s.name;
        }
      }
    }
    return entry.subName ? String(entry.subName) : '–';
  }
  function newRow() {
    var el = document.createElement('div');
    el.className = 'omkc-row';
    for (var i = 0; i < 5; i++) {
      var c = document.createElement('span');
      if (i === 0) c.className = 'omkc-id';
      if (i === 3) c.className = 'omkc-tok';
      if (i === 4) c.className = 'omkc-tool';
      el.appendChild(c);
    }
    return el;
  }
  function fillRow(el, entry, seed) {
    var isSub = entry.kind === 'sub' || entry.orphan;
    // Spec chips + highlight are a SUB-row treatment (C); a rule-1 match on a
    // main row is still tracked for ordering/dots but renders as its badge.
    var matched = isSub ? matchedSpecsOf(entry.key) : [];
    el.className = 'omkc-row' + (isSub ? ' sub' : '') + (matched.length ? ' matched' : '');
    if (entry.stale) el.classList.add('stale'); else el.classList.remove('stale');
    var idCell = el.children[0];
    idCell.textContent = '';
    idCell.title = entry.sessionId + (entry.home ? ' @ ' + entry.home : '');
    for (var i = 0; i < matched.length; i++) {
      var chip = document.createElement('span');
      chip.className = 'omkc-chip';
      chip.textContent = matched[i];
      idCell.appendChild(chip);
    }
    if (isSub) {
      var guide = document.createElement('span');
      guide.className = 'omkc-guide';
      guide.textContent = '└';
      idCell.appendChild(guide);
      var type = document.createElement('span');
      type.className = 'omkc-type';
      type.textContent = subTypeName(entry);
      idCell.appendChild(type);
    } else {
      var orch = sessionHasSubHits(entry.sessionId);
      var badge = document.createElement('span');
      badge.className = 'omkc-badge ' + (orch ? 'orchestrator' : 'main');
      badge.textContent = orch ? tr('debate.orchestrator') : tr('debate.mainAgent');
      idCell.appendChild(badge);
    }
    var name = document.createElement('span');
    name.className = 'omkc-name';
    name.textContent = entry.agentId;
    idCell.appendChild(name);
    el.children[1].textContent = entry.model || '–';
    var st = M.deriveStatus(entry);
    el.children[2].className = 'omkc-st st-' + st.tone;
    el.children[2].textContent = st.label ? st.label : tr('status.' + st.key);
    el.children[3].textContent = entry.contextTokens != null ? fmtTok(entry.contextTokens) : '–';
    var tc = entry.lastToolCall;
    if (tc && tc.name) {
      el.children[4].textContent = String(tc.name) + (tc.isError ? ' ✗' : '');
      el.children[4].className = 'omkc-tool' + (tc.isError ? ' err' : '');
    } else {
      el.children[4].textContent = '–';
      el.children[4].className = 'omkc-tool';
    }
    maybeLogTool(entry.key, entry, seed);
  }
  function buildRow(entry, seed) {
    var el = newRow();
    fillRow(el, entry, seed);
    return el;
  }
  function sessionHeadEl(sessionId) {
    var head = document.createElement('div');
    head.className = 'omkc-session';
    var row = model.sessions[sessionId] || {};
    if (typeof row.home === 'string' && row.home) {
      var home = document.createElement('span');
      home.className = 'omkc-home';
      home.textContent = row.home;
      head.appendChild(home);
    }
    var dir = document.createElement('span');
    dir.className = 'omkc-session-dir';
    var wd = row.workDir;
    dir.textContent = (typeof wd === 'string' && wd) ? wd : shortId(sessionId);
    dir.title = sessionId;
    head.appendChild(dir);
    // F7: ended (session-gone with surviving rows) marker on the group head.
    if (row.gone === true) {
      var ended = document.createElement('span');
      ended.className = 'omkc-ended';
      ended.textContent = tr('debate.sessionEnded');
      head.appendChild(ended);
    }
    return head;
  }
  /** Full re-render from the model (the card is compact; rows are cheap). */
  function renderOmkc(seed) {
    omkcRenderedOnce = true;
    recomputeSpecHits();
    var box = document.getElementById('omkcAgents');
    if (!box) return;
    var counts = M.modelCounts(model);
    document.getElementById('omkcCount').textContent = tr('debate.agentCount', { count: counts.agents });
    var ids = orderedSessionIds();
    var frag = document.createDocumentFragment();
    for (var i = 0; i < ids.length; i++) {
      var sid = ids[i];
      var parts = sessionEntries(sid);
      if (parts.mains.length + parts.subs.length === 0) continue;
      frag.appendChild(sessionHeadEl(sid));
      for (var m = 0; m < parts.mains.length; m++) frag.appendChild(buildRow(parts.mains[m], seed));
      for (var s = 0; s < parts.subs.length; s++) frag.appendChild(buildRow(parts.subs[s], seed));
    }
    box.textContent = '';
    box.appendChild(frag);
    updateDebaterDots();
  }
  /** Debaters chips: live-match status dot (busy=green / idle=gray via tone). */
  function updateDebaterDots() {
    var box = document.getElementById('agents');
    if (!box) return;
    var kids = box.children;
    var hits = specHits || {};
    for (var i = 0; i < kids.length; i++) {
      var chip = kids[i];
      if (!chip || typeof chip.getAttribute !== 'function') continue;
      var specId = chip.getAttribute('data-spec-id');
      if (specId == null) continue;
      var ks = hits[specId] || [];
      var any = false, busy = false;
      for (var j = 0; j < ks.length; j++) {
        var e = model.byKey[ks[j]];
        if (!e) continue;
        any = true;
        if (M.deriveStatus(e).tone === 'busy') busy = true;
      }
      var dot = chip.querySelector ? chip.querySelector('.omkc-dot') : null;
      if (dot) {
        dot.hidden = !any;
        dot.className = 'omkc-dot ' + (busy ? 'busy' : 'idle');
      }
    }
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
  /** Frame handling mirrors status-board.ts: snapshot -> applySnapshot, agent
   *  gone -> removeAgent, live agent -> upsertAgent, session gone ->
   *  removeSession (kept rows re-render from the model). F1: frames only
   *  mutate the model; the actual render is batched — the first snapshot
   *  renders synchronously (first-paint guarantee), later frames coalesce
   *  into one render per animation frame (status-board flushFrames pattern),
   *  so a sweep burst of N frames costs one render instead of N. */
  function onOmkcFrame(data, type) {
    queueOmkcFrame(data, type);
  }
  function queueOmkcFrame(data, type) {
    omkcPendingFrames.push({ data: data, type: type });
    if (omkcFlushScheduled) return;
    if (type === 'snapshot' && !omkcRenderedOnce && omkcPendingFrames.length === 1) {
      // First snapshot: paint now, don't wait for a rAF tick.
      flushOmkcFrames();
      return;
    }
    omkcFlushScheduled = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flushOmkcFrames);
    else setTimeout(flushOmkcFrames, 0);
  }
  function flushOmkcFrames() {
    omkcFlushScheduled = false;
    var frames = omkcPendingFrames;
    omkcPendingFrames = [];
    var changed = false, seed = false;
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var type = f.type;
      var data = f.data;
      if (type === 'snapshot') {
        M.applySnapshot(model, data);
        setOmkcScan(!!(data && data.scan && data.scan.scanning === true));
        omkcHidden = false;
        omkcShow(true);
        setOmkcStarting(false);
        changed = true;
        seed = true;
        continue;
      }
      if (type === 'session') {
        if (data && data.gone === true && typeof data.sessionId === 'string') {
          M.removeSession(model, data.sessionId);
          changed = true;
        }
        continue;
      }
      if (type === 'agent' && data) {
        var sid = typeof data.sessionId === 'string' ? data.sessionId : null;
        if (sid) {
          if (data.gone === true) M.removeAgent(model, sid, data.agentId);
          else M.upsertAgent(model, data);
          changed = true;
        }
      }
    }
    if (changed) renderOmkc(seed);
  }
  function connectOmkc() {
    if (omkcSse) return;
    omkcSse = window.__moaLib.connectSSE('/status/events', onOmkcFrame, onOmkcState, ['snapshot', 'agent', 'session']);
  }
  function onOmkcState(state) {
    if (state === 'open') {
      omkcFails = 0;
      if (omkcReprobe) { clearInterval(omkcReprobe); omkcReprobe = null; }
      if (omkcStartingTimer) { clearTimeout(omkcStartingTimer); omkcStartingTimer = null; }
    } else if (state === 'error') {
      // EventSource never exposes the HTTP status: probe /status to classify
      // 503 status_not_ready (controller still starting) from a plain failure.
      probeStatus();
    }
  }
  function startScanPoll() {
    if (omkcPoll) return;
    omkcPoll = window.__moaLib.startPoll(function () {
      fetch('/status').then(function (res) {
        if (res.status !== 200) return null;
        return res.json().catch(function () { return null; });
      }).then(function (snap) {
        if (snap) setOmkcScan(snap.scan && snap.scan.scanning === true);
      }).catch(function () {});
    }, window.__moaLib.POLL_MS.sseFallback);
  }
  /** GET /status probe: 200 -> show + connect SSE; 503 -> starting placeholder
   *  (slow retry, never treated as a loss); other/network error -> the
   *  historical 3-strike rule: hide the card and slow-probe every 30s. */
  function probeStatus() {
    try {
      fetch('/status').then(function (res) {
        if (res.status === 200) {
          omkcFails = 0;
          omkcHidden = false;
          if (omkcReprobe) { clearInterval(omkcReprobe); omkcReprobe = null; }
          if (omkcStartingTimer) { clearTimeout(omkcStartingTimer); omkcStartingTimer = null; }
          return res.json().catch(function () { return null; }).then(function (snap) {
            if (snap && typeof snap === 'object') {
              M.applySnapshot(model, snap);
              setOmkcScan(snap.scan && snap.scan.scanning === true);
              renderOmkc(true);
            }
            omkcShow(true);
            setOmkcStarting(false);
            connectOmkc();
            startScanPoll();
            return null;
          });
        }
        if (res.status === 503) {
          // Controller still starting (Retry-After: 2). A 503 proves the bus
          // is reachable, so it resets the failure counter (never a loss).
          // F2: a card hidden by the 3-strike rule must NOT be re-shown by an
          // in-flight 503 (only 200 / a snapshot frame re-shows it) — the 30s
          // reprobe owns recovery; a visible card keeps the starting
          // placeholder armed with the slow retry.
          omkcFails = 0;
          if (omkcHidden) return null;
          omkcShow(true);
          setOmkcStarting(true);
          if (!omkcStartingTimer) {
            omkcStartingTimer = setTimeout(function () {
              omkcStartingTimer = null;
              probeStatus();
            }, 2000);
          }
          return null;
        }
        throw new Error('status HTTP ' + res.status);
      }).catch(function () {
        omkcFails++;
        if (omkcFails >= 3) {
          // 3-strike hide: disarm any in-flight starting retry so a late 503
          // cannot re-show the card (F2).
          if (omkcStartingTimer) { clearTimeout(omkcStartingTimer); omkcStartingTimer = null; }
          omkcHidden = true;
          omkcShow(false);
          setOmkcStarting(false);
          setOmkcScan(false);
          stopOmkcSse();
          stopScanPoll();
          if (!omkcReprobe) {
            omkcReprobe = setInterval(function () { probeStatus(); }, 30000);
          }
        } else {
          setTimeout(probeStatus, 1000);
        }
      });
    } catch (_) {}
  }

  probeStatus();

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
      // F6: re-translate the scan chip with its current visibility.
      var scanChip = document.getElementById('omkcScan');
      if (scanChip) setOmkcScan(!scanChip.hidden);
      // Agent Status tree rows carry dynamic translations (badges, status
      // pills) — re-render from the model with the new locale.
      renderOmkc(false);
    }
  });
  if (!taskId) { setBadge(tr('debate.pickTask'), '', 'debate.pickTask'); showPicker(); return; }

  renderAgents();
  setStage(0);
  setDebateLabel();
  /* Shared lib.ts connectSSE: the same 3-fail backoff reconnect this page
     used to hand-roll; the waiting hint still arms 3s after every open.
     'connecting' is skipped so #conn stays empty until the stream opens
     or errors, exactly as with the hand-rolled version. The #dcLive dot
     mirrors status-board's .sb-live: off when disconnected/errored, pulsing
     on open. */
  window.__moaLib.connectSSE('/subscribe?task_id=' + encodeURIComponent(taskId), function (data) {
    gotAny = true;
    onEvent(data);
  }, function (state, msg) {
    if (state === 'connecting') return;
    setConn(msg);
    var liveEl = document.getElementById('dcLive');
    if (liveEl) liveEl.className = 'dc-live' + (state === 'open' ? '' : ' off');
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
