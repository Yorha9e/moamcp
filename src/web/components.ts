/**
 * moamcp web v3 shared component styles.
 * Glass cards, badges, buttons, form controls, progress pills, drawer, modal,
 * themed custom select (EnhanceSelect).
 */

/** Shared chevron data-uri used by native selects and the custom .cs-btn trigger. */
const SELECT_CHEVRON = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%2394a3b8' stroke-width='1.5' stroke-linecap='round'/></svg>")`;

export const COMPONENTS_CSS = `
/* Layout Container */
.wrap, .shell {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px 20px 56px;
  position: relative;
  z-index: 1;
}
.shell {
  max-width: 1220px;
}

/* Chrome Header (Sticky with Backdrop Blur) */
header {
  display: flex;
  align-items: center;
  gap: var(--sp3);
  margin-bottom: var(--sp5);
  flex-wrap: wrap;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--sp2);
}
.brand-mark {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  background: var(--aurora);
  box-shadow: var(--glow-green-brand);
}
.brand-title {
  background: var(--aurora);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  font-weight: 700;
  font-size: 18px;
  letter-spacing: 0.01em;
}
.app-version {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.app-version .app-version-value {
  color: var(--text-faint);
}
header h1 {
  font-size: 18px;
  font-weight: 650;
  letter-spacing: 0.01em;
}
header .control-link {
  padding: 4px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-pill);
  color: var(--accent-blue);
  font-size: 12px;
  background: var(--surface);
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
header .control-link:hover {
  border-color: var(--accent-green);
  color: var(--accent-green);
}
header .task {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 12.5px;
}
#conn {
  font-size: 12px;
  color: var(--text-faint);
}

/* Top Nav (Control Plane) */
.top-nav {
  display: flex;
  align-items: center;
  gap: var(--sp1);
  margin-left: auto;
  padding: 4px;
  background: var(--surface-strong);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
}
.top-nav a, .top-nav span {
  padding: 5px 13px;
  border-radius: var(--r-pill);
  color: var(--text-dim);
  font-size: 13px;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.top-nav a:hover {
  color: var(--text);
  background: var(--surface);
}
.top-nav .active {
  color: var(--accent-green);
  background: var(--aurora-dim);
}
.top-nav .muted {
  color: var(--text-faint);
  cursor: default;
}

/* Header pickers: compact pill groups shared by every page. */
.theme-picker, .locale-picker {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  background: var(--surface-strong);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
}
.theme-pill, .locale-pill {
  padding: 4px 10px;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  border-radius: var(--r-pill);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.locale-pill { padding-inline: 7px; }
.locale-separator { color: var(--text-faint); font-size: 11px; }
.theme-pill:hover, .locale-pill:hover {
  color: var(--text);
  background: var(--surface);
}
.theme-pill.active, .locale-pill.active {
  color: var(--accent-green);
  background: var(--aurora-dim);
}

/* Glass Cards (Long Scrolling Containers: NO backdrop-filter blur!) */
.card {
  background: var(--solid);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: var(--sp4) var(--sp5);
  margin-bottom: var(--sp3);
  box-shadow: var(--shadow-2);
  transition: border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.card:hover {
  border-color: var(--border-strong);
}

.sec-title {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-bottom: var(--sp3);
}
.sec-title::before {
  content: '';
  width: 3px;
  height: 12px;
  border-radius: 2px;
  background: var(--aurora);
}
.sec-title .aux {
  margin-left: auto;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  font-size: 12px;
}
.hint {
  color: var(--text-faint);
}

/* Badges */
.badge {
  margin-left: auto;
  padding: 3px 12px;
  border-radius: var(--r-pill);
  font-size: 12px;
  font-weight: 500;
  background: var(--surface-strong);
  color: var(--text-dim);
  border: 1px solid var(--border);
}
.badge.live, .badge.initialized, .badge.debating {
  background: var(--tint-green);
  color: var(--accent-green);
  border-color: var(--tint-green-border);
  box-shadow: var(--glow-green-soft);
}
.badge.done {
  background: var(--tint-blue);
  color: var(--accent-blue);
  border-color: var(--tint-blue-border);
}
.badge.closed {
  background: var(--tint-red);
  color: var(--accent-red);
  border-color: var(--tint-red-border);
}

/* Progress Pills Section */
#progress {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
}
.step {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  padding: 5px 14px 5px 10px;
  border-radius: var(--r-pill);
  font-size: 12.5px;
  font-weight: 500;
  background: var(--surface-strong);
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--dur-med) var(--ease-out), border-color var(--dur-med) var(--ease-out), background var(--dur-med) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.step:hover {
  transform: translateY(-1px);
  border-color: var(--border-strong);
  color: var(--text);
}
.step:focus-visible {
  outline: 2px solid var(--accent-green);
  outline-offset: 2px;
}
.step .dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 1.5px solid var(--border-strong);
  background: transparent;
  color: var(--bg);
  font-size: 9px;
  line-height: 1;
  transition: background var(--dur-med) var(--ease-out), border-color var(--dur-med) var(--ease-out);
}
.step.active {
  border-color: var(--accent-green);
  color: var(--accent-green);
  background: var(--tint-green);
  box-shadow: var(--glow-green-active);
}
.step.active .dot {
  background: var(--accent-green);
  border-color: var(--accent-green);
  animation: dotPulse 1.5s ease-in-out infinite;
}
.step.done {
  background: var(--tint-green);
  border-color: var(--tint-green-border);
  color: var(--accent-green);
}
.step.done .dot {
  background: var(--accent-green);
  border-color: var(--accent-green);
}
.step.done .dot::before {
  content: '✓';
  font-weight: 700;
}
@keyframes dotPulse {
  0%, 100% { box-shadow: var(--glow-ring); }
  50% { box-shadow: var(--glow-ring-end); }
}
.link {
  flex: 1 1 auto;
  height: 2px;
  border-radius: 1px;
  background: var(--border);
  min-width: 6px;
  transition: background var(--dur-med) var(--ease-out);
}
.link.done {
  background: var(--accent-green);
}

.step::after {
  content: attr(data-tip);
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%) translateY(-3px);
  background: var(--solid-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  padding: 5px 10px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-dim);
  white-space: nowrap;
  box-shadow: var(--shadow-2);
  opacity: 0;
  pointer-events: none;
  transition: opacity 180ms var(--ease-out), transform 180ms var(--ease-out);
  z-index: 20;
}
.step:hover::after, .step:focus-visible::after {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
#progress .step:first-child::after { left: 0; transform: translateY(-3px); }
#progress .step:first-child:hover::after, #progress .step:first-child:focus-visible::after { transform: translateY(0); }
#progress .step:last-child::after { left: auto; right: 0; transform: translateY(-3px); }
#progress .step:last-child:hover::after, #progress .step:last-child:focus-visible::after { transform: translateY(0); }

.step[aria-expanded="true"] {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
  box-shadow: var(--glow-blue);
}

#stageDetail {
  margin-top: var(--sp3);
  padding: 10px 14px;
  border-radius: var(--r-md);
  background: var(--solid-2);
  border: 1px solid var(--border-strong);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-dim);
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  animation: detailIn 180ms var(--ease-out);
}
#stageDetail .sd-name {
  color: var(--accent-blue);
  font-weight: 600;
  white-space: nowrap;
}
#stageDetail .sd-state {
  padding: 1px 9px;
  border-radius: var(--r-pill);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}
#stageDetail .sd-state.done {
  background: var(--tint-green);
  color: var(--accent-green);
}
#stageDetail .sd-state.active {
  background: var(--tint-green);
  color: var(--accent-green);
  animation: dotPulse 1.5s ease-in-out infinite;
}
#stageDetail .sd-state.pending {
  background: var(--surface-strong);
  color: var(--text-dim);
}
#stageDetail .sd-text {
  flex: 1 1 100%;
  word-break: break-word;
  white-space: pre-wrap;
}
@keyframes detailIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}

.card.flash {
  outline: 2px solid transparent;
  animation: cardFlash 1.6s var(--ease-out);
}
@keyframes cardFlash {
  0% { outline-color: var(--accent-blue); }
  60% { outline-color: var(--flash-outline); }
  100% { outline-color: transparent; }
}

/* Form Controls & Buttons */
button, input, select, textarea {
  background: var(--solid-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  padding: 8px 10px;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
button {
  cursor: pointer;
}
button:hover {
  border-color: var(--border-strong);
}
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 1px;
}
input:focus, select:focus, textarea:focus {
  border-color: var(--accent-green);
  box-shadow: var(--focus-ring);
  outline: none;
}

/* Selects: drop native chrome, draw our own chevron so every theme's
   border/background tokens show through. The chevron is a fixed slate-400
   (reads well on all current themes); the opened option list is OS-rendered
   and only follows each theme's color-scheme, not the full palette. */
select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 32px;
  cursor: pointer;
  background-image: ${SELECT_CHEVRON};
  background-repeat: no-repeat;
  background-position: right 10px center;
}
select option {
  background: var(--solid);
  color: var(--text);
}

.btn, .primary, .secondary, .danger {
  padding: 8px 14px;
  font-weight: 500;
  border-radius: var(--r-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  white-space: nowrap;
}
.primary {
  background: var(--aurora-dim);
  border: 1px solid var(--tint-green-border-strong);
  color: var(--text);
}
.primary:hover {
  border-color: var(--accent-green);
  box-shadow: var(--glow-green-cta);
  transform: translateY(-1px);
}
.secondary {
  background: var(--surface-strong);
  border: 1px solid var(--border);
  color: var(--text-dim);
}
.secondary:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.danger {
  background: var(--tint-red);
  border: 1px solid var(--tint-red-border);
  color: var(--accent-red);
}
.danger:hover {
  border-color: var(--accent-red);
}

/* Notice / Alerts */
.notice {
  margin: var(--sp2) 0;
  padding: 11px 14px;
  border-radius: var(--r-md);
  background: var(--tint-amber);
  color: var(--accent-amber);
  border: 1px solid var(--tint-amber-border);
}
.notice.error {
  background: var(--tint-red);
  color: var(--accent-red);
  border-color: var(--tint-red-border);
}

/* Drawer (Sticky / Fixed overlay WITH Backdrop Blur allowed) */
.drawer {
  position: fixed;
  top: 84px;
  right: 22px;
  bottom: 22px;
  z-index: var(--z-drawer);
  width: min(460px, calc(100vw - 44px));
  overflow-y: auto;
  padding: 18px;
  background: var(--surface-drawer);
  backdrop-filter: var(--surface-blur-lg);
  -webkit-backdrop-filter: var(--surface-blur-lg);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
  animation: drawerIn 220ms var(--ease-out);
}
@keyframes drawerIn {
  from { opacity: 0; transform: translateX(18px); }
  to { opacity: 1; transform: none; }
}

@media (max-width: 720px) {
  .drawer {
    top: auto;
    left: 12px;
    right: 12px;
    bottom: 12px;
    width: auto;
    max-height: 75vh;
  }
}

/* Themed Custom Select (EnhanceSelect)
   Wraps a native <select> (kept in the DOM, visually hidden, still the single
   source of truth) with a themed trigger button + role="listbox" popover.
   Every surface is token-driven, so glass / liquid / editorial all work.
   The native select itself is only ever read/written; the popover is plain
   divs rendered exclusively via createElement/textContent. */
.visually-hidden {
  position: absolute !important;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  overflow: hidden;
  white-space: nowrap;
}
.cs-root {
  position: relative;
  display: inline-block;
  vertical-align: middle;
}
.field .cs-root {
  width: 100%;
}
.cs-btn {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 32px 8px 10px; /* right padding clears the chevron */
  background-image: ${SELECT_CHEVRON};
  background-repeat: no-repeat;
  background-position: right 10px center;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cs-btn:focus {
  border-color: var(--accent-green);
  box-shadow: var(--focus-ring);
  outline: none;
}
.cs-root.disabled .cs-btn {
  opacity: 0.55;
  cursor: not-allowed;
}
.cs-pop {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  min-width: max-content;
  z-index: var(--z-modal);
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;
  background: var(--solid);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-2);
  animation: csPopIn var(--dur-fast) var(--ease-out);
}
.cs-pop[hidden] {
  display: none;
}
@keyframes csPopIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
.cs-option {
  position: relative;
  padding: 7px 10px 7px 14px;
  border-radius: var(--r-sm);
  color: var(--text);
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;
}
.cs-option:hover, .cs-option.active {
  background: var(--hover-tint);
}
.cs-option.selected {
  background: var(--tint-green);
}
.cs-option.selected::before {
  content: '';
  position: absolute;
  left: 0;
  top: 2px;
  bottom: 2px;
  width: 2px;
  border-radius: 1px;
  background: var(--accent-green);
}
.cs-option-disabled {
  opacity: 0.45;
  pointer-events: none;
}
/* Liquid theme: the popover becomes a glass float (blur + refraction edge),
   matching the .card treatment — token-driven, nothing hardcoded. */
:root[data-theme='liquid'] .cs-pop {
  background: var(--surface);
  backdrop-filter: var(--surface-blur);
  -webkit-backdrop-filter: var(--surface-blur);
  border-top-color: var(--border-top-color);
  border-bottom-color: var(--border-bottom-color);
}
/* Editorial theme: focus follows the page's edit-red convention. */
:root[data-theme='editorial'] .cs-btn:focus {
  border-color: var(--accent-red);
}
`;
