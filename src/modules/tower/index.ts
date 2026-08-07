/**
 * Tower module (B1): the tower workflow core — boot/plan/spawn/register/
 * mission/send/inbox/finding/review/merge/teardown/status tools plus the
 * `/api/tower/*` read routes, tier 'experimental'.
 *
 * The module is a thin aggregate over the controller seam: tools resolve the
 * shared BoardStore + repo root per call (B1-1 scope anchoring), routes read
 * the same board. `moa_tower_ci` is deliberately absent (B2 ships it with
 * the CI queue — no stub).
 */
import type { MoaModule } from '../types.js';
import type { TowerController } from './controller.js';
import { towerRoutes } from './routes.js';
import { towerTools } from './tools.js';

export { createTowerController } from './controller.js';
export type { TowerController, TowerControllerOptions } from './controller.js';
export * from './paths.js';
export { GitError } from './git.js';
export { TowerProtocolError, TowerStore } from './store.js';
export type {
  TowerFindingType,
  TowerInboxItem,
  TowerMission,
  TowerMissionKind,
  TowerMissionStatus,
  TowerRepoDoc,
  TowerReviewInfo,
  TowerReviewMerge,
  TowerReviewStatus,
  TowerRoster,
  TowerRosterEntry,
  TowerState,
} from './types.js';
export type {
  TowerFindingInput,
  TowerInitResult,
  TowerMissionPatch,
  TowerPlanInput,
  TowerReviewInput,
  TowerSendInput,
} from './store.js';

/** Create the tower module (id 'tower', tier 'experimental'). */
export function createTowerModule(controller: TowerController | undefined): MoaModule {
  return {
    id: 'tower',
    tier: 'experimental',
    tools: controller === undefined ? [] : towerTools(controller),
    routes: towerRoutes(controller),
  };
}
