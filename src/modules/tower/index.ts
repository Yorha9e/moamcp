/**
 * Tower module (B1 + B2): the tower workflow core — boot/plan/spawn/register/
 * mission/send/inbox/finding/review/merge/teardown/status/ci/progress tools
 * plus the `/api/tower/*` read routes, tier 'experimental'.
 *
 * The module is a thin aggregate over the controller seam: tools resolve the
 * shared BoardStore + repo root per call (B1-1 scope anchoring), routes read
 * the same board. B2 ships `moa_tower_ci` (with the controller's in-process
 * serial queue) and `moa_tower_progress`.
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
  TowerCiResult,
  TowerInitResult,
  TowerFindingInput,
  TowerMissionPatch,
  TowerPlanInput,
  TowerReviewInput,
  TowerSendInput,
} from './store.js';
export {
  IDENTITY_BLOCK_THRESHOLD,
  checkParentChild,
  checkWorkdirSoft,
  evaluateIdentity,
  evaluateTowerIdentity,
  findFoldAgent,
  foldView,
  type IdentityFoldView,
  type IdentityVerdict,
  type ParentChildResult,
  type WorkdirResult,
} from './identity.js';
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

/** Create the tower module (id 'tower', tier 'experimental'). */
export function createTowerModule(controller: TowerController | undefined): MoaModule {
  return {
    id: 'tower',
    tier: 'experimental',
    tools: controller === undefined ? [] : towerTools(controller),
    routes: towerRoutes(controller),
  };
}
