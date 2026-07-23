/**
 * Self-contained debate card, served by the Bus at GET / (no build step).
 * Open as http://127.0.0.1:<port>/?task_id=<id> — subscribes to the task's
 * SSE stream and renders, per design doc §5.1: a stage progress bar
 * (共识 → Reference → 辩论 R N/M → 聚合 → 结论) with all five steps always
 * visible and an explicit three-state dot per step (✓ done / pulsing green
 * active / hollow grey pending). Every pill is clickable (pending stages
 * included): it smooth-scrolls to the stage's content section with a brief
 * outline flash and opens a detail row under the bar — entry time and state,
 * the reference_results snapshot summary, live round/speaker/turn counts, or
 * the one-line VERDICT; a stage that has not started says so and names what
 * brings it in. Same pill again, or a click anywhere else, closes the row.
 * Also: a live 辩论 N/M label and a hover/focus tooltip explaining each
 * stage, the preset/config snapshot
 * from moa_init (with live round/speaker meta), the debater roster chips,
 * the per-round transcript, and a verdict panel that pulls result.json plus
 * the final turn (findings) from the archive on task_closed.
 *
 * Optional omkc-status integration (design doc §5.1 agent wall / tool log):
 * the card probes http://127.0.0.1:39627/health (500ms). Reachable → shows
 * two extra sections fed by its SSE /events (first `snapshot` frame may be
 * hundreds of KB — parsing is tolerant; then per-agent `agent` deltas):
 * a machine-wide agent status wall (model, phase/busy, context tokens,
 * latest tool call, stale rows dimmed, `scan.scanning` → "扫描中") and a
 * scrolling tool-call log (agent + tool + isError). Unreachable → both
 * sections stay hidden with zero trace: omkc-status is an optional omkc
 * ecosystem enhancement, never a dependency.
 *
 * Resilience rules: the Bus SSE survives 1-2 transient errors with a quick
 * retry and only enters exponential backoff after 3 consecutive failures
 * (E1 lesson); the task picker (no ?task_id) re-polls /tasks every 3s but
 * re-renders only on a real list change, so an idle page never flickers.
 * All untrusted content (transcript, tool output, task ids, presets) is
 * rendered via textContent — never innerHTML.
 */
export const FRONTEND_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>moamcp · debate card</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: #0e1014; background-image: radial-gradient(820px 300px at 50% -140px, #18261e66, transparent 70%); color: #d7dae0; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; padding: 20px; }
  .wrap { max-width: 880px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  header h1 { font-size: 17px; font-weight: 600; }
  header .task { color: #8b919c; font-family: ui-monospace, monospace; font-size: 13px; }
  .badge { margin-left: auto; padding: 2px 10px; border-radius: 999px; font-size: 12px; background: #262b36; color: #9aa3b2; }
  .badge.live { background: #14342a; color: #4ade80; }
  .badge.done { background: #1c2a44; color: #60a5fa; }
  .badge.closed { background: #3a2323; color: #f87171; }
  .card { background: #161a21; border: 1px solid #232936; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
  .sec-title { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: #5b6270; margin-bottom: 10px; }
  .sec-title .aux { margin-left: auto; font-weight: 400; letter-spacing: 0; text-transform: none; font-size: 12px; }
  .hint { color: #5b6270; }
  /* stage progress bar — all five steps always visible, each with an
     explicit three-state dot: pending = hollow grey, active = pulsing
     green, done = filled green with ✓. Connectors shrink, steps never
     wrap, so the row self-fits inside the card down to narrow widths. */
  #progress { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; }
  .step { position: relative; display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; padding: 4px 12px 4px 9px; border-radius: 999px; font-size: 12px; background: #1d222c; border: 1px solid #2a3140; color: #8b919c; white-space: nowrap; cursor: pointer; transition: color .25s, border-color .25s, background .25s, box-shadow .25s, transform .15s; }
  .step:hover { transform: translateY(-1px); border-color: #39415a; }
  .step:focus-visible { outline: 1px solid #4ade8066; outline-offset: 2px; }
  .step .dot { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 14px; height: 14px; border-radius: 50%; border: 1px solid #39404f; background: transparent; color: #0e1014; font-size: 9px; line-height: 1; transition: background .25s, border-color .25s; }
  .step.active { border-color: #4ade80; color: #4ade80; box-shadow: 0 0 10px #4ade8026; }
  .step.active .dot { background: #4ade80; border-color: #4ade80; animation: dotPulse 1.5s ease-in-out infinite; }
  .step.done { background: #14342a; border-color: #1f4d3a; color: #4ade80; }
  .step.done .dot { background: #4ade80; border-color: #4ade80; }
  .step.done .dot::before { content: '✓'; font-weight: 700; }
  @keyframes dotPulse { 0%, 100% { box-shadow: 0 0 0 0 #4ade8059; } 50% { box-shadow: 0 0 0 5px #4ade8000; } }
  .link { flex: 1 1 auto; height: 2px; background: #2a3140; min-width: 6px; transition: background .25s; }
  .link.done { background: #1f4d3a; }
  /* per-stage meaning tooltip (hover / keyboard focus); edge steps align
     their tooltip inward so it never spills out of the card */
  .step::after { content: attr(data-tip); position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%) translateY(-3px); background: #1d222c; border: 1px solid #2a3140; border-radius: 6px; padding: 4px 9px; font-size: 11px; line-height: 1.4; color: #b7bec9; white-space: nowrap; box-shadow: 0 6px 18px #00000059; opacity: 0; pointer-events: none; transition: opacity .18s, transform .18s; z-index: 20; }
  .step:hover::after, .step:focus-visible::after { opacity: 1; transform: translateX(-50%) translateY(0); }
  #progress .step:first-child::after { left: 0; transform: translateY(-3px); }
  #progress .step:first-child:hover::after, #progress .step:first-child:focus-visible::after { transform: translateY(0); }
  #progress .step:last-child::after { left: auto; right: 0; transform: translateY(-3px); }
  #progress .step:last-child:hover::after, #progress .step:last-child:focus-visible::after { transform: translateY(0); }
  @media (max-width: 600px) {
    .step { padding: 3px 8px 3px 6px; font-size: 11px; gap: 5px; }
    .step .dot { width: 12px; height: 12px; font-size: 8px; }
    .link { min-width: 4px; }
  }
  /* clicked pill: blue ring marks which stage's detail row is open */
  .step[aria-expanded="true"] { border-color: #60a5fa; box-shadow: 0 0 10px #60a5fa33; }
  /* stage detail row: expands under the progress bar on pill click */
  #stageDetail { margin-top: 10px; padding: 8px 12px; border-radius: 8px; background: #1d222c; border: 1px solid #2a3140; font-size: 12px; line-height: 1.6; color: #b7bec9; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; animation: detailIn .18s ease-out; }
  #stageDetail .sd-name { color: #7cc7ff; font-weight: 600; white-space: nowrap; }
  #stageDetail .sd-state { padding: 0 8px; border-radius: 999px; font-size: 11px; line-height: 18px; white-space: nowrap; }
  #stageDetail .sd-state.done { background: #14342a; color: #4ade80; }
  #stageDetail .sd-state.active { background: #14342a; color: #4ade80; animation: dotPulse 1.5s ease-in-out infinite; }
  #stageDetail .sd-state.pending { background: #262b36; color: #8b919c; }
  #stageDetail .sd-text { flex: 1 1 100%; word-break: break-word; white-space: pre-wrap; }
  @keyframes detailIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
  /* click a pill → its target card gets a ~1.6s outline flash on landing */
  .card.flash { outline: 2px solid transparent; animation: cardFlash 1.6s ease-out; }
  @keyframes cardFlash { 0% { outline-color: #60a5fa; } 60% { outline-color: #60a5fa80; } 100% { outline-color: transparent; } }
  /* preset / config panel (moa_init snapshot) */
  #configBody { display: flex; flex-wrap: wrap; gap: 6px 18px; color: #9aa3b2; font-size: 13px; }
  #configBody b { color: #e6e9ee; font-weight: 600; }
  /* round / speaker / turns meta (lives inside the config card, design §5.1) */
  #meta { display: flex; gap: 18px; color: #9aa3b2; font-size: 13px; margin-top: 10px; padding-top: 8px; border-top: 1px dashed #232936; }
  #meta b { color: #e6e9ee; font-weight: 600; }
  /* debater roster chips */
  #agents { display: flex; flex-wrap: wrap; gap: 8px; }
  .agent { padding: 5px 12px; border-radius: 8px; background: #1d222c; border: 1px solid #2a3140; font-family: ui-monospace, monospace; font-size: 13px; transition: border-color .25s, color .25s, box-shadow .25s; }
  .agent .sub { color: #5b6270; margin-left: 6px; font-size: 12px; }
  .agent.speaking { border-color: #4ade80; color: #4ade80; box-shadow: 0 0 8px #4ade8033; }
  .agent.speaking .sub { color: #4ade80; }
  #empty { color: #5b6270; padding: 4px 0; }
  /* omkc-status agent wall (optional section) */
  .omkc-scan { padding: 1px 8px; border-radius: 999px; background: #3a2f1c; color: #fbbf24; font-size: 11px; letter-spacing: 0; text-transform: none; }
  .omkc-list { max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; font-family: ui-monospace, monospace; font-size: 12px; }
  .omkc-row { display: grid; grid-template-columns: minmax(110px, 1.1fr) minmax(130px, 1.4fr) 86px 100px minmax(120px, 1.5fr); gap: 10px; align-items: center; padding: 3px 8px; border-radius: 6px; transition: opacity .3s, background .15s; }
  .omkc-row:hover { background: #1d222c; }
  .omkc-row.stale { opacity: .4; }
  .omkc-row > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .omkc-row .omkc-id { color: #7cc7ff; }
  .omkc-st { justify-self: start; padding: 0 8px; border-radius: 999px; font-size: 11px; line-height: 18px; }
  .omkc-st.on { background: #14342a; color: #4ade80; }
  .omkc-st.off { background: #262b36; color: #8b919c; }
  .omkc-tok { color: #9aa3b2; }
  .omkc-tool { color: #9aa3b2; }
  .omkc-tool.err { color: #f87171; }
  /* tool call log (optional section, same omkc-status source) */
  .tool-log { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; font-family: ui-monospace, monospace; font-size: 12px; }
  .tool-row { display: flex; gap: 10px; padding: 2px 8px; border-radius: 6px; }
  .tool-row:hover { background: #1d222c; }
  .tool-ts { color: #5b6270; }
  .tool-agent { color: #7cc7ff; min-width: 72px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-name { color: #d7dae0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-err { color: #f87171; white-space: nowrap; }
  .tool-empty { color: #5b6270; padding: 4px 8px; }
  /* transcript */
  .round-sep { display: flex; align-items: center; gap: 10px; color: #5b6270; font-size: 12px; margin: 16px 0 4px; }
  .round-sep:first-child { margin-top: 0; }
  .round-sep::before, .round-sep::after { content: ''; flex: 1; height: 1px; background: #232936; }
  .turn { border-left: 3px solid #2a3140; padding: 8px 12px; margin: 10px 0; }
  .turn.signoff { border-left-color: #4ade80; background: #14342a33; }
  .turn .head { display: flex; gap: 10px; align-items: center; font-size: 12px; color: #8b919c; margin-bottom: 4px; }
  .turn .who { color: #7cc7ff; font-family: ui-monospace, monospace; }
  .turn .text { white-space: pre-wrap; word-break: break-word; }
  .signoff-badge { padding: 0 7px; border-radius: 999px; background: #14342a; color: #4ade80; font-size: 11px; border: 1px solid #1f4d3a; white-space: nowrap; }
  .transcript-empty { color: #5b6270; font-size: 13px; }
  .early-badge { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #1c2a44; color: #60a5fa; font-size: 12px; margin-right: 8px; }
  /* verdict */
  #verdict { border-color: #2f4a3b; background: #12211a; }
  #verdict h2 { font-size: 14px; color: #4ade80; margin-bottom: 8px; letter-spacing: .08em; }
  #verdict .row { font-size: 13px; color: #b9c6b9; margin-bottom: 4px; }
  #verdict .row b { color: #e6e9ee; font-weight: 600; }
  #verdictFindings { margin: 8px 0; border-top: 1px dashed #2f4a3b; padding-top: 8px; }
  .findings-head { font-size: 12px; color: #4ade80; font-family: ui-monospace, monospace; margin-bottom: 4px; }
  .findings-text { white-space: pre-wrap; word-break: break-word; font-size: 13px; color: #c7d2c7; max-height: 240px; overflow-y: auto; }
  #fullBtn { margin-top: 8px; padding: 4px 14px; border-radius: 6px; border: 1px solid #2f4a3b; background: transparent; color: #4ade80; font-size: 12px; cursor: pointer; transition: background .15s; }
  #fullBtn:hover { background: #14342a; }
  #conn { font-size: 12px; color: #5b6270; }
  /* task picker (shown when the card is opened without ?task_id) */
  #picker h2 { font-size: 14px; color: #e6e9ee; margin-bottom: 8px; }
  .task-item { display: block; width: 100%; text-align: left; padding: 8px 12px; margin: 6px 0; border-radius: 8px; border: 1px solid #2a3140; background: #1d222c; color: #7cc7ff; font-family: ui-monospace, monospace; font-size: 13px; cursor: pointer; transition: border-color .15s, color .15s; }
  .task-item:hover { border-color: #4ade80; color: #4ade80; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>MOA Debate</h1>
    <span class="task" id="taskId"></span>
    <span id="conn"></span>
    <span class="badge" id="badge">connecting</span>
  </header>
  <div class="card" id="picker" hidden>
    <h2>活跃任务</h2>
    <div id="pickerList"><span class="hint">loading…</span></div>
  </div>
  <div class="card" id="progressCard">
    <div class="sec-title">阶段进度<span class="aux hint" id="stageHint">等待任务初始化…</span></div>
    <div id="progress">
      <span class="step" id="st0" data-tip="共识 — 文件共识准备 · 点击查看详情" aria-label="共识：文件共识准备" role="button" tabindex="0" aria-controls="stageDetail" aria-expanded="false"><span class="dot"></span><span class="lb">共识</span></span><span class="link" id="lk0"></span>
      <span class="step" id="st1" data-tip="Reference — 参考池 · 点击查看详情" aria-label="Reference：参考池" role="button" tabindex="0" aria-controls="stageDetail" aria-expanded="false"><span class="dot"></span><span class="lb">Reference</span></span><span class="link" id="lk1"></span>
      <span class="step" id="st2" data-tip="辩论 — 辩手轮流发言 · 点击查看详情" aria-label="辩论：辩手轮流发言" role="button" tabindex="0" aria-controls="stageDetail" aria-expanded="false"><span class="dot"></span><span class="lb" id="st2lb">辩论</span></span><span class="link" id="lk2"></span>
      <span class="step" id="st3" data-tip="聚合 — 汇总裁决 · 点击查看详情" aria-label="聚合：汇总裁决" role="button" tabindex="0" aria-controls="stageDetail" aria-expanded="false"><span class="dot"></span><span class="lb">聚合</span></span><span class="link" id="lk3"></span>
      <span class="step" id="st4" data-tip="结论 — VERDICT 输出 · 点击查看详情" aria-label="结论：VERDICT 输出" role="button" tabindex="0" aria-controls="stageDetail" aria-expanded="false"><span class="dot"></span><span class="lb">结论</span></span>
    </div>
    <div id="stageDetail" role="region" aria-live="polite" hidden></div>
  </div>
  <div class="card" id="config">
    <div class="sec-title">模式 / 配置</div>
    <div id="configBody"><span class="hint">waiting for task_initialized…</span></div>
    <div id="meta">
      <span>Round <b id="round">–</b> / <b id="rounds">–</b></span>
      <span>Speaker <b id="speaker">–</b></span>
      <span>Turns <b id="turns">0</b></span>
    </div>
  </div>
  <div class="card" id="agentsCard">
    <div class="sec-title">辩手</div>
    <div id="agents"></div>
  </div>
  <div class="card" id="omkcCard" hidden>
    <div class="sec-title">Agent 状态<span class="omkc-scan" id="omkcScan" hidden></span><span class="aux hint" id="omkcCount"></span></div>
    <div class="omkc-list" id="omkcAgents"></div>
  </div>
  <div class="card" id="transcriptCard">
    <div class="sec-title">辩论 transcript</div>
    <div id="transcript"><span class="transcript-empty">尚无发言，等待辩论开始…</span></div>
  </div>
  <div class="card" id="verdict" hidden>
    <h2>VERDICT</h2>
    <div class="row" id="verdictBody"></div>
    <div id="verdictFindings"></div>
    <div class="row" id="verdictStats"></div>
    <button id="fullBtn" hidden>加载完整 transcript</button>
  </div>
  <div class="card" id="omkcToolsCard" hidden>
    <div class="sec-title">工具调用日志<span class="aux hint" id="toolCount"></span></div>
    <div class="tool-log" id="toolLog"><span class="tool-empty">等待工具调用…</span></div>
  </div>
</div>
<script>
(function () {
  var taskId = new URLSearchParams(location.search).get('task_id') || '';
  document.getElementById('taskId').textContent = taskId || '(no task_id)';
  var agents = [], turns = 0, rounds = '–', curRound = '–', lastRound = 0, speaking = null;
  var badge = document.getElementById('badge');
  function setBadge(text, cls) { badge.textContent = text; badge.className = 'badge ' + cls; }

  // ---- stage progress: 共识 → Reference → 辩论 R N/M → 聚合 → 结论 ----
  // All five steps stay visible at all times; each carries one of three
  // explicit states (done ✓ / active pulse / pending hollow), and the aux
  // hint names the meaning of the current stage.
  var STEPS = 5;
  var STAGE_TIPS = ['共识：文件共识准备', 'Reference：参考池', '辩论：辩手轮流发言', '聚合：汇总裁决', '结论：VERDICT 输出'];
  var stageNow = 0;                                  // mirrors setStage: < stageNow done, === active
  var stageEnteredAt = [null, null, null, null, null]; // per-stage arrival time (ISO), for the detail row
  function setStage(n, ts) { // steps < n are done, step n is active; n === STEPS → all done
    stageNow = n;
    var entered = ts || new Date().toISOString();
    if (n >= STEPS) { if (!stageEnteredAt[STEPS - 1]) stageEnteredAt[STEPS - 1] = entered; }
    else if (!stageEnteredAt[n]) stageEnteredAt[n] = entered;
    for (var i = 0; i < STEPS; i++) {
      document.getElementById('st' + i).className = 'step' + (i < n ? ' done' : i === n ? ' active' : '');
      if (i < STEPS - 1) document.getElementById('lk' + i).className = 'link' + (i < n ? ' done' : '');
    }
    document.getElementById('stageHint').textContent =
      n >= STEPS ? '全部完成 — 结论已输出 VERDICT' : '当前：' + STAGE_TIPS[n];
    if (detailOpen >= 0) renderStageDetail(detailOpen); // keep an open detail row in sync
  }
  function setDebateLabel() {
    document.getElementById('st2lb').textContent =
      rounds === '–' ? '辩论' : '辩论 ' + curRound + '/' + rounds;
  }

  // ---- clickable stages: pill click → scroll + outline flash + detail row ----
  // Stage → section: 共识 → 配置区 (task_initialized snapshot), Reference →
  // 辩手 roster, 辩论 → transcript, 聚合/结论 → VERDICT 区. Pending pills are
  // clickable too — the detail row says the stage has not started and names
  // what brings it in. Same pill again (or a click anywhere else) closes.
  var STAGE_NAMES = ['共识', 'Reference', '辩论', '聚合', '结论'];
  var STAGE_TARGETS = ['config', 'agentsCard', 'transcriptCard', 'verdict', 'verdict'];
  var initExtras = null;   // task_initialized extras snapshot (may carry reference_results)
  var verdictSummary = ''; // one-line VERDICT once task_closed lands
  var detailOpen = -1;     // stage index whose detail row is open, -1 = closed

  function fmtClock(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function refSnippet() {
    var rr = initExtras ? initExtras.reference_results : null;
    if (rr == null) return null;
    var s = typeof rr === 'string' ? rr : JSON.stringify(rr);
    if (s == null) return null;
    return s.length > 500 ? s.slice(0, 500) + '…' : s;
  }
  function stageDetail(i) { // → { state: 'done'|'active'|'pending', text }
    var state = i < stageNow ? 'done' : (i === stageNow ? 'active' : 'pending');
    var at = '进入于 ' + fmtClock(stageEnteredAt[i]);
    if (state === 'pending') {
      var why = [
        '等待页面连接建立（载入即进入）',
        '等待 moa_init 完成任务初始化（task_initialized）',
        '等待 moa_start_debate 注入参考池并开赛（debate_started）',
        '等待最后一名辩手提交（debate_complete）',
        '等待 moa_complete 写入三层归档（task_closed）'
      ][i];
      return { state: 'pending', text: '该阶段尚未开始 — ' + why };
    }
    if (i === 0) {
      return { state: state, text: at + ' · ' + (state === 'done'
        ? '任务已初始化，共识准备完成'
        : '已连接，等待 moa_init 初始化任务') };
    }
    if (i === 1) {
      var ref = refSnippet();
      return { state: state, text: at + ' · ' + (ref != null
        ? 'reference_results 摘要：' + ref
        : '快照未携带 reference_results（由 moa_start_debate 直接注入辩手上下文，不经卡片）') };
    }
    if (i === 2) {
      return { state: state, text: 'Round ' + curRound + '/' + rounds +
        ' · 当前发言人 ' + (speaking || '–') + ' · 已提交 ' + turns + ' 个 turn' };
    }
    if (i === 3) {
      return { state: state, text: at + '（debate_complete）· ' + (state === 'done'
        ? '归档已写入，裁决已输出'
        : '汇总中 — 等待 moa_complete 写入归档') };
    }
    return { state: state, text: verdictSummary || (at + ' · 归档已写入，VERDICT 详情加载中…') };
  }
  function renderStageDetail(i) {
    var box = document.getElementById('stageDetail');
    box.textContent = '';
    var info = stageDetail(i);
    var name = document.createElement('span');
    name.className = 'sd-name';
    name.textContent = STAGE_NAMES[i];
    var chip = document.createElement('span');
    chip.className = 'sd-state ' + info.state;
    chip.textContent = info.state === 'done' ? '完成' : (info.state === 'active' ? '进行中' : '未开始');
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
    void el.offsetWidth; // force reflow so back-to-back clicks replay the animation
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
    if (target && !target.hidden) { // e.g. the VERDICT card only exists post-debate_complete
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
  // a click outside pills / detail row closes the row (pill clicks bubble up
  // here too — closest('.step') keeps them from closing what they just opened)
  document.addEventListener('click', function (ev) {
    if (detailOpen < 0) return;
    var t = ev.target;
    if (t && t.closest && (t.closest('.step') || t.closest('#stageDetail'))) return;
    closeStageDetail();
  });

  // ---- preset / config snapshot (task_initialized) ----
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
      empty.textContent = 'waiting for task_initialized…';
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
      var label = a.id === speaking ? 'speaking' : (a.turns > 0 ? a.turns + ' turn' + (a.turns > 1 ? 's' : '') : 'waiting');
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

  // ---- transcript (per-round grouped; everything via textContent) ----
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
      sb.textContent = '✍ 签字';
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

  // ---- archive helpers & verdict ----
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
    speaking = null; renderAgents(); setBadge('closed', 'closed');
    verdictSummary = '归档已写入 · ' + (e.archive || 'logs/' + taskId);
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
        eb.textContent = '提前闭合（全体签字）· ' + (r.reason || 'unanimous_signoff');
        vb.appendChild(eb);
      }
      putStat(vb, 'status', r.status || '–');
      putStat(vb, 'rounds', (r.rounds_completed != null ? r.rounds_completed : '–') + ' / ' + (r.rounds_configured != null ? r.rounds_configured : '–'));
      putStat(vb, 'turns', r.turns != null ? String(r.turns) : '–');
      var statsText = 'finished at ' + (r.finished_at || '–') + ' · archive: ' + (e.archive || 'logs/' + taskId);
      if (r.signoffs && typeof r.signoffs === 'object') {
        var signers = Object.keys(r.signoffs);
        if (signers.length) statsText += ' · ✍ 签字: ' + signers.join(', ');
      }
      document.getElementById('verdictStats').textContent = statsText;
      document.getElementById('fullBtn').hidden = false;
      verdictSummary = (r.early === true ? '提前闭合（全体签字） · ' : 'VERDICT · ') + 'status ' + (r.status || '–') + ' · rounds ' +
        (r.rounds_completed != null ? r.rounds_completed : '–') + '/' +
        (r.rounds_configured != null ? r.rounds_configured : '–') + ' · turns ' +
        (r.turns != null ? r.turns : '–');
      refreshDetailIfOpen(4);
    });
    // findings: the last archived turn carries the synthesized conclusion.
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

  // ---- Bus domain events ----
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
      setDebateLabel(); setStage(1, e.ts); setBadge('initialized', 'live');
    } else if (e.type === 'debate_started') {
      rounds = e.rounds || rounds;
      curRound = 1;
      setDebateLabel(); setMeta(1, null); setStage(2, e.ts); setBadge('debating', 'live');
    } else if (e.type === 'turn_submitted') {
      turns++; bumpAgent(e.agent_id); speaking = null;
      // Prefer the full content; fall back to excerpt for older replay buffers.
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
      speaking = null; renderAgents(); setStage(3, e.ts); setBadge('debate complete', 'done');
      document.getElementById('verdict').hidden = false;
      var vbLive = document.getElementById('verdictBody');
      vbLive.textContent = '';
      if (e.early === true) {
        var ebLive = document.createElement('span');
        ebLive.className = 'early-badge';
        ebLive.textContent = '提前闭合（全体签字）';
        vbLive.appendChild(ebLive);
      }
      vbLive.appendChild(document.createTextNode(
        'Rounds: ' + (e.rounds || '–') + ' · Turns: ' + (e.turns || turns) +
        (e.early === true ? ' · reason: ' + (e.reason || 'unanimous_signoff') : '') +
        ' — transcript archived on moa_complete.'));
    } else if (e.type === 'signoff_reset') {
      // A dissent wiped the accumulated signoffs; surface it in the stage hint.
      document.getElementById('stageHint').textContent =
        '签字清零（' + (e.agent_id || '–') + ' 提出异议）— 辩论按原轮次继续';
      refreshDetailIfOpen(2);
    } else if (e.type === 'task_closed') {
      onClosed(e);
    }
  }

  // ---- task picker: silent 3s refresh, re-render only on real changes ----
  var pickerSig = null, pickerErrShown = false;
  function renderPickerList(tasks) {
    var list = document.getElementById('pickerList');
    list.textContent = '';
    if (!tasks.length) {
      var hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '暂无活跃任务';
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
        if (sig === pickerSig && !pickerErrShown) return; // unchanged → do not touch the DOM
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
        hint.textContent = 'failed to load /tasks';
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

  // ---- optional omkc-status agent wall + tool call log ----
  // Optional enhancement from the omkc ecosystem, never a dependency:
  // probe http://127.0.0.1:39627/health (500ms); when absent, both sections
  // stay hidden with zero trace. When present, subscribe to its SSE /events:
  // the first 'snapshot' frame is the full state (can be hundreds of KB —
  // parsing stays tolerant), afterwards per-agent 'agent' delta frames.
  var OMKC = 'http://127.0.0.1:39627';
  var omkcRows = new Map();  // 'sessionId:agentId' -> row element
  var toolSeen = new Map();  // 'sessionId:agentId' -> last rendered lastToolCall.ts
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
    chip.textContent = '扫描中…';
  }
  function omkcKey(a) { return (a.sessionId || '') + ':' + (a.agentId || ''); }
  function fmtTok(n) {
    n = Number(n);
    if (!isFinite(n)) return '–';
    return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n);
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fillAgentRow(el, a) {
    var cells = el.children; // [id, model, status, tokens, tool]
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
      // late-arriving agents are the most recent — slot them on top.
      var box = document.getElementById('omkcAgents');
      box.insertBefore(el, box.firstChild);
    }
    fillAgentRow(el, a);
    maybeLogTool(key, a, false);
  }
  function applyOmkcSnapshot(snap) {
    // The snapshot can be very large (machine-wide agent list); parse and
    // render defensively — a malformed entry must not kill the whole wall.
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
    document.getElementById('omkcCount').textContent = sorted.length + ' 个 agent';
    setOmkcScan(!!(snap.scan && snap.scan.scanning === true));
  }
  function maybeLogTool(key, a, seed) {
    var tc = a.lastToolCall;
    if (!tc || !tc.name || !tc.ts) return;
    var last = toolSeen.get(key) || 0;
    if (tc.ts <= last) return;
    if (seed && Date.now() - Number(tc.ts) > 5 * 60 * 1000) return; // seed: last 5 min only
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
      err.textContent = '✗ error';
      row.appendChild(err);
    }
    if (seed) box.appendChild(row); // snapshot seed: append in lastSeen-desc order
    else box.insertBefore(row, box.firstChild); // live: newest on top
    while (box.children.length > 150) box.removeChild(box.lastChild);
    document.getElementById('toolCount').textContent = box.children.length + ' 条';
  }
  function omkcConnect() {
    if (omkcEs) { omkcEs.close(); omkcEs = null; }
    omkcEs = new EventSource(OMKC + '/events');
    omkcEs.addEventListener('snapshot', function (m) {
      omkcFails = 0;
      try { applyOmkcSnapshot(JSON.parse(m.data)); } catch (_) { /* tolerant: wait for deltas */ }
    });
    omkcEs.addEventListener('agent', function (m) {
      omkcFails = 0;
      try { upsertAgent(JSON.parse(m.data)); } catch (_) {}
    });
    omkcEs.onerror = function () {
      if (omkcEs) { omkcEs.close(); omkcEs = null; }
      omkcFails++;
      // Same E1 rule as the Bus SSE: 1-2 transient errors retry quickly;
      // 3 consecutive failures read as "service gone" — hide both sections
      // silently and re-probe on a slow cadence until it returns.
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

  // ---- bootstrap ----
  probeOmkc().then(function () {
    omkcShow(true);
    omkcConnect();
    // Keep the 扫描中 badge fresh (scan state only rides on snapshots).
    if (!omkcHealthPoll) {
      omkcHealthPoll = setInterval(function () {
        if (!omkcEs) return; // hidden / re-probing — skip
        probeOmkc().then(function (h) { setOmkcScan(h.scanning === true); }, function () {});
      }, 15000);
    }
  }, function () { /* omkc-status not installed — sections stay hidden */ });

  if (!taskId) { setBadge('pick a task', ''); showPicker(); return; }

  renderAgents();
  setStage(0);
  setDebateLabel();
  var sse = null, sseFails = 0, sseDelay = 800, gotAny = false, waitingShown = false;
  function setConn(text) { document.getElementById('conn').textContent = text; }
  function showWaitingHint() {
    if (waitingShown) return;
    waitingShown = true;
    setBadge('waiting', '');
    var box = document.getElementById('configBody');
    box.textContent = '';
    var span = document.createElement('span');
    span.className = 'hint';
    span.appendChild(document.createTextNode('已连接，但任务 '));
    var b = document.createElement('b');
    b.textContent = taskId;
    span.appendChild(b);
    span.appendChild(document.createTextNode(' 还没有任何事件。辩论可能尚未开始，或 Bus 进程重启过（事件日志在内存中）。'));
    var a = document.createElement('a');
    a.href = '/';
    a.style.color = '#7cc7ff';
    a.textContent = '返回任务列表';
    span.appendChild(a);
    box.appendChild(span);
  }
  function connect() {
    sse = new EventSource('/subscribe?task_id=' + encodeURIComponent(taskId));
    sse.onopen = function () {
      sseFails = 0;
      sseDelay = 800;
      setConn('● sse');
      // The Bus replays the event log on subscribe. If nothing arrives within
      // a few seconds the task either hasn't started or the Bus restarted
      // (event log is in-memory) — show a useful hint instead of "connecting" forever.
      setTimeout(function () {
        if (!gotAny) showWaitingHint();
      }, 3000);
    };
    sse.onmessage = function (m) {
      gotAny = true;
      sseFails = 0;
      try { onEvent(JSON.parse(m.data)); } catch (_) {}
    };
    sse.onerror = function () {
      if (sse) { sse.close(); sse = null; }
      sseFails++;
      // E1 lesson: one transient error must not tear the session down —
      // retry quickly twice, and only after 3 consecutive failures enter
      // exponential backoff (800ms doubling, capped at 15s).
      var delay = sseFails < 3 ? 800 : Math.min(15000, sseDelay * 2);
      sseDelay = delay;
      setConn(sseFails < 3
        ? '○ 瞬断 ' + sseFails + '/3'
        : '○ 重连退避 ' + Math.round(delay / 100) / 10 + 's');
      setTimeout(connect, delay);
    };
  }
  connect();
})();
</script>
</body>
</html>
`;
