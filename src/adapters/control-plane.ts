/**
 * Workspace Control Plane HTTP adapter.
 *
 * The Bus remains the only HTTP listener. Routes are aggregated from product
 * modules (agent-config) plus adapter-level endpoints (workspaces, tips/board
 * API, runs/archives/system); the adapter owns transport policy — body
 * parsing, origin checks, status-code mapping — and forwards everything else
 * to module route handlers, which delegate to BoardStore/TipStore and the
 * agent-config service. This module only translates the browser's sidecar
 * workspace id into a BoardStore workspace path.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { isValidTaskId, type ArchiveIndexEntry } from '../core/store/archive-index.js';
import {
  AgentConfigBusyError,
  AgentConfigConflictError,
  AgentConfigError,
  AgentConfigNotFoundError,
  AgentConfigUnsafePathError,
  WorkspaceAgentConfigService,
} from '../modules/agentconfig/agent-config.js';
import { createAgentConfigModule } from '../modules/agentconfig/index.js';
import { BoardStore, type BoardEntry, type WorkspaceInfo } from '../core/store/board.js';
import { migrateWorkspaceToProject } from '../core/store/project-migration.js';
import { PROJECT_ID_PATTERN } from '../core/store/project-registry.js';
import type { RunStatus, RunSummary } from '../core/store/run-read-model.js';
import type { TipsAuthority } from '../core/store/tips-authority.js';
import type { JsonObject, MoaModule, MoaRouteContext, MoaRouteDef } from '../modules/types.js';
import { CONTROL_PLANE_HTML } from '../web/control-plane-page.js';
import {
  HANDOFF_ID_PATTERN,
  HANDOFF_STATES,
  HandoffNotFoundError,
  HandoffStateError,
  HandoffStore,
  HandoffValidationError,
  type HandoffListOptions,
  type HandoffState,
} from '../modules/handoff/handoff.js';
import {
  TipCorruptError,
  TipNotFoundError,
  TipStore,
  TipValidationError,
  isProjectTipStatus,
  type TipCreateInput,
  type TipListOptions,
  type TipUpdateInput,
} from '../modules/tips/tips.js';

/** JSON request body cap for browser mutations. */
export const CONTROL_PLANE_BODY_MAX_BYTES = 64 * 1024;

const WORKSPACE_ID = /^[0-9a-f]{16}$/;

type ResolvedWorkspace = { id: string; cwd: string };

export interface RuntimeSystemInfo {
  process: {
    pid: number;
    instanceId: string | null;
    version: string;
    startedAt: string;
    uptimeSeconds: number;
  };
  bus: { requestedPort: number; actualPort: number; mode: string };
  registry: {
    /** Registry rows describe live Bus HTTP listeners, not MCP/Kimi processes. */
    listenerEntries: readonly Record<string, unknown>[];
  };
  runs: { total: number; live: number; recent: number; recentWindowSeconds: number };
  sse: { channelCount: number; subscriberCount: number };
  archives: { available: boolean; count: number | null };
  reuseWatch: { intervalMs: number; timeoutMs: number; failThreshold: number };
}

/** Narrow read-only seam mounted by Bus; no DebateHub or mutable Bus surface leaks through it. */
export interface RuntimeReadProvider {
  listRuns(): readonly RunSummary[];
  readRun(taskId: string): RunSummary | undefined;
  cardUrl(taskId: string): string;
  listArchives(): Promise<readonly ArchiveIndexEntry[]>;
  systemInfo(): Promise<RuntimeSystemInfo>;
}

const RUN_STATUSES = new Set<RunStatus>(['initialized', 'debating', 'complete', 'closed']);

class ApiValidationError extends Error {
  readonly status = 400;
}

class UnsupportedMediaTypeError extends Error {
  readonly status = 415;
}

class ForbiddenError extends Error {
  readonly status = 403;
}

class PayloadTooLargeError extends Error {
  readonly status = 413;
}

class ResourceNotFoundError extends Error {
  readonly status = 404;
}

class ControlPlaneUnavailableError extends Error {
  readonly status = 503;
}

class BoardConflictError extends Error {
  readonly status = 409;

  constructor(message: string, readonly currentTs?: string) {
    super(message);
  }
}

/** Path matched but the method has no route; `allow` carries the 405 Allow header value. */
class MethodNotAllowedError extends Error {
  constructor(readonly allow: string) {
    super('method not allowed');
  }
}

export function checkContentType(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string') return false;
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

export function checkOrigin(req: IncomingMessage, serverPort?: number): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (!origin || origin === 'null') return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:') return false;
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return false;
    const hostHeader = req.headers.host;
    if (hostHeader) {
      if (url.host !== hostHeader) return false;
    } else if (serverPort !== undefined) {
      if (url.port !== String(serverPort) && !(url.port === '' && serverPort === 80)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function sendCaughtError(res: ServerResponse, error: unknown): void {
  if (error instanceof BoardConflictError) {
    sendJson(res, 409, {
      error: error.message,
      ...(error.currentTs === undefined ? {} : { currentTs: error.currentTs }),
    });
    return;
  }
  if (error instanceof AgentConfigConflictError) {
    sendJson(res, 409, { error: error.message, currentHash: error.currentHash });
    return;
  }
  sendError(res, errorStatus(error), errorMessage(error));
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, {
    allow,
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify({ error: 'method not allowed' }));
}

function errorStatus(error: unknown): number {
  if (error instanceof UnsupportedMediaTypeError) return 415;
  if (error instanceof ForbiddenError) return 403;
  if (error instanceof BoardConflictError || error instanceof AgentConfigConflictError || error instanceof AgentConfigBusyError || error instanceof HandoffStateError) return 409;
  if (error instanceof AgentConfigUnsafePathError) return 403;
  if (error instanceof AgentConfigNotFoundError || error instanceof ResourceNotFoundError || error instanceof TipNotFoundError || error instanceof HandoffNotFoundError) return 404;
  if (error instanceof AgentConfigError) return error.status;
  if (error instanceof ApiValidationError || error instanceof TipValidationError || error instanceof HandoffValidationError) return 400;
  if (error instanceof PayloadTooLargeError) return 413;
  if (error instanceof ControlPlaneUnavailableError) return 503;
  // BoardStore deliberately uses plain Error for its low-level input guards.
  if (error instanceof Error && /^(key|value|tags?|author|limit|scope|workspace)\b/i.test(error.message)) return 400;
  return 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'request failed';
}

function assertObject(value: unknown, message = 'body must be a JSON object'): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiValidationError(message);
  }
  return value as JsonObject;
}

function rejectPathFields(body: JsonObject): void {
  // A browser can only select a sidecar id. In particular, never accept a
  // cwd/path escape hatch alongside the id-shaped workspace field.
  if ('cwd' in body || 'path' in body) {
    throw new ApiValidationError('cwd/path are not accepted by the Control Plane API');
  }
}

function requireWorkspaceId(value: unknown): string {
  if (typeof value !== 'string' || !WORKSPACE_ID.test(value)) {
    throw new ApiValidationError('workspace must be a 16-character workspace sidecar id');
  }
  return value;
}

function requireTipId(value: string): string {
  let id: string;
  try {
    id = decodeURIComponent(value);
  } catch {
    throw new ApiValidationError('invalid tip id');
  }
  if (id.length === 0 || id.includes('/') || id === '.' || id === '..') {
    throw new ApiValidationError('invalid tip id');
  }
  return id;
}

function requireTaskId(value: string): string {
  let id: string;
  try {
    id = decodeURIComponent(value);
  } catch {
    throw new ApiValidationError('invalid task id');
  }
  if (!isValidTaskId(id)) throw new ApiValidationError('invalid task id');
  return id;
}

function requireHandoffId(value: string): string {
  let id: string;
  try {
    id = decodeURIComponent(value);
  } catch {
    throw new ApiValidationError('invalid handoff id');
  }
  if (!HANDOFF_ID_PATTERN.test(id)) throw new ApiValidationError('invalid handoff id (expected ho_<12 hex chars>)');
  return id;
}

/** Parse `state=pending,consumed` into the store's state filter; empty/absent yields undefined. */
function parseHandoffStates(value: string | null): HandoffState[] | undefined {
  if (value === null || value === '') return undefined;
  const parts = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;
  for (const part of parts) {
    if (!HANDOFF_STATES.includes(part as HandoffState)) {
      throw new ApiValidationError('state must be pending, consumed, or archived (comma-separated)');
    }
  }
  return parts as HandoffState[];
}

function parseLimit(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  if (!/^\d+$/.test(value)) throw new ApiValidationError('limit must be a positive integer');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new ApiValidationError('limit must be a positive integer');
  return limit;
}

function parseBoolean(value: string | null, field: string): boolean | undefined {
  if (value === null || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ApiValidationError(`${field} must be true or false`);
}

function queryText(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

function requireExpectedHash(body: JsonObject): string | null {
  if (!Object.prototype.hasOwnProperty.call(body, 'expectedHash')) {
    throw new ApiValidationError('expectedHash is required for configuration mutations');
  }
  const value = body.expectedHash;
  if (value !== null && typeof value !== 'string') throw new ApiValidationError('expectedHash must be a string or null');
  return value as string | null;
}

function assertAllowedFields(body: JsonObject, allowed: readonly string[], label: string): void {
  for (const field of Object.keys(body)) {
    if (!allowed.includes(field)) throw new ApiValidationError(`unsupported ${label} field: ${field}`);
  }
}

async function readJsonBody(req: IncomingMessage, serverPort?: number): Promise<JsonObject> {
  if (!checkContentType(req)) {
    req.resume();
    throw new UnsupportedMediaTypeError('content-type must be application/json');
  }
  if (!checkOrigin(req, serverPort)) {
    req.resume();
    throw new ForbiddenError('forbidden origin');
  }

  const length = req.headers['content-length'];
  if (typeof length === 'string' && /^\d+$/.test(length) && Number(length) > CONTROL_PLANE_BODY_MAX_BYTES) {
    req.resume();
    throw new PayloadTooLargeError(`request body exceeds ${CONTROL_PLANE_BODY_MAX_BYTES} bytes`);
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += part.byteLength;
    if (bytes > CONTROL_PLANE_BODY_MAX_BYTES) {
      req.resume();
      throw new PayloadTooLargeError(`request body exceeds ${CONTROL_PLANE_BODY_MAX_BYTES} bytes`);
    }
    chunks.push(part);
  }
  if (chunks.length === 0) throw new ApiValidationError('JSON body required');

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiValidationError('body must be valid JSON');
  }
  return assertObject(parsed);
}

function workspaceActivity(info: WorkspaceInfo): number {
  const timestamp = info.updatedAt ?? info.createdAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function publicWorkspace(info: WorkspaceInfo): Record<string, unknown> {
  return {
    id: info.id,
    cwd: info.cwd,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt ?? null,
  };
}

/** Stable URL used by `moa_status` and the frontend's navigation. */
export function controlPlaneUrl(port: number): string {
  return `http://127.0.0.1:${port}/control-plane`;
}

interface PatternRouteGroup {
  pattern: RegExp;
  validateParam?: (rawParam: string) => string;
  defs: MoaRouteDef[];
}

interface ResolvedRoute {
  def: MoaRouteDef;
  param: string | undefined;
}

/**
 * Route handler mounted by Bus. `false` means the path is not a Control Plane
 * route and lets the legacy Bus endpoints produce their normal 404 response.
 * Routes are aggregated from product modules plus adapter-level endpoints;
 * dispatch is a plain table lookup, and handlers do the forwarding.
 */
export class ControlPlane {
  private board?: BoardStore;
  private tips?: TipsAuthority;
  private runtime?: RuntimeReadProvider;
  private agentConfig: WorkspaceAgentConfigService;
  private exactRoutes = new Map<string, MoaRouteDef[]>();
  private patternRoutes: PatternRouteGroup[] = [];

  constructor(board?: BoardStore, tips?: TipsAuthority, agentConfig: WorkspaceAgentConfigService = new WorkspaceAgentConfigService()) {
    this.agentConfig = agentConfig;
    this.registerRoutes();
    if (board !== undefined) this.mount(board, tips);
  }

  mount(board: BoardStore, tips: TipsAuthority = new TipStore(board)): void {
    this.board = board;
    this.tips = tips;
  }

  mountRuntime(runtime: RuntimeReadProvider): void {
    this.runtime = runtime;
  }

  /** Test seam for the source-tree adapter; mounting itself performs no I/O. */
  mountAgentConfig(agentConfig: WorkspaceAgentConfigService): void {
    this.agentConfig = agentConfig;
    this.registerRoutes();
  }

  /** Aggregate module routes and adapter-level routes into the dispatch tables. */
  private registerRoutes(): void {
    const modules: MoaModule[] = [createAgentConfigModule(this.agentConfig)];
    const routes: MoaRouteDef[] = [
      ...modules.flatMap((module) => module.routes ?? []),
      ...this.adapterRoutes(),
    ];
    this.exactRoutes = new Map();
    this.patternRoutes = [];
    for (const def of routes) {
      if (def.pattern === undefined) {
        const group = this.exactRoutes.get(def.path);
        if (group === undefined) this.exactRoutes.set(def.path, [def]);
        else group.push(def);
      } else {
        const group = this.patternRoutes.find((candidate) => candidate.pattern.source === (def.pattern as RegExp).source);
        if (group === undefined) {
          this.patternRoutes.push({ pattern: def.pattern, validateParam: def.validateParam, defs: [def] });
        } else {
          group.defs.push(def);
        }
      }
    }
  }

  /** Adapter-level endpoints: workspaces, tips/board API, runs/archives/system. */
  private adapterRoutes(): MoaRouteDef[] {
    return [
      { method: 'GET', path: '/api/workspaces', handler: (ctx) => this.workspaces(ctx.res) },
      { method: 'GET', path: '/api/tips', handler: (ctx) => this.listTips(ctx.url, ctx.res) },
      { method: 'POST', path: '/api/tips', handler: (ctx) => this.createTip(ctx) },
      { method: 'GET', path: '/api/board', handler: (ctx) => this.readBoard(ctx.url, ctx.res) },
      { method: 'POST', path: '/api/board', handler: (ctx) => this.mutateBoard(ctx) },
      { method: 'DELETE', path: '/api/board', handler: (ctx) => this.mutateBoard(ctx) },
      { method: 'GET', path: '/api/tasks', handler: (ctx) => this.listRuns(ctx.url, ctx.res) },
      { method: 'GET', path: '/api/archives', handler: (ctx) => this.listArchives(ctx.res) },
      { method: 'GET', path: '/api/system', handler: (ctx) => this.system(ctx.res) },
      { method: 'GET', path: '/api/projects', handler: (ctx) => this.listProjects(ctx.res) },
      { method: 'POST', path: '/api/projects/migrate', handler: (ctx) => this.migrateProject(ctx) },
      { method: 'GET', path: '/api/handoff/inbox', handler: (ctx) => this.handoffInbox(ctx.url, ctx.res) },
      { method: 'GET', path: '/api/handoff/outbox', handler: (ctx) => this.handoffOutbox(ctx.url, ctx.res) },
      {
        method: 'POST',
        path: '/api/handoff/:id/consume',
        pattern: /^\/api\/handoff\/([^/]+)\/consume$/,
        validateParam: requireHandoffId,
        handler: (ctx) => this.handoffTransition(ctx, ctx.param as string, 'consume'),
      },
      {
        method: 'POST',
        path: '/api/handoff/:id/archive',
        pattern: /^\/api\/handoff\/([^/]+)\/archive$/,
        validateParam: requireHandoffId,
        handler: (ctx) => this.handoffTransition(ctx, ctx.param as string, 'archive'),
      },
      {
        method: 'GET',
        path: '/api/tasks/:id',
        pattern: /^\/api\/tasks\/(.*)$/,
        validateParam: requireTaskId,
        handler: (ctx) => this.readRun(ctx.param as string, ctx.res),
      },
      {
        method: 'GET',
        path: '/api/tips/:id',
        pattern: /^\/api\/tips\/([^/]+)$/,
        validateParam: requireTipId,
        handler: (ctx) => this.readTip(ctx.param as string, ctx.url, ctx.res),
      },
      {
        method: 'PATCH',
        path: '/api/tips/:id',
        pattern: /^\/api\/tips\/([^/]+)$/,
        validateParam: requireTipId,
        handler: (ctx) => this.updateTip(ctx, ctx.param as string),
      },
      {
        method: 'POST',
        path: '/api/tips/:id/archive',
        pattern: /^\/api\/tips\/([^/]+)\/archive$/,
        validateParam: requireTipId,
        handler: (ctx) => this.archiveTip(ctx, ctx.param as string),
      },
    ];
  }

  async handle(req: IncomingMessage, res: ServerResponse, serverPort?: number): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (path === '/control-plane') {
      if (req.method !== 'GET') {
        methodNotAllowed(res, 'GET');
        return true;
      }
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      });
      res.end(CONTROL_PLANE_HTML);
      return true;
    }

    let route: ResolvedRoute | undefined;
    try {
      route = this.resolveRoute(path, req.method ?? '');
    } catch (error) {
      if (error instanceof MethodNotAllowedError) {
        methodNotAllowed(res, error.allow);
      } else {
        sendCaughtError(res, error);
      }
      return true;
    }
    if (route === undefined) return false;

    const ctx = this.createContext(req, res, url, serverPort, route.param);
    try {
      await route.def.handler(ctx);
    } catch (error) {
      sendCaughtError(res, error);
    }
    return true;
  }

  /**
   * Match a request path + method against the aggregated route tables. Exact
   * paths win over pattern routes; parameter validation runs before method
   * matching (an invalid path parameter is a 400 even for unsupported
   * methods). Throws MethodNotAllowedError when the path exists for other
   * methods; returns undefined for non-Control-Plane paths.
   */
  private resolveRoute(path: string, method: string): ResolvedRoute | undefined {
    const exact = this.exactRoutes.get(path);
    if (exact !== undefined) {
      const hit = exact.find((def) => def.method === method);
      if (hit !== undefined) return { def: hit, param: undefined };
      throw new MethodNotAllowedError(exact.map((def) => def.method).join(', '));
    }
    for (const group of this.patternRoutes) {
      const match = group.pattern.exec(path);
      if (match === null) continue;
      let param: string | undefined;
      if (group.validateParam !== undefined) {
        try {
          param = group.validateParam(match[1]);
        } catch (error) {
          throw new ApiValidationError(errorMessage(error));
        }
      } else {
        param = match[1];
      }
      const hit = group.defs.find((def) => def.method === method);
      if (hit !== undefined) return { def: hit, param };
      throw new MethodNotAllowedError(group.defs.map((def) => def.method).join(', '));
    }
    return undefined;
  }

  private createContext(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    serverPort: number | undefined,
    param: string | undefined,
  ): MoaRouteContext {
    return {
      req,
      res,
      url,
      serverPort,
      param,
      jsonBody: () => readJsonBody(req, serverPort),
      resolveWorkspace: (id) => this.resolveWorkspace(id),
      sendJson: (status, body) => sendJson(res, status, body),
      badRequest: (message): never => {
        throw new ApiValidationError(message);
      },
      rejectPathFields,
      assertAllowedFields,
      requireExpectedHash,
    };
  }

  private runtimeProvider(): RuntimeReadProvider {
    if (this.runtime === undefined) throw new ControlPlaneUnavailableError('runtime provider is not wired');
    return this.runtime;
  }

  private listRuns(url: URL, res: ServerResponse): void {
    const rawStatus = queryText(url.searchParams.get('status'));
    if (rawStatus !== undefined && !RUN_STATUSES.has(rawStatus as RunStatus)) {
      throw new ApiValidationError('status must be initialized, debating, complete, or closed');
    }
    const query = queryText(url.searchParams.get('query'))?.toLocaleLowerCase();
    const tasks = this.runtimeProvider().listRuns().filter((task) => {
      if (rawStatus !== undefined && task.status !== rawStatus) return false;
      if (query === undefined) return true;
      return task.taskId.toLocaleLowerCase().includes(query)
        || task.agentSpecs.some((agent) => agent.id.toLocaleLowerCase().includes(query)
          || agent.binding_slot?.toLocaleLowerCase().includes(query));
    });
    sendJson(res, 200, { tasks });
  }

  private readRun(taskId: string, res: ServerResponse): void {
    const runtime = this.runtimeProvider();
    const task = runtime.readRun(taskId);
    if (task === undefined) throw new ResourceNotFoundError('task not found');
    sendJson(res, 200, { task, cardUrl: runtime.cardUrl(taskId) });
  }

  private async listArchives(res: ServerResponse): Promise<void> {
    try {
      sendJson(res, 200, { archives: await this.runtimeProvider().listArchives() });
    } catch {
      throw new ControlPlaneUnavailableError('archive index is unavailable');
    }
  }

  private async system(res: ServerResponse): Promise<void> {
    sendJson(res, 200, await this.runtimeProvider().systemInfo());
  }

  private stores(): { board: BoardStore; tips: TipsAuthority } {
    if (this.board === undefined || this.tips === undefined) {
      throw new ControlPlaneUnavailableError('Control Plane stores are not wired');
    }
    return { board: this.board, tips: this.tips };
  }

  private async resolveWorkspace(id: unknown): Promise<ResolvedWorkspace> {
    const workspaceId = requireWorkspaceId(id);
    const cwd = await this.stores().board.resolveWorkspace(workspaceId);
    if (cwd === undefined) throw new ResourceNotFoundError('workspace not found');
    return { id: workspaceId, cwd };
  }

  private async workspaces(res: ServerResponse): Promise<void> {
    const { board } = this.stores();
    const rows = await board.listWorkspaces();
    rows.sort((a, b) => workspaceActivity(b) - workspaceActivity(a) || b.createdAt.localeCompare(a.createdAt));
    sendJson(res, 200, { workspaces: rows.map(publicWorkspace) });
  }

  private async listTips(url: URL, res: ServerResponse): Promise<void> {
    const { tips } = this.stores();
    const workspace = await this.resolveWorkspace(url.searchParams.get('workspace'));
    const rawStatus = queryText(url.searchParams.get('status'));
    if (rawStatus !== undefined && !isProjectTipStatus(rawStatus)) {
      throw new ApiValidationError('status is not a supported Project Tip status');
    }
    const options: TipListOptions = {
      ...(rawStatus === undefined ? {} : { status: rawStatus }),
      ...(queryText(url.searchParams.get('module')) === undefined ? {} : { module: queryText(url.searchParams.get('module')) }),
      ...(queryText(url.searchParams.get('tag')) === undefined ? {} : { tag: queryText(url.searchParams.get('tag')) }),
      ...(parseBoolean(url.searchParams.get('includeArchived'), 'includeArchived') === undefined
        ? {}
        : { includeArchived: parseBoolean(url.searchParams.get('includeArchived'), 'includeArchived') }),
      ...(parseLimit(url.searchParams.get('limit')) === undefined ? {} : { limit: parseLimit(url.searchParams.get('limit')) }),
    };
    const rows = await tips.list(options, workspace.cwd);
    sendJson(res, 200, { workspace: workspace.id, tips: rows });
  }

  private async readTip(id: string, url: URL, res: ServerResponse): Promise<void> {
    const { tips } = this.stores();
    const workspace = await this.resolveWorkspace(url.searchParams.get('workspace'));
    const tip = await tips.read(id, workspace.cwd);
    if (tip === undefined) throw new TipNotFoundError(id);
    sendJson(res, 200, tip);
  }

  private async createTip(ctx: MoaRouteContext): Promise<void> {
    const { tips } = this.stores();
    const body = await ctx.jsonBody();
    rejectPathFields(body);
    const workspace = await this.resolveWorkspace(body.workspace);
    const { workspace: _workspace, ...input } = body;
    const tip = await tips.create(input as TipCreateInput, workspace.cwd);
    ctx.sendJson(200, tip);
  }

  private async updateTip(ctx: MoaRouteContext, id: string): Promise<void> {
    const { tips } = this.stores();
    const body = await ctx.jsonBody();
    rejectPathFields(body);
    const workspace = await this.resolveWorkspace(body.workspace);
    const { workspace: _workspace, ...patch } = body;
    const tip = await tips.update(id, patch as TipUpdateInput, workspace.cwd);
    ctx.sendJson(200, tip);
  }

  private async archiveTip(ctx: MoaRouteContext, id: string): Promise<void> {
    const { tips } = this.stores();
    const body = await ctx.jsonBody();
    rejectPathFields(body);
    const workspace = await this.resolveWorkspace(body.workspace);
    const actor = body.actor;
    if (actor !== undefined && actor !== null && typeof actor !== 'string') {
      throw new ApiValidationError('actor must be a string');
    }
    const tip = await tips.archive(id, workspace.cwd, actor as string | null | undefined);
    ctx.sendJson(200, tip);
  }

  // ---- projects + handoff (mailbox task 4) ----

  /** HandoffStore is a stateless typed view over the mounted BoardStore. */
  private handoffStore(): HandoffStore {
    return new HandoffStore(this.stores().board);
  }

  private async listProjects(res: ServerResponse): Promise<void> {
    const projects = await this.stores().board.registry.listProjects();
    sendJson(res, 200, { projects });
  }

  private async migrateProject(ctx: MoaRouteContext): Promise<void> {
    const body = await ctx.jsonBody();
    rejectPathFields(body);
    ctx.assertAllowedFields(body, ['workspace', 'projectId', 'name'], 'migration');
    const workspace = await this.resolveWorkspace(body.workspace);
    const projectId = body.projectId;
    if (projectId !== undefined && (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId))) {
      throw new ApiValidationError('projectId must be a p_<12 hex chars> project id');
    }
    const name = body.name;
    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
      throw new ApiValidationError('name must be a non-empty string');
    }
    const homeDir = dirname(this.stores().board.boardsDir());
    const result = await migrateWorkspaceToProject(workspace.cwd, {
      homeDir,
      // Reuse the mounted registry so its in-process projection sees the alias
      // immediately (migration writes the same registry.jsonl either way).
      registry: this.stores().board.registry,
      ...(projectId === undefined ? {} : { projectId: projectId as string }),
      ...(name === undefined ? {} : { name: name as string }),
    });
    ctx.sendJson(200, result);
  }

  private async handoffInbox(url: URL, res: ServerResponse): Promise<void> {
    const workspace = await this.resolveWorkspace(url.searchParams.get('workspace'));
    const states = parseHandoffStates(url.searchParams.get('state'));
    const limit = parseLimit(url.searchParams.get('limit'));
    const options: HandoffListOptions = {
      ...(states === undefined ? {} : { state: states }),
      ...(limit === undefined ? {} : { limit }),
    };
    const rows = await this.handoffStore().inbox(workspace.cwd, options);
    sendJson(res, 200, { workspace: workspace.id, handoffs: rows });
  }

  private async handoffOutbox(url: URL, res: ServerResponse): Promise<void> {
    const workspace = await this.resolveWorkspace(url.searchParams.get('workspace'));
    const states = parseHandoffStates(url.searchParams.get('state'));
    const limit = parseLimit(url.searchParams.get('limit'));
    const options: HandoffListOptions = {
      ...(states === undefined ? {} : { state: states }),
      ...(limit === undefined ? {} : { limit }),
    };
    const rows = await this.handoffStore().outbox(workspace.cwd, options);
    sendJson(res, 200, { workspace: workspace.id, handoffs: rows });
  }

  private async handoffTransition(ctx: MoaRouteContext, id: string, action: 'consume' | 'archive'): Promise<void> {
    const body = await ctx.jsonBody();
    rejectPathFields(body);
    ctx.assertAllowedFields(body, ['workspace', 'actor'], 'handoff transition');
    const workspace = await this.resolveWorkspace(body.workspace);
    const actor = body.actor;
    if (actor !== undefined && actor !== null && typeof actor !== 'string') {
      throw new ApiValidationError('actor must be a string');
    }
    const store = this.handoffStore();
    const handoff = action === 'consume'
      ? await store.consume(id, workspace.cwd, actor as string | null | undefined)
      : await store.archive(id, workspace.cwd, actor as string | null | undefined);
    ctx.sendJson(200, handoff);
  }

  private async mutateBoard(ctx: MoaRouteContext): Promise<void> {
    const { board } = this.stores();
    const body = await ctx.jsonBody();
    rejectPathFields(body);

    const method = ctx.req.method as 'POST' | 'DELETE';
    const allowed = new Set(['scope', 'workspace', 'key', 'tags', 'author', 'expectedTs', ...(method === 'POST' ? ['value'] : [])]);
    for (const field of Object.keys(body)) {
      if (!allowed.has(field)) throw new ApiValidationError(`unsupported board field: ${field}`);
    }
    if (body.scope !== 'workspace' && body.scope !== 'global') {
      throw new ApiValidationError('scope must be workspace or global');
    }
    if (typeof body.key !== 'string') throw new ApiValidationError('key must be a string');
    if (method === 'POST' && typeof body.value !== 'string') {
      throw new ApiValidationError('value must be a string (markdown)');
    }
    if (body.tags !== undefined && (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === 'string'))) {
      throw new ApiValidationError('tags must be a string array');
    }
    if (body.author !== undefined && typeof body.author !== 'string') {
      throw new ApiValidationError('author must be a string');
    }
    if (body.expectedTs !== undefined && body.expectedTs !== null && typeof body.expectedTs !== 'string') {
      throw new ApiValidationError('expectedTs must be a string or null');
    }

    let workspaceId: string | undefined;
    let cwd: string | undefined;
    if (body.scope === 'workspace' || body.workspace !== undefined) {
      const workspace = await this.resolveWorkspace(body.workspace);
      workspaceId = workspace.id;
      cwd = workspace.cwd;
    }

    const expectedTs = body.expectedTs as string | null | undefined;
    let responseEntry: BoardEntry | undefined;
    let deletedTs: string | null = null;

    // Best-effort concurrency control: compare and update share one in-process
    // scope queue transaction. BoardStore's persistent JSONL is shared across
    // processes, so this intentionally does not promise cross-process CAS.
    await board.mutate(body.key, body.scope, (current, commitTs) => {
      if (expectedTs === null && current !== undefined) {
        throw new BoardConflictError('board entry already exists', current.ts);
      }
      if (typeof expectedTs === 'string' && current?.ts !== expectedTs) {
        throw new BoardConflictError('board entry timestamp conflict', current?.ts);
      }

      if (method === 'DELETE') {
        // A missing unconstrained (or expected-null) delete is an explicit,
        // successful no-op. Existing entries return null so mutate appends the
        // normal BoardStore tombstone and emits board_updated.
        deletedTs = current === undefined ? null : commitTs;
        return null;
      }

      const author = body.author === undefined
        ? (current !== undefined ? current.author : 'anonymous')
        : (body.author === '' ? 'anonymous' : (body.author as string));

      const tags = body.tags === undefined
        ? (current !== undefined ? [...current.tags] : [])
        : [...(body.tags as string[])];

      responseEntry = {
        key: body.key as string,
        value: body.value as string,
        author,
        ts: commitTs,
        tags,
      };
      return responseEntry;
    }, cwd);

    if (method === 'POST') {
      ctx.sendJson(200, { ok: true, entry: responseEntry });
    } else {
      ctx.sendJson(200, { ok: true, ts: deletedTs });
    }
  }

  private async readBoard(url: URL, res: ServerResponse): Promise<void> {
    const { board } = this.stores();
    if (url.searchParams.has('cwd') || url.searchParams.has('path')) {
      throw new ApiValidationError('cwd/path are not accepted by the Control Plane API');
    }
    const rawScope = url.searchParams.get('scope') ?? 'workspace';
    if (rawScope !== 'workspace' && rawScope !== 'global') {
      throw new ApiValidationError('scope must be workspace or global');
    }
    const workspaceId = queryText(url.searchParams.get('workspace'));
    let cwd: string | undefined;
    if (rawScope === 'workspace' || workspaceId !== undefined) {
      const workspace = await this.resolveWorkspace(workspaceId);
      cwd = workspace.cwd;
    }
    const key = queryText(url.searchParams.get('key'));
    const tag = queryText(url.searchParams.get('tag'));
    const limit = parseLimit(url.searchParams.get('limit'));
    const entries = key !== undefined
      ? await board.readNamespace(key, tag, rawScope, limit, cwd)
      : await board.read(undefined, tag, rawScope, limit, cwd);
    const enrichedEntries = entries.map((entry) => ({
      ...entry,
      bytes: Buffer.byteLength(entry.value, 'utf8'),
    }));
    sendJson(res, 200, {
      scope: rawScope,
      ...(workspaceId === undefined ? {} : { workspace: workspaceId }),
      entries: enrichedEntries,
    });
  }
}

// Keep these types visible to declaration consumers without duplicating the
// underlying Tip schema in the HTTP layer.
export type { TipCreateInput, TipUpdateInput };
export { TipCorruptError };
