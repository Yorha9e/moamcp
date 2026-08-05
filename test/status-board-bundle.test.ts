/**
 * Status Board production-bundle regression (F1, 0.9.0 review).
 *
 * The page inlines STATUS_MODEL_JS, whose serialized model sources are
 * generated from `Function.prototype.toString()` of the live module
 * functions. esbuild's production bundle renames status-model's exported
 * `agentKey` to `agentKey2` (src/modules/status/state.ts exports the same
 * name), which used to break the plain IIFE's static `agentKey: agentKey`
 * text with `ReferenceError: agentKey is not defined` — the whole page died.
 *
 * This test bundles STATUS_BOARD_HTML with build.js's exact esbuild config
 * (platform node, banner, alias process) plus the colliding state.ts export,
 * extracts the final HTML's model IIFE and executes it in a bare vm.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

/** Mirrors build.js's shared config — the production bundle shape F1 shipped in. */
const SHARED = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; var require = __cr(import.meta.url);",
  },
  alias: { process: 'node:process' },
};

describe('Status Board production bundle (F1 regression)', () => {
  let html: string;
  let bundleText: string;
  let tmpDir: string;
  let outfile: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'moamcp-sb-bundle-'));
    outfile = join(tmpDir, 'bundle.mjs');
    buildSync({ ...SHARED, entryPoints: ['test/fixtures/status-board-bundle-entry.ts'], outfile });
    bundleText = await readFile(outfile, 'utf8');
    const mod = (await import(pathToFileURL(outfile).href)) as { STATUS_BOARD_HTML: string };
    html = mod.STATUS_BOARD_HTML;
  });

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('inlined model IIFE survives the esbuild agentKey -> agentKey2 rename', () => {
    // The collision source must be present, like dist/server.js: state.ts's
    // `agentKey` export lives in the bundle. Whether esbuild renames
    // status-model.ts's `agentKey` (agentKey2 in this esbuild generation) is an
    // implementation detail — the contract is that the served model IIFE runs
    // regardless, so every assertion below is rename-scheme agnostic (no
    // hard-coded `agentKey2` suffix that would false-fail if a future esbuild
    // stops renaming or picks a different name).
    expect(bundleText).toContain('function agentKey(sessionId, agentId)');

    // Extract the page's model IIFE — it starts with the fixed parameter list
    // and is immediately followed by the page IIFE — and run it in a bare vm
    // (no DOM), exactly the critic's attack path.
    const start = html.indexOf('(function (agentKey,');
    const pageMarker = "\n(function () {\n  'use strict';\n  var M = window.__moaStatusModel;";
    const end = html.indexOf(pageMarker);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const modelJs = html.slice(start, end).trim();
    expect(modelJs.endsWith(');')).toBe(true);

    // Rewrite-clean: if esbuild renamed a model function (digit-suffixed in its
    // scheme), the fixed-name rewrite must have normalized every serialized
    // declaration back to the source-level name — a partial rewrite would leave
    // e.g. `function agentKey2(...)` inside the IIFE and the vm run below would
    // throw. When no rename happened there is nothing to rewrite and this still
    // passes (no model function legitimately carries a digit in its name).
    expect(modelJs).not.toMatch(/function\s+[$\w]*\d[$\w]*\s*\(/);

    // HTML-safe: the serialized sources are embedded inside a <script> block;
    // jsonStringForHtml escapes `<` as \u003C so a future model source cannot
    // close the script early (`</script>`) or enter the escaped-data state
    // (`<!--`). No such sequence may survive into the served page.
    expect(modelJs).not.toMatch(/<\/script|<!--/);

    const sandbox: Record<string, unknown> = { console };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    expect(() => vm.runInContext(modelJs, sandbox, { timeout: 5000 })).not.toThrow();

    const api = (sandbox as { window: { __moaStatusModel: any } }).window.__moaStatusModel;
    expect(api).toBeDefined();
    // Key functions must be usable end-to-end (not just mounted).
    expect(api.agentKey('s1', 'main')).toBe('s1:main');
    const model = api.newModel();
    api.applySnapshot(model, {
      sessions: [],
      agents: [{ sessionId: 's1', agentId: 'main', busy: true, stale: false, subagents: [] }],
    });
    expect(api.modelCounts(model)).toEqual({ agents: 1, sessions: 1 });
    expect(api.deriveStatus(model.byKey['s1:main']).tone).toBe('busy');
    expect(
      api.upsertAgent(model, { sessionId: 's2', agentId: 'lone', busy: false, stale: false, subagents: [] }).created,
    ).toBe(true);
    expect(api.modelCounts(model)).toEqual({ agents: 2, sessions: 2 });
  });
});
