// Control Plane page assembly entry (Step C).
// The per-page HTML/JS fragments live in ./pages/*.ts; this file keeps the
// shared shell: head + page-specific CSS, workspace bar and section/view
// scaffolding, and the script IIFE shell (shared state/helpers, section and
// view switching, event wiring, locale refresh, bootstrap). The composed
// CONTROL_PLANE_HTML must remain byte-identical to the pre-split output:
// keep fragment order and surrounding whitespace exactly as they are.

import { TOKENS_CSS, THEME_BOOTSTRAP } from './tokens.js';
import { COMPONENTS_CSS } from './components.js';
import { LIB_JS } from './lib.js';
import { I18N_BOOTSTRAP, I18N_JS } from './i18n.js';
import { renderAppHeader } from './app-header.js';
import {
  TIPS_VIEW_HTML,
  TIPS_PAGE_JS,
} from './pages/tips.js';
import {
  BOARD_VIEW_HTML,
  BOARD_MODAL_HTML,
  BOARD_LIST_JS,
  BOARD_FORM_JS,
} from './pages/board.js';
import { AGENTS_VIEW_HTML, AGENTS_PAGE_JS } from './pages/agents.js';
import { RUNS_SECTION_HTML, RUNS_PAGE_JS } from './pages/runs.js';
import { SYSTEM_SECTION_HTML, SYSTEM_PAGE_JS } from './pages/system.js';
import { PROJECTS_VIEW_HTML, PROJECTS_PAGE_JS } from './pages/projects.js';
import { INBOX_VIEW_HTML, INBOX_PAGE_JS } from './pages/inbox.js';

/** Check-mark data-uri for the custom .check checkbox skin. Fixed glass-ink
 * stroke — the same convention as components.ts' SELECT_CHEVRON fixed slate —
 * so the mark reads on every theme's --accent-green checked fill. */
const CHECK_MARK = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='8' viewBox='0 0 10 8'><path d='M1 4.2 3.8 7 9 1.4' fill='none' stroke='%230d1017' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/></svg>")`;

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
/* Workspace rename + release (mailbox task 5a/5c) */
.ws-actions {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.ws-actions button {
  padding: 8px 12px;
}
.ws-rename {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.ws-rename[hidden] {
  display: none;
}
.ws-rename input {
  min-width: 200px;
  padding: 8px 9px;
}
.ws-rename button {
  padding: 8px 12px;
}
.ws-actions button:disabled, .ws-rename button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
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
  cursor: pointer;
}
/* Custom checkbox skin in the .cs-* family: the native input stays the
   single source of truth (keyboard + AT operable) but drops its platform
   look. Box chrome comes from the same tokens as buttons/selects
   (--solid-2/--border-strong via the shared input rule, which also brings
   the themed focus ring); hover/checked use the accent-green tokens, so
   glass, liquid and editorial each render their own palette. */
.check input {
  appearance: none;
  -webkit-appearance: none;
  width: 17px;
  height: 17px;
  padding: 0;
  margin: 0;
  flex: 0 0 auto;
  border-radius: 4px;
  cursor: pointer;
  background-position: center;
  background-repeat: no-repeat;
}
.check input:hover {
  border-color: var(--accent-green);
}
.check input:checked {
  background-color: var(--accent-green);
  border-color: var(--accent-green);
  background-image: ${CHECK_MARK};
  background-size: 10px 8px;
}
.check input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
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

/* Projects & Handoff Inbox (mailbox task 4) */
.proj-toolbar, .ho-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  padding: 13px 15px;
  margin-bottom: 14px;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-1);
}
.proj-intro {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
  max-width: 640px;
  flex: 1 1 320px;
}
.proj-create {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.proj-create input {
  flex: 1 1 240px;
  max-width: 360px;
}
.proj-dirs {
  margin-top: 10px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
/* display:flex would otherwise override the hidden attribute's UA display:none. */
.proj-dirs[hidden] {
  display: none;
}
.proj-dir-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}
.proj-dir-cwd {
  flex: 1 1 auto;
  font-family: var(--mono, monospace);
  overflow-wrap: anywhere;
}
.proj-dir-hash {
  color: var(--text-faint);
  font-family: var(--mono, monospace);
  font-size: 11px;
}
.proj-dirs-empty {
  margin: 0;
  color: var(--text-dim);
  font-size: 12.5px;
}
.proj-list, .ho-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 880px;
}
.proj-card {
  padding: 14px 16px;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-1);
  transition: border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.proj-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
}
.proj-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.proj-name {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.proj-id {
  font-family: var(--font-mono);
  color: var(--text-faint);
  font-size: 12px;
}
.proj-meta {
  margin-top: 6px;
  color: var(--text-faint);
  font-size: 12px;
}
.proj-aliases {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.proj-aliases-label {
  color: var(--text-faint);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.03em;
}
.proj-actions {
  display: flex;
  gap: 7px;
  margin-top: 12px;
}
.proj-actions button {
  padding: 5px 10px;
  font-size: 12px;
}
/* Project rename / alias detach / archive (mailbox task 6) */
.proj-name-edit {
  cursor: pointer;
}
.proj-name-edit:hover {
  color: var(--accent-blue);
}
.proj-rename {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 240px;
}
.proj-rename input {
  min-width: 160px;
  padding: 6px 8px;
}
.proj-rename button {
  padding: 6px 10px;
  font-size: 12px;
}
.proj-alias {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.proj-alias-hash {
  overflow-wrap: anywhere;
}
.proj-alias-detach {
  border: 0;
  background: transparent;
  color: var(--text-faint);
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  border-radius: 4px;
  cursor: pointer;
}
.proj-alias-detach:hover {
  color: var(--accent-red);
}
.ho-row {
  padding: 13px 15px;
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-1);
  transition: border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.ho-row:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
}
.ho-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.ho-title {
  flex: 1;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-weight: 600;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.ho-title:hover {
  color: var(--accent-blue);
}
.ho-summary {
  margin: 7px 0;
  color: var(--text-dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ho-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--text-faint);
  font-size: 12px;
  align-items: center;
}
.ho-actions {
  display: flex;
  gap: 7px;
  margin-top: 10px;
}
.ho-actions button {
  padding: 4px 10px;
  font-size: 12px;
}
.ho-detail {
  margin-top: 12px;
  padding: 12px;
  background: var(--solid-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.status.ho-pending { background: var(--tint-blue); color: var(--accent-blue); border-color: var(--tint-blue-border); }
.status.ho-consumed { background: var(--tint-green); color: var(--accent-green); border-color: var(--tint-green-border); }
.status.ho-archived { background: var(--hover-tint-subtle); color: var(--text-faint); }
.ho-toggle {
  display: flex;
  gap: 7px;
  margin-left: auto;
}
.ho-toggle .secondary.active {
  background: var(--tint-green);
  border-color: var(--tint-green-border);
  color: var(--accent-green);
}

@media (max-width: 800px) {
  .tip-layout, .board-layout, .agent-layout { grid-template-columns: 1fr; }
  .board-detail { position: static; }
  .agent-binding-row { grid-template-columns: 1fr 1fr; }
  .agent-binding-row .remove-binding { justify-self: start; }
  .management-list { grid-template-columns: 1fr; }
  .ho-toggle { margin-left: 0; }
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
    <span class="ws-actions">
      <button id="renameWorkspaceButton" class="secondary" type="button" disabled data-i18n="workspace.rename" data-i18n-title="workspace.renameTitle">Rename</button>
      <button id="releaseWorkspaceButton" class="danger" type="button" disabled data-i18n="workspace.release" data-i18n-title="workspace.releaseTitle">Release</button>
    </span>
    <span id="workspaceRename" class="ws-rename" hidden>
      <input id="workspaceRenameInput" type="text" maxlength="80" data-i18n-placeholder="workspace.renamePlaceholder" placeholder="Workspace name (empty clears)">
      <button id="workspaceRenameSave" class="primary" type="button" data-i18n="workspace.renameSave">Save</button>
      <button id="workspaceRenameCancel" class="secondary" type="button" data-i18n="common.cancel">Cancel</button>
    </span>
    <span id="workspaceHint"></span>
  </div>

  <div class="tabs section-tabs" role="tablist" aria-label="Workspace Memory" data-i18n-aria="memory.tabs">
    <button id="tipsTab" class="tab active" role="tab" type="button" data-i18n="memory.tips">Project Tips</button>
    <button id="boardTab" class="tab" role="tab" type="button" data-i18n="memory.board">Shared Board · Raw</button>
    <button id="agentsTab" class="tab" role="tab" type="button" data-i18n="memory.agents">Agents &amp; Profiles</button>
    <button id="projectsTab" class="tab" role="tab" type="button" data-i18n="memory.projects">Projects</button>
    <button id="inboxTab" class="tab" role="tab" type="button" data-i18n="memory.inbox">Handoff Inbox</button>
  </div>

${TIPS_VIEW_HTML}
${BOARD_VIEW_HTML}
${AGENTS_VIEW_HTML}
${PROJECTS_VIEW_HTML}
${INBOX_VIEW_HTML}  </main>

${RUNS_SECTION_HTML}
${SYSTEM_SECTION_HTML}</div>
${BOARD_MODAL_HTML}<script>
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
  var projects = [];
  var workspaceRename = document.getElementById('workspaceRename');
  var workspaceRenameInput = document.getElementById('workspaceRenameInput');
  var selectedTip = null;
  var editingId = '';
  var BOARD_VALUE_MAX_BYTES = 32768;
  var boardEntries = [];
  var selectedBoardKey = '';
  var boardEditing = null;
  var boardSubscription = null;
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

  // ---- Bus update banner (BUS_VERSION_RESTART.md task B) ----
  // Control-plane only (deliberate: the shared lib must stay reload-free).
  // The served page may be older than the build installed on disk; the banner
  // makes that visible and offers a controlled restart (task C endpoint).
  function compareVersions(a, b) {
    var pa = String(a).split('.').map(Number);
    var pb = String(b).split('.').map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0;
      var y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }
  var busUpdateBanner = null;
  var busUpdateRestarting = false;
  var busUpdateTarget = null;
  function busUpdateBannerEl() {
    if (busUpdateBanner) return busUpdateBanner;
    busUpdateBanner = document.createElement('div');
    busUpdateBanner.className = 'bus-update-banner';
    busUpdateBanner.hidden = true;
    document.body.appendChild(busUpdateBanner);
    return busUpdateBanner;
  }
  function checkDiskVersion() {
    if (busUpdateRestarting) return;
    api('/api/system').then(function (data) {
      if (!data || typeof data.version !== 'string' || typeof data.diskVersion !== 'string') return;
      if (compareVersions(data.diskVersion, data.version) <= 0) {
        busUpdateBannerEl().hidden = true;
        return;
      }
      var banner = busUpdateBannerEl();
      busUpdateTarget = data.diskVersion;
      banner.className = 'bus-update-banner';
      banner.textContent = '';
      var text = document.createElement('span');
      text.textContent = tr('busUpdate.banner', { disk: data.diskVersion, running: data.version });
      banner.appendChild(text);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary';
      btn.textContent = tr('busUpdate.restart');
      btn.addEventListener('click', restartBackend);
      banner.appendChild(btn);
      banner.hidden = false;
    }).catch(function () {});
  }
  function restartBackend() {
    if (busUpdateRestarting) return;
    busUpdateRestarting = true;
    var banner = busUpdateBannerEl();
    banner.className = 'bus-update-banner';
    banner.textContent = tr('busUpdate.restarting');
    banner.hidden = false;
    var target = busUpdateTarget;
    api('/api/bus/restart', { method: 'POST' }).catch(function () {});
    var attempts = 0;
    var timer = setInterval(function () {
      attempts++;
      api('/api/system').then(function (d) {
        // The disk truth does not change mid-flow, so backfill the target from
        // any successful poll instead of relying on a racy pre-restart GET:
        // a failed first GET used to lock reload out forever and end in a
        // misleading "stale" banner after a successful restart.
        if (d && typeof d.diskVersion === 'string') target = d.diskVersion;
        if (d && typeof d.version === 'string' && target !== null && compareVersions(d.version, target) >= 0) {
          clearInterval(timer);
          location.reload();
        }
      }).catch(function () {}); // request failures while the old owner releases are expected
      if (attempts >= 15) {
        clearInterval(timer);
        busUpdateRestarting = false;
        banner.className = 'bus-update-banner danger';
        banner.textContent = tr('busUpdate.stale');
      }
    }, 2000);
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
    if (boardSubscription) { boardSubscription.close(); boardSubscription = null; }
    if (boardRefreshTimer) { clearTimeout(boardRefreshTimer); boardRefreshTimer = null; }
  }
  function refreshActiveView() {
    if (!currentWorkspace && activeView !== 'board') return Promise.resolve();
    if (activeView === 'board') return loadBoard();
    if (activeView === 'agents') return loadAgentSummary();
    if (activeView === 'projects') return loadProjects();
    if (activeView === 'inbox') return loadInbox();
    return loadTips();
  }
  function getBoardChannel() {
    if (activeSection !== 'memory' || activeView !== 'board') return '';
    var scopeEl = document.getElementById('boardScope');
    var scope = scopeEl ? scopeEl.value : 'workspace';
    if (scope === 'global') {
      return '@board/global';
    }
    // Project selections key the synthetic channel directly (project:<id>);
    // workspace selections keep the workspace:<hash> channel.
    if (currentWorkspace && isProjectValue(currentWorkspace)) return '@board/' + currentWorkspace;
    return currentWorkspace ? '@board/workspace:' + currentWorkspace : '';
  }
  function connectBoardSubscription() {
    closeBoardSubscription();
    var channel = getBoardChannel();
    if (!channel) return;
    boardSubscription = window.__moaLib.subscribeWithPoll('/subscribe?task_id=' + encodeURIComponent(channel), function (event) {
      var payload = null;
      try { payload = JSON.parse(event.data); } catch (_) {}
      if (payload && payload.type === 'board_updated') handleBoardEvent(payload);
      if (boardRefreshTimer) clearTimeout(boardRefreshTimer);
      boardRefreshTimer = setTimeout(function () {
        boardRefreshTimer = null;
        refreshActiveView().catch(function () {});
      }, 300);
    }, function () { refreshActiveView().catch(function () {}); }, window.__moaLib.POLL_MS.sseFallback);
  }
  function isProjectValue(value) { return typeof value === 'string' && value.indexOf('project:') === 0; }
  function projectForValue(value) {
    if (!isProjectValue(value)) return null;
    var projectId = value.slice('project:'.length);
    return projects.filter(function (project) { return project.projectId === projectId; })[0] || null;
  }
  function projectLabel(project) { return project ? (project.name || project.projectId) : ''; }
  function aliasedWorkspaceIds() {
    // Workspaces aliased to a project are already represented by that project's
    // option; showing them again as plain workspaces duplicates one board under
    // two identities (their lag-recreated sidecar is just a shell).
    var ids = {};
    projects.forEach(function (project) {
      (project.aliases || []).forEach(function (hash) { ids[hash] = true; });
    });
    return ids;
  }
  function workspaceDisplay(item) {
    // Custom name first (mailbox task 5a): "name (cwd)", falling back to cwd.
    return item.name ? item.name + ' (' + item.cwd + ')' : item.cwd;
  }
  function renderWorkspaceOptions() {
    workspaceSelect.textContent = '';
    var aliased = aliasedWorkspaceIds();
    var plainWorkspaces = workspaces.filter(function (item) { return !aliased[item.id]; });
    if (plainWorkspaces.length) {
      var wsGroup = document.createElement('optgroup');
      wsGroup.label = tr('workspace.groupWorkspaces');
      plainWorkspaces.forEach(function (item) {
        var option = document.createElement('option');
        option.value = item.id;
        option.textContent = workspaceDisplay(item);
        wsGroup.appendChild(option);
      });
      workspaceSelect.appendChild(wsGroup);
    }
    if (projects.length) {
      // Merged workspaces/projects stay browsable via project:<id> (task 5b).
      var projectGroup = document.createElement('optgroup');
      projectGroup.label = tr('workspace.groupProjects');
      projects.forEach(function (project) {
        var option = document.createElement('option');
        option.value = 'project:' + project.projectId;
        option.textContent = projectLabel(project);
        projectGroup.appendChild(option);
      });
      workspaceSelect.appendChild(projectGroup);
    }
    if (currentWorkspace) workspaceSelect.value = currentWorkspace;
  }
  function updateWorkspaceActions() {
    var actionable = !!currentWorkspace && !isProjectValue(currentWorkspace);
    document.getElementById('renameWorkspaceButton').disabled = !actionable;
    document.getElementById('releaseWorkspaceButton').disabled = !actionable;
    if (!actionable) closeWorkspaceRename();
  }
  function openWorkspaceRename() {
    if (!currentWorkspace || isProjectValue(currentWorkspace)) return;
    var info = workspaces.filter(function (item) { return item.id === currentWorkspace; })[0];
    workspaceRenameInput.value = info && info.name ? info.name : '';
    workspaceRename.hidden = false;
    workspaceRenameInput.focus();
  }
  function closeWorkspaceRename() { workspaceRename.hidden = true; }
  function saveWorkspaceRename() {
    if (!currentWorkspace || isProjectValue(currentWorkspace)) return;
    var id = currentWorkspace;
    var name = workspaceRenameInput.value.trim();
    api('/api/workspaces/' + encodeURIComponent(id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name }) }).then(function (updated) {
      closeWorkspaceRename();
      var info = workspaces.filter(function (item) { return item.id === id; })[0];
      if (info) info.name = updated && updated.name ? updated.name : null;
      renderWorkspaceOptions();
      setNotice(tr('workspace.renamed'), false);
    }).catch(function (error) { setNotice(error.message, true); });
  }
  function releaseCurrentWorkspace() {
    if (!currentWorkspace || isProjectValue(currentWorkspace)) return;
    var info = workspaces.filter(function (item) { return item.id === currentWorkspace; })[0];
    var label = info ? workspaceDisplay(info) : currentWorkspace;
    if (!window.confirm(tr('workspace.releaseConfirm', { workspace: label }))) return;
    api('/api/workspaces/' + encodeURIComponent(currentWorkspace), { method: 'DELETE' }).then(function () {
      setNotice(tr('workspace.released'), false);
      // Reload picks the first remaining workspace/project automatically when
      // the released selection is gone (task 5c).
      return loadWorkspaces().catch(function (error) { setNotice(error.message, true); });
    }).catch(function (error) { setNotice(error.message, true); });
  }
  function applyWorkspace(id) {
    if (!id || currentWorkspace === id) return;
    currentWorkspace = id;
    workspaceSelect.value = id;
    var info = workspaces.filter(function (item) { return item.id === id; })[0];
    var project = projectForValue(id);
    // The bar names the selection: cwd for workspaces, the project name (or
    // projectId) when a project is selected (tasks 5a/5b).
    workspaceHint.textContent = info ? info.cwd : (project ? projectLabel(project) : '');
    updateWorkspaceActions();
    updateLocation(id);
    closeBoardSubscription();
    connectBoardSubscription();
    if (activeView === 'agents') { clearAgentEditor(); agentSnapshot = null; agentLocalHash = null; }
    loadTips().catch(function (error) { setNotice(error.message, true); });
    if (activeView === 'board') loadBoard().catch(function (error) { setNotice(error.message, true); });
    if (activeView === 'agents') loadAgentSummary().catch(function (error) { setNotice(tr('agent.error') + error.message, true); });
    if (activeView === 'projects') loadProjects().catch(function (error) { setNotice(error.message, true); });
    if (activeView === 'inbox') loadInbox().catch(function (error) { setNotice(error.message, true); });
  }
  function showNoWorkspace() {
    currentWorkspace = '';
    workspaceSelect.disabled = true;
    workspaceHint.textContent = '';
    updateWorkspaceActions();
    closeBoardSubscription();
    tipList.textContent = '';
    var empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = tr('tips.noWorkspace');
    tipList.appendChild(empty);
    document.getElementById('boardList').textContent = '';
    agentSnapshot = null; agentLocalHash = null; clearAgentEditor(); agentList.textContent = '';
    document.getElementById('projectsList').textContent = '';
    document.getElementById('inboxList').textContent = '';
    setNotice(tr('tips.createWorkspace'), false);
  }
  function loadWorkspaces() {
    // Projects are fetched alongside (task 5b): merged workspaces vanish from
    // /api/workspaces but stay browsable as project:<projectId> options.
    return Promise.all([
      api('/api/workspaces'),
      api('/api/projects').catch(function () { return { projects: [] }; })
    ]).then(function (results) {
      workspaces = results[0] && Array.isArray(results[0].workspaces) ? results[0].workspaces : [];
      projects = results[1] && Array.isArray(results[1].projects) ? results[1].projects : [];
      renderWorkspaceOptions();
      if (!workspaces.length && !projects.length) { showNoWorkspace(); return; }
      workspaceSelect.disabled = false;
      var requested = new URLSearchParams(location.search).get('workspace');
      var known = function (value) {
        return workspaces.some(function (item) { return item.id === value; })
          || projects.some(function (project) { return 'project:' + project.projectId === value; });
      };
      // Prefer a non-aliased workspace; aliased ones are hidden behind their
      // project option, so fall through to the first project instead.
      var aliased = aliasedWorkspaceIds();
      var firstPlain = workspaces.filter(function (item) { return !aliased[item.id]; })[0];
      var fallback = firstPlain ? firstPlain.id
        : (projects.length ? 'project:' + projects[0].projectId : (workspaces.length ? workspaces[0].id : ''));
      var found = requested && known(requested) ? requested : fallback;
      applyWorkspace(found);
    });
  }
${TIPS_PAGE_JS}${BOARD_LIST_JS}${AGENTS_PAGE_JS}${BOARD_FORM_JS}${RUNS_PAGE_JS}${SYSTEM_PAGE_JS}${PROJECTS_PAGE_JS}${INBOX_PAGE_JS}  function closeSectionResources() {
    closeBoardSubscription();
    if (runsPollTimer) { runsPollTimer.stop(); runsPollTimer = null; }
    if (systemPollTimer) { systemPollTimer.stop(); systemPollTimer = null; }
    if (runSearchTimer) { clearTimeout(runSearchTimer); runSearchTimer = null; }
  }
  function switchRunsView(view) {
    activeRunsView = view;
    document.getElementById('liveRunsView').hidden = view !== 'live'; document.getElementById('archivesView').hidden = view !== 'archives';
    document.getElementById('liveRunsTab').className = 'tab' + (view === 'live' ? ' active' : ''); document.getElementById('archivesTab').className = 'tab' + (view === 'archives' ? ' active' : '');
    if (runsPollTimer) { runsPollTimer.stop(); runsPollTimer = null; }
    if (activeSection !== 'runs') return;
    if (view === 'live') { loadRuns().catch(function (error) { setNotice(error.message, true); }); runsPollTimer = window.__moaLib.startPoll(function () { loadRuns().catch(function () {}); }, window.__moaLib.POLL_MS.runs); }
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
    else { loadSystem(); systemPollTimer = window.__moaLib.startPoll(function () { loadSystem(); }, window.__moaLib.POLL_MS.system); }
  }
  function switchView(view) {
    if (['tips', 'board', 'agents', 'projects', 'inbox'].indexOf(view) < 0) view = 'tips';
    activeView = view;
    document.getElementById('tipsView').hidden = view !== 'tips'; document.getElementById('boardView').hidden = view !== 'board'; document.getElementById('agentsView').hidden = view !== 'agents'; document.getElementById('projectsView').hidden = view !== 'projects'; document.getElementById('inboxView').hidden = view !== 'inbox';
    document.getElementById('tipsTab').className = 'tab' + (view === 'tips' ? ' active' : ''); document.getElementById('boardTab').className = 'tab' + (view === 'board' ? ' active' : ''); document.getElementById('agentsTab').className = 'tab' + (view === 'agents' ? ' active' : ''); document.getElementById('projectsTab').className = 'tab' + (view === 'projects' ? ' active' : ''); document.getElementById('inboxTab').className = 'tab' + (view === 'inbox' ? ' active' : '');
    connectBoardSubscription();
    if (view === 'board') loadBoard().catch(function (error) { setNotice(error.message, true); });
    else if (view === 'agents') loadAgentSummary().catch(function (error) { setNotice(tr('agent.error') + error.message, true); });
    else if (view === 'projects') loadProjects().catch(function (error) { setNotice(error.message, true); });
    else if (view === 'inbox') loadInbox().catch(function (error) { setNotice(error.message, true); });
    else loadTips().catch(function (error) { setNotice(error.message, true); });
  }
  workspaceSelect.addEventListener('change', function () { applyWorkspace(workspaceSelect.value); });
  document.getElementById('renameWorkspaceButton').addEventListener('click', openWorkspaceRename);
  document.getElementById('releaseWorkspaceButton').addEventListener('click', releaseCurrentWorkspace);
  document.getElementById('workspaceRenameSave').addEventListener('click', saveWorkspaceRename);
  document.getElementById('workspaceRenameCancel').addEventListener('click', closeWorkspaceRename);
  workspaceRenameInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); saveWorkspaceRename(); }
    else if (event.key === 'Escape') closeWorkspaceRename();
  });
  document.getElementById('newTip').addEventListener('click', function () { openTipForm(null); });
  document.getElementById('cancelForm').addEventListener('click', closeTipForm);
  document.getElementById('tipsTab').addEventListener('click', function () { switchView('tips'); });
  document.getElementById('boardTab').addEventListener('click', function () { switchView('board'); });
  document.getElementById('agentsTab').addEventListener('click', function () { switchView('agents'); });
  document.getElementById('projectsTab').addEventListener('click', function () { switchView('projects'); });
  document.getElementById('inboxTab').addEventListener('click', function () { switchView('inbox'); });
  document.getElementById('refreshProjects').addEventListener('click', function () { loadProjects().catch(function (error) { setNotice(error.message, true); }); });
  document.getElementById('createProject').addEventListener('click', createProjectFromCurrentWorkspace);
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
    if (!workspaces.length && !projects.length) showNoWorkspace();
    else renderWorkspaceOptions();
    if (selectedTip && !tipDrawer.hidden) renderDrawer(selectedTip);
    if (!tipForm.hidden) document.getElementById('formTitle').textContent = tr(editingId ? 'tips.edit' : 'tips.new').replace(/^\\+\\s*/, '');
    if (boardEditing) document.getElementById('boardFormTitle').textContent = tr(boardEditing.mode === 'edit' ? 'board.editTitle' : 'board.newTitle');
    if (activeSection === 'memory') {
      if (activeView === 'board') renderBoardList(boardEntries);
      else if (activeView === 'agents') { renderAgentList(agentSnapshot && agentSnapshot.agents); if (agentSnapshot) updateBindingRowTranslations(); if (selectedAgent && !agentIsNew) renderAgentMeta(selectedAgent); }
      else if (activeView === 'projects') loadProjects().catch(function () {});
      else if (activeView === 'inbox') loadInbox().catch(function () {});
      else loadTips().catch(function () {});
    } else if (activeSection === 'runs') {
      if (activeRunsView === 'live') loadRuns().catch(function () {}); else loadArchives().catch(function () {});
    } else loadSystem();
  });
  window.addEventListener('beforeunload', closeSectionResources);
  var requestedSection = new URLSearchParams(location.search).get('section');
  switchSection(requestedSection);
  loadWorkspaces().catch(function (error) { setNotice(error.message, true); });
  checkDiskVersion();
  setInterval(checkDiskVersion, 60000);
})();
</script>
</body>
</html>
`;
