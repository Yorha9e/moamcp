/**
 * Debate Card production-bundle regression fixture (0.13.0).
 *
 * Bundles DEBATE_CARD_HTML together with state.ts's exported `agentKey` so
 * esbuild renames status-model.ts's `agentKey` (the second occurrence) to
 * `agentKey2` — exactly the collision that occurs in the real dist/server.js
 * bundle. The debate card inlines STATUS_MODEL_JS the same way the Status
 * Board does, so the same agentKey -> agentKey2 rename hazard applies to its
 * inlined model IIFE. Import order matters: state.ts first so that
 * status-model's symbol is the one esbuild renames.
 */
export { agentKey } from '../../src/modules/status/state.js';
export { DEBATE_CARD_HTML } from '../../src/web/debate-card.js';
