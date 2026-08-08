/**
 * Tower module — the 14 tower MCP tools (moa_tower_boot / plan / spawn /
 * register / mission / send / inbox / finding / review / merge / teardown /
 * status / ci / progress). Hand-written JSON schemas (board/index.ts
 * convention).
 *
 * Protocol discipline (B1, not deferred to B4 profiles):
 *  - **B1-1 scope anchoring**: every tool REQUIRES `workspace` (the absolute
 *    repo root). The server's workspaceCwd is never used as a fallback — a
 *    worker session cwd is its worktree, and falling back would silently split
 *    the tower namespace.
 *  - **resolveCallerName / owner / reviewer / tower-only** checks run here at
 *    the protocol layer (the MCP transport cannot authenticate callers; the
 *    caller passes its own agent id and the roster decides — 纪律辅助, not a
 *    security boundary).
 *  - plan/spawn/register/merge/ci/teardown are tower-only; mission/progress
 *    updates go through the store's owner check; review requires an assigned
 *    reviewer.
 *  - B2 identity (①②③) cross-validation runs on register (eager) and status
 *    read (lazy re-verify) via `store.verifyAgentIdentity`; the fold accessor
 *    comes from the controller.
 */
import type { BoardStore } from '../../core/store/board.js';
import type { MoaModule, MoaToolDef, MoaToolArgs } from '../types.js';
import type { TowerController } from './controller.js';
import * as git from './git.js';
import { IDENTITY_BLOCK_THRESHOLD, foldView } from './identity.js';
import { TOWER_NAME, normalizeTowerRoot, worktreePath } from './paths.js';
import {
  TowerProtocolError,
  TowerStore,
} from './store.js';
import type { TowerFindingType, TowerMission, TowerReviewInfo, TowerState } from './types.js';

const STATUS_EMOJI: Record<TowerMission['status'], string> = {
  planned: '🟡',
  active: '🔵',
  completed: '🟢',
  blocked: '🔴',
  paused: '⏸️',
  merged: '✅',
};

const INBOX_COUNT_LIMIT = 1000;
const RECENT_LOG_LINES = 10;

const WORKSPACE_ARG = {
  type: 'string',
  description:
    'The absolute repo root (main checkout) this tower namespace anchors to. Required on every tower tool — the server cwd is never used as a fallback.',
} as const;
const CALLER_ARG = {
  type: 'string',
  description:
    'Your engine agent id. The tower tools resolve it against the boot-registered roster (the booted tower, or a spawned worker/reviewer).',
} as const;

// ---------------------------------------------------------------------------
// shared tool plumbing
// ---------------------------------------------------------------------------

function argString(args: MoaToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/** Build the store from the required `workspace` arg (B1-1 scope anchoring). */
function storeFor(controller: TowerController, args: MoaToolArgs): { store: TowerStore; repoRoot: string } {
  const board: BoardStore | undefined = controller.getBoard();
  const workspace = argString(args, 'workspace');
  if (board === undefined) {
    throw new TowerProtocolError('tower is not ready — no shared board mounted (start the server first)');
  }
  if (workspace === undefined || workspace.trim().length === 0) {
    throw new TowerProtocolError(
      'workspace (the absolute repo root) is required — tower tools never fall back to the server cwd',
    );
  }
  const repoRoot = normalizeTowerRoot(workspace); // throws on non-absolute
  return { store: new TowerStore(repoRoot, board), repoRoot };
}

/** Resolve the caller and load state (protocol-layer identity check). */
async function resolveCaller(
  store: TowerStore,
  state: TowerState,
  args: MoaToolArgs,
): Promise<string> {
  const agentId = argString(args, 'caller_agent_id');
  if (agentId === undefined || agentId.trim().length === 0) {
    throw new TowerProtocolError('caller_agent_id is required — pass your engine agent id');
  }
  return store.resolveCallerName(state, agentId);
}

/** Tower-only gate: plan/spawn/register/merge/teardown are the tower's levers. */
async function requireTower(
  store: TowerStore,
  args: MoaToolArgs,
): Promise<{ state: TowerState; caller: string }> {
  const state = await store.load();
  const caller = await resolveCaller(store, state, args);
  if (caller !== 'tower') {
    throw new TowerProtocolError(
      `agent "${caller}" is not the control tower — only the booted tower may run this tool`,
    );
  }
  return { state, caller };
}

/**
 * Uniform error mapping: protocol/git failures become error results, and B2
 * extends the same mapping to ANY Error (fs errors — EACCES/ENOSPC/… — are
 * plain Errors, e.g. from the guard-mirror write or the boot exclude write;
 * "fs 错误统一经 runTool 映射为 isError"). Non-Error throws still propagate.
 */
async function runTool<T>(fn: () => Promise<T>): Promise<Record<string, unknown>> {
  try {
    return (await fn()) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error) {
      return { output: error.message, isError: true };
    }
    throw error;
  }
}

/**
 * B2-6: rebuild the guard mirror, returning the failure message instead of
 * throwing. fs errors (EACCES/ENOSPC/…) are plain Errors — mapping them here
 * keeps the register/spawn retryable-error contract ("fs 错误统一经 runTool
 * 映射为 isError" is honored by the callers returning the isError result).
 */
async function syncMirrorOrRetry(store: TowerStore): Promise<string | undefined> {
  try {
    await store.syncGuardMirror();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

export function towerTools(controller: TowerController): MoaToolDef[] {
  return [
    {
      name: 'moa_tower_boot',
      description:
        'Boot the tower workspace for a git repository: validates the repo (inside a git repo, ≥1 commit), writes the state + namespace identity docs to the shared board, and registers the tower roster entry (name "tower") with your orchestrator agent id. Idempotent lifecycle: repeated boot while booted errors; teardown clears the namespace so boot works again. No .tower/ directory is created inside the repo — state lives in the board, worktrees live in a sibling <repoName>-worktrees/ dir.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          repo_root: {
            type: 'string',
            description:
              'Optional alias for the same value as workspace (must resolve to the identical absolute path when provided); defaults to workspace.',
          },
          tower_agent_id: {
            type: 'string',
            description: 'Your orchestrator agent id — the roster entry for the tower is registered with it.',
          },
          base: {
            type: 'string',
            description: 'Base branch for missions (default: the repo\'s current branch).',
          },
          mode: {
            type: 'string',
            enum: ['branch', 'pr'],
            description: 'Tower mode (default "branch"; "pr" is reserved for a future gh-backed mode).',
          },
          ci_command: {
            type: 'string',
            description:
              'Optional CI command (B2): moa_tower_ci runs it in each mission worktree and the merge gate turns hard (green ci/<branchSlug> record required) once set. Re-booting with ci_command is the idempotent configuration channel — it updates the repo doc instead of erroring.',
          },
        },
        required: ['workspace', 'tower_agent_id'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store, repoRoot } = storeFor(controller, args);
          const repoRootArg = argString(args, 'repo_root');
          if (repoRootArg !== undefined && normalizeTowerRoot(repoRootArg) !== repoRoot) {
            throw new TowerProtocolError(
              'repo_root must resolve to the same absolute path as workspace',
            );
          }
          const towerAgentId = argString(args, 'tower_agent_id');
          if (towerAgentId === undefined || towerAgentId.trim().length === 0) {
            throw new TowerProtocolError('tower_agent_id is required');
          }
          const base = argString(args, 'base');
          const modeArg = argString(args, 'mode');
          const ciCommand = argString(args, 'ci_command');
          const result = await store.boot(towerAgentId, {
            ...(base !== undefined ? { base } : {}),
            ...(modeArg !== undefined ? { mode: modeArg as 'branch' | 'pr' } : {}),
            ...(ciCommand !== undefined && ciCommand.trim().length > 0 ? { ciCommand: ciCommand.trim() } : {}),
          });
          // B2 (decision 2): the booted towerAgentId goes through the same ①
          // fold-existence check (missing fold data → verified:false, never a
          // mismatch — lazy re-verify happens on later status reads).
          const outcome = await store.verifyAgentIdentity(
            TOWER_NAME,
            foldView(controller.getFold()),
            towerAgentId,
          );
          return {
            booted: result.created || result.updated === true,
            ...(result.updated === true ? { ci_command_updated: true } : {}),
            base: result.base,
            mode: 'branch',
            workspace: repoRoot,
            tower_agent_id: towerAgentId,
            verified: outcome.entry.verified ?? false,
            roster: ['tower'],
          };
        }),
    },
    {
      name: 'moa_tower_plan',
      description:
        'Split a tower goal into missions (tower-only): each mission gets an id (M<n>), a branch (feat/M<n>-<slug> — id-prefixed so same-titled missions never collide), and a worktree slot (wt-<n>). Build scopes must be pairwise disjoint (merged missions reserve nothing); deps must reference known mission ids. Survey missions are read-only and reserve no scope.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          caller_agent_id: CALLER_ARG,
          missions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short mission title; becomes the branch/worktree slug' },
                scope: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Files/globs this mission may touch (e.g. "src/build/**"). Scopes of different build missions must not overlap; "survey" scopes are informational and may overlap.',
                },
                tasks: { type: 'array', items: { type: 'string' }, description: 'Checklist the worker ticks via moa_tower_mission task_done' },
                deps: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Mission ids (e.g. "M1") that must merge before this one can merge',
                },
                kind: {
                  type: 'string',
                  enum: ['build', 'survey'],
                  description: '"survey" = read-only investigation (no review/git merge needed to close); default "build".',
                },
              },
              required: ['title', 'scope'],
              additionalProperties: false,
            },
            minItems: 1,
          },
        },
        required: ['workspace', 'caller_agent_id', 'missions'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store } = storeFor(controller, args);
          await requireTower(store, args);
          const rawMissions = args.missions;
          if (!Array.isArray(rawMissions) || rawMissions.length === 0) {
            throw new TowerProtocolError('TowerPlan needs at least one mission');
          }
          const missions = await store.plan(
            rawMissions.map((raw) => {
              const item = (raw ?? {}) as Record<string, unknown>;
              const title = argString(item as MoaToolArgs, 'title');
              const scope = item.scope;
              if (title === undefined || title.trim().length === 0) {
                throw new TowerProtocolError('each mission needs a title');
              }
              if (!Array.isArray(scope) || scope.length === 0 || !scope.every((s) => typeof s === 'string')) {
                throw new TowerProtocolError(`mission "${title}" needs a non-empty string scope array`);
              }
              return {
                title,
                scope: scope as string[],
                ...(Array.isArray(item.tasks) ? { tasks: item.tasks as string[] } : {}),
                ...(Array.isArray(item.deps) ? { deps: item.deps as string[] } : {}),
                ...(item.kind === 'survey' || item.kind === 'build' ? { kind: item.kind } : {}),
              };
            }),
          );
          return {
            planned: missions.length,
            missions: missions.map((m) => ({
              id: m.id,
              title: m.title,
              kind: m.kind,
              branch: m.branch,
              worktree: m.worktree,
              scope: m.scope,
              deps: [...m.deps],
              status: m.status,
            })),
            next: 'TowerSpawn one worker per build mission, reviewers for their branches; survey missions close with a zero-diff TowerMerge.',
          };
        }),
    },
    {
      name: 'moa_tower_spawn',
      description:
        'Two-stage spawn (tower-only, B1 bookkeeping stage): creates the mission\'s physical git worktree (sibling <repoName>-worktrees/wt-<n>, never inside the repo), marks the mission active with the agent as owner, and registers the roster entry with a PENDING agent id. The tower then launches the agent with its own Agent tool (run_in_background=true) and completes the enrollment with moa_tower_register(agent_id=…). Reviewers take review_target (a branch to review) instead of a mission.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          caller_agent_id: CALLER_ARG,
          name: { type: 'string', description: 'Unique tower name (e.g. "agent-build", "reviewer-a"); used for inbox addressing and mission ownership' },
          kind: { type: 'string', enum: ['worker', 'reviewer'], description: 'workers execute a mission in their worktree; reviewers review one branch' },
          mission_id: { type: 'string', description: 'Required for workers: the mission id (e.g. "M1") from moa_tower_plan' },
          review_target: { type: 'string', description: 'Required for reviewers: the branch to review (e.g. "feat/M2-x")' },
          instructions: { type: 'string', description: 'Extra tower instructions for the agent briefing' },
        },
        required: ['workspace', 'caller_agent_id', 'name', 'kind'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store, repoRoot } = storeFor(controller, args);
          const { state } = await requireTower(store, args);
          const name = argString(args, 'name');
          const kind = argString(args, 'kind');
          if (name === undefined || name.trim().length === 0) {
            throw new TowerProtocolError('spawn needs a unique agent name');
          }
          if (kind !== 'worker' && kind !== 'reviewer') {
            throw new TowerProtocolError('kind must be "worker" or "reviewer"');
          }
          // B1R-1 preflight: reject an exact duplicate AND any slug collision
          // with the existing roster / reserved names (tower, all) BEFORE any
          // side effect — worktree creation, mission activation, roster
          // registration. Without this, a "Reviewer A" spawn while the roster
          // holds "reviewer-a" would build the worktree + activate the mission
          // and only fail at registerAgent, leaving a half-spawned state.
          // Shared judgment with registerAgent (defense in depth inside its
          // board mutate) — one source of truth, no regex/message drift.
          store.assertNameAvailable(state, name);
          const notes: string[] = [];
          let missionId: string | undefined;
          let reviewTarget: string | undefined;
          let worktree: string | undefined;
          let branch: string | undefined;
          if (kind === 'worker') {
            const rawMission = argString(args, 'mission_id');
            if (rawMission === undefined || rawMission.trim().length === 0) {
              throw new TowerProtocolError('worker spawns require mission_id');
            }
            const mission = (await store.loadMissions(state)).find((m) => m.id === rawMission);
            if (mission === undefined) {
              throw new TowerProtocolError(
                `unknown mission "${rawMission}" — known missions: ${state.missions.join(', ') || '(none planned yet)'}`,
              );
            }
            missionId = mission.id;
            worktree = mission.worktree;
            branch = mission.branch;
            try {
              await store.addWorktree(mission.worktree, mission.branch, state.base);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              // B1R-3: only a pre-existing branch/worktree (respawn after a
              // crash — git says "already exists / already checked out /
              // already a registered worktree") is safe to continue through:
              // the agent can still work in the existing worktree. Any OTHER
              // worktree-creation failure (permissions, long path, disk) is a
              // real spawn failure — the mission stays planned and the spawn
              // errors instead of silently registering a worker with no tree.
              if (!/already exists|already checked out|already a registered worktree/i.test(message)) {
                throw new TowerProtocolError(
                  `spawn failed: cannot create worktree ${mission.worktree} for ${mission.branch} — ${message}`,
                );
              }
              notes.push(`worktree setup warning (continuing): ${message}`);
            }
            // Silent: the spawn log line below already carries name/owner/mission.
            await store.updateMission('tower', mission.id, { status: 'active', owner: name }, { silent: true });
          } else {
            reviewTarget = argString(args, 'review_target');
            if (reviewTarget === undefined || reviewTarget.trim().length === 0) {
              throw new TowerProtocolError('reviewer spawns require review_target');
            }
          }
          await store.registerAgent({
            name,
            agentId: '', // pending — moa_tower_register fills the real engine id
            kind,
            ...(missionId !== undefined ? { missionId } : {}),
            ...(reviewTarget !== undefined ? { reviewTarget } : {}),
            ...(worktree !== undefined ? { worktree } : {}),
            ...(branch !== undefined ? { branch } : {}),
            spawnedAt: new Date().toISOString(),
          });
          // B2-6: spawn ALSO writes the guard mirror (pending entry agentId:null,
          // name-addressable — fail-open until register fills the id).
          const mirrorError = await syncMirrorOrRetry(store);
          if (mirrorError !== undefined) {
            // The spawn side effects (worktree/mission/roster) are done; the
            // mirror write is the retryable part — re-running register rebuilds it.
            return {
              output: `guard mirror write failed: ${mirrorError} — the spawn side effects (worktree/mission/roster entry) are recorded; re-run moa_tower_register(name="${name}", agent_id=<engine id>) to retry the mirror write`,
              isError: true,
            };
          }
          await store.appendLog(
            'tower',
            'spawn',
            {
              name,
              kind,
              mission: missionId,
              target: reviewTarget,
            },
            missionId !== undefined ? store.missionRef(missionId) : undefined,
          );
          return {
            name,
            kind,
            mission_id: missionId,
            review_target: reviewTarget,
            branch,
            worktree: worktree !== undefined ? worktreePathOf(repoRoot, worktree) : undefined,
            agent_id: '',
            status: 'pending-register',
            notes,
            next: `Launch the ${kind} with your Agent tool (run_in_background=true), then complete enrollment: moa_tower_register(workspace, name="${name}", agent_id=<the engine agent id>).`,
          };
        }),
    },
    {
      name: 'moa_tower_register',
      description:
        'Two-stage spawn completion (tower-only): fills the real engine agent id into the pending roster entry created by moa_tower_spawn, runs the B2 identity cross-validation (① fold entry exists; ② dual-channel parent-child: wire parentAgentId == towerAgentId OR the tower fold entry lists this agent as a subagent; ③ soft session-workDir check), and rebuilds the guard mirror file (<repoRoot>/.tower-guard.json — name-keyed agents map with {name, worktree, agentId} + worktrees array). Missing fold data degrades to verified:false (never blocked); a hard mismatch increments failed_count (3 consecutive → blocked). Re-running register is allowed and re-verifies (B2-9).',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          caller_agent_id: CALLER_ARG,
          name: { type: 'string', description: 'The tower name registered by moa_tower_spawn' },
          agent_id: { type: 'string', description: 'The engine agent id returned by your Agent tool' },
          mission_id: { type: 'string', description: 'Optional: mission id if it was not recorded at spawn' },
          review_target: { type: 'string', description: 'Optional: review target if it was not recorded at spawn' },
          worktree: { type: 'string', description: 'Optional: worktree slot if it was not recorded at spawn' },
          branch: { type: 'string', description: 'Optional: branch if it was not recorded at spawn' },
        },
        required: ['workspace', 'caller_agent_id', 'name', 'agent_id'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store } = storeFor(controller, args);
          const { state } = await requireTower(store, args);
          const name = argString(args, 'name');
          const agentId = argString(args, 'agent_id');
          if (name === undefined || name.trim().length === 0) {
            throw new TowerProtocolError('register needs the roster name from moa_tower_spawn');
          }
          if (agentId === undefined || agentId.trim().length === 0) {
            throw new TowerProtocolError('agent_id is required — the engine agent id from your Agent tool');
          }
          const entry = await store.updateRosterAgentId(name, agentId, {
            ...(argString(args, 'mission_id') !== undefined ? { missionId: argString(args, 'mission_id')! } : {}),
            ...(argString(args, 'review_target') !== undefined ? { reviewTarget: argString(args, 'review_target')! } : {}),
            ...(argString(args, 'worktree') !== undefined ? { worktree: argString(args, 'worktree')! } : {}),
            ...(argString(args, 'branch') !== undefined ? { branch: argString(args, 'branch')! } : {}),
          });
          // B2 identity ①②③ — persist verified/verifiedAt/failedCount (lazy
          // re-verify trigger: an overwrite is allowed, so re-running register
          // re-validates after the fold caught up).
          const towerAgentId =
            state.roster.agents.find((a) => a.name === TOWER_NAME)?.agentId ?? '';
          const outcome = await store.verifyAgentIdentity(
            name,
            foldView(controller.getFold()),
            towerAgentId,
          );
          // B2-6: agentId lands in the roster + the guard mirror. A mirror
          // write failure is a RETRYABLE isError — the roster entry is already
          // recorded, re-running register retries the mirror write.
          const mirrorError = await syncMirrorOrRetry(store);
          if (mirrorError !== undefined) {
            return {
              output: `guard mirror write failed: ${mirrorError} — the roster entry IS recorded (agentId ${agentId}); re-run moa_tower_register to retry the mirror write`,
              isError: true,
            };
          }
          await store.appendLog('tower', 'register', { name, agent: agentId });
          return {
            registered: true,
            name: entry.name,
            agent_id: entry.agentId,
            kind: entry.kind,
            verified: outcome.entry.verified ?? false,
            failed_count: outcome.entry.failedCount ?? 0,
            blocked: (outcome.entry.failedCount ?? 0) >= IDENTITY_BLOCK_THRESHOLD,
            identity: outcome.verdict.reason,
            ...(entry.missionId !== undefined ? { mission_id: entry.missionId } : {}),
            ...(entry.reviewTarget !== undefined ? { review_target: entry.reviewTarget } : {}),
            guard_mirror: `${store.repoRoot}/.tower-guard.json`,
            next: 'The agent can now use the tower tools under its own identity.',
          };
        }),
    },
    {
      name: 'moa_tower_mission',
      description:
        'Read or patch a mission. With only an id, returns the rendered mission view. Patches go through the store: workers may only patch their own mission; ownership assignment and scope changes are tower-only (scope changes re-run the disjoint check and are logged); a blocker sets the mission blocked; task_done marks the first open task containing that text done.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          caller_agent_id: CALLER_ARG,
          id: { type: 'string', description: 'Mission id (e.g. "M1")' },
          status: { type: 'string', enum: ['planned', 'active', 'completed', 'blocked', 'paused', 'merged'], description: 'New lifecycle status' },
          note: { type: 'string', description: 'Append a decision-log note' },
          blocker: { type: 'string', description: 'Report a blocker (also sets status to blocked)' },
          clear_blockers: { type: 'boolean', description: 'Clear all recorded blockers' },
          task_done: { type: 'string', description: 'Mark the first open task containing this text as done' },
          scope: { type: 'array', items: { type: 'string' }, description: 'Tower only: replace the mission scope globs (picomatch — `**` crosses directories). Logged; widens what the merge gate accepts.' },
        },
        required: ['workspace', 'caller_agent_id', 'id'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store } = storeFor(controller, args);
          const state = await store.load();
          const caller = await resolveCaller(store, state, args);
          const id = argString(args, 'id');
          if (id === undefined || id.trim().length === 0) {
            throw new TowerProtocolError('mission id is required');
          }
          const hasPatch =
            argString(args, 'status') !== undefined ||
            argString(args, 'note') !== undefined ||
            argString(args, 'blocker') !== undefined ||
            args.clear_blockers !== undefined ||
            argString(args, 'task_done') !== undefined ||
            args.scope !== undefined;
          if (!hasPatch) {
            const missions = await store.loadMissions(state);
            const mission = missions.find((m) => m.id === id);
            if (mission === undefined) {
              throw new TowerProtocolError(
                `unknown mission "${id}" — known missions: ${state.missions.join(', ') || '(none planned yet)'}`,
              );
            }
            return { mission: id, view: store.missionView(mission) };
          }
          const scopeArg = args.scope;
          if (scopeArg !== undefined && (!Array.isArray(scopeArg) || !scopeArg.every((s) => typeof s === 'string'))) {
            throw new TowerProtocolError('scope must be a string array');
          }
          const mission = await store.updateMission(caller, id, {
            ...(argString(args, 'status') !== undefined
              ? { status: argString(args, 'status') as TowerMission['status'] }
              : {}),
            ...(argString(args, 'note') !== undefined ? { note: argString(args, 'note')! } : {}),
            ...(argString(args, 'blocker') !== undefined ? { blocker: argString(args, 'blocker')! } : {}),
            ...(args.clear_blockers !== undefined ? { clearBlockers: args.clear_blockers === true } : {}),
            ...(argString(args, 'task_done') !== undefined ? { taskDone: argString(args, 'task_done')! } : {}),
            ...(scopeArg !== undefined ? { scope: scopeArg as string[] } : {}),
          });
          return {
            updated: true,
            mission: mission.id,
            status: mission.status,
            open_tasks: mission.tasks.filter((t) => !t.done).length,
            blockers: mission.blockers.length,
            view: store.missionView(mission),
          };
        }),
    },
    {
      name: 'moa_tower_send',
      description:
        'Deliver an inbox message to a roster agent, the tower, or "all" (broadcast). Self-send is forbidden; the body is capped at 96KB (board ceiling) — split larger content into multiple messages. Returns the message board key.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          caller_agent_id: CALLER_ARG,
          to: { type: 'string', description: 'Recipient: a roster agent name, "tower", or "all" (broadcast)' },
          subject: { type: 'string', description: 'One-line subject; keep it greppable' },
          body: { type: 'string', description: 'Full message body (markdown), ≤ 96KB' },
          scope: { type: 'string', description: 'Optional scope tag (e.g. the mission id)' },
          action: { type: 'string', description: 'Optional action tag for machine routing' },
          consent_ref: { type: 'string', description: 'Optional reference to a consent/approval record this message relies on' },
        },
        required: ['workspace', 'caller_agent_id', 'to', 'subject', 'body'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store } = storeFor(controller, args);
          const state = await store.load();
          const caller = await resolveCaller(store, state, args);
          const to = argString(args, 'to');
          const subject = argString(args, 'subject');
          const body = argString(args, 'body');
          if (to === undefined || subject === undefined || body === undefined) {
            throw new TowerProtocolError('send requires to, subject and body');
          }
          const rel = await store.send(caller, {
            to,
            subject,
            body,
            ...(argString(args, 'scope') !== undefined ? { scope: argString(args, 'scope')! } : {}),
            ...(argString(args, 'action') !== undefined ? { action: argString(args, 'action')! } : {}),
            ...(argString(args, 'consent_ref') !== undefined ? { consentRef: argString(args, 'consent_ref')! } : {}),
          });
          return { sent: true, to, file: rel };
        }),
    },
    {
      name: 'moa_tower_inbox',
      description:
        'Read the caller\'s inbox (messages addressed to you or broadcast; the tower sees everything), newest first.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          caller_agent_id: CALLER_ARG,
          limit: { type: 'number', description: 'Max messages to return (default 20), newest first' },
        },
        required: ['workspace', 'caller_agent_id'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store } = storeFor(controller, args);
          const state = await store.load();
          const caller = await resolveCaller(store, state, args);
          const rawLimit = args.limit;
          const limit =
            typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
              ? Math.floor(rawLimit)
              : 20;
          const items = await store.readInbox(caller, limit);
          return {
            caller,
            count: items.length,
            messages: items.map((item) => ({
              file: item.file,
              from: item.from,
              to: item.to,
              subject: item.subject,
              sent_at: item.sentAt,
              ...(item.scope !== undefined ? { scope: item.scope } : {}),
              ...(item.action !== undefined ? { action: item.action } : {}),
              body: item.body,
            })),
          };
        }),
    },
    {
      name: 'moa_tower_finding',
      description:
        'File a structured finding (bug | improve | vuln | idea) for the tower to route. Workers use it for anything notable outside their mission scope instead of fixing it directly. The finding is stored under a random UUID key.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          caller_agent_id: CALLER_ARG,
          type: { type: 'string', enum: ['bug', 'improve', 'vuln', 'idea'], description: 'Finding category' },
          title: { type: 'string', description: 'Short finding title' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Optional severity (default medium)' },
          summary: { type: 'string', description: 'What was found, in a sentence or two' },
          location: { type: 'string', description: 'File/symbol the finding concerns' },
          details: { type: 'string', description: 'Full details: evidence, reproduction, impact' },
          suggested_fix: { type: 'string', description: 'What you would do about it' },
        },
        required: ['workspace', 'caller_agent_id', 'type', 'title', 'summary', 'details', 'suggested_fix'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store } = storeFor(controller, args);
          const state = await store.load();
          const caller = await resolveCaller(store, state, args);
          const type = argString(args, 'type');
          const title = argString(args, 'title');
          const summary = argString(args, 'summary');
          const details = argString(args, 'details');
          const suggestedFix = argString(args, 'suggested_fix');
          if (type === undefined || title === undefined || summary === undefined || details === undefined || suggestedFix === undefined) {
            throw new TowerProtocolError('finding requires type, title, summary, details and suggested_fix');
          }
          const rel = await store.fileFinding(caller, {
            type: type as TowerFindingType,
            title,
            ...(argString(args, 'severity') !== undefined ? { severity: argString(args, 'severity') as 'low' | 'medium' | 'high' | 'critical' } : {}),
            summary,
            ...(argString(args, 'location') !== undefined ? { location: argString(args, 'location')! } : {}),
            details,
            suggestedFix,
          });
          return { filed: true, file: rel, next: 'The tower will route it — do not fix out-of-scope issues yourself.' };
        }),
    },
    {
      name: 'moa_tower_review',
      description:
        'Submit a review verdict for an assigned branch (reviewers and the tower only). The store assigns the round (your history + 1) and stamps the branch tip — the tool resolves the tip itself via git rev-parse, never trusting a self-reported commit. Only a "clean" review of the exact current tip passes the merge gate.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          caller_agent_id: CALLER_ARG,
          target: { type: 'string', description: 'The branch you were assigned to review' },
          status: { type: 'string', pattern: '^(clean|p[12]-\\d+items)$', description: 'Verdict: "clean", or "p1-Nitems" / "p2-Nitems" with the number of findings at that priority' },
          merge: { type: 'string', enum: ['merge', 'fix-then-merge', 'hold'], description: 'Merge recommendation for the tower' },
          findings: { type: 'string', description: 'Full findings text (markdown); write "none" when clean' },
          checks: { type: 'array', items: { type: 'string' }, description: 'Checklist items you verified (e.g. "tests pass", "no secrets")' },
          decision: { type: 'string', description: 'The reasoning behind your verdict' },
        },
        required: ['workspace', 'caller_agent_id', 'target', 'status', 'merge', 'findings', 'decision'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store, repoRoot } = storeFor(controller, args);
          const state = await store.load();
          const caller = await resolveCaller(store, state, args);
          const target = argString(args, 'target');
          const status = argString(args, 'status');
          const merge = argString(args, 'merge');
          const findings = argString(args, 'findings');
          const decision = argString(args, 'decision');
          if (target === undefined || status === undefined || merge === undefined || findings === undefined || decision === undefined) {
            throw new TowerProtocolError('review requires target, status, merge, findings and decision');
          }
          // B1-6: reviewedCommit comes from the CONTROLLER running
          // `git rev-parse <branch>` — the LLM never self-reports it.
          const reviewedCommit = await git.branchTip(repoRoot, target);
          const rel = await store.submitReview(caller, {
            target,
            status,
            merge,
            findings,
            ...(Array.isArray(args.checks) ? { checks: args.checks as string[] } : {}),
            decision,
          }, reviewedCommit);
          return {
            submitted: true,
            file: rel,
            round: Number(rel.slice(rel.lastIndexOf('-r') + 2)),
            reviewed_commit: reviewedCommit,
            next: 'Also notify the branch author (or the tower) with moa_tower_send so the verdict is seen.',
          };
        }),
    },
    {
      name: 'moa_tower_merge',
      description:
        'Merge a mission branch into the base (tower-only). The hard gate runs in fixed order: branch belongs to a mission → dependencies merged → survey zero-diff noop → review exists → latest round fully clean (every reviewer of the highest round) → branch tip unchanged since the clean review → changed files inside the mission scope (picomatch) → CI green (only when a ci_command is configured on boot — requires a ci/<branchSlug> record with commit == current tip && exitCode == 0 && clean worktree; otherwise skipped) → git merge --no-ff → conflicts report. Every blocked step records a merge.blocked activity-log line.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          caller_agent_id: CALLER_ARG,
          branch: { type: 'string', description: 'The mission branch to merge into the base branch (e.g. "feat/M1-x")' },
        },
        required: ['workspace', 'caller_agent_id', 'branch'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store } = storeFor(controller, args);
          await requireTower(store, args);
          const branch = argString(args, 'branch');
          if (branch === undefined || branch.trim().length === 0) {
            throw new TowerProtocolError('merge needs the mission branch');
          }
          const { mergeCommit, conflictsWith, noop } = await store.merge(branch);
          if (noop === true) {
            return {
              merged: true,
              noop: true,
              branch,
              output: `${branch} is a read-only survey with a zero-diff branch — mission marked merged, no git merge needed.`,
            };
          }
          return {
            merged: true,
            branch,
            merge_commit: mergeCommit,
            conflicts_with: conflictsWith.map((c) => ({ branch: c.branch, files: [...c.files] })),
            next:
              conflictsWith.length > 0
                ? 'Unmerged branches changed the same files — tell each affected worker to rebase onto the updated base and request a re-review.'
                : 'Continue with the remaining missions in Dependency Flow order.',
          };
        }),
    },
    {
      name: 'moa_tower_teardown',
      description:
        'Tear the tower down (tower-only): remove mission worktrees (dirty ones are kept unless force), delete the guard mirror file, and clear the live tower namespace so a fresh boot is possible. The append-only board JSONL stays as the audit trail.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          caller_agent_id: CALLER_ARG,
          force: { type: 'boolean', description: 'Remove worktrees even when they contain uncommitted changes' },
        },
        required: ['workspace', 'caller_agent_id'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store } = storeFor(controller, args);
          await requireTower(store, args);
          const report = await store.teardown({ force: args.force === true });
          return {
            torn_down: true,
            report,
            next: 'The board JSONL keeps the full audit trail; boot again with moa_tower_boot when ready.',
          };
        }),
    },
    {
      name: 'moa_tower_status',
      description:
        'Shared tower dashboard: mission table, roster (with B2 identity verified/failed_count/blocked columns), per-branch review-gate state (highest review round/status and whether it still matches the branch tip), CI summary (configured + per-branch latest result), the caller\'s inbox count, and the recent activity log. Reading status also re-verifies every roster entry against the status fold (lazy re-verify, B2-9) and persists the verdicts.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          caller_agent_id: CALLER_ARG,
        },
        required: ['workspace', 'caller_agent_id'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store } = storeFor(controller, args);
          const state = await store.load();
          const caller = await resolveCaller(store, state, args);
          const missions = await store.loadMissions(state);
          // B2-9: lazy identity re-verification while reading status — persist
          // verdicts (the register re-run is the other trigger). Cheap: the
          // store skips the board write when nothing changed.
          const towerAgentId =
            state.roster.agents.find((a) => a.name === TOWER_NAME)?.agentId ?? '';
          const fold = foldView(controller.getFold());
          for (const agent of state.roster.agents) {
            await store.verifyAgentIdentity(agent.name, fold, towerAgentId);
          }
          const latest = await store.load();
          const reviewGate: Array<Record<string, unknown>> = [];
          for (const mission of missions.filter((m) => m.status !== 'merged')) {
            // Shared with the /api/tower/missions route (B4) — one
            // implementation, no drift between the tool and the panel.
            reviewGate.push(await store.reviewGateForMission(mission));
          }
          const inbox = await store.readInbox(caller, INBOX_COUNT_LIMIT);
          const log = await store.recentLog(RECENT_LOG_LINES);
          // B2 CI summary: configured flag + latest per-branch result.
          const repoDoc = await store.loadRepoDoc();
          const ciConfigured =
            repoDoc?.ciCommand !== undefined && repoDoc.ciCommand.trim().length > 0;
          const ciPerBranch: Record<string, { commit: string; exitCode: number | null; ranAt: string }> = {};
          for (const mission of missions) {
            const ci = await store.loadCiResult(mission.branch);
            if (ci !== undefined) {
              ciPerBranch[mission.branch] = { commit: ci.commit, exitCode: ci.exitCode, ranAt: ci.ranAt };
            }
          }
          return {
            caller,
            base: state.base,
            mode: state.mode,
            booted: true,
            missions: renderMissions(missions),
            roster: renderRoster(latest),
            review_gate: reviewGate,
            ci: { configured: ciConfigured, 'per-branch': ciPerBranch },
            inbox_count: inbox.length,
            recent_activity: [...log],
          };
        }),
    },
    {
      name: 'moa_tower_ci',
      description:
        'Run the configured CI command (boot ci_command) in the mission branch\'s worktree (tower-only). The run is serialized per tower process (single-tower single-session assumption — no cross-process mutex, 风险台账 11). A dirty worktree is intercepted BEFORE execution: the run errors asking for a commit first and records a dirty:true failed result. The outcome is stored under ci/<branchSlug> {commit (tip at run time), exitCode, dirty, logRef, ranAt}; the run log is truncated (last 200 lines, ≤64KB) and referenced by logRef. When a ci_command is configured, the merge gate requires a green (exitCode 0, clean, current tip) record before merging.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          caller_agent_id: CALLER_ARG,
          branch: { type: 'string', description: 'The mission branch to run CI against (e.g. "feat/M1-x")' },
        },
        required: ['workspace', 'caller_agent_id', 'branch'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store } = storeFor(controller, args);
          await requireTower(store, args);
          const branch = argString(args, 'branch');
          if (branch === undefined || branch.trim().length === 0) {
            throw new TowerProtocolError('moa_tower_ci needs the mission branch');
          }
          const repoDoc = await store.loadRepoDoc();
          const ciCommand = repoDoc?.ciCommand?.trim();
          if (ciCommand === undefined || ciCommand.length === 0) {
            return {
              output:
                'no ci_command configured — set one by re-booting: moa_tower_boot(workspace, tower_agent_id, ci_command="…")',
              isError: true,
            };
          }
          // In-process serial queue (controller seam): CI runs against the same
          // worktree can never overlap inside this process.
          const result = await controller.runCiSerial(() => store.runCi(branch, ciCommand));
          if (result.dirty) {
            // B2-3 dirty-tree interception: error + dirty flag; a dirty failed
            // record was already persisted (merge gate rejects it).
            return {
              output: `ci skipped: the worktree for ${branch} has uncommitted changes — commit them first and re-run moa_tower_ci (a dirty run is recorded as failed)`,
              isError: true,
              dirty: true,
              branch,
              commit: result.commit,
              ran_at: result.ranAt,
            };
          }
          return {
            ran: true,
            branch,
            commit: result.commit,
            exit_code: result.exitCode,
            dirty: false,
            log_ref: result.logRef ?? null,
            ...(result.logError !== undefined ? { log_error: result.logError } : {}),
            ran_at: result.ranAt,
            next:
              result.exitCode === 0
                ? 'CI green — the merge gate accepts this record while the branch tip stays put.'
                : 'CI failed — fix the failures, commit, and re-run moa_tower_ci.',
          };
        }),
    },
    {
      name: 'moa_tower_progress',
      description:
        'Post a progress note to a mission (the mission\'s owning worker or the tower only — row-11 ownership). Notes accumulate under the single LWW key progress/<missionId>; the value keeps the newest lines within the board ceiling (80KB headroom). Write frequency is the profile\'s cron discipline (B4) — keep notes sparse.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: WORKSPACE_ARG,
          caller_agent_id: CALLER_ARG,
          mission_id: { type: 'string', description: 'The mission id (e.g. "M1") you own' },
          note: { type: 'string', description: 'A short progress note (timestamped and attributed automatically)' },
        },
        required: ['workspace', 'caller_agent_id', 'mission_id', 'note'],
        additionalProperties: false,
      },
      handler: (args) =>
        runTool(async () => {
          const { store } = storeFor(controller, args);
          const state = await store.load();
          const caller = await resolveCaller(store, state, args);
          const missionId = argString(args, 'mission_id');
          const note = argString(args, 'note');
          if (missionId === undefined || missionId.trim().length === 0) {
            throw new TowerProtocolError('moa_tower_progress needs mission_id');
          }
          if (note === undefined || note.trim().length === 0) {
            throw new TowerProtocolError('moa_tower_progress needs a non-empty note');
          }
          const result = await store.updateProgress(caller, missionId, note);
          return {
            posted: true,
            mission: missionId,
            file: result.key,
            bytes: result.bytes,
          };
        }),
    },
  ];
}

// ---------------------------------------------------------------------------
// renderers (ported from official statusTool.ts, minus the rate limiter —
// moamcp has no spawn-concurrency limiter in B1)
// ---------------------------------------------------------------------------

function renderMissions(missions: readonly TowerMission[]): Array<Record<string, unknown>> {
  if (missions.length === 0) return [];
  return missions.map((m) => ({
    id: m.id,
    title: m.title,
    kind: m.kind,
    branch: m.branch,
    worktree: m.worktree,
    status: m.status,
    emoji: STATUS_EMOJI[m.status],
    owner: m.owner ?? null,
    scope: [...m.scope],
  }));
}

function renderRoster(state: TowerState): Array<Record<string, unknown>> {
  return state.roster.agents.map((a) => {
    // B4 masking (携带项 F1): the tower row's agentId is the tier-2 re-boot
    // channel key (B2R-2) — mask it wherever the roster is exposed (status
    // tool here, /api/tower/state in routes.ts; the panel consumes both).
    // Worker/reviewer rows keep their agentId.
    const isTower = a.kind === 'tower' || a.name === TOWER_NAME;
    return {
      name: a.name,
      kind: a.kind,
      ...(isTower ? {} : { agentId: a.agentId === '' ? null : a.agentId }),
      // B2 identity columns: verified / failed_count / blocked (derived from
      // consecutive hard mismatches — missing data never counts, decision 2).
      verified: a.verified ?? false,
      ...(a.verifiedAt !== undefined ? { verified_at: a.verifiedAt } : {}),
      failed_count: a.failedCount ?? 0,
      blocked: (a.failedCount ?? 0) >= IDENTITY_BLOCK_THRESHOLD,
      ...(a.missionId !== undefined ? { mission_id: a.missionId } : {}),
      ...(a.reviewTarget !== undefined ? { review_target: a.reviewTarget } : {}),
      ...(a.branch !== undefined ? { branch: a.branch } : {}),
      ...(a.worktree !== undefined ? { worktree: a.worktree } : {}),
    };
  });
}

/** Absolute worktree path for a slot (spawn output helper; 基准 decision 8 layout). */
function worktreePathOf(repoRoot: string, slot: string): string {
  return worktreePath(repoRoot, slot);
}
