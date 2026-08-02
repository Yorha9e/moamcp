import { TOKENS_CSS, THEME_BOOTSTRAP } from './tokens.js';
import { COMPONENTS_CSS } from './components.js';
import { LIB_JS } from './lib.js';
import { I18N_BOOTSTRAP, I18N_JS } from './i18n.js';
import { renderAppHeader } from './app-header.js';

export const CONTROL_PLANE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title data-i18n="control.title">Workspace Control Plane</title>
<style>
${TOKENS_CSS}
${COMPONENTS_CSS}

/* Control Plane Specific Styles */
.workspace-bar {
  position: sticky;
  top: 14px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  padding: 12px 15px;
  /* Solid chrome avoids Windows Chromium edge artifacts above long board lists. */
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}
.workspace-bar label {
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 500;
}
#workspace {
  min-width: 280px;
  padding: 8px 32px 8px 10px; /* right padding clears the custom chevron */
}
#workspaceHint {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 14px;
  padding: 4px;
  background: var(--surface-strong);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  width: fit-content;
}
.tab {
  padding: 7px 15px;
  background: transparent;
  border-color: transparent;
  color: var(--text-dim);
  border-radius: var(--r-sm);
  font-weight: 500;
}
.tab:hover {
  color: var(--text);
}
.tab.active {
  background: var(--tint-green);
  border-color: var(--tint-green-border);
  color: var(--accent-green);
}

.view[hidden], .drawer[hidden], #tipForm[hidden], .board-modal[hidden], #boardConflictReload[hidden] {
  display: none;
}

.toolbar, .board-toolbar {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  flex-wrap: wrap;
  padding: 13px 15px;
  margin-bottom: 14px;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-1);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 130px;
  flex: 1 1 130px;
}
.field.wide {
  flex-basis: 220px;
}
.field label {
  color: var(--text-faint);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.03em;
}
.field input, .field select, .field textarea {
  width: 100%;
  padding: 8px 9px;
}
.field textarea {
  min-height: 76px;
  resize: vertical;
}

.check {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  padding: 8px 0;
  color: var(--text-dim);
}
.check input {
  accent-color: var(--accent-green);
}

.tip-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
  align-items: start;
  max-width: 880px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tip-card {
  padding: 14px 16px;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-1);
  transition: border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.tip-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
}
.tip-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.tip-title {
  flex: 1;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-weight: 600;
  font-size: 14.5px;
}
.tip-title:hover {
  color: var(--accent-blue);
}
.status {
  flex: 0 0 auto;
  padding: 2px 9px;
  border-radius: var(--r-pill);
  background: var(--surface-strong);
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 500;
  border: 1px solid var(--border);
}
.status.st-captured { background: var(--surface-strong); color: var(--text-dim); }
.status.st-exploring { background: var(--tint-blue); color: var(--accent-blue); border-color: var(--tint-blue-border); }
.status.st-planned { background: var(--tint-amber); color: var(--accent-amber); border-color: var(--tint-amber-border); }
.status.st-implemented { background: var(--tint-green); color: var(--accent-green); border-color: var(--tint-green-border); }
.status.st-deferred { background: var(--tint-purple); color: var(--accent-purple); border-color: var(--tint-purple-border); }
.status.st-discarded { background: var(--tint-red); color: var(--accent-red); border-color: var(--tint-red-border); }
.status.st-archived { background: var(--hover-tint-subtle); color: var(--text-faint); }

.tip-summary {
  margin: 8px 0;
  color: var(--text-dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tip-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--text-faint);
  font-size: 12px;
  align-items: center;
}
.tag {
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--surface-strong);
  color: var(--text-dim);
  border: 1px solid var(--border);
}
.tip-actions {
  display: flex;
  gap: 7px;
  margin-top: 10px;
}
.tip-actions button {
  padding: 4px 10px;
  font-size: 12px;
}

.drawer-head {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.drawer h2 {
  flex: 1;
  margin: 0;
  font-size: 17px;
  overflow-wrap: anywhere;
}
.close {
  border: 0;
  background: transparent;
  color: var(--text-faint);
  font-size: 22px;
  line-height: 1;
  border-radius: 6px;
  padding: 0 4px;
}
.close:hover {
  color: var(--text);
}
.details {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 8px 12px;
  margin: 14px 0;
}
.details dt {
  color: var(--text-faint);
  font-size: 12.5px;
}
.details dd {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text);
}
.details dd.code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--solid-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 9px;
  max-height: 300px;
  overflow-y: auto;
}

.form-card {
  grid-column: 1 / -1;
  padding: 16px;
  background: var(--solid);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}
.form-card h2 {
  margin: 0 0 14px;
  font-size: 16px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.form-grid .full {
  grid-column: 1 / -1;
}
.form-actions {
  display: flex;
  gap: 9px;
  margin-top: 14px;
}
.form-error {
  color: var(--accent-red);
  min-height: 1.5em;
  margin-top: 8px;
}
/* This page combines a fixed drawer with long board scrolling. A solid drawer
   avoids the Windows Chromium black-edge artifact caused by a blurred layer. */
.drawer {
  background: var(--solid);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.board-modal {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  overflow-y: auto;
  padding: 5vh 18px;
  background: rgba(0, 0, 0, 0.48);
}
.board-form-card {
  width: min(760px, 100%);
  max-height: none;
}
.board-form-card textarea {
  min-height: 260px;
}
.board-form-head, .board-toolbar-status, .byte-line, .board-detail-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.board-form-head h2 {
  flex: 1;
}
.board-toolbar-status {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 12px;
}
.byte-line {
  justify-content: space-between;
  color: var(--text-faint);
  font-size: 12px;
}
.byte-line.over-limit, .external-warning {
  color: var(--accent-red);
}
.external-warning {
  padding: 9px 11px;
  margin-top: 10px;
  background: var(--tint-red);
  border: 1px solid var(--tint-red-border);
  border-radius: var(--r-sm);
}
.board-detail-actions {
  margin: 12px 0 4px;
}
.board-detail-actions button {
  padding: 5px 10px;
  font-size: 12px;
}
#boardFormKey[readonly] {
  color: var(--text-faint);
  cursor: not-allowed;
}

.agent-layout {
  display: grid;
  grid-template-columns: minmax(250px, 0.7fr) minmax(0, 1.5fr);
  gap: 14px;
  align-items: start;
}
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.agent-row {
  display: block;
  width: 100%;
  padding: 11px 13px;
  text-align: left;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  color: var(--text);
}
.agent-row:hover, .agent-row.selected { border-color: var(--accent-green); box-shadow: var(--glow-green-soft); }
.agent-row-head, .agent-editor-head, .agent-banner, .agent-binding-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.agent-row-head strong, .agent-editor-head h2 { flex: 1; overflow-wrap: anywhere; }
.agent-row-meta, .agent-hash, .agent-layout-note { color: var(--text-faint); font-size: 12px; overflow-wrap: anywhere; }
.agent-row-error { margin-top: 5px; color: var(--accent-red); font-size: 12px; overflow-wrap: anywhere; }
.agent-editor {
  min-width: 0;
  padding: 16px;
  background: var(--solid);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}
.agent-editor-head h2 { margin: 0; font-size: 16px; }
.agent-editor textarea { min-height: 360px; font-family: var(--font-mono); font-size: 12px; line-height: 1.55; }
.agent-banner {
  justify-content: space-between;
  margin: 12px 0;
  padding: 10px 12px;
  background: var(--tint-green);
  border: 1px solid var(--tint-green-border);
  border-radius: var(--r-sm);
  color: var(--accent-green);
}
.agent-banner span { flex: 1 1 360px; }
.agent-binding-section, .agent-raw-section { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
.agent-binding-head h3, .agent-raw-section summary { margin: 0; font-size: 14px; }
.agent-binding-head h3 { flex: 1; }
.agent-binding-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.agent-binding-row { display: grid; grid-template-columns: minmax(110px, 0.8fr) minmax(120px, 1fr) minmax(120px, 1fr) 110px auto; gap: 7px; align-items: end; }
.agent-binding-row .field { min-width: 0; }
.agent-binding-row .field label { font-size: 10px; }
.agent-binding-row .remove-binding { padding: 7px 9px; font-size: 12px; }
.agent-raw-section summary { cursor: pointer; color: var(--text); }
.agent-raw-section textarea { min-height: 270px; margin-top: 10px; }
.agent-raw-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 9px; }
.agent-details { margin: 10px 0 0; }

.board-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.8fr);
  gap: 14px;
  align-items: start;
}
.board-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.board-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 92px 120px;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 10px 12px;
  text-align: left;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  transition: border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.board-row:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
}
.board-row.selected {
  border-color: var(--accent-green);
  box-shadow: var(--glow-green-soft);
}
.board-key {
  color: var(--accent-blue);
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.board-small {
  color: var(--text-faint);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board-detail {
  position: sticky;
  top: 86px;
  min-height: 180px;
  padding: 16px;
  background: var(--solid);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}
.board-detail h2 {
  margin: 0 0 10px;
  font-size: 15px;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  color: var(--accent-blue);
}
.board-value {
  max-height: 520px;
  overflow: auto;
  margin-top: 10px;
  padding: 12px;
  border-radius: var(--r-sm);
  background: var(--solid-2);
  border: 1px solid var(--border);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.empty {
  padding: 20px;
  color: var(--text-faint);
  background: var(--surface);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-md);
  text-align: center;
}
.section[hidden], .subview[hidden], .workspace-bar[hidden], .section-tabs[hidden] { display: none; }
.section-intro { margin: 0 0 14px; color: var(--text-dim); }
.result-count { margin-left: auto; color: var(--text-faint); font-size: 12px; }
.management-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 12px; }
.management-card {
  min-width: 0;
  padding: 16px;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-1);
}
.management-head, .management-actions, .file-grid, .health-grid {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.management-head h2 { flex: 1; margin: 0; font-size: 15px; font-family: var(--font-mono); overflow-wrap: anywhere; }
.management-actions { margin-top: 12px; }
.management-actions button, .management-actions a, .file-grid button, .file-grid a { padding: 5px 10px; font-size: 12px; }
.run-roster { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }
.run-agent { padding: 3px 8px; border-radius: var(--r-pill); background: var(--surface-strong); border: 1px solid var(--border); font-family: var(--font-mono); font-size: 12px; }
.meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 14px; margin-top: 10px; }
.meta-item { min-width: 0; color: var(--text-dim); overflow-wrap: anywhere; }
.meta-label { color: var(--text-faint); font-size: 11px; display: block; }
.run-detail, .archive-detail {
  max-height: 420px;
  overflow: auto;
  margin-top: 12px;
  padding: 12px;
  background: var(--solid-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 12px;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.file-grid { margin-top: 12px; align-items: stretch; }
.file-item { flex: 1 1 180px; padding: 9px; background: var(--solid-2); border: 1px solid var(--border); border-radius: var(--r-sm); }
.file-item strong { display: block; font-family: var(--font-mono); overflow-wrap: anywhere; }
.file-meta { color: var(--text-faint); font-size: 11px; overflow-wrap: anywhere; }
.health-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); align-items: stretch; }
.health-card { margin: 0; }
.health-card h2 { margin: 0 0 8px; font-size: 14px; }
.health-card dl { display: grid; grid-template-columns: minmax(90px, auto) 1fr; gap: 5px 10px; }
.health-card dt { color: var(--text-faint); }
.health-card dd { margin: 0; overflow-wrap: anywhere; }
.degraded { color: var(--accent-amber); }

@media (max-width: 800px) {
  .tip-layout, .board-layout, .agent-layout { grid-template-columns: 1fr; }
  .board-detail { position: static; }
  .agent-binding-row { grid-template-columns: 1fr 1fr; }
  .agent-binding-row .remove-binding { justify-self: start; }
  .management-list { grid-template-columns: 1fr; }
}
@media (max-width: 620px) {
  .shell { padding: 14px; }
  .form-grid { grid-template-columns: 1fr; }
  .form-grid .full { grid-column: auto; }
  .board-row { grid-template-columns: minmax(0, 1fr) 72px; }
  .board-row .board-small:last-child { display: none; }
}
</style>
${THEME_BOOTSTRAP}
${I18N_BOOTSTRAP}
</head>
<body>
<div class="aurora-bg"></div>
<div class="shell">
  ${renderAppHeader('memory')}

  <div id="notice" class="notice" hidden></div>
  <main id="memorySection" class="section">
  <div id="workspaceBar" class="workspace-bar">
    <label for="workspace" data-i18n="memory.workspaceLabel">Workspace · Memory only</label>
    <select id="workspace" aria-label="Select workspace" data-i18n-aria="memory.workspaceAria"></select>
    <span id="workspaceHint"></span>
  </div>

  <div class="tabs section-tabs" role="tablist" aria-label="Workspace Memory" data-i18n-aria="memory.tabs">
    <button id="tipsTab" class="tab active" role="tab" type="button" data-i18n="memory.tips">Project Tips</button>
    <button id="boardTab" class="tab" role="tab" type="button" data-i18n="memory.board">Shared Board · Raw</button>
    <button id="agentsTab" class="tab" role="tab" type="button" data-i18n="memory.agents">Agents &amp; Profiles</button>
  </div>

  <section id="tipsView" class="view" role="tabpanel">
    <div class="toolbar">
      <div class="field"><label for="statusFilter" data-i18n="common.status">Status</label><select id="statusFilter"><option value="" data-i18n="common.allStatuses">All statuses</option><option value="captured">captured</option><option value="exploring">exploring</option><option value="planned">planned</option><option value="implemented">implemented</option><option value="deferred">deferred</option><option value="discarded">discarded</option><option value="archived">archived</option></select></div>
      <div class="field"><label for="moduleFilter" data-i18n="common.module">Module</label><input id="moduleFilter" type="text" placeholder="module" data-i18n-placeholder="common.module"></div>
      <div class="field"><label for="tagFilter" data-i18n="common.tag">Tag</label><input id="tagFilter" type="text" placeholder="tag" data-i18n-placeholder="common.tag"></div>
      <label class="check"><input id="archivedFilter" type="checkbox"> <span data-i18n="memory.includeArchived">Include archived</span></label>
      <div class="field"><label for="tipLimit" data-i18n="common.limit">Limit</label><input id="tipLimit" type="number" min="1" max="1000" value="100"></div>
      <button id="newTip" class="primary" type="button" data-i18n="tips.new">+ New Tip</button>
    </div>
    <div class="tip-layout">
      <div id="tipList" class="list"></div>
      <aside id="tipDrawer" class="drawer" hidden></aside>
      <form id="tipForm" class="form-card" hidden>
        <h2 id="formTitle">New Tip</h2>
        <div class="form-grid">
          <div class="field"><label for="tipTitle" data-i18n="tips.title">Title *</label><input id="tipTitle" required type="text"></div>
          <div class="field"><label for="tipStatus" data-i18n="common.status">Status</label><select id="tipStatus"><option value="captured">captured</option><option value="exploring">exploring</option><option value="planned">planned</option><option value="implemented">implemented</option><option value="deferred">deferred</option><option value="discarded">discarded</option><option value="archived">archived</option></select></div>
          <div class="field full"><label for="tipSummary" data-i18n="tips.summary">Summary *</label><textarea id="tipSummary" required></textarea></div>
          <div class="field full"><label for="tipContext" data-i18n="tips.context">Context</label><textarea id="tipContext"></textarea></div>
          <div class="field"><label for="tipModule" data-i18n="common.module">Module</label><input id="tipModule" type="text"></div>
          <div class="field"><label for="tipNextAction" data-i18n="tips.nextAction">Next action</label><input id="tipNextAction" type="text"></div>
          <div class="field"><label for="tipTags" data-i18n="tips.tags">Tags · comma or newline separated</label><textarea id="tipTags"></textarea></div>
          <div class="field"><label for="tipSourceRefs" data-i18n="tips.sourceRefs">Source refs · comma or newline separated</label><textarea id="tipSourceRefs"></textarea></div>
          <div class="field"><label for="tipRelatedTipIds" data-i18n="tips.relatedTipIds">Related Tip IDs · comma or newline separated</label><textarea id="tipRelatedTipIds"></textarea></div>
          <div class="field"><label for="tipRelatedProjects" data-i18n="tips.relatedProjects">Related projects · comma or newline separated</label><textarea id="tipRelatedProjects"></textarea></div>
          <div class="field"><label for="tipSourceSessionId" data-i18n="tips.sourceSessionId">Source session ID</label><input id="tipSourceSessionId" type="text"></div>
          <div class="field"><label for="tipAuthor" data-i18n="tips.authorCreate">Author · create only</label><input id="tipAuthor" type="text"></div>
          <div class="field full"><label for="tipDocumentRefs" data-i18n="tips.documentRefs">Document refs · safe JSON array</label><textarea id="tipDocumentRefs" placeholder='[{"path":"docs/example.md","section":"Overview"}]'></textarea></div>
        </div>
        <div id="formError" class="form-error" role="alert"></div>
        <div class="form-actions"><button class="primary" type="submit" data-i18n="tips.save">Save Tip</button><button id="cancelForm" class="secondary" type="button" data-i18n="common.cancel">Cancel</button></div>
      </form>
    </div>
  </section>

  <section id="boardView" class="view" role="tabpanel" hidden>
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

  <section id="agentsView" class="view" role="tabpanel" hidden>
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
  </main>

  <main id="runsSection" class="section" hidden>
    <p class="section-intro" data-i18n="runs.intro">The run model is an in-memory event projection of the owner Bus. After a Bus restart, use Archives as the source of truth.</p>
    <div class="tabs section-tabs" role="tablist" aria-label="MoA Runs" data-i18n-aria="runs.tabs">
      <button id="liveRunsTab" class="tab active" role="tab" type="button" data-i18n="runs.live">Live &amp; Recent</button>
      <button id="archivesTab" class="tab" role="tab" type="button" data-i18n="runs.archives">Archives</button>
    </div>
    <section id="liveRunsView" class="subview" role="tabpanel">
      <div class="toolbar">
        <div class="field"><label for="runStatusFilter" data-i18n="common.status">Status</label><select id="runStatusFilter"><option value="" data-i18n="common.allStatuses">All statuses</option><option value="initialized">initialized</option><option value="debating">debating</option><option value="complete">complete</option><option value="closed">closed</option></select></div>
        <div class="field wide"><label for="runQuery" data-i18n="runs.query">Query</label><input id="runQuery" type="search" placeholder="task id, agent, binding slot" data-i18n-placeholder="runs.queryPlaceholder"></div>
        <button id="refreshRuns" class="secondary" type="button" data-i18n="common.refresh">Refresh</button>
        <span id="runResultCount" class="result-count" role="status">0 results</span>
      </div>
      <div id="runList" class="management-list"></div>
    </section>
    <section id="archivesView" class="subview" role="tabpanel" hidden>
      <div class="toolbar"><button id="refreshArchives" class="secondary" type="button" data-i18n="common.refresh">Refresh</button><span id="archiveResultCount" class="result-count" role="status">0 results</span></div>
      <div id="archiveList" class="management-list"></div>
    </section>
  </main>

  <main id="systemSection" class="section" hidden>
    <div class="toolbar">
      <button id="refreshSystem" class="secondary" type="button" data-i18n="common.refresh">Refresh</button>
      <button id="copyControlPlaneUrl" class="secondary" type="button" data-i18n="system.copyUrl">Copy Control Plane URL</button>
      <a class="secondary" href="/" data-i18n="system.openDebate">Open MOA Debate</a>
    </div>
    <p class="section-intro" data-i18n="system.intro">Bus listener entries do not represent every Kimi Session or MCP process. This page is read-only and provides no dangerous mutations.</p>
    <div id="systemHealth" class="health-grid"></div>
  </main>
</div>
<div id="boardModal" class="board-modal" role="dialog" aria-modal="true" aria-labelledby="boardFormTitle" hidden>
  <form id="boardForm" class="form-card board-form-card">
    <div class="board-form-head"><h2 id="boardFormTitle">New Board Entry</h2><button id="closeBoardForm" class="close" type="button" aria-label="Close Board form" data-i18n-aria="board.closeForm">×</button></div>
    <div class="form-grid">
      <div class="field"><label for="boardFormScope" data-i18n="board.scope">Scope *</label><select id="boardFormScope"><option value="workspace">workspace</option><option value="global">global</option></select></div>
      <div class="field"><label for="boardFormKey">key *</label><input id="boardFormKey" required type="text" autocomplete="off"></div>
      <div class="field full"><label for="boardFormValue" data-i18n="board.value">Markdown value</label><textarea id="boardFormValue"></textarea><div id="boardByteLine" class="byte-line"><span data-i18n="board.valueSize">UTF-8 value size</span><span id="boardValueBytes">0 / 32768 bytes</span></div></div>
      <div class="field"><label for="boardFormTags" data-i18n="tips.tags">Tags · comma or newline separated</label><textarea id="boardFormTags"></textarea></div>
      <div class="field"><label for="boardFormAuthor" data-i18n="board.author">Author</label><input id="boardFormAuthor" type="text"></div>
    </div>
    <div id="boardExternalWarning" class="external-warning" role="status" hidden data-i18n="board.external">Updated externally: your draft is preserved. Saving will confirm again and use the version stamp from when the form opened.</div>
    <div id="boardFormError" class="form-error" role="alert"></div>
    <button id="boardConflictReload" class="secondary" type="button" hidden data-i18n="board.reload">Reload current version</button>
    <div class="form-actions"><button id="saveBoardEntry" class="primary" type="submit" data-i18n="board.save">Save Entry</button><button id="cancelBoardForm" class="secondary" type="button" data-i18n="common.cancel">Cancel</button></div>
  </form>
</div>
<script>
${I18N_JS}
${LIB_JS}
(function () {
  'use strict';
  var tr = window.__moaI18n ? window.__moaI18n.t : function (key) { return key; };
  var STATUS_NAMES = ['captured', 'exploring', 'planned', 'implemented', 'deferred', 'discarded', 'archived'];
  var workspaceSelect = document.getElementById('workspace');
  var workspaceHint = document.getElementById('workspaceHint');
  var notice = document.getElementById('notice');
  var tipList = document.getElementById('tipList');
  var tipDrawer = document.getElementById('tipDrawer');
  var tipForm = document.getElementById('tipForm');
  var formError = document.getElementById('formError');
  var currentWorkspace = '';
  var workspaces = [];
  var selectedTip = null;
  var editingId = '';
  var BOARD_VALUE_MAX_BYTES = 32768;
  var boardEntries = [];
  var selectedBoardKey = '';
  var boardEditing = null;
  var boardEventSource = null;
  var boardPollTimer = null;
  var boardRefreshTimer = null;
  var boardSearchTimer = null;
  var activeView = 'tips';
  var activeSection = 'memory';
  var activeRunsView = 'live';
  var runsPollTimer = null;
  var systemPollTimer = null;
  var runSearchTimer = null;
  var ARCHIVE_FILES = ['result.json', 'probe.json', 'events.jsonl', 'board.jsonl'];
  var boardModal = document.getElementById('boardModal');
  var boardForm = document.getElementById('boardForm');
  var boardFormError = document.getElementById('boardFormError');
  var boardSaveButton = document.getElementById('saveBoardEntry');
  var agentList = document.getElementById('agentList');
  var agentForm = document.getElementById('agentForm');
  var agentEditorEmpty = document.getElementById('agentEditorEmpty');
  var agentConfigPanel = document.getElementById('agentConfigPanel');
  var agentReloadBanner = document.getElementById('agentReloadBanner');
  var agentSnapshot = null;
  var selectedAgentName = '';
  var selectedAgent = null;
  var agentIsNew = false;
  var agentLocalHash = null;
  var agentRawLoaded = false;
  var deletedBindings = [];

  function setNotice(message, isError) {
    notice.hidden = !message;
    notice.textContent = message || '';
    notice.className = 'notice' + (isError ? ' error' : '');
  }
  function setFormError(message) { formError.textContent = message || ''; }
  function valueText(value) {
    if (value === undefined || value === null) return '—';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
  }
  function api(url, options) {
    return fetch(url, options).then(function (response) {
      return response.text().then(function (raw) {
        var data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = { error: raw || 'invalid server response' }; }
        if (!response.ok) {
          var error = new Error(data && data.error ? data.error : 'HTTP ' + response.status);
          error.status = response.status;
          error.data = data;
          error.currentTs = data && data.currentTs;
          error.currentHash = data && data.currentHash;
          throw error;
        }
        return data;
      });
    });
  }
  function fetchText(url) {
    return fetch(url).then(function (response) {
      return response.text().then(function (raw) {
        if (!response.ok) throw new Error(raw || 'HTTP ' + response.status);
        return raw;
      });
    });
  }
  function utf8Bytes(value) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
    var bytes = 0;
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code < 128) bytes += 1;
      else if (code < 2048) bytes += 2;
      else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xDC00 && value.charCodeAt(i + 1) <= 0xDFFF) { bytes += 4; i += 1; }
      else bytes += 3;
    }
    return bytes;
  }
  function splitArray(id) {
    return document.getElementById(id).value.split(/[\\n,]+/).map(function (item) { return item.trim(); }).filter(Boolean);
  }
  function optionalText(id) {
    var value = document.getElementById(id).value.trim();
    return value ? value : null;
  }
  function parseDocumentRefs() {
    var raw = document.getElementById('tipDocumentRefs').value.trim();
    if (!raw) return null;
    var parsed;
    try { parsed = JSON.parse(raw); } catch (_) { throw new Error(tr('tips.documentJson')); }
    if (!Array.isArray(parsed)) throw new Error(tr('tips.documentArray'));
    return parsed;
  }
  function replaceLocationParam(name, value) {
    var next = new URL(location.href);
    if (value) next.searchParams.set(name, value); else next.searchParams.delete(name);
    history.replaceState(null, '', next.pathname + (next.search ? next.search : ''));
  }
  function updateLocation(id) { replaceLocationParam('workspace', id); }
  function updateSectionLocation(section) { replaceLocationParam('section', section); }
  function closeBoardSubscription() {
    if (boardEventSource) { boardEventSource.close(); boardEventSource = null; }
    if (boardPollTimer) { clearInterval(boardPollTimer); boardPollTimer = null; }
    if (boardRefreshTimer) { clearTimeout(boardRefreshTimer); boardRefreshTimer = null; }
  }
  function refreshActiveView() {
    if (!currentWorkspace && activeView !== 'board') return Promise.resolve();
    if (activeView === 'board') return loadBoard();
    if (activeView === 'agents') return loadAgentSummary();
    return loadTips();
  }
  function getBoardChannel() {
    if (activeSection !== 'memory' || activeView !== 'board') return '';
    var scopeEl = document.getElementById('boardScope');
    var scope = scopeEl ? scopeEl.value : 'workspace';
    if (scope === 'global') {
      return '@board/global';
    }
    return currentWorkspace ? '@board/workspace:' + currentWorkspace : '';
  }
  function connectBoardSubscription() {
    closeBoardSubscription();
    var channel = getBoardChannel();
    if (!channel) return;
    if (typeof EventSource !== 'undefined') {
      boardEventSource = new EventSource('/subscribe?task_id=' + encodeURIComponent(channel));
      boardEventSource.onmessage = function (event) {
        var payload = null;
        try { payload = JSON.parse(event.data); } catch (_) {}
        if (payload && payload.type === 'board_updated') handleBoardEvent(payload);
        if (boardRefreshTimer) clearTimeout(boardRefreshTimer);
        boardRefreshTimer = setTimeout(function () {
          boardRefreshTimer = null;
          refreshActiveView().catch(function () {});
        }, 300);
      };
      boardEventSource.onerror = function () {};
    }
    boardPollTimer = setInterval(function () { refreshActiveView().catch(function () {}); }, 15000);
  }
  function renderWorkspaceOptions() {
    workspaceSelect.textContent = '';
    workspaces.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.id + ' · ' + item.cwd;
      workspaceSelect.appendChild(option);
    });
  }
  function applyWorkspace(id) {
    if (!id || currentWorkspace === id) return;
    currentWorkspace = id;
    workspaceSelect.value = id;
    var info = workspaces.filter(function (item) { return item.id === id; })[0];
    workspaceHint.textContent = info ? info.cwd : '';
    updateLocation(id);
    closeBoardSubscription();
    connectBoardSubscription();
    if (activeView === 'agents') { clearAgentEditor(); agentSnapshot = null; agentLocalHash = null; }
    loadTips().catch(function (error) { setNotice(error.message, true); });
    if (activeView === 'board') loadBoard().catch(function (error) { setNotice(error.message, true); });
    if (activeView === 'agents') loadAgentSummary().catch(function (error) { setNotice(tr('agent.error') + error.message, true); });
  }
  function showNoWorkspace() {
    currentWorkspace = '';
    workspaceSelect.disabled = true;
    workspaceHint.textContent = '';
    closeBoardSubscription();
    tipList.textContent = '';
    var empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = tr('tips.noWorkspace');
    tipList.appendChild(empty);
    document.getElementById('boardList').textContent = '';
    agentSnapshot = null; agentLocalHash = null; clearAgentEditor(); agentList.textContent = '';
    setNotice(tr('tips.createWorkspace'), false);
  }
  function loadWorkspaces() {
    return api('/api/workspaces').then(function (data) {
      workspaces = data && Array.isArray(data.workspaces) ? data.workspaces : [];
      renderWorkspaceOptions();
      if (!workspaces.length) { showNoWorkspace(); return; }
      workspaceSelect.disabled = false;
      var requested = new URLSearchParams(location.search).get('workspace');
      var found = requested && workspaces.some(function (item) { return item.id === requested; }) ? requested : workspaces[0].id;
      applyWorkspace(found);
    });
  }
  function tipQuery() {
    var query = new URLSearchParams();
    query.set('workspace', currentWorkspace);
    var status = document.getElementById('statusFilter').value;
    var moduleName = document.getElementById('moduleFilter').value.trim();
    var tag = document.getElementById('tagFilter').value.trim();
    var limit = document.getElementById('tipLimit').value;
    if (status) query.set('status', status);
    if (moduleName) query.set('module', moduleName);
    if (tag) query.set('tag', tag);
    if (document.getElementById('archivedFilter').checked) query.set('includeArchived', 'true');
    if (limit) query.set('limit', limit);
    return query.toString();
  }
  function renderTipCard(tip) {
    var article = document.createElement('article');
    article.className = 'tip-card';
    var head = document.createElement('div');
    head.className = 'tip-head';
    var title = document.createElement('button');
    title.className = 'tip-title';
    title.type = 'button';
    title.textContent = tip.title || tip.id;
    title.addEventListener('click', function () { showTip(tip.id); });
    var status = document.createElement('span');
    status.className = 'status st-' + (tip.status || 'captured');
    status.textContent = tip.status || '—';
    head.appendChild(title);
    head.appendChild(status);
    article.appendChild(head);
    var summary = document.createElement('div');
    summary.className = 'tip-summary';
    summary.textContent = tip.summary || '';
    article.appendChild(summary);
    var meta = document.createElement('div');
    meta.className = 'tip-meta';
    if (tip.module) { var module = document.createElement('span'); module.textContent = tip.module; meta.appendChild(module); }
    (tip.tags || []).forEach(function (tag) { var chip = document.createElement('span'); chip.className = 'tag'; chip.textContent = '#' + tag; meta.appendChild(chip); });
    var updated = document.createElement('span');
    updated.textContent = tip.updatedAt || '';
    meta.appendChild(updated);
    article.appendChild(meta);
    var actions = document.createElement('div');
    actions.className = 'tip-actions';
    var details = document.createElement('button');
    details.className = 'secondary'; details.type = 'button'; details.textContent = tr('common.details');
    details.addEventListener('click', function () { showTip(tip.id); });
    actions.appendChild(details);
    if (tip.status !== 'archived') {
      var archive = document.createElement('button');
      archive.className = 'danger'; archive.type = 'button'; archive.textContent = tr('common.archive');
      archive.addEventListener('click', function () { archiveTip(tip.id); });
      actions.appendChild(archive);
    }
    article.appendChild(actions);
    return article;
  }
  function renderTipList(tips) {
    tipList.textContent = '';
    if (!tips.length) { var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('tips.empty'); tipList.appendChild(empty); return; }
    tips.forEach(function (tip) { tipList.appendChild(renderTipCard(tip)); });
  }
  function loadTips() {
    if (!currentWorkspace) return Promise.resolve();
    return api('/api/tips?' + tipQuery()).then(function (data) {
      renderTipList(data && Array.isArray(data.tips) ? data.tips : []);
    });
  }
  function addDetailRow(box, label, value, code) {
    var dt = document.createElement('dt'); dt.textContent = label;
    var dd = document.createElement('dd'); if (code) dd.className = 'code'; dd.textContent = valueText(value);
    box.appendChild(dt); box.appendChild(dd);
  }
  function renderDrawer(tip) {
    tipDrawer.textContent = '';
    var head = document.createElement('div'); head.className = 'drawer-head';
    var title = document.createElement('h2'); title.textContent = tip.title || tip.id;
    var close = document.createElement('button'); close.className = 'close'; close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', tr('common.closeDetails'));
    close.addEventListener('click', function () { tipDrawer.hidden = true; });
    head.appendChild(title); head.appendChild(close); tipDrawer.appendChild(head);
    var details = document.createElement('dl'); details.className = 'details';
    ['id', 'status', 'summary', 'context', 'module', 'tags', 'nextAction', 'documentRefs', 'sourceRefs', 'relatedTipIds', 'relatedProjects', 'sourceSessionId', 'author', 'createdAt', 'updatedAt'].forEach(function (field) {
      if (tip[field] !== undefined) addDetailRow(details, field, tip[field], field === 'documentRefs' || field === 'context');
    });
    tipDrawer.appendChild(details);
    var actions = document.createElement('div'); actions.className = 'tip-actions';
    var edit = document.createElement('button'); edit.className = 'primary'; edit.type = 'button'; edit.textContent = tr('common.edit'); edit.addEventListener('click', function () { openTipForm(tip); }); actions.appendChild(edit);
    var raw = document.createElement('button'); raw.className = 'secondary'; raw.type = 'button'; raw.textContent = tr('tips.boardLink', { id: tip.id }); raw.addEventListener('click', function () { openTipBoardEntry(tip.id); }); actions.appendChild(raw);
    if (tip.status !== 'archived') { var archive = document.createElement('button'); archive.className = 'danger'; archive.type = 'button'; archive.textContent = tr('common.archive'); archive.addEventListener('click', function () { archiveTip(tip.id); }); actions.appendChild(archive); }
    tipDrawer.appendChild(actions);
    tipDrawer.hidden = false;
  }
  function showTip(id) {
    if (!currentWorkspace) return Promise.resolve();
    return api('/api/tips/' + encodeURIComponent(id) + '?workspace=' + encodeURIComponent(currentWorkspace)).then(function (tip) {
      selectedTip = tip; renderDrawer(tip);
    }).catch(function (error) { setNotice(error.message, true); });
  }
  function setField(id, value) { document.getElementById(id).value = value == null ? '' : String(value); }
  function openTipForm(tip) {
    editingId = tip ? tip.id : '';
    document.getElementById('formTitle').textContent = tr(editingId ? 'tips.edit' : 'tips.new').replace(/^\\+\\s*/, '');
    setField('tipTitle', tip && tip.title); setField('tipSummary', tip && tip.summary); setField('tipStatus', (tip && tip.status) || 'captured');
    setField('tipContext', tip && tip.context); setField('tipModule', tip && tip.module); setField('tipNextAction', tip && tip.nextAction);
    setField('tipTags', tip && tip.tags ? tip.tags.join('\\n') : ''); setField('tipSourceRefs', tip && tip.sourceRefs ? tip.sourceRefs.join('\\n') : '');
    setField('tipRelatedTipIds', tip && tip.relatedTipIds ? tip.relatedTipIds.join('\\n') : ''); setField('tipRelatedProjects', tip && tip.relatedProjects ? tip.relatedProjects.join('\\n') : '');
    setField('tipSourceSessionId', tip && tip.sourceSessionId); setField('tipAuthor', tip && tip.author);
    setField('tipDocumentRefs', tip && tip.documentRefs ? JSON.stringify(tip.documentRefs, null, 2) : '');
    setFormError(''); tipForm.hidden = false; tipForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeTipForm() { editingId = ''; tipForm.hidden = true; setFormError(''); }
  function buildTipPayload() {
    var refs = parseDocumentRefs();
    var payload = { workspace: currentWorkspace, title: document.getElementById('tipTitle').value.trim(), summary: document.getElementById('tipSummary').value.trim(), status: document.getElementById('tipStatus').value };
    if (!payload.title || !payload.summary) throw new Error(tr('tips.required'));
    if (editingId) {
      payload.context = optionalText('tipContext'); payload.module = optionalText('tipModule'); payload.nextAction = optionalText('tipNextAction');
      payload.tags = splitArray('tipTags').length ? splitArray('tipTags') : null;
      payload.sourceRefs = splitArray('tipSourceRefs').length ? splitArray('tipSourceRefs') : null;
      payload.relatedTipIds = splitArray('tipRelatedTipIds').length ? splitArray('tipRelatedTipIds') : null;
      payload.relatedProjects = splitArray('tipRelatedProjects').length ? splitArray('tipRelatedProjects') : null;
      payload.sourceSessionId = optionalText('tipSourceSessionId'); payload.documentRefs = refs;
    } else {
      var context = optionalText('tipContext'); var moduleName = optionalText('tipModule'); var nextAction = optionalText('tipNextAction');
      if (context) payload.context = context; if (moduleName) payload.module = moduleName; if (nextAction) payload.nextAction = nextAction;
      var tags = splitArray('tipTags'); var sourceRefs = splitArray('tipSourceRefs'); var relatedTipIds = splitArray('tipRelatedTipIds'); var relatedProjects = splitArray('tipRelatedProjects');
      if (tags.length) payload.tags = tags; if (sourceRefs.length) payload.sourceRefs = sourceRefs; if (relatedTipIds.length) payload.relatedTipIds = relatedTipIds; if (relatedProjects.length) payload.relatedProjects = relatedProjects;
      var sourceSessionId = optionalText('tipSourceSessionId'); var author = optionalText('tipAuthor');
      if (sourceSessionId) payload.sourceSessionId = sourceSessionId; if (author) payload.author = author; if (refs !== null) payload.documentRefs = refs;
    }
    return payload;
  }
  tipForm.addEventListener('submit', function (event) {
    event.preventDefault(); setFormError('');
    var payload;
    try { payload = buildTipPayload(); } catch (error) { setFormError(error.message); return; }
    var method = editingId ? 'PATCH' : 'POST';
    var url = editingId ? '/api/tips/' + encodeURIComponent(editingId) : '/api/tips';
    api(url, { method: method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then(function (tip) {
      selectedTip = tip; closeTipForm(); renderDrawer(tip); return loadTips();
    }).catch(function (error) { setFormError(error.message); });
  });
  function archiveTip(id) {
    if (!currentWorkspace || !window.confirm(tr('tips.archiveConfirm'))) return;
    api('/api/tips/' + encodeURIComponent(id) + '/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: currentWorkspace }) }).then(function (tip) {
      selectedTip = tip; renderDrawer(tip); return loadTips();
    }).catch(function (error) { setNotice(error.message, true); });
  }
  function boardQuery() {
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
        renderBoardDetail(entry);
      });
      list.appendChild(row);
    });
    renderBoardDetail(boardEntries[selectedIndex]);
  }
  function loadBoard() {
    var scope = document.getElementById('boardScope').value;
    if (scope === 'workspace' && !currentWorkspace) {
      renderBoardList([]);
      setNotice(tr('board.scopeNotice'), false);
      return Promise.resolve();
    }
    return api('/api/board?' + boardQuery()).then(function (data) { renderBoardList(data && Array.isArray(data.entries) ? data.entries : []); });
  }
  function setAgentFormError(message) { document.getElementById('agentFormError').textContent = message || ''; }
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
  function setBoardFormError(message) { boardFormError.textContent = message || ''; }
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
    if (utf8Bytes(value) > BOARD_VALUE_MAX_BYTES) throw new Error(tr('board.tooLarge'));
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
    if (updateBoardValueBytes() > BOARD_VALUE_MAX_BYTES) { setBoardFormError(tr('board.tooLarge')); return; }
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
    var query = new URLSearchParams(); query.set('scope', boardEditing.scope); query.set('key', boardEditing.key); query.set('limit', '1000');
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
  function appendMeta(grid, label, value) {
    var item = document.createElement('div'); item.className = 'meta-item';
    var key = document.createElement('span'); key.className = 'meta-label'; key.textContent = label;
    var text = document.createElement('span'); text.textContent = valueText(value);
    item.appendChild(key); item.appendChild(text); grid.appendChild(item);
  }
  function makeButton(label, className, handler) {
    var button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; button.addEventListener('click', handler); return button;
  }
  function renderRunCard(task) {
    var card = document.createElement('article'); card.className = 'management-card';
    var head = document.createElement('div'); head.className = 'management-head';
    var title = document.createElement('h2'); title.textContent = task.taskId || 'unknown task';
    var status = document.createElement('span'); status.className = 'status'; status.textContent = task.status || 'unknown';
    head.appendChild(title); head.appendChild(status); card.appendChild(head);
    var roster = document.createElement('div'); roster.className = 'run-roster';
    var specs = Array.isArray(task.agentSpecs) ? task.agentSpecs : [];
    if (!specs.length && Array.isArray(task.agents)) specs = task.agents.map(function (id) { return { id: id }; });
    specs.forEach(function (agent) { var chip = document.createElement('span'); chip.className = 'run-agent'; chip.textContent = valueText(agent.id) + (agent.binding_slot ? ' · ' + agent.binding_slot : ''); roster.appendChild(chip); });
    card.appendChild(roster);
    var grid = document.createElement('div'); grid.className = 'meta-grid';
    appendMeta(grid, tr('runs.roundConfigured'), valueText(task.round) + ' / ' + valueText(task.roundsConfigured));
    appendMeta(grid, tr('runs.turn'), task.turn); appendMeta(grid, tr('runs.speaker'), task.currentSpeaker);
    appendMeta(grid, tr('runs.turnsSignoffs'), valueText(task.turnCount) + ' / ' + valueText(task.signoffCount));
    appendMeta(grid, tr('runs.lastEvent'), task.lastEvent); appendMeta(grid, tr('runs.updated'), task.updatedAt);
    if (task.early !== undefined || task.reason) appendMeta(grid, tr('runs.earlyReason'), (task.early ? 'early · ' : '') + valueText(task.reason));
    card.appendChild(grid);
    var actions = document.createElement('div'); actions.className = 'management-actions';
    actions.appendChild(makeButton(tr('common.details'), 'secondary', function () { showRunDetails(card, task.taskId); }));
    actions.appendChild(makeButton(tr('runs.copyTask'), 'secondary', function () { copyBoardText(task.taskId, 'task id'); }));
    actions.appendChild(makeButton(tr('runs.openLive'), 'primary', function () { openLiveCard(task.taskId); }));
    card.appendChild(actions); return card;
  }
  function showRunDetails(card, taskId) {
    api('/api/tasks/' + encodeURIComponent(taskId)).then(function (data) {
      var detail = card.querySelector('.run-detail');
      if (!detail) { detail = document.createElement('pre'); detail.className = 'run-detail'; card.appendChild(detail); }
      detail.textContent = JSON.stringify(data && data.task ? data.task : data, null, 2);
    }).catch(function (error) { setNotice(tr('runs.detailsError') + error.message, true); });
  }
  function safeCardUrl(value) {
    try {
      var url = new URL(value, location.href);
      var loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
      return url.protocol === 'http:' && loopback && url.port === location.port ? url.href : '';
    } catch (_) { return ''; }
  }
  function openLiveCard(taskId) {
    api('/api/tasks/' + encodeURIComponent(taskId)).then(function (data) {
      var target = safeCardUrl(data && data.cardUrl);
      if (!target) throw new Error('invalid cardUrl');
      window.open(target, '_blank', 'noopener');
    }).catch(function (error) { setNotice(tr('runs.openError') + error.message, true); });
  }
  function loadRuns() {
    var query = new URLSearchParams();
    var status = document.getElementById('runStatusFilter').value;
    var text = document.getElementById('runQuery').value.trim();
    if (status) query.set('status', status); if (text) query.set('query', text);
    return api('/api/tasks?' + query.toString()).then(function (data) {
      var tasks = data && Array.isArray(data.tasks) ? data.tasks : [];
      document.getElementById('runResultCount').textContent = tr(tasks.length === 1 ? 'board.result' : 'board.results', { count: tasks.length });
      var list = document.getElementById('runList'); list.textContent = '';
      if (!tasks.length) { var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('runs.empty'); list.appendChild(empty); return; }
      tasks.forEach(function (task) { list.appendChild(renderRunCard(task)); });
    });
  }
  function archiveUrl(taskId, file) {
    if (ARCHIVE_FILES.indexOf(file) < 0) return '';
    var query = new URLSearchParams(); query.set('task_id', taskId); query.set('file', file); return '/archive?' + query.toString();
  }
  function showArchiveFile(card, taskId, file) {
    var url = archiveUrl(taskId, file); if (!url) return;
    fetchText(url).then(function (raw) {
      var detail = card.querySelector('.archive-detail');
      if (!detail) { detail = document.createElement('pre'); detail.className = 'archive-detail'; card.appendChild(detail); }
      var shown = raw;
      if (file.slice(-5) === '.json') { try { shown = JSON.stringify(JSON.parse(raw), null, 2); } catch (_) {} }
      detail.textContent = shown;
      var oldActions = card.querySelector('.archive-detail-actions'); if (oldActions) oldActions.remove();
      var actions = document.createElement('div'); actions.className = 'management-actions archive-detail-actions';
      actions.appendChild(makeButton(tr('archives.copy', { file: file }), 'secondary', function () { copyBoardText(shown, file); }));
      var download = document.createElement('a'); download.className = 'secondary'; download.textContent = tr('archives.download', { file: file }); download.href = url; download.download = taskId + '-' + file; actions.appendChild(download);
      card.appendChild(actions);
    }).catch(function (error) { setNotice(tr('archives.fileError') + error.message, true); });
  }
  function renderArchiveCard(entry) {
    var card = document.createElement('article'); card.className = 'management-card';
    var head = document.createElement('div'); head.className = 'management-head';
    var title = document.createElement('h2'); title.textContent = entry.taskId || 'unknown task'; head.appendChild(title);
    var state = document.createElement('span'); state.className = entry.degraded ? 'degraded' : 'status'; state.textContent = tr(entry.degraded ? 'archives.degraded' : 'archives.available'); head.appendChild(state); card.appendChild(head);
    var grid = document.createElement('div'); grid.className = 'meta-grid'; appendMeta(grid, tr('archives.updated'), entry.updatedAt); appendMeta(grid, tr('archives.summary'), entry.summary || '—'); card.appendChild(grid);
    if (entry.degraded || (Array.isArray(entry.errors) && entry.errors.length)) {
      var errors = document.createElement('details'); var summary = document.createElement('summary'); summary.textContent = tr('archives.errors', { count: (entry.errors || []).length }); errors.appendChild(summary);
      var errorText = document.createElement('pre'); errorText.className = 'archive-detail'; errorText.textContent = JSON.stringify(entry.errors || [], null, 2); errors.appendChild(errorText); card.appendChild(errors);
    }
    var files = document.createElement('div'); files.className = 'file-grid';
    ARCHIVE_FILES.forEach(function (file) {
      var info = entry.files && entry.files[file];
      var item = document.createElement('div'); item.className = 'file-item';
      var name = document.createElement('strong'); name.textContent = file; item.appendChild(name);
      var meta = document.createElement('div'); meta.className = 'file-meta'; meta.textContent = info && info.exists ? valueText(info.size) + ' B · ' + valueText(info.mtime) : tr('archives.notPresent'); item.appendChild(meta);
      if (info && info.exists) item.appendChild(makeButton(tr('archives.view'), 'secondary', function () { showArchiveFile(card, entry.taskId, file); }));
      files.appendChild(item);
    });
    card.appendChild(files); return card;
  }
  function loadArchives() {
    return api('/api/archives').then(function (data) {
      var archives = data && Array.isArray(data.archives) ? data.archives : [];
      document.getElementById('archiveResultCount').textContent = tr(archives.length === 1 ? 'board.result' : 'board.results', { count: archives.length });
      var list = document.getElementById('archiveList'); list.textContent = '';
      if (!archives.length) { var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('archives.empty'); list.appendChild(empty); return; }
      archives.forEach(function (entry) { list.appendChild(renderArchiveCard(entry)); });
    });
  }
  function renderHealthCard(container, title, value) {
    var card = document.createElement('article'); card.className = 'card health-card';
    var heading = document.createElement('h2'); heading.textContent = title; card.appendChild(heading);
    var dl = document.createElement('dl');
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.keys(value).forEach(function (key) { var dt = document.createElement('dt'); dt.textContent = key; var dd = document.createElement('dd'); dd.textContent = valueText(value[key]); dl.appendChild(dt); dl.appendChild(dd); });
    else { var dt = document.createElement('dt'); dt.textContent = tr('system.value'); var dd = document.createElement('dd'); dd.textContent = valueText(value); dl.appendChild(dt); dl.appendChild(dd); }
    card.appendChild(dl); container.appendChild(card);
  }
  function loadSystem() {
    return api('/api/system').then(function (data) {
      var box = document.getElementById('systemHealth'); box.textContent = '';
      ['process', 'bus', 'runs', 'sse', 'archives', 'reuseWatch'].forEach(function (key) { renderHealthCard(box, key, data ? data[key] : undefined); });
      renderHealthCard(box, 'registry listenerEntries', data && data.registry ? data.registry.listenerEntries : undefined);
    }).catch(function (error) {
      var box = document.getElementById('systemHealth'); box.textContent = '';
      var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('system.unavailable') + error.message; box.appendChild(empty);
    });
  }
  function closeSectionResources() {
    closeBoardSubscription();
    if (runsPollTimer) { clearInterval(runsPollTimer); runsPollTimer = null; }
    if (systemPollTimer) { clearInterval(systemPollTimer); systemPollTimer = null; }
    if (runSearchTimer) { clearTimeout(runSearchTimer); runSearchTimer = null; }
  }
  function switchRunsView(view) {
    activeRunsView = view;
    document.getElementById('liveRunsView').hidden = view !== 'live'; document.getElementById('archivesView').hidden = view !== 'archives';
    document.getElementById('liveRunsTab').className = 'tab' + (view === 'live' ? ' active' : ''); document.getElementById('archivesTab').className = 'tab' + (view === 'archives' ? ' active' : '');
    if (runsPollTimer) { clearInterval(runsPollTimer); runsPollTimer = null; }
    if (activeSection !== 'runs') return;
    if (view === 'live') { loadRuns().catch(function (error) { setNotice(error.message, true); }); runsPollTimer = setInterval(function () { loadRuns().catch(function () {}); }, 5000); }
    else loadArchives().catch(function (error) { setNotice(error.message, true); });
  }
  function switchSection(section) {
    if (['memory', 'runs', 'system'].indexOf(section) < 0) section = 'memory';
    closeSectionResources(); activeSection = section; updateSectionLocation(section); setNotice('', false); tipDrawer.hidden = true;
    ['memory', 'runs', 'system'].forEach(function (name) {
      var current = name === section;
      var nav = document.getElementById(name + 'Nav');
      document.getElementById(name + 'Section').hidden = !current;
      nav.className = current ? 'active' : '';
      if (current) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
    });
    if (section === 'memory') { switchView(activeView); }
    else if (section === 'runs') switchRunsView(activeRunsView);
    else { loadSystem(); systemPollTimer = setInterval(function () { loadSystem(); }, 10000); }
  }
  function switchView(view) {
    if (['tips', 'board', 'agents'].indexOf(view) < 0) view = 'tips';
    activeView = view;
    document.getElementById('tipsView').hidden = view !== 'tips'; document.getElementById('boardView').hidden = view !== 'board'; document.getElementById('agentsView').hidden = view !== 'agents';
    document.getElementById('tipsTab').className = 'tab' + (view === 'tips' ? ' active' : ''); document.getElementById('boardTab').className = 'tab' + (view === 'board' ? ' active' : ''); document.getElementById('agentsTab').className = 'tab' + (view === 'agents' ? ' active' : '');
    connectBoardSubscription();
    if (view === 'board') loadBoard().catch(function (error) { setNotice(error.message, true); });
    else if (view === 'agents') loadAgentSummary().catch(function (error) { setNotice(tr('agent.error') + error.message, true); });
    else loadTips().catch(function (error) { setNotice(error.message, true); });
  }
  workspaceSelect.addEventListener('change', function () { applyWorkspace(workspaceSelect.value); });
  document.getElementById('newTip').addEventListener('click', function () { openTipForm(null); });
  document.getElementById('cancelForm').addEventListener('click', closeTipForm);
  document.getElementById('tipsTab').addEventListener('click', function () { switchView('tips'); });
  document.getElementById('boardTab').addEventListener('click', function () { switchView('board'); });
  document.getElementById('agentsTab').addEventListener('click', function () { switchView('agents'); });
  document.getElementById('refreshAgents').addEventListener('click', function () { loadAgentSummary().catch(function (error) { setNotice(tr('agent.error') + error.message, true); }); });
  document.getElementById('newAgent').addEventListener('click', openNewAgent);
  agentForm.addEventListener('submit', saveAgent);
  document.getElementById('deleteAgent').addEventListener('click', deleteAgent);
  document.getElementById('useAgentTemplate').addEventListener('click', useAgentTemplate);
  document.getElementById('agentLoadLatest').addEventListener('click', reloadAgentLatest);
  document.getElementById('addTypeBinding').addEventListener('click', function () { var list = document.getElementById('typeBindingsList'); list.querySelector('.empty') && (list.textContent = ''); appendAgentBindingRow(list, 'subagent', null); });
  document.getElementById('addSlotBinding').addEventListener('click', function () { var list = document.getElementById('slotBindingsList'); list.querySelector('.empty') && (list.textContent = ''); appendAgentBindingRow(list, 'subagent-slot', null); });
  document.getElementById('saveAgentBindings').addEventListener('click', saveAgentBindings);
  document.getElementById('loadAgentRaw').addEventListener('click', function () { loadAgentRaw().catch(function (error) { setAgentRawError(tr('agent.error') + error.message); }); });
  document.getElementById('saveAgentRaw').addEventListener('click', saveAgentRaw);
  document.getElementById('copyAgentReload').addEventListener('click', function () { copyBoardText('/reload', '/reload'); });
  document.getElementById('refreshBoard').addEventListener('click', function () { loadBoard().catch(function (error) { setNotice(error.message, true); }); });
  document.getElementById('newBoardEntry').addEventListener('click', function () { openBoardForm(null); });
  document.getElementById('closeBoardForm').addEventListener('click', closeBoardForm);
  document.getElementById('cancelBoardForm').addEventListener('click', closeBoardForm);
  document.getElementById('boardConflictReload').addEventListener('click', reloadBoardConflict);
  document.getElementById('boardFormValue').addEventListener('input', updateBoardValueBytes);
  boardForm.addEventListener('submit', saveBoardEntry);
  boardModal.addEventListener('click', function (event) { if (event.target === boardModal) closeBoardForm(); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !boardModal.hidden) closeBoardForm(); });
  ['statusFilter', 'archivedFilter'].forEach(function (id) { document.getElementById(id).addEventListener('change', function () { loadTips().catch(function (error) { setNotice(error.message, true); }); }); });
  ['moduleFilter', 'tagFilter', 'tipLimit'].forEach(function (id) { document.getElementById(id).addEventListener('change', function () { loadTips().catch(function (error) { setNotice(error.message, true); }); }); });
  document.getElementById('boardScope').addEventListener('change', function () { selectedBoardKey = ''; connectBoardSubscription(); loadBoard().catch(function (error) { setNotice(error.message, true); }); });
  ['boardKey', 'boardTag'].forEach(function (id) { document.getElementById(id).addEventListener('input', function () {
    if (boardSearchTimer) clearTimeout(boardSearchTimer);
    boardSearchTimer = setTimeout(function () { boardSearchTimer = null; loadBoard().catch(function (error) { setNotice(error.message, true); }); }, 250);
  }); });
  document.getElementById('boardLimit').addEventListener('change', function () { loadBoard().catch(function (error) { setNotice(error.message, true); }); });
  document.getElementById('boardSort').addEventListener('change', function () { renderBoardList(boardEntries); });
  ['memory', 'runs', 'system'].forEach(function (section) {
    document.getElementById(section + 'Nav').addEventListener('click', function (event) {
      event.preventDefault();
      switchSection(section);
    });
  });
  document.getElementById('liveRunsTab').addEventListener('click', function () { switchRunsView('live'); });
  document.getElementById('archivesTab').addEventListener('click', function () { switchRunsView('archives'); });
  document.getElementById('refreshRuns').addEventListener('click', function () { loadRuns().catch(function (error) { setNotice(error.message, true); }); });
  document.getElementById('runStatusFilter').addEventListener('change', function () { loadRuns().catch(function (error) { setNotice(error.message, true); }); });
  document.getElementById('runQuery').addEventListener('input', function () {
    if (runSearchTimer) clearTimeout(runSearchTimer);
    runSearchTimer = setTimeout(function () { runSearchTimer = null; if (activeSection === 'runs' && activeRunsView === 'live') loadRuns().catch(function (error) { setNotice(error.message, true); }); }, 250);
  });
  document.getElementById('refreshArchives').addEventListener('click', function () { loadArchives().catch(function (error) { setNotice(error.message, true); }); });
  document.getElementById('refreshSystem').addEventListener('click', loadSystem);
  document.getElementById('copyControlPlaneUrl').addEventListener('click', function () { copyBoardText(location.href, 'Control Plane URL'); });
  window.addEventListener('moamcp:localechange', function () {
    tr = window.__moaI18n.t;
    if (!workspaces.length) showNoWorkspace();
    if (selectedTip && !tipDrawer.hidden) renderDrawer(selectedTip);
    if (!tipForm.hidden) document.getElementById('formTitle').textContent = tr(editingId ? 'tips.edit' : 'tips.new').replace(/^\\+\\s*/, '');
    if (boardEditing) document.getElementById('boardFormTitle').textContent = tr(boardEditing.mode === 'edit' ? 'board.editTitle' : 'board.newTitle');
    if (activeSection === 'memory') {
      if (activeView === 'board') renderBoardList(boardEntries);
      else if (activeView === 'agents') { renderAgentList(agentSnapshot && agentSnapshot.agents); if (agentSnapshot) updateBindingRowTranslations(); if (selectedAgent && !agentIsNew) renderAgentMeta(selectedAgent); }
      else loadTips().catch(function () {});
    } else if (activeSection === 'runs') {
      if (activeRunsView === 'live') loadRuns().catch(function () {}); else loadArchives().catch(function () {});
    } else loadSystem();
  });
  window.addEventListener('beforeunload', closeSectionResources);
  var requestedSection = new URLSearchParams(location.search).get('section');
  switchSection(requestedSection);
  loadWorkspaces().catch(function (error) { setNotice(error.message, true); });
})();
</script>
</body>
</html>
`;
