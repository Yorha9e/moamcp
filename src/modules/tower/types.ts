/**
 * `tower` domain (protocol) — the machine-readable state types behind the
 * tower workflow (ported from kimi-code `pr-2633-tower`:
 * `packages/agent-core-v2/src/agent/tower/protocol/types.ts`).
 *
 * moamcp board-化 deviations (基准 TOWER_V1_IMPLEMENTATION_PLAN.md 附录 A):
 *  - `TowerState.missions` is an ordered list of mission **ids** (M1, M2, …).
 *    Each mission's full document lives under its own board key
 *    `tower/<repoKey>/mission/<id>` (row 5 deviation: single-document
 *    missions — board 96KB ceiling + lower read-modify-write contention).
 *  - `TowerAgentKind` gains `'tower'`: the boot-registered orchestrator entry
 *    (name `tower`) sits in the roster with kind `'tower'` (row 7 deviation:
 *    the official tower is the implicit `main` agent and never appears in the
 *    roster; here the tower is a fixed orchestrator profile registered at
 *    boot).
 */

export type TowerAgentKind = 'tower' | 'worker' | 'reviewer' | 'delegator';

export interface TowerRosterEntry {
  /** Display/route name, e.g. `tower`, `agent-build`, `reviewer-a`. Unique per workspace. */
  readonly name: string;
  /** Engine agent id (e.g. `agent-3`); the boot-registered tower entry carries the orchestrator's id. */
  readonly agentId: string;
  readonly kind: TowerAgentKind;
  /** Workers: the mission they own. */
  readonly missionId?: string;
  /** Reviewers: the branch they are assigned to review. */
  readonly reviewTarget?: string;
  /** Workers: worktree slot, e.g. `wt-1`. */
  readonly worktree?: string;
  /** Workers: their branch, e.g. `feat/M1-vulkan-build`. */
  readonly branch?: string;
  /** B2 identity (decision 2): fold cross-validation outcome (① ∧ ② ∧ ③ for
   *  spawned agents; ① only for the tower entry). `false` also covers "not yet
   *  re-verified / fold data missing" — missing ≠ mismatch (see identity.ts). */
  readonly verified?: boolean;
  /** B2 identity: ISO timestamp of the last `verified:true` stamp. */
  readonly verifiedAt?: string;
  /** B2 identity: consecutive hard-mismatch count (② data-present-but-wrong
   *  only; missing data never counts). blocked is derived: failedCount ≥ 3. */
  readonly failedCount?: number;
  readonly spawnedAt: string;
}

export interface TowerRoster {
  readonly agents: TowerRosterEntry[];
}

export type TowerMissionStatus =
  | 'planned'
  | 'active'
  | 'completed'
  | 'blocked'
  | 'paused'
  | 'merged';

/**
 * `build` missions change code: their scope reserves write access (plan-time
 * disjoint check, merge-time containment) and they merge through the full
 * review gate. `survey` missions are read-only investigations: their scope is
 * informational only (reserves nothing), and their merge is a zero-diff
 * formality that closes the mission without a git merge.
 */
export type TowerMissionKind = 'build' | 'survey';

export interface TowerMissionTask {
  text: string;
  done: boolean;
}

export interface TowerMission {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  kind: TowerMissionKind;
  /** picomatch globs; mutable only through `updateMission` (tower, logged). */
  scope: string[];
  readonly branch: string;
  readonly worktree: string;
  readonly deps: readonly string[];
  status: TowerMissionStatus;
  owner?: string;
  tasks: TowerMissionTask[];
  /** Decision log, oldest first. */
  notes: string[];
  blockers: string[];
}

/**
 * Single tower state document (board key `tower/<repoKey>/state`). `missions`
 * holds mission **ids in plan order** — the full missions live in
 * `tower/<repoKey>/mission/<id>` single documents (附录 A row 5 deviation,
 * board 化). `roster` includes the boot-registered `tower` entry (kind
 * `'tower'`) plus spawned workers/reviewers.
 */
export interface TowerState {
  readonly version: 1;
  readonly base: string;
  /** `pr` is reserved for a future gh-backed mode; v1 always runs `branch`. */
  readonly mode: 'branch' | 'pr';
  readonly createdAt: string;
  roster: TowerRoster;
  /** Mission ids in plan order (M1, M2, …). */
  missions: string[];
}

/**
 * `tower/<repoKey>/repo` — the namespace identity document written at boot:
 * which checkout this tower namespace belongs to and where its worktrees
 * physically live (基准 decision 7/8 layout; worktrees are a sibling
 * `<repoName>-worktrees/` directory, never inside the repo — we write no
 * `.tower/` tree, 附录 A row 4 deviation).
 */
export interface TowerRepoDoc {
  readonly repoRoot: string;
  readonly worktreesRoot: string;
  readonly base: string;
  readonly mode: 'branch' | 'pr';
  readonly createdAt: string;
  readonly bootedAt: string;
  /** B2 CI (B2-4): optional shell command `moa_tower_ci` runs in each mission
   *  worktree; the merge gate turns hard (ci/<branchSlug> green required) when
   *  configured. Set idempotently by re-booting with `ci_command`. */
  readonly ciCommand?: string;
}

export type TowerFindingType = 'bug' | 'improve' | 'vuln' | 'idea';
export type TowerFindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export type TowerReviewStatus = 'clean' | `p1-${number}items` | `p2-${number}items`;
export type TowerReviewMerge = 'merge' | 'fix-then-merge' | 'hold';

export interface TowerReviewInfo {
  readonly reviewer: string;
  readonly target: string;
  readonly round: number;
  readonly status: string;
  readonly merge: string;
  /** Branch tip the review was written against; merge gate compares it. */
  readonly reviewedCommit: string;
  readonly date: string;
  readonly file: string;
}

export interface TowerInboxItem {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly sentAt: string;
  readonly scope?: string;
  readonly action?: string;
  readonly consentRef?: string;
  readonly body: string;
}
