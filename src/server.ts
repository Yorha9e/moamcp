#!/usr/bin/env node
/**
 * moamcp — MCP server (stdio) exposing the mailbox debate hub.
 * Tool list per design doc §5.3: moa_init, moa_start_debate, moa_wait_turn,
 * moa_submit_turn, moa_complete.
 *
 * Uses the low-level Server with plain JSON Schemas so the only runtime
 * dependency is @modelcontextprotocol/sdk itself.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { DebateHub, type PresetConfig } from './state.js';
import { Bus } from './bus.js';

const TASK_ID = { type: 'string', description: 'MOA task id' } as const;
const AGENT_ID = { type: 'string', description: 'Debate agent id (must be in preset agents)' } as const;

const TOOLS = [
  {
    name: 'moa_init',
    description: 'Initialize task state: agent list + debate params from an inline preset config.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: TASK_ID,
        preset_config: {
          type: 'object',
          description: 'Inline preset: { agents: (string|{id,...})[], debate?: { rounds?: number } }',
        },
      },
      required: ['task_id', 'preset_config'],
    },
  },
  {
    name: 'moa_start_debate',
    description: 'Seed the debate state machine {turn:1, round:1, speaker: first agent} with reference results.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: TASK_ID,
        reference_results: { description: 'Reference Pool results, passed through to agents as context' },
      },
      required: ['task_id', 'reference_results'],
    },
  },
  {
    name: 'moa_wait_turn',
    description:
      'Long-poll until it is this agent\'s turn. Returns {speaker_id, round, prompt, full_context}, or ' +
      '{status:"debate_complete", transcript}, or {status:"timeout", retry:true} at the safety cap.',
    inputSchema: {
      type: 'object',
      properties: { task_id: TASK_ID, agent_id: AGENT_ID },
      required: ['task_id', 'agent_id'],
    },
  },
  {
    name: 'moa_submit_turn',
    description: 'Submit this agent\'s turn content. Validates turn order ({error:"not_your_turn"} otherwise), advances to the next speaker.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: TASK_ID,
        agent_id: AGENT_ID,
        content: { type: 'string', description: 'The agent\'s debate contribution for this turn' },
      },
      required: ['task_id', 'agent_id', 'content'],
    },
  },
  {
    name: 'moa_complete',
    description: 'Write the three-layer archive to ./logs/{task_id}/ (probe.json, events.jsonl, result.json), close the task, wake remaining waiters.',
    inputSchema: {
      type: 'object',
      properties: { task_id: TASK_ID },
      required: ['task_id'],
    },
  },
];

export function createServer(hub: DebateHub = new DebateHub()): Server {
  const server = new Server(
    { name: 'moamcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;
    let result: unknown;
    switch (name) {
      case 'moa_init':
        result = hub.init(a.task_id as string, a.preset_config as PresetConfig);
        break;
      case 'moa_start_debate':
        result = await hub.startDebate(a.task_id as string, a.reference_results);
        break;
      case 'moa_wait_turn':
        result = await hub.waitTurn(a.task_id as string, a.agent_id as string);
        break;
      case 'moa_submit_turn':
        result = await hub.submitTurn(a.task_id as string, a.agent_id as string, a.content as string);
        break;
      case 'moa_complete':
        result = await hub.complete(a.task_id as string);
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  return server;
}

async function main(): Promise<void> {
  const waitCap = Number(process.env.MOAMCP_WAIT_CAP_MS);
  // Bus: SSE channel + frontend card. Default port 8913, free-port fallback,
  // actual port written to {cwd}/bus.port (design doc §1.2/§1.3).
  const busPort = Number(process.env.MOAMCP_BUS_PORT);
  const logsDir = process.env.MOAMCP_LOGS_DIR ?? 'logs';
  const bus = new Bus({
    ...(Number.isFinite(busPort) && busPort > 0 ? { port: busPort } : {}),
    cwd: process.cwd(),
    logsDir,
  });
  const actualPort = await bus.start();
  const hub = new DebateHub({
    ...(Number.isFinite(waitCap) && waitCap > 0 ? { waitCapMs: waitCap } : {}),
    logsDir,
    emit: (taskId, event) => bus.publish(taskId, event),
  });
  const server = createServer(hub);
  await server.connect(new StdioServerTransport());
  console.error(`[moamcp] bus: http://127.0.0.1:${actualPort}/?task_id=<id> (port file: bus.port)`);
  // Best-effort bus.port cleanup. Note: Windows does not deliver SIGTERM to
  // Node processes, so when the host CLI kills us the file may survive —
  // harmless, since it is overwritten on every start.
  const { rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  process.on('exit', () => rmSync(join(process.cwd(), 'bus.port'), { force: true }));
  const shutdown = () => {
    void bus.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('moamcp server failed:', err);
    process.exit(1);
  });
}
