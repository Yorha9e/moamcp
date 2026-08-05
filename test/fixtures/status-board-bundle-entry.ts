/**
 * F1 production-bundle regression fixture (0.9.0 review).
 *
 * Bundles STATUS_BOARD_HTML together with state.ts's exported `agentKey` so
 * esbuild renames status-model.ts's `agentKey` (the second occurrence) to
 * `agentKey2` — exactly the collision that occurs in the real dist/server.js
 * bundle. With the pre-fix serialized model IIFE, the page's inlined model
 * then threw `ReferenceError: agentKey is not defined` and never mounted
 * window.__moaStatusModel. Import order matters: state.ts first so that
 * status-model's symbol is the one esbuild renames.
 */
export { agentKey } from '../../src/modules/status/state.js';
export { STATUS_BOARD_HTML } from '../../src/web/status-board.js';
