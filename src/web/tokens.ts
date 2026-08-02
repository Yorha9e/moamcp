/**
 * moamcp web v3 design tokens & reset.
 * Dark glass aesthetic with aurora gradient accents.
 *
 * ── THEMES ──────────────────────────────────────────────────────────────
 * The default theme ("glass") lives on plain `:root` — zero-risk default,
 * no data-theme attribute required. A new theme is added in exactly two
 * places:
 *   1. Append one entry to THEMES below (name + label; the picker UI,
 *      the localStorage persistence and the anti-FOUC bootstrap all derive
 *      from this list automatically).
 *   2. Append one `:root[data-theme='<name>'] { ... }` variable block at
 *      the bottom of TOKENS_CSS overriding any of the theme-varying tokens
 *      (copy the "THEME-VARYING · glass" section, tweak values, e.g. set
 *      --surface-blur/--surface-blur-lg to `none` and surfaces opaque for a
 *      flat/light theme, or --aurora-opacity to 0 to hide the glow layer).
 * Theme-invariant tokens (fonts/spacing/radii/motion/z-index) are shared
 * unless a theme explicitly overrides them.
 */

/** Theme registry: one entry per theme. Picker + persistence + bootstrap are driven by this. */
export const THEMES: { name: string; label: string }[] = [
  { name: 'glass', label: 'Glass' },
  { name: 'liquid', label: 'Liquid Glass' },
  { name: 'editorial', label: 'Editorial' },
];

/** localStorage key that persists the selected theme. */
export const THEME_STORAGE_KEY = 'moamcp-theme';

/**
 * Anti-FOUC bootstrap: inline in each page's <head> right after the <style>.
 * Reads the persisted theme and sets <html data-theme> before first paint.
 * Unknown/stale values are ignored (the page then just uses the :root default).
 */
export const THEME_BOOTSTRAP = `<script>
(function () {
  try {
    var t = localStorage.getItem('${THEME_STORAGE_KEY}');
    if (t && ${JSON.stringify(THEMES.map((x) => x.name))}.indexOf(t) !== -1) {
      document.documentElement.dataset.theme = t;
    }
  } catch (e) {}
})();
</script>`;

export const TOKENS_CSS = `
:root {
  /* ════════════════════════════════════════════════════════════════════
     THEME-VARYING tokens — "glass" theme (default).
     A future theme overrides any of these in a :root[data-theme='x'] block.
     ════════════════════════════════════════════════════════════════════ */

  /* Background & page */
  --bg: #07090f;
  --bg-aurora-1: rgba(52, 211, 153, 0.08);
  --bg-aurora-2: rgba(96, 165, 250, 0.08);
  --bg-aurora-3: rgba(167, 139, 250, 0.06);

  /* Aurora background layer (geometry/opacity — themes can restyle or hide) */
  --aurora-opacity: 1;            /* master switch: 0 hides the whole layer */
  --aurora-1-top: -160px;
  --aurora-1-left: 50%;
  --aurora-1-w: 880px;
  --aurora-1-h: 360px;
  --aurora-1-x: -50%;             /* translateX offset (centering) */
  --aurora-1-opacity: 0.9;
  --aurora-2-top: -140px;
  --aurora-2-right: 5%;
  --aurora-2-w: 620px;
  --aurora-2-h: 320px;
  --aurora-2-opacity: 0.8;

  /* Surfaces & glassiness */
  --surface: rgba(148, 163, 184, 0.05);
  --surface-strong: rgba(148, 163, 184, 0.09);
  --solid: #0d1017;
  --solid-2: #141824;
  --surface-chrome: rgba(13, 16, 23, 0.85);   /* sticky workspace bar */
  --surface-drawer: rgba(20, 24, 35, 0.85);   /* right-side drawer */
  --border: rgba(148, 163, 184, 0.14);
  --border-strong: rgba(148, 163, 184, 0.24);
  --surface-blur: blur(20px);                 /* chrome blur; flat theme: none */
  --surface-blur-lg: blur(24px);              /* drawer blur; flat theme: none */

  /* Typography Colors */
  --text: #e6ebf4;
  --text-dim: #94a3b8;
  --text-faint: #64748b;
  --link-soft: #7cc7ff;

  /* Accent & Status Colors */
  --accent-green: #34d399;
  --accent-blue: #60a5fa;
  --accent-purple: #a78bfa;
  --accent-amber: #fbbf24;
  --accent-red: #f87171;

  --ok: var(--accent-green);
  --warn: var(--accent-amber);
  --err: var(--accent-red);
  --live: var(--accent-green);
  --done: var(--accent-blue);

  /* Aurora Gradient (Used strictly for brand text, primary CTA, active states, focus ring) */
  --aurora: linear-gradient(100deg, #34d399, #60a5fa 50%, #a78bfa);
  --aurora-dim: linear-gradient(100deg, rgba(52, 211, 153, 0.14), rgba(96, 165, 250, 0.14) 50%, rgba(167, 139, 250, 0.14));

  /* Status tints (soft backgrounds / borders per status color) */
  --tint-green: rgba(52, 211, 153, 0.12);
  --tint-green-soft: rgba(52, 211, 153, 0.1);
  --tint-green-border: rgba(52, 211, 153, 0.35);
  --tint-green-border-soft: rgba(52, 211, 153, 0.3);
  --tint-green-border-strong: rgba(52, 211, 153, 0.4);
  --tint-blue: rgba(96, 165, 250, 0.12);
  --tint-blue-border: rgba(96, 165, 250, 0.35);
  --tint-amber: rgba(251, 191, 36, 0.12);
  --tint-amber-border: rgba(251, 191, 36, 0.3);
  --tint-red: rgba(248, 113, 113, 0.12);
  --tint-red-border: rgba(248, 113, 113, 0.35);
  --tint-purple: rgba(167, 139, 250, 0.12);
  --tint-purple-border: rgba(167, 139, 250, 0.35);
  --hover-tint: rgba(255, 255, 255, 0.05);
  --hover-tint-subtle: rgba(255, 255, 255, 0.03);

  /* Accent glow shadows & focus rings */
  --glow-green: 0 0 12px rgba(52, 211, 153, 0.3);
  --glow-green-soft: 0 0 12px rgba(52, 211, 153, 0.2);
  --glow-green-active: 0 0 16px rgba(52, 211, 153, 0.25);
  --glow-green-brand: 0 0 12px rgba(52, 211, 153, 0.4);
  --glow-green-cta: 0 0 14px rgba(52, 211, 153, 0.28);
  --glow-green-verdict: 0 0 24px rgba(52, 211, 153, 0.12);
  --glow-green-btn: 0 0 10px rgba(52, 211, 153, 0.25);
  --glow-blue: 0 0 12px rgba(96, 165, 250, 0.3);
  --glow-ring: 0 0 0 0 rgba(52, 211, 153, 0.35);   /* live dot pulse */
  --glow-ring-end: 0 0 0 5px rgba(52, 211, 153, 0);
  --focus-ring: 0 0 0 3px rgba(52, 211, 153, 0.14);
  --flash-outline: rgba(96, 165, 250, 0.5);

  /* Shadows */
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-2: 0 8px 24px rgba(0, 0, 0, 0.45);

  color-scheme: dark;

  /* ════════════════════════════════════════════════════════════════════
     THEME-INVARIANT tokens — shared across all themes.
     ════════════════════════════════════════════════════════════════════ */

  /* Font Stacks */
  --font-ui: -apple-system, "Segoe UI", "Inter", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --font-mono: "Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace;

  /* Spacing Scale (4px base) */
  --sp1: 4px;
  --sp2: 8px;
  --sp3: 12px;
  --sp4: 16px;
  --sp5: 20px;
  --sp6: 24px;
  --sp8: 32px;
  --sp12: 48px;

  /* Radii Scale */
  --r-sm: 8px;
  --r-md: 12px;
  --r-lg: 16px;
  --r-pill: 999px;

  /* Motion */
  --dur-fast: 150ms;
  --dur-med: 250ms;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);

  /* Z-index Scale */
  --z-sticky: 10;
  --z-drawer: 40;
  --z-scrim: 45;
  --z-modal: 50;
}

/* ── Theme: Liquid Glass (colorful) ────────────────────────────────────────
   High-saturation cyan/magenta/purple/orange blobs drifting behind
   translucent blur(24px) saturate(1.8) surfaces, refraction edges
   (bright top / dim bottom), specular highlights, flowing gradient accents. */
:root[data-theme='liquid'] {
  /* Background & page */
  --bg: #05050d;
  --bg-aurora-1: rgba(0, 240, 255, 0.22);    /* cyan */
  --bg-aurora-2: rgba(255, 0, 160, 0.20);    /* magenta */
  --bg-aurora-3: rgba(176, 66, 255, 0.18);   /* purple */
  --bg-aurora-4: rgba(255, 130, 0, 0.16);    /* orange */

  --aurora-1-top: -140px;
  --aurora-1-left: 10%;
  --aurora-1-w: 750px;
  --aurora-1-h: 550px;
  --aurora-1-x: 0%;
  --aurora-1-opacity: 0.85;
  --aurora-2-top: 80px;
  --aurora-2-right: -100px;
  --aurora-2-w: 700px;
  --aurora-2-h: 600px;
  --aurora-2-opacity: 0.8;

  /* Surfaces & glassiness */
  --surface: rgba(255, 255, 255, 0.05);
  --surface-strong: rgba(255, 255, 255, 0.09);
  --solid: #0b0e17;
  --solid-2: #121624;
  --surface-chrome: rgba(10, 14, 26, 0.5);
  --surface-drawer: rgba(12, 16, 30, 0.6);
  --surface-blur: blur(24px) saturate(1.8);
  --surface-blur-lg: blur(32px) saturate(2);

  /* Refraction borders & specular highlight (theme-local tokens) */
  --border: rgba(255, 255, 255, 0.16);
  --border-strong: rgba(255, 255, 255, 0.3);
  --border-top-color: rgba(255, 255, 255, 0.42);
  --border-bottom-color: rgba(255, 255, 255, 0.08);
  --border-side-color: rgba(255, 255, 255, 0.18);
  --glass-specular: linear-gradient(135deg, rgba(255, 255, 255, 0.14) 0%, rgba(255, 255, 255, 0.03) 30%, transparent 60%);
  --glass-specular-hover: linear-gradient(135deg, rgba(255, 255, 255, 0.24) 0%, rgba(255, 255, 255, 0.06) 40%, transparent 70%);

  /* Accent & status */
  --accent-cyan: #00f0ff;
  --accent-magenta: #ff00a0;
  --accent-green: #00f59b;
  --accent-blue: #3b9eff;
  --accent-purple: #b042ff;
  --accent-amber: #ffb700;
  --accent-red: #ff4d6d;

  /* Typography */
  --text: #f0f4fc;
  --text-dim: #9daec8;
  --text-faint: #6c7f9d;
  --link-soft: #66c2ff;

  /* Flowing gradient (cyan -> purple -> magenta) */
  --aurora: linear-gradient(135deg, #00f0ff 0%, #b042ff 50%, #ff00a0 100%);
  --aurora-dim: linear-gradient(135deg, rgba(0, 240, 255, 0.2) 0%, rgba(176, 66, 255, 0.2) 50%, rgba(255, 0, 160, 0.2) 100%);

  /* Status tints */
  --tint-green: rgba(0, 245, 155, 0.16);
  --tint-green-soft: rgba(0, 245, 155, 0.1);
  --tint-green-border: rgba(0, 245, 155, 0.45);
  --tint-green-border-soft: rgba(0, 245, 155, 0.35);
  --tint-green-border-strong: rgba(0, 245, 155, 0.6);
  --tint-blue: rgba(59, 158, 255, 0.16);
  --tint-blue-border: rgba(59, 158, 255, 0.45);
  --tint-amber: rgba(255, 183, 0, 0.16);
  --tint-amber-border: rgba(255, 183, 0, 0.4);
  --tint-red: rgba(255, 77, 109, 0.16);
  --tint-red-border: rgba(255, 77, 109, 0.45);
  --tint-purple: rgba(176, 66, 255, 0.16);
  --tint-purple-border: rgba(176, 66, 255, 0.45);
  --hover-tint: rgba(255, 255, 255, 0.07);
  --hover-tint-subtle: rgba(255, 255, 255, 0.04);

  /* Glows & focus */
  --glow-green: 0 0 16px rgba(0, 245, 155, 0.45);
  --glow-green-soft: 0 0 14px rgba(0, 245, 155, 0.25);
  --glow-green-active: 0 0 20px rgba(0, 245, 155, 0.35);
  --glow-green-brand: 0 0 16px rgba(0, 240, 255, 0.6), 0 0 28px rgba(255, 0, 160, 0.35);
  --glow-green-cta: 0 0 18px rgba(0, 240, 255, 0.4), 0 0 30px rgba(255, 0, 160, 0.3);
  --glow-green-verdict: 0 0 24px rgba(0, 245, 155, 0.2);
  --glow-green-btn: 0 0 12px rgba(0, 245, 155, 0.35);
  --glow-blue: 0 0 16px rgba(59, 158, 255, 0.45);
  --glow-ring: 0 0 0 0 rgba(0, 240, 255, 0.45);
  --glow-ring-end: 0 0 0 6px rgba(0, 240, 255, 0);
  --focus-ring: 0 0 0 3px rgba(0, 240, 255, 0.25);
  --flash-outline: rgba(0, 240, 255, 0.5);

  /* Shadows */
  --shadow-1: 0 2px 8px rgba(0, 0, 0, 0.5);
  --shadow-2: 0 12px 40px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.1) inset;
}

/* Background blobs: two extra fixed color spots (purple/orange) + drifting pseudos.
   Mouse parallax: --mx/--my (viewport-normalized -1..1, set by initLiquidParallax)
   move the whole layer with inertia; the drift animations live on the pseudos
   and compose naturally with the container transform. */
:root[data-theme='liquid'] .aurora-bg {
  /* Bleed 64px past every viewport edge so the parallax translate
     (±36px/±24px) never exposes the page background at the border. */
  top: -64px;
  left: -64px;
  right: -64px;
  bottom: -64px;
  background:
    radial-gradient(circle at 75% 25%, var(--bg-aurora-3) 0%, transparent 45%),
    radial-gradient(circle at 25% 75%, var(--bg-aurora-4) 0%, transparent 45%);
  transform: translate3d(calc(var(--mx, 0) * 36px), calc(var(--my, 0) * 24px), 0);
  transition: transform 600ms var(--ease-out);
  animation: liquidHueShift 24s linear infinite;
}
/* Two-layer blobs: core color + a contrasting outer halo (cyan core +
   magenta halo, magenta core + purple halo). Blur stays 40px. */
:root[data-theme='liquid'] .aurora-bg::before {
  background:
    radial-gradient(circle at 45% 40%, var(--bg-aurora-1) 0%, transparent 50%),
    radial-gradient(circle at 70% 65%, rgba(255, 0, 160, 0.16) 0%, transparent 55%);
  filter: blur(40px);
  will-change: transform;
  animation: liquidBlobDrift1 26s ease-in-out infinite alternate;
}
:root[data-theme='liquid'] .aurora-bg::after {
  background:
    radial-gradient(circle at 55% 45%, var(--bg-aurora-2) 0%, transparent 50%),
    radial-gradient(circle at 30% 75%, rgba(176, 66, 255, 0.18) 0%, transparent 55%);
  filter: blur(40px);
  will-change: transform;
  animation: liquidBlobDrift2 30s ease-in-out infinite alternate;
}
/* Slow full-spectrum hue rotation over the whole aurora layer (filter only). */
@keyframes liquidHueShift {
  from { filter: hue-rotate(0deg); }
  to { filter: hue-rotate(360deg); }
}
/* Transform-only motion: zero layout/paint recalculation */
@keyframes liquidBlobDrift1 {
  0% { transform: translate3d(0, 0, 0) rotate(0deg) scale(1); }
  50% { transform: translate3d(120px, 75px, 0) rotate(180deg) scale(1.3); }
  100% { transform: translate3d(-75px, 150px, 0) rotate(360deg) scale(0.85); }
}
@keyframes liquidBlobDrift2 {
  0% { transform: translate3d(0, 0, 0) rotate(0deg) scale(1); }
  50% { transform: translate3d(-135px, -90px, 0) rotate(-180deg) scale(1.3); }
  100% { transform: translate3d(90px, -60px, 0) rotate(-360deg) scale(0.85); }
}

/* Liquid cards: translucent + blurred, refraction edges, specular highlight.
   Entrance: one-shot fade/rise (fill backwards = pre-delay state only, so the
   finished animation never pins transform over the :hover translateY(-1px)). */
:root[data-theme='liquid'] .card {
  position: relative;
  overflow: hidden; /* clips the ::before specular layer to border-radius */
  background: var(--surface);
  backdrop-filter: var(--surface-blur);
  -webkit-backdrop-filter: var(--surface-blur);
  border-top: 1px solid var(--border-top-color);
  border-bottom: 1px solid var(--border-bottom-color);
  border-left: 1px solid var(--border-side-color);
  border-right: 1px solid var(--border-side-color);
  box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.45), inset 0 1px 0 0 rgba(255, 255, 255, 0.2);
  animation: liquidCardIn 460ms var(--ease-out) backwards;
}
:root[data-theme='liquid'] .card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 100%;
  background: var(--glass-specular);
  pointer-events: none;
  opacity: 0.8;
  transition: opacity var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
/* Cursor-following radial highlight (--cx/--cy in card pixels, set by
   initLiquidParallax; 50% fallback until the first mousemove). */
:root[data-theme='liquid'] .card::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  background: radial-gradient(320px circle at var(--cx, 50%) var(--cy, 50%), rgba(255, 255, 255, 0.14), transparent 65%);
  transition: opacity var(--dur-fast) var(--ease-out);
}
:root[data-theme='liquid'] .card:hover::after {
  opacity: 1;
}
:root[data-theme='liquid'] .card:hover {
  border-top-color: rgba(255, 255, 255, 0.65);
  border-bottom-color: rgba(255, 255, 255, 0.15);
  box-shadow: 0 14px 44px 0 rgba(0, 0, 0, 0.58), inset 0 1px 0 0 rgba(255, 255, 255, 0.35);
  transform: translateY(-1px);
}
:root[data-theme='liquid'] .card:hover::before {
  opacity: 1;
  background: var(--glass-specular-hover);
}
/* Staggered entrance: cards 1-6 walk in at 60ms intervals. nth-of-type counts
   div siblings, so delays land on the first six .card divs of each page. */
:root[data-theme='liquid'] .card:nth-of-type(1) { animation-delay: 0ms; }
:root[data-theme='liquid'] .card:nth-of-type(2) { animation-delay: 60ms; }
:root[data-theme='liquid'] .card:nth-of-type(3) { animation-delay: 120ms; }
:root[data-theme='liquid'] .card:nth-of-type(4) { animation-delay: 180ms; }
:root[data-theme='liquid'] .card:nth-of-type(5) { animation-delay: 240ms; }
:root[data-theme='liquid'] .card:nth-of-type(6) { animation-delay: 300ms; }
@keyframes liquidCardIn {
  0% { opacity: 0; transform: translateY(14px); }
  100% { opacity: 1; transform: none; }
}
/* Steps card hosts ::after tooltips below the steps — must not be clipped. */
:root[data-theme='liquid'] #progressCard {
  overflow: visible;
}
:root[data-theme='liquid'] #progressCard::before {
  content: none;
}
:root[data-theme='liquid'] #progressCard::after {
  content: none;
}

/* Drawer & chrome: stronger blur, refraction top edge */
:root[data-theme='liquid'] .drawer {
  border-top: 1px solid var(--border-top-color);
  border-bottom: 1px solid var(--border-bottom-color);
}
:root[data-theme='liquid'] .top-nav,
:root[data-theme='liquid'] .locale-picker,
:root[data-theme='liquid'] .theme-picker {
  backdrop-filter: var(--surface-blur);
  -webkit-backdrop-filter: var(--surface-blur);
  border-top-color: var(--border-top-color);
}
:root[data-theme='liquid'] #stageDetail {
  backdrop-filter: var(--surface-blur);
  -webkit-backdrop-filter: var(--surface-blur);
}

/* HARD RULE: long-scroll regions stay opaque & blur-free (already solid via
   tokens; re-asserted here so no future liquid tweak re-blurs them). */
:root[data-theme='liquid'] .omkc-list,
:root[data-theme='liquid'] .tool-log,
:root[data-theme='liquid'] .findings-text,
:root[data-theme='liquid'] .details dd.code {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

/* Flowing gradient on brand, section markers, primary CTA, active steps */
:root[data-theme='liquid'] .brand-mark {
  background-size: 200% 200%;
  box-shadow: var(--glow-green-brand);
  animation: liquidGradientFlow 6s ease infinite alternate;
}
:root[data-theme='liquid'] .brand-title {
  background-size: 200% 200%;
  animation: liquidGradientFlow 6s ease infinite alternate;
}
/* Flowing conic border ring: @property-registered --liquid-angle is what makes
   the conic actually rotate; without @property the browser silently drops the
   interpolation and keeps a static gradient ring (var() fallback covers the
   initial 0deg). Ring = masked ::before so the interior fill is untouched. */
@property --liquid-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
@keyframes liquidAngleSpin {
  to { --liquid-angle: 360deg; }
}
:root[data-theme='liquid'] .primary,
:root[data-theme='liquid'] button.primary {
  position: relative;
  background: linear-gradient(135deg, rgba(0, 240, 255, 0.28) 0%, rgba(176, 66, 255, 0.28) 50%, rgba(255, 0, 160, 0.28) 100%);
  background-size: 200% 200%;
  border: 1px solid transparent;
  color: #fff;
  box-shadow: var(--glow-green-cta);
}
:root[data-theme='liquid'] .primary::before,
:root[data-theme='liquid'] button.primary::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: conic-gradient(from var(--liquid-angle, 0deg), rgba(0, 240, 255, 0.95), rgba(176, 66, 255, 0.95), rgba(255, 0, 160, 0.95), rgba(0, 240, 255, 0.95));
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
  animation: liquidAngleSpin 4s linear infinite;
}
:root[data-theme='liquid'] .primary:hover,
:root[data-theme='liquid'] button.primary:hover {
  background-position: 100% 0;
  border-color: rgba(255, 255, 255, 0.7);
  box-shadow: 0 0 22px rgba(0, 240, 255, 0.5), 0 0 36px rgba(255, 0, 160, 0.38);
  transform: translateY(-1px);
}
:root[data-theme='liquid'] .step.active {
  border-color: var(--accent-cyan);
  color: var(--accent-cyan);
  background: linear-gradient(135deg, rgba(0, 240, 255, 0.18) 0%, rgba(176, 66, 255, 0.18) 50%, rgba(255, 0, 160, 0.18) 100%);
  box-shadow: 0 0 18px rgba(0, 240, 255, 0.35);
}
:root[data-theme='liquid'] .step.active::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: conic-gradient(from var(--liquid-angle, 0deg), rgba(0, 240, 255, 0.95), rgba(176, 66, 255, 0.95), rgba(255, 0, 160, 0.95), rgba(0, 240, 255, 0.95));
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
  animation: liquidAngleSpin 4s linear infinite;
}
:root[data-theme='liquid'] .step.active .dot {
  background: var(--aurora);
  animation: liquidDotPulse 1.5s ease-in-out infinite;
}
@keyframes liquidGradientFlow {
  0% { background-position: 0% 50%; }
  100% { background-position: 100% 50%; }
}
@keyframes liquidDotPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(0, 240, 255, 0.5); }
  50% { box-shadow: 0 0 0 6px rgba(0, 240, 255, 0); }
}
/* (reduced-motion: the global media block at the bottom already disables
   all animations, no theme-specific safeguard needed.) */

/* ── Theme: Editorial (light, ink on paper) ──────────────────────────────
   Warm paper background, opaque cream/white surfaces, 1px hairline ink
   borders, a single edit-red accent, quiet serif typography. The aurora
   layer is switched off entirely (--aurora-opacity: 0), every glow is
   dropped and shadows become hard offset rules — no blur, no animation. */
:root[data-theme='editorial'] {
  /* Background & page */
  --bg: #f7f4ee;
  --bg-aurora-1: rgba(181, 52, 42, 0.05);
  --bg-aurora-2: rgba(199, 152, 95, 0.05);
  --bg-aurora-3: rgba(28, 26, 23, 0.04);

  /* Aurora background layer: hidden entirely — quiet paper, no glow */
  --aurora-opacity: 0;

  /* Surfaces & glassiness: opaque paper, blur off */
  --surface: #fbf9f4;
  --surface-strong: #efece3;
  --solid: #ffffff;
  --solid-2: #f3f0e8;
  --surface-chrome: rgba(252, 250, 245, 0.96);
  --surface-drawer: rgba(255, 255, 255, 0.98);
  --border: rgba(28, 26, 23, 0.75);
  --border-strong: rgba(28, 26, 23, 0.9);
  --surface-blur: none;
  --surface-blur-lg: none;

  /* Typography colors (ink) */
  --text: #1c1a17;
  --text-dim: #57534a;
  --text-faint: #7c766b;
  --link-soft: #8c2f26;

  /* Accent & status: desaturated + darkened to sit on light paper */
  --accent-green: #4a7c59;
  --accent-blue: #3d6b8f;
  --accent-purple: #6d5a9e;
  --accent-amber: #9a6514;
  --accent-red: #b5342a;

  /* Aurora gradient: ink → edit red (brand mark, primary CTA, active states) */
  --aurora: linear-gradient(100deg, #1c1a17 0%, #b5342a 100%);
  --aurora-dim: linear-gradient(100deg, rgba(28, 26, 23, 0.07) 0%, rgba(181, 52, 42, 0.09) 100%);

  /* Status tints: pale washes of the darkened status colors */
  --tint-green: rgba(74, 124, 89, 0.1);
  --tint-green-soft: rgba(74, 124, 89, 0.07);
  --tint-green-border: rgba(74, 124, 89, 0.4);
  --tint-green-border-soft: rgba(74, 124, 89, 0.32);
  --tint-green-border-strong: rgba(74, 124, 89, 0.5);
  --tint-blue: rgba(61, 107, 143, 0.1);
  --tint-blue-border: rgba(61, 107, 143, 0.4);
  --tint-amber: rgba(154, 101, 20, 0.1);
  --tint-amber-border: rgba(154, 101, 20, 0.38);
  --tint-red: rgba(181, 52, 42, 0.09);
  --tint-red-border: rgba(181, 52, 42, 0.4);
  --tint-purple: rgba(109, 90, 158, 0.1);
  --tint-purple-border: rgba(109, 90, 158, 0.4);
  --hover-tint: rgba(28, 26, 23, 0.05);
  --hover-tint-subtle: rgba(28, 26, 23, 0.03);

  /* Glows: none on paper; focus ring is a faint edit-red ring */
  --glow-green: none;
  --glow-green-soft: none;
  --glow-green-active: none;
  --glow-green-brand: none;
  --glow-green-cta: none;
  --glow-green-verdict: none;
  --glow-green-btn: none;
  --glow-blue: none;
  --glow-ring: 0 0 0 0 rgba(181, 52, 42, 0.2);
  --glow-ring-end: 0 0 0 5px rgba(181, 52, 42, 0);
  --focus-ring: 0 0 0 3px rgba(181, 52, 42, 0.16);
  --flash-outline: rgba(181, 52, 42, 0.35);

  /* Shadows: hard offset, no blur */
  --shadow-1: 1px 1px 0 rgba(28, 26, 23, 0.08);
  --shadow-2: 2px 3px 0 rgba(28, 26, 23, 0.08);

  color-scheme: light;

  /* Explicit overrides of THEME-INVARIANT tokens (allowed per the header
     docs): serif typography + tighter radii. --font-mono stays untouched. */
  --font-ui: Georgia, "Times New Roman", "Songti SC", "STSong", "SimSun", serif;
  --r-sm: 4px;
  --r-md: 6px;
  --r-lg: 8px;
}

/* Editorial component refinements — all scoped to the theme and written
   with strictly higher specificity than the shared component rules. */
/* Active nav / picker pills take the single edit-red accent. */
:root[data-theme='editorial'] .top-nav .active,
:root[data-theme='editorial'] .locale-pill.active,
:root[data-theme='editorial'] .theme-pill.active {
  color: var(--accent-red);
}
/* Links, CTA and focused fields hover into edit red; focus outlines red. */
:root[data-theme='editorial'] a:hover {
  color: var(--accent-red);
}
:root[data-theme='editorial'] .primary {
  border-color: rgba(28, 26, 23, 0.85);
}
:root[data-theme='editorial'] .primary:hover {
  border-color: var(--accent-red);
}
:root[data-theme='editorial'] input:focus,
:root[data-theme='editorial'] select:focus,
:root[data-theme='editorial'] textarea:focus {
  border-color: var(--accent-red);
}
:root[data-theme='editorial'] button:focus-visible,
:root[data-theme='editorial'] input:focus-visible,
:root[data-theme='editorial'] select:focus-visible,
:root[data-theme='editorial'] textarea:focus-visible {
  outline-color: var(--accent-red);
}
:root[data-theme='editorial'] .step:focus-visible {
  outline-color: var(--accent-red);
}
/* Active debate step: edit red instead of status green (done stays green). */
:root[data-theme='editorial'] .step.active {
  border-color: var(--accent-red);
  color: var(--accent-red);
  background: var(--tint-red);
}
:root[data-theme='editorial'] .step.active .dot {
  background: var(--accent-red);
  border-color: var(--accent-red);
}
/* Typography: tighter tracking on brand/headings; section markers become
   thin edit-red rules. */
:root[data-theme='editorial'] .brand-title {
  letter-spacing: 0.03em;
}
:root[data-theme='editorial'] header h1,
:root[data-theme='editorial'] h2 {
  letter-spacing: 0.02em;
  font-weight: 700;
}
:root[data-theme='editorial'] .sec-title {
  letter-spacing: 0.14em;
}
:root[data-theme='editorial'] .sec-title::before {
  width: 2px;
  border-radius: 1px;
  background: var(--accent-red);
}

/* ── Future themes: append :root[data-theme='<name>'] override blocks here. ──
   Plus one entry in THEMES above. Nothing else changes. */

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-thumb {
  background: var(--border-strong);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--text-faint);
}
::-webkit-scrollbar-track {
  background: transparent;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 1.6;
  min-height: 100vh;
  position: relative;
}

/* Background Aurora Layer (Fixed, Non-scrolling) */
.aurora-bg {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;
  opacity: var(--aurora-opacity);
}
.aurora-bg::before {
  content: '';
  position: absolute;
  top: var(--aurora-1-top);
  left: var(--aurora-1-left);
  transform: translateX(var(--aurora-1-x));
  width: var(--aurora-1-w);
  height: var(--aurora-1-h);
  background: radial-gradient(circle, var(--bg-aurora-1) 0%, transparent 70%);
  opacity: var(--aurora-1-opacity);
}
.aurora-bg::after {
  content: '';
  position: absolute;
  top: var(--aurora-2-top);
  right: var(--aurora-2-right);
  width: var(--aurora-2-w);
  height: var(--aurora-2-h);
  background: radial-gradient(circle, var(--bg-aurora-2) 0%, transparent 70%);
  opacity: var(--aurora-2-opacity);
}

a {
  color: var(--accent-blue);
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease-out);
}
a:hover {
  color: var(--accent-green);
}

button, input, select, textarea {
  font-family: inherit;
  font-size: inherit;
  color: var(--text);
}

@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
`;
