/**
 * Workspace Control Plane HTTP API.
 *
 * The Bus remains the only HTTP listener. This module only translates the
 * browser's sidecar workspace id into a BoardStore workspace path and then
 * delegates all persistence and validation to BoardStore/TipStore.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isValidTaskId, type ArchiveIndexEntry } from './archive-index.js';
import {
  AgentConfigBusyError,
  AgentConfigConflictError,
  AgentConfigError,
  AgentConfigLayoutError,
  AgentConfigNotFoundError,
  AgentConfigUnsafePathError,
  AgentConfigValidationError,
  WorkspaceAgentConfigService,
  isKebabCaseName,
  type AgentSection,
  type BindingChange,
  type BindingPatch,
} from './agent-config.js';
import { BoardStore, type BoardEntry, type WorkspaceInfo } from './board.js';
import type { RunStatus, RunSummary } from './run-read-model.js';
import { CONTROL_PLANE_HTML } from './web/control-plane-page.js';
import {
  TipCorruptError,
  TipNotFoundError,
  TipStore,
  TipValidationError,
  isProjectTipStatus,
  type TipCreateInput,
  type TipListOptions,
  type TipUpdateInput,
} from './tips.js';

/** JSON request body cap for browser mutations. */
export const CONTROL_PLANE_BODY_MAX_BYTES = 64 * 1024;

const WORKSPACE_ID = /^[0-9a-f]{16}$/;

type JsonObject = Record<string, unknown>;

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
  if (error instanceof BoardConflictError || error instanceof AgentConfigConflictError || error instanceof AgentConfigBusyError) return 409;
  if (error instanceof AgentConfigUnsafePathError) return 403;
  if (error instanceof AgentConfigNotFoundError || error instanceof ResourceNotFoundError || error instanceof TipNotFoundError) return 404;
  if (error instanceof AgentConfigError) return error.status;
  if (error instanceof ApiValidationError || error instanceof TipValidationError) return 400;
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

function requireAgentName(value: string): string {
  let name: string;
  try {
    name = decodeURIComponent(value);
  } catch {
    throw new ApiValidationError('invalid agent name');
  }
  if (!isKebabCaseName(name)) throw new ApiValidationError('invalid agent name');
  return name;
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

/**
 * Route handler mounted by Bus. `false` means the path is not a Control Plane
 * route and lets the legacy Bus endpoints produce their normal 404 response.
 */
export class ControlPlane {
  private board?: BoardStore;
  private tips?: TipStore;
  private runtime?: RuntimeReadProvider;
  private agentConfig: WorkspaceAgentConfigService;

  constructor(board?: BoardStore, tips?: TipStore, agentConfig: WorkspaceAgentConfigService = new WorkspaceAgentConfigService()) {
    this.agentConfig = agentConfig;
    if (board !== undefined) this.mount(board, tips);
  }

  mount(board: BoardStore, tips: TipStore = new TipStore(board)): void {
    this.board = board;
    this.tips = tips;
  }

  mountRuntime(runtime: RuntimeReadProvider): void {
    this.runtime = runtime;
  }

  /** Test seam for the source-tree adapter; mounting itself performs no I/O. */
  mountAgentConfig(agentConfig: WorkspaceAgentConfigService): void {
    this.agentConfig = agentConfig;
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

    let route: ReturnType<ControlPlane['route']>;
    try {
      route = this.route(path);
    } catch (error) {
      sendCaughtError(res, error);
      return true;
    }
    if (route === undefined) return false;
    if (!route.methods.includes(req.method ?? '')) {
      methodNotAllowed(res, route.methods.join(', '));
      return true;
    }

    try {
      switch (route.name) {
        case 'workspaces':
          await this.workspaces(res);
          break;
        case 'tips':
          if (req.method === 'GET') await this.listTips(url, res);
          else await this.createTip(req, res, serverPort);
          break;
        case 'tip':
          if (req.method === 'GET') await this.readTip(route.id, url, res);
          else await this.updateTip(req, route.id, res, serverPort);
          break;
        case 'tip-archive':
          await this.archiveTip(req, route.id, res, serverPort);
          break;
        case 'board':
          if (req.method === 'GET') await this.readBoard(url, res);
          else await this.mutateBoard(req, res, serverPort);
          break;
        case 'agent-config':
          await this.readAgentConfig(url, res);
          break;
        case 'agent':
          if (req.method === 'GET') await this.readAgent(route.id, url, res);
          else if (req.method === 'PUT') await this.saveAgent(req, route.id, res, serverPort);
          else await this.deleteAgent(req, route.id, res, serverPort);
          break;
        case 'agent-bindings':
          await this.saveBindings(req, res, serverPort);
          break;
        case 'agent-local':
          if (req.method === 'GET') await this.readLocalToml(url, res);
          else await this.saveLocalToml(req, res, serverPort);
          break;
        case 'runs':
          this.listRuns(url, res);
          break;
        case 'run':
          this.readRun(route.id, res);
          break;
        case 'archives':
          await this.listArchives(res);
          break;
        case 'system':
          await this.system(res);
          break;
      }
    } catch (error) {
      sendCaughtError(res, error);
    }
    return true;
  }

  private route(path: string):
    | { name: 'workspaces'; methods: string[] }
    | { name: 'tips'; methods: string[] }
    | { name: 'tip'; methods: string[]; id: string }
    | { name: 'tip-archive'; methods: string[]; id: string }
    | { name: 'board'; methods: string[] }
    | { name: 'agent-config'; methods: string[] }
    | { name: 'agent'; methods: string[]; id: string }
    | { name: 'agent-bindings'; methods: string[] }
    | { name: 'agent-local'; methods: string[] }
    | { name: 'runs'; methods: string[] }
    | { name: 'run'; methods: string[]; id: string }
    | { name: 'archives'; methods: string[] }
    | { name: 'system'; methods: string[] }
    | undefined {
    if (path === '/api/workspaces') return { name: 'workspaces', methods: ['GET'] };
    if (path === '/api/tips') return { name: 'tips', methods: ['GET', 'POST'] };
    if (path === '/api/board') return { name: 'board', methods: ['GET', 'POST', 'DELETE'] };
    if (path === '/api/agent-config') return { name: 'agent-config', methods: ['GET'] };
    if (path === '/api/agent-config/bindings') return { name: 'agent-bindings', methods: ['PUT'] };
    if (path === '/api/agent-config/local-toml') return { name: 'agent-local', methods: ['GET', 'PUT'] };
    if (path === '/api/tasks') return { name: 'runs', methods: ['GET'] };

    const agentMatch = /^\/api\/agent-config\/agents\/(.*)$/.exec(path);
    if (agentMatch !== null) return { name: 'agent', methods: ['GET', 'PUT', 'DELETE'], id: requireAgentName(agentMatch[1]) };
    if (path === '/api/archives') return { name: 'archives', methods: ['GET'] };
    if (path === '/api/system') return { name: 'system', methods: ['GET'] };

    const runMatch = /^\/api\/tasks\/(.*)$/.exec(path);
    if (runMatch !== null) return { name: 'run', methods: ['GET'], id: requireTaskId(runMatch[1]) };

    const match = /^\/api\/tips\/([^/]+)(\/archive)?$/.exec(path);
    if (match === null) return undefined;
    const id = requireTipId(match[1]);
    if (match[2] === '/archive') return { name: 'tip-archive', methods: ['POST'], id };
    return { name: 'tip', methods: ['GET', 'PATCH'], id };
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

  private stores(): { board: BoardStore; tips: TipStore } {
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

  private async readAgentConfig(url: URL, res: ServerResponse): Promise<void> {
    if (url.searchParams.has('cwd') || url.searchParams.has('path')) {
      throw new ApiValidationError('cwd/path are not accepted by the Control Plane API');
    }
    const workspace = await this.resolveWorkspace(url.searchParams.get('workspace'));
    sendJson(res, 200, { workspace: workspace.id, ...(await this.agentConfig.inspect(workspace.cwd)) });
  }

  private async readAgent(name: string, url: URL, res: ServerResponse): Promise<void> {
    if (url.searchParams.has('cwd') || url.searchParams.has('path')) {
      throw new ApiValidationError('cwd/path are not accepted by the Control Plane API');
    }
    const workspace = await this.resolveWorkspace(url.searchParams.get('workspace'));
    sendJson(res, 200, { workspace: workspace.id, agent: await this.agentConfig.readAgent(workspace.cwd, name) });
  }

  private async saveAgent(req: IncomingMessage, name: string, res: ServerResponse, serverPort?: number): Promise<void> {
    const body = await readJsonBody(req, serverPort);
    rejectPathFields(body);
    assertAllowedFields(body, ['workspace', 'content', 'expectedHash'], 'agent');
    if (typeof body.content !== 'string') throw new ApiValidationError('content must be a Markdown string');
    const workspace = await this.resolveWorkspace(body.workspace);
    const result = await this.agentConfig.saveAgent(workspace.cwd, name, body.content, requireExpectedHash(body));
    sendJson(res, 200, { workspace: workspace.id, agent: result });
  }

  private async deleteAgent(req: IncomingMessage, name: string, res: ServerResponse, serverPort?: number): Promise<void> {
    const body = await readJsonBody(req, serverPort);
    rejectPathFields(body);
    assertAllowedFields(body, ['workspace', 'expectedHash'], 'agent');
    const workspace = await this.resolveWorkspace(body.workspace);
    sendJson(res, 200, { workspace: workspace.id, agent: await this.agentConfig.deleteAgent(workspace.cwd, name, requireExpectedHash(body)) });
  }

  private async saveBindings(req: IncomingMessage, res: ServerResponse, serverPort?: number): Promise<void> {
    const body = await readJsonBody(req, serverPort);
    rejectPathFields(body);
    assertAllowedFields(body, ['workspace', 'changes', 'expectedHash'], 'bindings');
    if (!Array.isArray(body.changes)) {
      throw new ApiValidationError('changes must be an array');
    }
    const workspace = await this.resolveWorkspace(body.workspace);
    const result = await this.agentConfig.saveBindings(
      workspace.cwd,
      body.changes as BindingChange[],
      requireExpectedHash(body),
    );
    sendJson(res, 200, {
      workspace: workspace.id,
      bindings: result,
      hash: result.hash,
      content: result.content,
    });
  }

  private async readLocalToml(url: URL, res: ServerResponse): Promise<void> {
    if (url.searchParams.has('cwd') || url.searchParams.has('path')) {
      throw new ApiValidationError('cwd/path are not accepted by the Control Plane API');
    }
    const workspace = await this.resolveWorkspace(url.searchParams.get('workspace'));
    sendJson(res, 200, { workspace: workspace.id, localToml: await this.agentConfig.readLocalToml(workspace.cwd) });
  }

  private async saveLocalToml(req: IncomingMessage, res: ServerResponse, serverPort?: number): Promise<void> {
    const body = await readJsonBody(req, serverPort);
    rejectPathFields(body);
    assertAllowedFields(body, ['workspace', 'content', 'expectedHash'], 'local.toml');
    if (typeof body.content !== 'string') throw new ApiValidationError('content must be a TOML string');
    const workspace = await this.resolveWorkspace(body.workspace);
    const result = await this.agentConfig.saveLocalToml(workspace.cwd, body.content, requireExpectedHash(body));
    sendJson(res, 200, { workspace: workspace.id, localToml: result });
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

  private async createTip(req: IncomingMessage, res: ServerResponse, serverPort?: number): Promise<void> {
    const { tips } = this.stores();
    const body = await readJsonBody(req, serverPort);
    rejectPathFields(body);
    const workspace = await this.resolveWorkspace(body.workspace);
    const { workspace: _workspace, ...input } = body;
    const tip = await tips.create(input as TipCreateInput, workspace.cwd);
    sendJson(res, 200, tip);
  }

  private async updateTip(req: IncomingMessage, id: string, res: ServerResponse, serverPort?: number): Promise<void> {
    const { tips } = this.stores();
    const body = await readJsonBody(req, serverPort);
    rejectPathFields(body);
    const workspace = await this.resolveWorkspace(body.workspace);
    const { workspace: _workspace, ...patch } = body;
    const tip = await tips.update(id, patch as TipUpdateInput, workspace.cwd);
    sendJson(res, 200, tip);
  }

  private async archiveTip(req: IncomingMessage, id: string, res: ServerResponse, serverPort?: number): Promise<void> {
    const { tips } = this.stores();
    const body = await readJsonBody(req, serverPort);
    rejectPathFields(body);
    const workspace = await this.resolveWorkspace(body.workspace);
    const actor = body.actor;
    if (actor !== undefined && actor !== null && typeof actor !== 'string') {
      throw new ApiValidationError('actor must be a string');
    }
    const tip = await tips.archive(id, workspace.cwd, actor as string | null | undefined);
    sendJson(res, 200, tip);
  }

  private async mutateBoard(req: IncomingMessage, res: ServerResponse, serverPort?: number): Promise<void> {
    const { board } = this.stores();
    const body = await readJsonBody(req, serverPort);
    rejectPathFields(body);

    const method = req.method as 'POST' | 'DELETE';
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
      sendJson(res, 200, { ok: true, entry: responseEntry });
    } else {
      sendJson(res, 200, { ok: true, ts: deletedTs });
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
