/**
 * moamcp web v3 shared browser JS utilities.
 * Pure DOM API helper (pure DOM manipulation), API fetch wrapper, formatters, SSE helper.
 */
import { THEMES, THEME_STORAGE_KEY } from './tokens.js';

/**
 * Shared refresh-layer polling intervals (milliseconds).
 *
 * Values intentionally preserve each page's historical cadence — the
 * convergence is on shared constants/helpers, not on changed behavior:
 * SSE-backed views keep a 15s freshness fallback (board subscription,
 * debate OMKC health probe), the runs live view polls every 5s, and
 * system health every 10s.
 */
export const SSE_FALLBACK_POLL_MS = 15000;
export const RUNS_POLL_MS = 5000;
export const SYSTEM_POLL_MS = 10000;

export const LIB_JS = `
(function(window) {
  'use strict';

  var THEME_OPTIONS = ${JSON.stringify(THEMES)};
  var THEME_KEY = ${JSON.stringify(THEME_STORAGE_KEY)};

  function themeValid(name) {
    for (var i = 0; i < THEME_OPTIONS.length; i++) {
      if (THEME_OPTIONS[i].name === name) return true;
    }
    return false;
  }

  function themeCurrent() {
    try {
      var d = document.documentElement;
      return (d.dataset && d.dataset.theme) || '';
    } catch (e) { return ''; }
  }

  function themeApply(name, persist) {
    if (!themeValid(name)) return;
    try { document.documentElement.dataset.theme = name; } catch (e) {}
    if (persist !== false) {
      try { localStorage.setItem(THEME_KEY, name); } catch (e) {}
    }
    var container = document.getElementById('themePicker');
    if (!container) return;
    for (var i = 0; i < container.children.length; i++) {
      var btn = container.children[i];
      btn.className = 'theme-pill' + (btn.getAttribute('data-theme') === name ? ' active' : '');
    }
  }

  function syncThemePickerLabels() {
    try {
      var container = document.getElementById('themePicker');
      if (!container) return;
      var tr = window.__moaI18n && window.__moaI18n.t;
      for (var i = 0; i < container.children.length; i++) {
        var btn = container.children[i];
        var label = btn.textContent || '';
        btn.setAttribute('aria-label', tr ? tr('theme.option', { name: label }) : 'Theme: ' + label);
      }
    } catch (e) {}
  }

  /** Render the header theme picker from THEME_OPTIONS and sync it to the applied theme. */
  function initThemePicker() {
    try {
      var container = document.getElementById('themePicker');
      if (!container || !THEME_OPTIONS.length) return;
      for (var i = 0; i < THEME_OPTIONS.length; i++) {
        (function (opt) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'theme-pill';
          btn.setAttribute('data-theme', opt.name);
          btn.textContent = opt.label;
          btn.addEventListener('click', function () { themeApply(opt.name); });
          container.appendChild(btn);
        })(THEME_OPTIONS[i]);
      }
      syncThemePickerLabels();
      if (window.addEventListener) window.addEventListener('moamcp:localechange', syncThemePickerLabels);
      themeApply(themeCurrent() || THEME_OPTIONS[0].name, false);
    } catch (e) {}
  }

  /**
   * Liquid theme only: mouse parallax for the aurora layer + cursor-following
   * card highlight origin. The listener stays attached forever; the handler
   * no-ops outside the liquid theme, so theme switches need no rebinding.
   * Writes viewport-normalized -1..1 into <html> --mx/--my, and card-local
   * pixels into the hovered .card's --cx/--cy. rAF-throttled; harmless no-op
   * in headless sandboxes (no requestAnimationFrame / documentElement).
   */
  function initLiquidParallax() {
    try {
      var raf = window.requestAnimationFrame;
      var docEl = document.documentElement;
      if (typeof raf !== 'function' || !docEl || !docEl.style) return;
      var pending = false;
      function onMove(e) {
        if (pending) return;
        pending = true;
        raf(function () {
          pending = false;
          try {
            if (!docEl.dataset || docEl.dataset.theme !== 'liquid') return;
            var vw = window.innerWidth || 1;
            var vh = window.innerHeight || 1;
            docEl.style.setProperty('--mx', ((e.clientX / vw) * 2 - 1).toFixed(3));
            docEl.style.setProperty('--my', ((e.clientY / vh) * 2 - 1).toFixed(3));
            var target = e.target;
            var card = target && typeof target.closest === 'function' ? target.closest('.card') : null;
            if (card && card.style) {
              var r = card.getBoundingClientRect();
              if (r && (r.width || r.height)) {
                card.style.setProperty('--cx', (e.clientX - r.left).toFixed(1) + 'px');
                card.style.setProperty('--cy', (e.clientY - r.top).toFixed(1) + 'px');
              }
            }
          } catch (_) {}
        });
      }
      window.addEventListener('mousemove', onMove, { passive: true });
    } catch (e) {}
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function fmtClock(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtTokens(n) {
    n = Number(n);
    if (!isFinite(n)) return '–';
    return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n);
  }

  function fmtBytes(bytes) {
    bytes = Number(bytes);
    if (!isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function valueText(value) {
    if (value === undefined || value === null) return '—';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
  }

  /** Fill the header version chip from /api/system (best-effort, safe DOM text only). */
  function loadAppVersion() {
    try {
      var el = document.getElementById('appVersionValue');
      if (!el) return;
      api('/api/system').then(function (data) {
        if (data && typeof data.version === 'string') el.textContent = data.version;
      }).catch(function () {});
    } catch (_) {}
  }

  function api(url, options) {
    return fetch(url, options).then(function(res) {
      return res.text().then(function(raw) {
        var data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = { error: raw || 'invalid server response' }; }
        if (!res.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + res.status);
        return data;
      });
    });
  }

  /**
   * SSE helper with 3-fail backoff and close-suppressed native reconnect.
   * onEvent(data, type) receives every frame: plain messages arrive with
   * type 'message'; frames carrying an 'event:' line (e.g. /status/events'
   * snapshot/agent/session) are delivered through addEventListener with their
   * event type — pass the expected type names as the optional eventTypes
   * array so they reach the same handler (EventSource routes typed events
   * away from onmessage).
   */
  function connectSSE(url, onEvent, onState, eventTypes) {
    var sse = null;
    var fails = 0;
    var delay = 800;
    var stopped = false;

    function deliver(raw, type) {
      var data = null;
      try { data = JSON.parse(raw); } catch (_) { return; }
      if (onEvent) {
        try { onEvent(data, type); } catch (_) {}
      }
    }

    function connect() {
      if (stopped) return;
      sse = new EventSource(url);
      if (onState) onState('connecting', '● sse');

      sse.onopen = function() {
        fails = 0;
        delay = 800;
        if (onState) onState('open', '● sse');
      };

      sse.onmessage = function(ev) {
        fails = 0;
        deliver(ev.data, 'message');
      };

      if (eventTypes && eventTypes.length) {
        for (var i = 0; i < eventTypes.length; i++) {
          (function (type) {
            sse.addEventListener(type, function (ev) {
              fails = 0;
              deliver(ev.data, type);
            });
          })(eventTypes[i]);
        }
      }

      sse.onerror = function() {
        if (sse) { sse.close(); sse = null; }
        if (stopped) return;
        fails++;
        // E1 rule: 1-2 transient errors retry quickly; 3+ enter exponential backoff capped at 15s
        var nextDelay = fails < 3 ? 800 : Math.min(15000, delay * 2);
        delay = nextDelay;
        var tr = window.__moaI18n && window.__moaI18n.t;
        var stateMsg = fails < 3
          ? (tr ? tr('debate.transient', { count: fails }) : '○ 瞬断 ' + fails + '/3')
          : (tr ? tr('debate.backoff', { seconds: Math.round(nextDelay / 100) / 10 }) : '○ 重连退避 ' + Math.round(nextDelay / 100) / 10 + 's');
        if (onState) onState('error', stateMsg);
        setTimeout(connect, nextDelay);
      };
    }

    connect();

    return {
      close: function() {
        stopped = true;
        if (sse) { sse.close(); sse = null; }
      }
    };
  }

  /* ── Shared refresh layer (converged polling/SSE-fallback plumbing) ──────
     Polling intervals keep each page's historical cadence (SSE fallback
     15s, runs 5s, system 10s); the constants are exported from lib.ts and
     inlined here so every page reads the same source of truth. */
  var POLL_MS = {
    sseFallback: ${SSE_FALLBACK_POLL_MS},
    runs: ${RUNS_POLL_MS},
    system: ${SYSTEM_POLL_MS}
  };

  /**
   * Shared polling timer for the refresh layer (runs live, system health,
   * the SSE fallback below). Runs fn() every intervalMs and returns
   * { stop() }; error handling stays with the caller, exactly like the
   * historical per-page setInterval(...).catch(...) call sites.
   */
  function startPoll(fn, intervalMs) {
    var timer = setInterval(function () { fn(); }, intervalMs);
    return {
      stop: function () {
        if (timer) { clearInterval(timer); timer = null; }
      }
    };
  }

  /**
   * SSE stream plus an unconditional polling fallback (the board view's
   * pattern): a plain EventSource keeps the browser's native reconnect
   * (onerror stays inert on purpose — reconnect parameters untouched),
   * while poll() every pollMs keeps the view fresh if the stream stalls
   * silently or never connects. Returns { close() } releasing both; pair
   * it with the owning view's teardown.
   */
  function subscribeWithPoll(url, onMessage, poll, pollMs) {
    var source = null;
    if (typeof EventSource !== 'undefined') {
      source = new EventSource(url);
      source.onmessage = onMessage;
      source.onerror = function () {};
    }
    var pollTimer = startPoll(poll, pollMs);
    return {
      close: function () {
        if (source) { source.close(); source = null; }
        pollTimer.stop();
      }
    };
  }

  /* ── Themed custom <select> (EnhanceSelect) ──────────────────────────────
     Wraps a native <select> with a themed button + role="listbox" popover.
     The native select stays in the DOM (visually hidden, still readable by
     assistive tech) and remains the single source of truth: every option
     add/remove, .value / .disabled write and 'change' dispatch on it keeps
     working exactly as before. A MutationObserver (option list, disabled,
     selectedness) plus a light polling backstop mirror native state into
     the custom UI; picking an option writes select.value back and dispatches
     a bubbling 'change'. Idempotent (data-cs-enhanced marker) and no-op safe
     in fake-DOM sandboxes (initLiquidParallax-style guarding). */
  var CS_POLL_MS = 300;
  var CS_TYPEAHEAD_MS = 800;
  var csPopCounter = 0;

  function EnhanceSelect(select) {
    try {
      if (!select || !select.parentNode || select.multiple) return null;
      if (select.getAttribute && select.getAttribute('data-cs-enhanced')) return select;

      var doc = document;
      var root = doc.createElement('div');
      root.className = 'cs-root';
      root.setAttribute('data-cs', '1');
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'cs-btn';
      btn.setAttribute('aria-haspopup', 'listbox');
      btn.setAttribute('aria-expanded', 'false');
      var popId = (select.id ? select.id + '-pop' : 'cs-pop-' + (++csPopCounter));
      var pop = doc.createElement('div');
      pop.className = 'cs-pop';
      pop.id = popId;
      pop.setAttribute('role', 'listbox');
      pop.hidden = true;
      btn.setAttribute('aria-controls', popId);

      /* Share the select's accessible name: its <label>, else aria-label. */
      var label = '';
      if (select.id) {
        var labelEl = null;
        try { labelEl = doc.querySelector('label[for="' + select.id + '"]'); } catch (e) { labelEl = null; }
        if (labelEl) {
          var labelId = labelEl.id || (select.id + '-lbl');
          if (!labelEl.id) labelEl.id = labelId;
          label = labelEl.textContent || '';
          btn.setAttribute('aria-labelledby', labelId);
        }
      }
      if (!label) {
        label = select.getAttribute('aria-label') || select.getAttribute('label') || '';
        if (label) btn.setAttribute('aria-label', label);
      }
      if (label) pop.setAttribute('aria-label', label);

      select.parentNode.insertBefore(root, select);
      select.className = (select.className ? select.className + ' ' : '') + 'cs-native visually-hidden';
      select.tabIndex = -1; /* the button is the tab stop; label clicks redirect below */
      root.appendChild(select);
      root.appendChild(btn);
      root.appendChild(pop);
      select.setAttribute('data-cs-enhanced', '1');

      /* Copy a px min-width (e.g. #workspace's 280px) so the wrapper keeps the
         native select's footprint in flex bars; .field .cs-root{width:100%}
         covers the toolbar fields. */
      if (typeof getComputedStyle === 'function') {
        try {
          var css = getComputedStyle(select);
          if (css && css.minWidth && /px$/.test(css.minWidth)) root.style.minWidth = css.minWidth;
        } catch (e) {}
      }

      var activeIndex = -1;
      var lastValue = select.value;
      var lastDisabled = !!select.disabled;
      var typeBuffer = '';
      var typeLastTs = 0;
      var typeTimer = null;
      var observer = null;
      var pollTimer = null;
      var destroyed = false;

      function optCount() {
        var opts = select.options;
        return opts ? opts.length : 0;
      }
      function optAt(index) {
        var opts = select.options;
        return opts ? opts[index] : null;
      }
      function findIndexByValue(value) {
        for (var i = 0; i < optCount(); i++) {
          var opt = optAt(i);
          if (opt && opt.value === value) return i;
        }
        return -1;
      }
      function firstEnabledIndex() {
        for (var i = 0; i < optCount(); i++) {
          var opt = optAt(i);
          if (opt && !opt.disabled) return i;
        }
        return -1;
      }
      function lastEnabledIndex() {
        for (var i = optCount() - 1; i >= 0; i--) {
          var opt = optAt(i);
          if (opt && !opt.disabled) return i;
        }
        return -1;
      }
      function selectedText() {
        var n = optCount();
        if (!n) return '';
        var idx = select.selectedIndex;
        var opt = (idx >= 0 && idx < n) ? optAt(idx) : null;
        if (!opt) {
          for (var i = 0; i < n; i++) {
            if (optAt(i).value === select.value) { opt = optAt(i); break; }
          }
        }
        return opt ? (opt.textContent || opt.text || '') : '';
      }
      function scrollItemIntoView(item) {
        try { if (item && item.scrollIntoView) item.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      }
      function syncDisplay() {
        lastValue = select.value;
        lastDisabled = !!select.disabled;
        btn.textContent = selectedText();
        btn.disabled = lastDisabled;
        if (lastDisabled) closePop(false);
        root.className = 'cs-root' + (lastDisabled ? ' disabled' : '');
        var items = pop.children;
        for (var i = 0; i < items.length; i++) {
          if (items[i].getAttribute('data-value') === lastValue) items[i].setAttribute('aria-selected', 'true');
          else items[i].setAttribute('aria-selected', 'false');
        }
      }
      function rebuildOptions() {
        pop.textContent = '';
        var n = optCount();
        for (var i = 0; i < n; i++) {
          (function (option, index) {
            var item = doc.createElement('div');
            item.className = 'cs-option' + (option.disabled ? ' cs-option-disabled' : '');
            item.id = popId + '-o' + index;
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', 'false');
            if (option.disabled) item.setAttribute('aria-disabled', 'true');
            item.textContent = option.textContent || option.text || '';
            item.setAttribute('data-value', option.value);
            item.addEventListener('mousemove', function () {
              if (!option.disabled) setActive(index);
            });
            item.addEventListener('click', function () {
              if (!option.disabled) commitValue(option.value, true);
            });
            pop.appendChild(item);
          })(optAt(i), i);
        }
        activeIndex = findIndexByValue(select.value);
        syncDisplay();
        if (pop.hidden === false) applyActive();
      }
      function applyActive() {
        var items = pop.children;
        for (var i = 0; i < items.length; i++) items[i].classList.remove('active');
        if (activeIndex >= 0 && activeIndex < items.length) {
          items[activeIndex].classList.add('active');
          pop.setAttribute('aria-activedescendant', items[activeIndex].id);
          scrollItemIntoView(items[activeIndex]);
        }
      }
      function setActive(index) {
        var n = optCount();
        if (index < 0) index = 0;
        if (index > n - 1) index = n - 1;
        if (index !== activeIndex) { activeIndex = index; applyActive(); }
      }
      function moveActive(delta) {
        var n = optCount();
        if (!n) return;
        var i = activeIndex >= 0 ? activeIndex : (delta > 0 ? -1 : n);
        for (var step = 0; step < n; step++) {
          i = (i + delta + n) % n;
          var opt = optAt(i);
          if (opt && !opt.disabled) { activeIndex = i; applyActive(); return; }
        }
      }
      function openPop() {
        if (lastDisabled || !optCount() || pop.hidden === false) return;
        rebuildOptions();
        var rect = null;
        try { rect = btn.getBoundingClientRect(); } catch (e) { rect = null; }
        pop.style.top = 'calc(100% + 4px)';
        pop.style.bottom = 'auto';
        pop.hidden = false;
        if (rect && typeof window !== 'undefined' && window.innerHeight) {
          var popH = 0;
          try { popH = pop.offsetHeight || 0; } catch (e) {}
          if (rect.bottom + 4 + popH > window.innerHeight) {
            pop.style.top = 'auto';
            pop.style.bottom = 'calc(100% + 4px)';
          }
        }
        btn.setAttribute('aria-expanded', 'true');
        applyActive();
      }
      function closePop(restoreFocus) {
        if (pop.hidden === false) {
          pop.hidden = true;
          if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
        }
        btn.setAttribute('aria-expanded', 'false');
        pop.removeAttribute('aria-activedescendant');
        if (restoreFocus && btn.focus) { try { btn.focus(); } catch (e) {} }
      }
      function commitValue(value, dispatch) {
        if (select.value !== value) {
          select.value = value;
          activeIndex = findIndexByValue(value);
        }
        syncDisplay();
        if (dispatch) {
          var ev = null;
          try { ev = new Event('change', { bubbles: true }); } catch (e) {
            try { ev = doc.createEvent('Event'); ev.initEvent('change', true, false); } catch (e2) { ev = null; }
          }
          if (ev && select.dispatchEvent) select.dispatchEvent(ev);
        }
        closePop(false);
      }
      function typeaheadSearch(needle, start) {
        var n = optCount();
        if (!n) return -1;
        needle = needle.toLowerCase();
        for (var step = 0; step < n; step++) {
          var i = (start + step) % n;
          var opt = optAt(i);
          if (!opt || opt.disabled) continue;
          var t = (opt.textContent || opt.text || '').toLowerCase();
          if (t.indexOf(needle) === 0) return i;
        }
        return -1;
      }
      function typeaheadMove(ch) {
        var now = Date.now();
        if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
        if (now - typeLastTs > CS_TYPEAHEAD_MS) typeBuffer = '';
        typeLastTs = now;
        typeBuffer += ch;
        var start = activeIndex >= 0 ? activeIndex + 1 : 0;
        var hit = typeaheadSearch(typeBuffer, start);
        if (hit < 0) hit = typeaheadSearch(typeBuffer, 0);
        if (hit >= 0) { activeIndex = hit; applyActive(); }
        typeTimer = setTimeout(function () { typeBuffer = ''; typeTimer = null; }, CS_TYPEAHEAD_MS);
      }
      function typeaheadCommit(ch) {
        var hit = typeaheadSearch(ch, 0);
        if (hit >= 0) {
          var opt = optAt(hit);
          if (opt) commitValue(opt.value, true);
        }
      }

      btn.addEventListener('click', function () {
        if (pop.hidden === false) closePop(false); else openPop();
      });
      btn.addEventListener('keydown', function (e) {
        var key = e.key;
        if (!key) return;
        if (pop.hidden === false) {
          if (key === 'Escape') { e.preventDefault(); closePop(true); }
          else if (key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
          else if (key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
          else if (key === 'Home') { e.preventDefault(); activeIndex = 0; applyActive(); }
          else if (key === 'End') { e.preventDefault(); activeIndex = optCount() - 1; applyActive(); }
          else if (key === 'Enter' || key === ' ') {
            e.preventDefault();
            var idx = activeIndex;
            var opt = (idx >= 0 && idx < optCount()) ? optAt(idx) : null;
            if (!opt || opt.disabled) opt = optAt(firstEnabledIndex());
            if (opt) commitValue(opt.value, true);
          }
          else if (key === 'Tab') { closePop(false); }
          else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeaheadMove(key); }
        } else {
          if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
            e.preventDefault();
            openPop();
            if (key === 'ArrowDown') { activeIndex = firstEnabledIndex(); applyActive(); }
            else if (key === 'ArrowUp') { activeIndex = lastEnabledIndex(); applyActive(); }
          }
          else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { typeaheadCommit(key); }
        }
      });
      /* Native 'change' (dispatched by page code) re-syncs the custom UI. */
      select.addEventListener('change', syncDisplay);
      /* Label clicks land on the hidden select — hand focus to the button. */
      select.addEventListener('focus', function () {
        if (!lastDisabled && btn.focus) { try { btn.focus(); } catch (e) {} }
      });

      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(function (mutations) {
          if (destroyed) return;
          var structural = false;
          for (var i = 0; i < mutations.length; i++) {
            if (mutations[i].type === 'childList') { structural = true; break; }
          }
          if (structural) rebuildOptions(); else syncDisplay();
        });
        observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
      }
      /* Value reflection onto option[selected] is not universally observable,
         so a light poll backstops .value / .disabled writes. */
      if (typeof setInterval === 'function') {
        pollTimer = setInterval(function () {
          if (destroyed) return;
          var v = select.value;
          var d = !!select.disabled;
          if (v !== lastValue || d !== lastDisabled) {
            lastValue = v;
            lastDisabled = d;
            syncDisplay();
          }
        }, CS_POLL_MS);
      }

      /* Close on outside mousedown (capture, so it beats inner handlers) and
         on window scroll/resize; both removed on destroy. */
      function onDocMousedown(e) {
        if (pop.hidden === false) {
          var t = e.target;
          if (t === root || (t && t.nodeType === 1 && root.contains(t))) return;
          closePop(false);
        }
      }
      if (doc.addEventListener) doc.addEventListener('mousedown', onDocMousedown, true);
      function onViewportChange() { closePop(false); }
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('scroll', onViewportChange, { passive: true });
        window.addEventListener('resize', onViewportChange, { passive: true });
      }

      function destroy() {
        destroyed = true;
        if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
        if (doc.removeEventListener) doc.removeEventListener('mousedown', onDocMousedown, true);
        if (typeof window !== 'undefined' && window.removeEventListener) {
          window.removeEventListener('scroll', onViewportChange);
          window.removeEventListener('resize', onViewportChange);
        }
      }
      root.destroy = destroy;

      rebuildOptions();
      return root;
    } catch (e) {
      return null;
    }
  }

  /** Enhance every native <select> on the page. Idempotent; harmless no-op
   *  in fake-DOM sandboxes (initLiquidParallax-style guarding). */
  function initCustomSelects() {
    try {
      var selects = document.querySelectorAll('select');
      if (!selects) return;
      for (var i = 0; i < selects.length; i++) {
        try { EnhanceSelect(selects[i]); } catch (e) {}
      }
    } catch (e) {}
  }

  window.__moaLib = {
    pad2: pad2,
    fmtClock: fmtClock,
    fmtTokens: fmtTokens,
    fmtBytes: fmtBytes,
    valueText: valueText,
    api: api,
    connectSSE: connectSSE,
    POLL_MS: POLL_MS,
    startPoll: startPoll,
    subscribeWithPoll: subscribeWithPoll,
    initThemePicker: initThemePicker,
    initLiquidParallax: initLiquidParallax,
    EnhanceSelect: EnhanceSelect,
    initCustomSelects: initCustomSelects,
    loadAppVersion: loadAppVersion
  };

  initThemePicker();
  initLiquidParallax();
  initCustomSelects();
  loadAppVersion();
})(typeof window !== 'undefined' ? window : this);
`;
