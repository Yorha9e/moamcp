/**
 * Self-contained debate card, served by the Bus at GET / (no build step).
 * Open as http://127.0.0.1:<port>/?task_id=<id> — subscribes to the task's
 * SSE stream and renders, per design doc §5.1: a stage progress bar, the
 * preset/config snapshot, per-agent status chips, the live transcript, and
 * a verdict panel. After archival (task_closed) the card pulls result.json
 * and can load the full transcript via the Bus's /archive endpoint.
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
  body { background: #0e1014; color: #d7dae0; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; padding: 20px; }
  .wrap { max-width: 860px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  header h1 { font-size: 17px; font-weight: 600; }
  header .task { color: #8b919c; font-family: ui-monospace, monospace; font-size: 13px; }
  .badge { margin-left: auto; padding: 2px 10px; border-radius: 999px; font-size: 12px; background: #262b36; color: #9aa3b2; }
  .badge.live { background: #14342a; color: #4ade80; }
  .badge.done { background: #1c2a44; color: #60a5fa; }
  .badge.closed { background: #3a2323; color: #f87171; }
  .card { background: #161a21; border: 1px solid #232936; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
  /* stage progress bar */
  #progress { display: flex; align-items: center; gap: 6px; }
  .step { padding: 3px 12px; border-radius: 999px; font-size: 12px; background: #1d222c; border: 1px solid #2a3140; color: #8b919c; white-space: nowrap; }
  .step.active { border-color: #4ade80; color: #4ade80; }
  .step.done { background: #14342a; border-color: #1f4d3a; color: #4ade80; }
  .link { flex: 1; height: 2px; background: #2a3140; min-width: 12px; }
  .link.done { background: #1f4d3a; }
  /* preset / config panel */
  #config { display: flex; flex-wrap: wrap; gap: 6px 18px; color: #9aa3b2; font-size: 13px; }
  #config b { color: #e6e9ee; font-weight: 600; }
  /* agent status chips */
  #agents { display: flex; flex-wrap: wrap; gap: 8px; }
  .agent { padding: 5px 12px; border-radius: 8px; background: #1d222c; border: 1px solid #2a3140; font-family: ui-monospace, monospace; font-size: 13px; }
  .agent .sub { color: #5b6270; margin-left: 6px; font-size: 12px; }
  .agent.speaking { border-color: #4ade80; color: #4ade80; box-shadow: 0 0 8px #4ade8033; }
  .agent.speaking .sub { color: #4ade80; }
  /* round / speaker / turns meta */
  #meta { display: flex; gap: 18px; color: #9aa3b2; font-size: 13px; }
  #meta b { color: #e6e9ee; font-weight: 600; }
  /* transcript */
  .round-sep { display: flex; align-items: center; gap: 10px; color: #5b6270; font-size: 12px; margin: 16px 0 4px; }
  .round-sep::before, .round-sep::after { content: ''; flex: 1; height: 1px; background: #232936; }
  .turn { border-left: 3px solid #2a3140; padding: 8px 12px; margin: 10px 0; }
  .turn .head { display: flex; gap: 10px; font-size: 12px; color: #8b919c; margin-bottom: 4px; }
  .turn .who { color: #7cc7ff; font-family: ui-monospace, monospace; }
  .turn .text { white-space: pre-wrap; word-break: break-word; }
  /* verdict */
  #verdict { border-color: #2f4a3b; background: #12211a; }
  #verdict h2 { font-size: 14px; color: #4ade80; margin-bottom: 8px; }
  #verdict .row { font-size: 13px; color: #b9c6b9; margin-bottom: 4px; }
  #verdict .row b { color: #e6e9ee; font-weight: 600; }
  #fullBtn { margin-top: 8px; padding: 4px 14px; border-radius: 6px; border: 1px solid #2f4a3b; background: transparent; color: #4ade80; font-size: 12px; cursor: pointer; }
  #fullBtn:hover { background: #14342a; }
  #empty { color: #5b6270; text-align: center; padding: 30px 0; }
  #conn { font-size: 12px; color: #5b6270; }
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
  <div class="card" id="progress">
    <span class="step" id="st0">初始化</span><span class="link" id="lk0"></span>
    <span class="step" id="st1">辩论中</span><span class="link" id="lk1"></span>
    <span class="step" id="st2">辩论完成</span><span class="link" id="lk2"></span>
    <span class="step" id="st3">已归档</span>
  </div>
  <div class="card" id="config"><span style="color:#5b6270">waiting for task_initialized…</span></div>
  <div class="card"><div id="agents"></div></div>
  <div class="card" id="meta">
    <span>Round <b id="round">–</b> / <b id="rounds">–</b></span>
    <span>Speaker <b id="speaker">–</b></span>
    <span>Turns <b id="turns">0</b></span>
  </div>
  <div id="transcript"></div>
  <div class="card" id="verdict" hidden>
    <h2>DEBATE COMPLETE</h2>
    <div class="row" id="verdictBody"></div>
    <div class="row" id="verdictStats"></div>
    <button id="fullBtn" hidden>加载完整 transcript</button>
  </div>
</div>
<script>
(function () {
  var taskId = new URLSearchParams(location.search).get('task_id') || '';
  document.getElementById('taskId').textContent = taskId || '(no task_id)';
  var agents = [], turns = 0, rounds = '–', lastRound = 0, speaking = null;
  var badge = document.getElementById('badge');
  function setBadge(text, cls) { badge.textContent = text; badge.className = 'badge ' + cls; }
  function setStage(n) {
    for (var i = 0; i < 4; i++) {
      document.getElementById('st' + i).className = 'step' + (i < n ? ' done' : i === n ? ' active' : '');
      if (i < 3) document.getElementById('lk' + i).className = 'link' + (i < n ? ' done' : '');
    }
  }
  function renderConfig(extras) {
    var box = document.getElementById('config');
    box.innerHTML = '';
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
    if (!agents.length) { box.innerHTML = '<span id="empty">waiting for task_initialized…</span>'; return; }
    box.innerHTML = '';
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
  function addRoundSep(round) {
    var div = document.createElement('div');
    div.className = 'round-sep';
    div.textContent = 'Round ' + round;
    document.getElementById('transcript').appendChild(div);
  }
  function addTurn(who, round, turn, text, ts) {
    if (round !== lastRound) { lastRound = round; addRoundSep(round); }
    var div = document.createElement('div');
    div.className = 'turn';
    var head = document.createElement('div');
    head.className = 'head';
    head.innerHTML = '<span class="who"></span><span>round ' + round + ' · turn ' + turn + '</span><span>' + (ts || '') + '</span>';
    head.querySelector('.who').textContent = who;
    var body = document.createElement('div');
    body.className = 'text';
    body.textContent = text || '';
    div.appendChild(head); div.appendChild(body);
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
  function onClosed(e) {
    speaking = null; renderAgents(); setBadge('closed', 'closed'); setStage(3);
    var v = document.getElementById('verdict'); v.hidden = false;
    loadArchive('result.json', function (text) {
      var r;
      try { r = JSON.parse(text); } catch (_) { return; }
      document.getElementById('verdictBody').innerHTML =
        'status <b></b> · rounds <b></b> · turns <b></b>';
      var bs = document.getElementById('verdictBody').querySelectorAll('b');
      bs[0].textContent = r.status || '–';
      bs[1].textContent = (r.rounds_completed != null ? r.rounds_completed : '–') + ' / ' + (r.rounds_configured != null ? r.rounds_configured : '–');
      bs[2].textContent = r.turns != null ? String(r.turns) : '–';
      document.getElementById('verdictStats').textContent =
        'finished at ' + (r.finished_at || '–') + ' · archive: ' + (e.archive || 'logs/' + taskId);
      document.getElementById('fullBtn').hidden = false;
    });
  }
  document.getElementById('fullBtn').addEventListener('click', function () {
    this.hidden = true;
    loadArchive('events.jsonl', function (text) {
      document.getElementById('transcript').innerHTML = '';
      lastRound = 0;
      var lines = text.split('\\n');
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        try {
          var t = JSON.parse(lines[i]);
          addTurn(t.speaker, t.round, t.turn, t.content, t.timestamp);
        } catch (_) {}
      }
    });
  });
  function onEvent(e) {
    if (e.type === 'task_initialized') {
      var specs = e.agent_specs || (e.agents || []).map(function (id) { return { id: id }; });
      agents = specs.map(function (s) {
        return { id: s.id, tag: s.role || s.model || '', turns: 0 };
      });
      rounds = e.rounds || '–';
      speaking = null;
      renderAgents(); renderConfig(e.extras); setMeta('–', null);
      setStage(0); setBadge('initialized', 'live');
    } else if (e.type === 'debate_started') {
      rounds = e.rounds || rounds;
      setMeta(1, null); setStage(1); setBadge('debating', 'live');
    } else if (e.type === 'turn_submitted') {
      turns++; bumpAgent(e.agent_id); speaking = null;
      addTurn(e.agent_id, e.round, e.turn, e.excerpt, e.ts);
      renderAgents(); setMeta(e.round, null);
    } else if (e.type === 'turn_advanced') {
      speaking = e.speaker;
      renderAgents(); setMeta(e.round, e.speaker);
    } else if (e.type === 'debate_complete') {
      speaking = null; renderAgents(); setStage(2); setBadge('debate complete', 'done');
      var v = document.getElementById('verdict'); v.hidden = false;
      document.getElementById('verdictBody').textContent =
        'Rounds: ' + (e.rounds || '–') + ' · Turns: ' + (e.turns || turns) + ' — transcript archived on moa_complete.';
    } else if (e.type === 'task_closed') {
      onClosed(e);
    }
  }
  if (!taskId) { setBadge('missing task_id', 'closed'); return; }
  renderAgents();
  var es = new EventSource('/subscribe?task_id=' + encodeURIComponent(taskId));
  es.onopen = function () { document.getElementById('conn').textContent = '● sse'; };
  es.onerror = function () { document.getElementById('conn').textContent = '○ reconnecting'; };
  es.onmessage = function (m) { try { onEvent(JSON.parse(m.data)); } catch (_) {} };
})();
</script>
</body>
</html>
`;
