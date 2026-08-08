/**
 * Tower module — Control Plane routes `/api/tower/*` (panel data + future
 * reuse-proxy target). B1 ships the basic read faces over the shared board:
 *
 *   GET /api/tower/state?workspace=<abs repoRoot>
 *       → booted flag + state doc (base/mode/createdAt/roster/mission ids)
 *   GET /api/tower/missions?workspace=<abs repoRoot>
 *       → full mission documents in plan order, each carrying `ci` (latest
 *         ci/<branchSlug> result, or null) and `review_gate` (shared helper
 *         identical to the status tool's review_gate rows) — B4 panel faces
 *   GET /api/tower/log?workspace=<abs repoRoot>&lines=N
 *       → recent activity-log lines (default 100, capped 1000)
 *   GET /api/tower/findings?workspace=<abs repoRoot>
 *       → every filed finding, newest first (B4 panel face)
 *   GET /api/tower/reviews?workspace=<abs repoRoot>&branch=<branch>
 *       → all reviews for the target branch, round ascending (B4 panel face)
 *
 * Masking is uniform here: the tower row's agentId is hidden on every
 * roster-bearing endpoint (B4 携带项 F1 — the key is the B2R-2 re-boot
 * channel secret).
 *
 * The board is disk-backed under MOAMCP_HOME, so these reads work in both
 * own and reuse mode without proxying; a later batch can add a reuse proxy
 * to the owning Bus when panel data must include process-local state. The
 * workspace query parameter is REQUIRED — routes never fall back to the
 * server cwd (B1-1 scope anchoring).
 */
import type { MoaRouteDef, MoaRouteContext } from '../types.js';
import type { TowerController } from './controller.js';
import { TOWER_NAME } from './paths.js';
import { TowerProtocolError, TowerStore } from './store.js';

const LOG_LINES_DEFAULT = 100;
const LOG_LINES_MAX = 1000;

/** Extract + validate the required `workspace` query parameter. */
function requireWorkspaceParam(ctx: MoaRouteContext): string {
  const workspace = ctx.url.searchParams.get('workspace');
  if (workspace === null || workspace.trim().length === 0) {
    ctx.badRequest('tower routes require a ?workspace=<absolute repo root> query parameter');
  }
  return workspace as string;
}

/** 503 while the tower has no board mounted (mirrors /status's not-ready shape). */
function notReady(ctx: MoaRouteContext): void {
  ctx.res.setHeader('retry-after', '2');
  ctx.sendJson(503, { error: 'tower_not_ready', started: false });
}

export function towerRoutes(controller: TowerController | undefined): MoaRouteDef[] {
  const storeFor = (ctx: MoaRouteContext): TowerStore => {
    if (controller === undefined) {
      notReady(ctx);
      throw new Error('tower_not_ready'); // unreachable: notReady already sent
    }
    const board = controller.getBoard();
    if (board === undefined) {
      notReady(ctx);
      throw new Error('tower_not_ready');
    }
    return new TowerStore(requireWorkspaceParam(ctx), board);
  };

  const readState = async (ctx: MoaRouteContext): Promise<void> => {
    const store = storeFor(ctx);
    try {
      const state = await store.load();
      const repo = await store.loadRepoDoc();
      ctx.sendJson(200, {
        booted: true,
        base: state.base,
        mode: state.mode,
        createdAt: state.createdAt,
        worktreesRoot: repo?.worktreesRoot ?? null,
        roster: state.roster.agents.map((a) => {
          // B4 masking (携带项 F1): the tower row's agentId is the tier-2
          // re-boot channel key (B2R-2) — masked here and in the status tool's
          // renderRoster; worker/reviewer rows keep their agentId.
          const isTower = a.kind === 'tower' || a.name === TOWER_NAME;
          return {
            name: a.name,
            ...(isTower ? {} : { agentId: a.agentId === '' ? null : a.agentId }),
            kind: a.kind,
            verified: a.verified ?? false,
            ...(a.verifiedAt !== undefined ? { verifiedAt: a.verifiedAt } : {}),
            failedCount: a.failedCount ?? 0,
            // B2: blocked is derived from consecutive hard mismatches (缺失≠不匹配).
            blocked: (a.failedCount ?? 0) >= 3,
            ...(a.missionId !== undefined ? { missionId: a.missionId } : {}),
            ...(a.reviewTarget !== undefined ? { reviewTarget: a.reviewTarget } : {}),
            ...(a.worktree !== undefined ? { worktree: a.worktree } : {}),
            ...(a.branch !== undefined ? { branch: a.branch } : {}),
          };
        }),
        missions: state.missions,
      });
    } catch (error) {
      if (error instanceof TowerProtocolError) {
        ctx.sendJson(200, { booted: false, error: error.message });
        return;
      }
      throw error;
    }
  };

  const readMissions = async (ctx: MoaRouteContext): Promise<void> => {
    const store = storeFor(ctx);
    try {
      const state = await store.load();
      const missions = await store.loadMissions(state);
      const rows = [];
      for (const m of missions) {
        // B4 (面板数据缺口): per-mission CI badge data (latest ci/<branchSlug>
        // result, same read the status tool's summary uses) + the review-gate
        // summary (shared helper — identical to the status tool's review_gate).
        const ci = await store.loadCiResult(m.branch);
        rows.push({
          id: m.id,
          title: m.title,
          kind: m.kind,
          scope: [...m.scope],
          branch: m.branch,
          worktree: m.worktree,
          deps: [...m.deps],
          status: m.status,
          owner: m.owner ?? null,
          tasks: m.tasks.map((t) => ({ text: t.text, done: t.done })),
          notes: [...m.notes],
          blockers: [...m.blockers],
          ci:
            ci === undefined
              ? null
              : { commit: ci.commit, exitCode: ci.exitCode, ranAt: ci.ranAt },
          review_gate: await store.reviewGateForMission(m),
        });
      }
      ctx.sendJson(200, { booted: true, missions: rows });
    } catch (error) {
      if (error instanceof TowerProtocolError) {
        ctx.sendJson(200, { booted: false, error: error.message });
        return;
      }
      throw error;
    }
  };

  const readLog = async (ctx: MoaRouteContext): Promise<void> => {
    const store = storeFor(ctx);
    const rawLines = Number(ctx.url.searchParams.get('lines') ?? LOG_LINES_DEFAULT);
    const lines = Number.isFinite(rawLines) && rawLines > 0 ? Math.min(Math.floor(rawLines), LOG_LINES_MAX) : LOG_LINES_DEFAULT;
    try {
      await store.load(); // booted check
      const log = await store.recentLog(lines);
      ctx.sendJson(200, { booted: true, lines: [...log] });
    } catch (error) {
      if (error instanceof TowerProtocolError) {
        ctx.sendJson(200, { booted: false, error: error.message });
        return;
      }
      throw error;
    }
  };

  // B4 (面板数据缺口): findings + reviews faces for the tower panel.
  const readFindings = async (ctx: MoaRouteContext): Promise<void> => {
    const store = storeFor(ctx);
    try {
      await store.load(); // booted check
      const findings = await store.listFindings();
      ctx.sendJson(200, { booted: true, findings });
    } catch (error) {
      if (error instanceof TowerProtocolError) {
        ctx.sendJson(200, { booted: false, error: error.message });
        return;
      }
      throw error;
    }
  };

  const readReviews = async (ctx: MoaRouteContext): Promise<void> => {
    const store = storeFor(ctx);
    const branch = ctx.url.searchParams.get('branch');
    if (branch === null || branch.trim().length === 0) {
      ctx.badRequest('tower reviews require a ?branch=<target branch> query parameter');
    }
    try {
      await store.load(); // booted check
      const reviews = await store.reviewsFor(branch as string);
      ctx.sendJson(200, { booted: true, branch: branch as string, reviews });
    } catch (error) {
      if (error instanceof TowerProtocolError) {
        ctx.sendJson(200, { booted: false, error: error.message });
        return;
      }
      throw error;
    }
  };

  return [
    { method: 'GET', path: '/api/tower/state', handler: (ctx) => readState(ctx) },
    { method: 'GET', path: '/api/tower/missions', handler: (ctx) => readMissions(ctx) },
    { method: 'GET', path: '/api/tower/log', handler: (ctx) => readLog(ctx) },
    { method: 'GET', path: '/api/tower/findings', handler: (ctx) => readFindings(ctx) },
    { method: 'GET', path: '/api/tower/reviews', handler: (ctx) => readReviews(ctx) },
  ];
}
