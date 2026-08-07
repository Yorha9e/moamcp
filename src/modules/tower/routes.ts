/**
 * Tower module — Control Plane routes `/api/tower/*` (panel data + future
 * reuse-proxy target). B1 ships the basic read faces over the shared board:
 *
 *   GET /api/tower/state?workspace=<abs repoRoot>
 *       → booted flag + state doc (base/mode/createdAt/roster/mission ids)
 *   GET /api/tower/missions?workspace=<abs repoRoot>
 *       → full mission documents in plan order
 *   GET /api/tower/log?workspace=<abs repoRoot>&lines=N
 *       → recent activity-log lines (default 100, capped 1000)
 *
 * The board is disk-backed under MOAMCP_HOME, so these reads work in both
 * own and reuse mode without proxying; a later batch can add a reuse proxy
 * to the owning Bus when panel data must include process-local state. The
 * workspace query parameter is REQUIRED — routes never fall back to the
 * server cwd (B1-1 scope anchoring).
 */
import type { MoaRouteDef, MoaRouteContext } from '../types.js';
import type { TowerController } from './controller.js';
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
        roster: state.roster.agents.map((a) => ({
          name: a.name,
          agentId: a.agentId === '' ? null : a.agentId,
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
        })),
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
      ctx.sendJson(200, {
        booted: true,
        missions: missions.map((m) => ({
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
        })),
      });
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

  return [
    { method: 'GET', path: '/api/tower/state', handler: (ctx) => readState(ctx) },
    { method: 'GET', path: '/api/tower/missions', handler: (ctx) => readMissions(ctx) },
    { method: 'GET', path: '/api/tower/log', handler: (ctx) => readLog(ctx) },
  ];
}
