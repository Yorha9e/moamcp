/**
 * MCP adapter: aggregates the modules' tool definitions into one MCP server
 * over the low-level Server + plain JSON Schemas (the only runtime dependency
 * stays @modelcontextprotocol/sdk itself). The adapter translates MCP request
 * envelopes only — every handler delegates straight to a module tool.
 *
 * moa_status is assembly-level status summary (Bus + process), so it is owned
 * here rather than by a product module.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Bus } from '../core/bus/bus.js';
import { VERSION } from '../core/bus/registry.js';
import { BoardStore } from '../core/store/board.js';
import { DebateHub } from '../modules/debate/state.js';
import { createBoardModule } from '../modules/board/index.js';
import { createDebateModule } from '../modules/debate/index.js';
import { createHandoffModule } from '../modules/handoff/index.js';
import { HandoffStore } from '../modules/handoff/handoff.js';
import { createTipsModule } from '../modules/tips/index.js';
import type { MoaModule, MoaToolDef } from '../modules/types.js';
import { TipStore } from '../modules/tips/tips.js';
import { controlPlaneUrl } from './control-plane.js';

/** Assembly-level status tool: Bus port/mode, live tasks, control-plane URL, process info. */
function statusTool(bus?: Bus): MoaToolDef {
  return {
    name: 'moa_status',
    description: 'Get the current Bus status: port, mode (own/reuse), active tasks, process info. Use this to discover the Bus port for the debate card URL.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: () => ({
      bus: bus ? { port: bus.actualPort, mode: bus.mode } : undefined,
      tasks: (bus?.activeTasks() ?? []).filter((taskId) => !taskId.startsWith('@')),
      control_plane_url: bus ? controlPlaneUrl(bus.actualPort) : undefined,
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
    }),
  };
}

export function createServer(
  hub: DebateHub = new DebateHub(),
  bus?: Bus,
  board?: BoardStore,
  tipStore?: TipStore,
  statusModule?: MoaModule,
): Server {
  const boardStore = board ?? new BoardStore();
  const tips = tipStore ?? new TipStore(boardStore);
  const handoffs = new HandoffStore(boardStore);
  bus?.mountControlPlane(boardStore, tips);
  const modules: MoaModule[] = [
    createDebateModule(hub),
    createBoardModule(boardStore),
    createTipsModule(tips),
    createHandoffModule(handoffs, boardStore),
  ];
  if (statusModule) modules.push(statusModule); // appended last (status module, batch 1a)
  const tools: MoaToolDef[] = [
    ...modules.flatMap((module) => module.tools ?? []),
    statusTool(bus),
  ];
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server(
    { name: 'moamcp', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolByName.get(name);
    if (tool === undefined) throw new Error(`unknown tool: ${name}`);
    const result = await tool.handler((args ?? {}) as Record<string, unknown>);
    // JSON has no undefined value; expose an absent optional result as null over MCP.
    return { content: [{ type: 'text', text: JSON.stringify(result === undefined ? null : result) }] };
  });

  return server;
}
