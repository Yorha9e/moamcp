/**
 * Agent-config module: the /api/agent-config* HTTP routes over
 * WorkspaceAgentConfigService. Handlers orchestrate the module service
 * through the adapter-provided route context; all transport policy
 * (body parsing, origin checks, status mapping) stays in the HTTP adapter.
 */
import type { MoaModule, MoaRouteContext, MoaRouteDef } from '../types.js';
import { WorkspaceAgentConfigService, isKebabCaseName, type BindingChange } from './agent-config.js';

/** Decode + validate the agents/:name path capture (adapter maps throws to 400). */
function requireAgentName(rawParam: string): string {
  let name: string;
  try {
    name = decodeURIComponent(rawParam);
  } catch {
    throw new Error('invalid agent name');
  }
  if (!isKebabCaseName(name)) throw new Error('invalid agent name');
  return name;
}

function rejectCwdPathQueries(ctx: MoaRouteContext): void {
  if (ctx.url.searchParams.has('cwd') || ctx.url.searchParams.has('path')) {
    throw ctx.badRequest('cwd/path are not accepted by the Control Plane API');
  }
}

async function readAgentConfig(agentConfig: WorkspaceAgentConfigService, ctx: MoaRouteContext): Promise<void> {
  rejectCwdPathQueries(ctx);
  const workspace = await ctx.resolveWorkspace(ctx.url.searchParams.get('workspace'));
  ctx.sendJson(200, { workspace: workspace.id, ...(await agentConfig.inspect(workspace.cwd)) });
}

async function readAgent(agentConfig: WorkspaceAgentConfigService, ctx: MoaRouteContext): Promise<void> {
  rejectCwdPathQueries(ctx);
  const workspace = await ctx.resolveWorkspace(ctx.url.searchParams.get('workspace'));
  ctx.sendJson(200, { workspace: workspace.id, agent: await agentConfig.readAgent(workspace.cwd, ctx.param as string) });
}

async function saveAgent(agentConfig: WorkspaceAgentConfigService, ctx: MoaRouteContext): Promise<void> {
  const body = await ctx.jsonBody();
  ctx.rejectPathFields(body);
  ctx.assertAllowedFields(body, ['workspace', 'content', 'expectedHash'], 'agent');
  if (typeof body.content !== 'string') throw ctx.badRequest('content must be a Markdown string');
  const workspace = await ctx.resolveWorkspace(body.workspace);
  const result = await agentConfig.saveAgent(workspace.cwd, ctx.param as string, body.content, ctx.requireExpectedHash(body));
  ctx.sendJson(200, { workspace: workspace.id, agent: result });
}

async function deleteAgent(agentConfig: WorkspaceAgentConfigService, ctx: MoaRouteContext): Promise<void> {
  const body = await ctx.jsonBody();
  ctx.rejectPathFields(body);
  ctx.assertAllowedFields(body, ['workspace', 'expectedHash'], 'agent');
  const workspace = await ctx.resolveWorkspace(body.workspace);
  ctx.sendJson(200, { workspace: workspace.id, agent: await agentConfig.deleteAgent(workspace.cwd, ctx.param as string, ctx.requireExpectedHash(body)) });
}

async function saveBindings(agentConfig: WorkspaceAgentConfigService, ctx: MoaRouteContext): Promise<void> {
  const body = await ctx.jsonBody();
  ctx.rejectPathFields(body);
  ctx.assertAllowedFields(body, ['workspace', 'changes', 'expectedHash'], 'bindings');
  if (!Array.isArray(body.changes)) {
    throw ctx.badRequest('changes must be an array');
  }
  const workspace = await ctx.resolveWorkspace(body.workspace);
  const result = await agentConfig.saveBindings(
    workspace.cwd,
    body.changes as BindingChange[],
    ctx.requireExpectedHash(body),
  );
  ctx.sendJson(200, {
    workspace: workspace.id,
    bindings: result,
    hash: result.hash,
    content: result.content,
  });
}

async function readLocalToml(agentConfig: WorkspaceAgentConfigService, ctx: MoaRouteContext): Promise<void> {
  rejectCwdPathQueries(ctx);
  const workspace = await ctx.resolveWorkspace(ctx.url.searchParams.get('workspace'));
  ctx.sendJson(200, { workspace: workspace.id, localToml: await agentConfig.readLocalToml(workspace.cwd) });
}

async function saveLocalToml(agentConfig: WorkspaceAgentConfigService, ctx: MoaRouteContext): Promise<void> {
  const body = await ctx.jsonBody();
  ctx.rejectPathFields(body);
  ctx.assertAllowedFields(body, ['workspace', 'content', 'expectedHash'], 'local.toml');
  if (typeof body.content !== 'string') throw ctx.badRequest('content must be a TOML string');
  const workspace = await ctx.resolveWorkspace(body.workspace);
  const result = await agentConfig.saveLocalToml(workspace.cwd, body.content, ctx.requireExpectedHash(body));
  ctx.sendJson(200, { workspace: workspace.id, localToml: result });
}

const AGENT_PATH = '/api/agent-config/agents/:name';
const AGENT_PATTERN = /^\/api\/agent-config\/agents\/(.*)$/;

export function agentConfigRoutes(agentConfig: WorkspaceAgentConfigService): MoaRouteDef[] {
  return [
    {
      method: 'GET',
      path: '/api/agent-config',
      handler: (ctx) => readAgentConfig(agentConfig, ctx),
    },
    {
      method: 'PUT',
      path: '/api/agent-config/bindings',
      handler: (ctx) => saveBindings(agentConfig, ctx),
    },
    {
      method: 'GET',
      path: '/api/agent-config/local-toml',
      handler: (ctx) => readLocalToml(agentConfig, ctx),
    },
    {
      method: 'PUT',
      path: '/api/agent-config/local-toml',
      handler: (ctx) => saveLocalToml(agentConfig, ctx),
    },
    {
      method: 'GET',
      path: AGENT_PATH,
      pattern: AGENT_PATTERN,
      validateParam: requireAgentName,
      handler: (ctx) => readAgent(agentConfig, ctx),
    },
    {
      method: 'PUT',
      path: AGENT_PATH,
      pattern: AGENT_PATTERN,
      validateParam: requireAgentName,
      handler: (ctx) => saveAgent(agentConfig, ctx),
    },
    {
      method: 'DELETE',
      path: AGENT_PATH,
      pattern: AGENT_PATTERN,
      validateParam: requireAgentName,
      handler: (ctx) => deleteAgent(agentConfig, ctx),
    },
  ];
}

export function createAgentConfigModule(
  agentConfig: WorkspaceAgentConfigService = new WorkspaceAgentConfigService(),
): MoaModule {
  return {
    id: 'agentconfig',
    tier: 'stable',
    routes: agentConfigRoutes(agentConfig),
  };
}
