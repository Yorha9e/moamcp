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
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { DebateHub, defaultLogsDir, type DomainEvent, type PresetConfig } from './state.js';
import { Bus } from './bus.js';

/** Best-effort forward timeout for reuse-mode publishes (design §3.3: no retries). */
const REUSE_PUBLISH_TIMEOUT_MS = 2000;

/** Debate-card URL for a task; task_id is percent-encoded so it cannot break the query string. */
export function cardUrl(port: number, taskId: string): string {
  return `http://127.0.0.1:${port}/?task_id=${encodeURIComponent(taskId)}`;
}

/**
 * Reuse-mode event sink (design §3.3): forward each domain event to the Bus
 * that owns the port via `POST /publish`. Strictly one-way best-effort — a
 * timeout, network failure, or non-200 response logs a warning and drops the
 * event; it never blocks or retries the MCP call chain. Dropped events are
 * covered by the two fallbacks: the owning Bus's SSE replay buffer (last 200
 * frames per task) and the shared archive root.
 */
function reusePublishForwarder(port: number): (taskId: string, event: DomainEvent) => void {
  return (taskId, event) => {
    const body = JSON.stringify({ task_id: taskId, event });
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/publish',
        timeout: REUSE_PUBLISH_TIMEOUT_MS,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume(); // drain; we only care about the status
        if (res.statusCode !== 200) {
          console.warn(`[moamcp] reuse publish dropped: HTTP ${res.statusCode} (task=${taskId}, type=${event.type})`);
        }
      },
    );
    // A timeout destroys the request, which surfaces through 'error' — one warn path.
    req.on('timeout', () => req.destroy(new Error(`publish timeout after ${REUSE_PUBLISH_TIMEOUT_MS}ms`)));
    req.on('error', (err) => {
      console.warn(`[moamcp] reuse publish dropped: ${err.message} (task=${taskId}, type=${event.type})`);
    });
    req.end(body);
  };
}

const TASK_ID = { type: 'string', description: 'MOA task id' } as const;
const AGENT_ID = { type: 'string', description: 'Debate agent id (must be in preset agents)' } as const;

const TOOLS = [
  {
    name: 'moa_init',
    description: 'Initialize task state: agent list + debate params from an inline preset config. Returns {ok, card_url, agents} where agents is the dispatch map [{id, binding_slot?}] - use binding_slot to dispatch each debater with the correct model.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: TASK_ID,
        preset_config: {
          type: 'object',
          description: 'Inline preset: { agents: (string|{id, binding_slot?, ...})[], debate?: { rounds?: number } }',
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
    description: 'Write the three-layer archive to <logsDir>/{task_id}/ (probe.json, events.jsonl, result.json; logsDir defaults to ~/.moamcp/logs, MOAMCP_LOGS_DIR overrides), close the task, wake remaining waiters.',
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
  // Bus: SSE channel + frontend card. Port rules per the port-discovery design
  // (§3.2/§3.3): register → bind 8913 (MOAMCP_BUS_PORT overrides) → a live
  // moamcp holding the port means reuse mode (no listener in this process);
  // anything else walks port+1 up to the cap.
  const busPort = Number(process.env.MOAMCP_BUS_PORT);
  // Fixed archive root shared by all instances (reuse mode's /archive depends
  // on it): MOAMCP_LOGS_DIR or <MOAMCP_HOME|~/.moamcp>/logs (design §3.1).
  const logsDir = defaultLogsDir();
  const bus = new Bus({
    ...(Number.isFinite(busPort) && busPort > 0 ? { port: busPort } : {}),
    cwd: process.cwd(),
    logsDir,
  });
  let actualPort: number;
  try {
    actualPort = await bus.start();
  } catch (err) {
    // Port walk exhausted (or another bind failure): bus.start() has already
    // released the registry entry; close whatever partially started, then exit
    // loudly — never leave a half-initialized server behind (design §3.2/§4).
    await bus.stop().catch(() => {});
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error('[moamcp] no free Bus port: port+1 walk exhausted, giving up');
    }
    throw err;
  }
  const startResult = bus.startResult;
  // own: fan events out on this process's Bus. reuse: forward them to the Bus
  // that owns the port — best-effort, never blocks the MCP call chain (§3.3).
  // Either way the card points at startResult.port (the owning Bus).
  const emit =
    startResult.mode === 'own'
      ? (taskId: string, event: DomainEvent) => bus.publish(taskId, event)
      : reusePublishForwarder(startResult.port);
  const hub = new DebateHub({
    ...(Number.isFinite(waitCap) && waitCap > 0 ? { waitCapMs: waitCap } : {}),
    logsDir,
    emit,
    cardUrlFactory: (taskId) => cardUrl(startResult.port, taskId),
  });
  const server = createServer(hub);
  await server.connect(new StdioServerTransport());
  if (startResult.mode === 'reuse') {
    console.error(
      `[moamcp] reuse: forwarding events to existing Bus at http://127.0.0.1:${actualPort}/ (this process does not listen)`,
    );
  } else {
    console.error(`[moamcp] bus: http://127.0.0.1:${actualPort}/?task_id=<id> (port file: bus.port)`);
  }
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
