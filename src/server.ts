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
import { controlPlaneUrl } from './control-plane.js';
import { BoardStore } from './board.js';
import { PROJECT_TIP_STATUSES, TipStore, type TipCreateInput, type TipUpdateInput } from './tips.js';

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
const BOARD_SCOPE = {
  type: 'string',
  description:
    'Board scope: "workspace" (default — persisted, shared by all sessions of this project), ' +
    '"global" (persisted, cross-project), or "task:<task_id>" (debate-local, archived with the task).',
} as const;
const BOARD_AUTHOR = {
  type: 'string',
  description: 'Who writes this entry (default "anonymous"). Subagents should pass their own agent id.',
} as const;
const BOARD_WORKSPACE = {
  type: 'string',
  description: 'Optional absolute project path for workspace scope; omitted keeps the server workspaceCwd default.',
} as const;

const TIP_STATUS = { type: 'string', enum: [...PROJECT_TIP_STATUSES] } as const;
const TIP_WORKSPACE = {
  type: 'string',
  description: 'Absolute project path. Tips never infer a workspace from the MCP process cwd.',
} as const;
const TIP_DOCUMENT_REF = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    section: { type: 'string' },
    note: { type: 'string' },
    contentHash: { type: 'string' },
  },
  required: ['path'],
  additionalProperties: false,
} as const;
const TIP_DOCUMENT_REFS = { type: 'array', items: TIP_DOCUMENT_REF } as const;
const TIP_STRING_ARRAY = { type: 'array', items: { type: 'string' } } as const;
const TIP_CREATE_PROPERTIES = {
  workspace: TIP_WORKSPACE,
  title: { type: 'string' },
  summary: { type: 'string' },
  status: TIP_STATUS,
  context: { type: 'string' },
  module: { type: 'string' },
  tags: TIP_STRING_ARRAY,
  nextAction: { type: 'string' },
  documentRefs: TIP_DOCUMENT_REFS,
  sourceRefs: TIP_STRING_ARRAY,
  relatedTipIds: TIP_STRING_ARRAY,
  relatedProjects: TIP_STRING_ARRAY,
  sourceSessionId: { type: 'string' },
  author: { type: 'string' },
} as const;
const TIP_UPDATE_PROPERTIES = {
  workspace: TIP_WORKSPACE,
  id: { type: 'string' },
  title: { type: 'string' },
  summary: { type: 'string' },
  status: TIP_STATUS,
  context: { type: ['string', 'null'] },
  module: { type: ['string', 'null'] },
  tags: { type: ['array', 'null'], items: { type: 'string' } },
  nextAction: { type: ['string', 'null'] },
  documentRefs: { type: ['array', 'null'], items: TIP_DOCUMENT_REF },
  sourceRefs: { type: ['array', 'null'], items: { type: 'string' } },
  relatedTipIds: { type: ['array', 'null'], items: { type: 'string' } },
  relatedProjects: { type: ['array', 'null'], items: { type: 'string' } },
  sourceSessionId: { type: ['string', 'null'] },
  actor: { type: 'string' },
} as const;

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
    description:
      'Submit this agent\'s turn content. Validates turn order ({error:"not_your_turn"} otherwise), advances to the next speaker. ' +
      'Pass signoff:true to cast an early-close (unanimous signoff) vote; when every agent has signed off the debate closes early ' +
      '({debate_complete:true, early:true, reason:"unanimous_signoff"}). Any normal (non-signoff) submission counts as dissent and resets accumulated signoffs.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: TASK_ID,
        agent_id: AGENT_ID,
        content: { type: 'string', description: 'The agent\'s debate contribution for this turn (the signoff statement when signoff is true)' },
        signoff: {
          type: 'boolean',
          description:
            'True to cast an early-close (unanimous signoff) vote instead of a normal turn; content carries the signoff statement. ' +
            'A normal (non-signoff) submission is a dissent that clears all accumulated signoffs.',
        },
      },
      required: ['task_id', 'agent_id', 'content'],
    },
  },
  {
    name: 'moa_complete',
    description: 'Write the archive to <logsDir>/{task_id}/ (probe.json, events.jsonl, result.json, plus board.jsonl — the task-scope blackboard notes; logsDir defaults to ~/.moamcp/logs, MOAMCP_LOGS_DIR overrides), close the task, wake remaining waiters (including board waiters, which get {status:"closed"}).',
    inputSchema: {
      type: 'object',
      properties: { task_id: TASK_ID },
      required: ['task_id'],
    },
  },
  {
    name: 'moa_board_write',
    description:
      'Write an entry to the shared blackboard (last-write-wins per key). value is markdown, max 32KB — put large content in files and reference them. ' +
      'Use the blackboard for contracts/decisions/status/pointers across agents and sessions; one-shot instructions belong in dispatch prompts instead.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Entry key (unique within the scope; rewriting replaces the value)' },
        value: { type: 'string', description: 'Markdown payload, ≤ 32KB' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for moa_board_read tag filtering' },
        author: BOARD_AUTHOR,
        scope: BOARD_SCOPE,
        workspace: BOARD_WORKSPACE,
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'moa_board_read',
    description:
      'Read live entries from the blackboard (deleted keys never appear). With key: that key\'s latest entry; with tag: entries carrying the tag; ' +
      'with neither: every key\'s latest value. Newest first, capped by limit (default 100).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        tag: { type: 'string' },
        scope: BOARD_SCOPE,
        workspace: BOARD_WORKSPACE,
        limit: { type: 'number', description: 'Max entries to return (default 100, hard cap 1000)' },
      },
    },
  },
  {
    name: 'moa_board_list',
    description: 'Lightweight browse of the blackboard: one row per live key with {key, author, ts, tags, bytes} (no values).',
    inputSchema: {
      type: 'object',
      properties: { scope: BOARD_SCOPE, workspace: BOARD_WORKSPACE },
    },
  },
  {
    name: 'moa_board_wait',
    description:
      'Long-poll until key has a value — or, with since (ISO timestamp), until the entry is strictly newer than it ("wait for the next update"). ' +
      'Returns {status:"ready", entry}, {status:"timeout", retry:true} at the safety cap (default 25min like moa_wait_turn, MOAMCP_WAIT_CAP_MS / timeoutMs tune it), ' +
      'or {status:"closed"} when a task scope is archived while waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        scope: BOARD_SCOPE,
        workspace: BOARD_WORKSPACE,
        timeoutMs: { type: 'number', description: 'Per-call cap override (clamped to the safety cap)' },
        since: { type: 'string', description: 'ISO timestamp: wake only on entries strictly newer than it' },
      },
      required: ['key'],
    },
  },
  {
    name: 'moa_board_delete',
    description: 'Tombstone-delete a key: it disappears from read/list; the append-only JSONL keeps the deletion record.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        author: BOARD_AUTHOR,
        scope: BOARD_SCOPE,
        workspace: BOARD_WORKSPACE,
      },
      required: ['key'],
    },
  },
  {
    name: 'moa_tip_create',
    description: 'Create a project-level Tip in the explicitly selected workspace.',
    inputSchema: {
      type: 'object',
      properties: TIP_CREATE_PROPERTIES,
      required: ['workspace', 'title', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'moa_tip_read',
    description: 'Read one complete project Tip, including context when present.',
    inputSchema: {
      type: 'object',
      properties: { workspace: TIP_WORKSPACE, id: { type: 'string' } },
      required: ['workspace', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'moa_tip_list',
    description: 'List lightweight project Tip summaries with status/module/tag filters; archived rows are hidden by default.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: TIP_WORKSPACE,
        status: TIP_STATUS,
        module: { type: 'string' },
        tag: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        includeArchived: { type: 'boolean' },
        limit: { type: 'number' },
      },
      required: ['workspace'],
      additionalProperties: false,
    },
  },
  {
    name: 'moa_tip_update',
    description: 'Update a Tip atomically; omitted fields remain and nullable optional fields clear their values.',
    inputSchema: {
      type: 'object',
      properties: TIP_UPDATE_PROPERTIES,
      required: ['workspace', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'moa_tip_archive',
    description: 'Archive a project Tip without changing its other content; actor identifies the updater in BoardEntry.author.',
    inputSchema: {
      type: 'object',
      properties: { workspace: TIP_WORKSPACE, id: { type: 'string' }, actor: { type: 'string' } },
      required: ['workspace', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'moa_status',
    description: 'Get the current Bus status: port, mode (own/reuse), active tasks, process info. Use this to discover the Bus port for the debate card URL.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export function createServer(hub: DebateHub = new DebateHub(), bus?: Bus, board?: BoardStore, tipStore?: TipStore): Server {
  const boardStore = board ?? new BoardStore();
  const tips = tipStore ?? new TipStore(boardStore);
  bus?.mountControlPlane(boardStore, tips);
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
        result = await hub.submitTurn(a.task_id as string, a.agent_id as string, a.content as string, a.signoff === true);
        break;
      case 'moa_complete':
        result = await hub.complete(a.task_id as string);
        break;
      case 'moa_board_write':
        result = await boardStore.write(a.key, a.value, a.tags, a.author, a.scope, a.workspace);
        break;
      case 'moa_board_read':
        result = await boardStore.read(a.key, a.tag, a.scope, a.limit, a.workspace);
        break;
      case 'moa_board_list':
        result = await boardStore.list(a.scope, a.workspace);
        break;
      case 'moa_board_wait':
        result = await boardStore.wait(a.key, a.scope, a.timeoutMs, a.since, a.workspace);
        break;
      case 'moa_board_delete':
        result = await boardStore.delete(a.key, a.author, a.scope, a.workspace);
        break;
      case 'moa_tip_create': {
        const { workspace, ...input } = a;
        result = await tips.create(input as TipCreateInput, workspace as string);
        break;
      }
      case 'moa_tip_read':
        result = await tips.read(a.id as string, a.workspace as string);
        break;
      case 'moa_tip_list': {
        const { workspace, ...filters } = a;
        result = await tips.list(filters, workspace as string);
        break;
      }
      case 'moa_tip_update': {
        const { workspace, id, ...patch } = a;
        result = await tips.update(id as string, patch as TipUpdateInput, workspace as string);
        break;
      }
      case 'moa_tip_archive':
        result = await tips.archive(a.id as string, a.workspace as string, a.actor as string | null | undefined);
        break;
      case 'moa_status':
        result = {
          bus: bus ? { port: bus.actualPort, mode: bus.mode } : undefined,
          tasks: (bus?.activeTasks() ?? []).filter((taskId) => !taskId.startsWith('@')),
          control_plane_url: bus ? controlPlaneUrl(bus.actualPort) : undefined,
          pid: process.pid,
          uptime_s: Math.round(process.uptime()),
        };
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    // JSON has no undefined value; expose an absent optional result as null over MCP.
    return { content: [{ type: 'text', text: JSON.stringify(result === undefined ? null : result) }] };
  });

  return server;
}

async function main(): Promise<void> {
  const waitCap = Number(process.env.MOAMCP_WAIT_CAP_MS);
  // Bus: SSE channel + frontend card. Port rules per the port-discovery design
  // (§3.2/§3.3): register → bind 39813 (MOAMCP_BUS_PORT overrides) → a live
  // moamcp holding the port means reuse mode (no listener in this process);
  // anything else walks port+1 up to the cap.
  const busPort = Number(process.env.MOAMCP_BUS_PORT);
  // Reuse-mode host watch tuning (defaults: 10s interval / 1s timeout /
  // 3 consecutive failures → dead → takeover).
  const watchIntervalMs = Number(process.env.MOAMCP_BUS_WATCH_INTERVAL_MS);
  const watchTimeoutMs = Number(process.env.MOAMCP_BUS_WATCH_TIMEOUT_MS);
  const watchFailThreshold = Number(process.env.MOAMCP_BUS_WATCH_FAILS);
  // Fixed archive root shared by all instances (reuse mode's /archive depends
  // on it): MOAMCP_LOGS_DIR or <MOAMCP_HOME|~/.moamcp>/logs (design §3.1).
  const logsDir = defaultLogsDir();
  const bus = new Bus({
    ...(Number.isFinite(busPort) && busPort > 0 ? { port: busPort } : {}),
    ...(Number.isFinite(watchIntervalMs) && watchIntervalMs > 0 ? { reuseWatchIntervalMs: watchIntervalMs } : {}),
    ...(Number.isFinite(watchTimeoutMs) && watchTimeoutMs > 0 ? { reuseWatchTimeoutMs: watchTimeoutMs } : {}),
    ...(Number.isFinite(watchFailThreshold) && watchFailThreshold > 0 ? { reuseWatchFailThreshold: watchFailThreshold } : {}),
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
  // Either way the card points at the owning Bus's port. Both go through
  // mutable bindings: in reuse mode the watched host Bus can die, and the
  // Bus takeover re-points them via onTakeover — the event outlet switches
  // from forwarding to the local Bus (or to a new host) while the DebateHub
  // state machine in this process's memory stays untouched.
  let sink: (taskId: string, event: DomainEvent) => void =
    startResult.mode === 'own'
      ? (taskId, event) => bus.publish(taskId, event)
      : reusePublishForwarder(startResult.port);
  let cardPort = startResult.port;
  bus.onTakeover = (result) => {
    cardPort = result.port;
    sink =
      result.mode === 'own'
        ? (taskId, event) => bus.publish(taskId, event)
        : reusePublishForwarder(result.port);
    console.error(
      result.mode === 'own'
        ? `[moamcp] takeover: now owns the Bus at http://127.0.0.1:${result.port}/ (registry entry restored, card_url re-pointed, events served locally)`
        : `[moamcp] takeover: lost the port race; reusing new Bus at http://127.0.0.1:${result.port}/`,
    );
  };
  // Shared blackboard: task-scope events ride the task's SSE stream (card-
  // visible); workspace/global events fan out on a synthetic `@board/<scope>`
  // bus channel for Control Plane invalidation (card panels are future work).
  // Routing goes through the mutable `sink`, so a reuse-mode takeover re-points
  // board events (forwarded ↔ local Bus) exactly like debate events.
  const board = new BoardStore({
    ...(Number.isFinite(waitCap) && waitCap > 0 ? { waitCapMs: waitCap } : {}),
    workspaceCwd: process.cwd(),
    emit: (scope, event) => sink(scope.kind === 'task' ? scope.taskId : `@board/${scope.key}`, event),
  });
  const hub = new DebateHub({
    ...(Number.isFinite(waitCap) && waitCap > 0 ? { waitCapMs: waitCap } : {}),
    logsDir,
    emit: (taskId, event) => sink(taskId, event),
    cardUrlFactory: (taskId) => cardUrl(cardPort, taskId),
    board,
  });
  const tips = new TipStore(board);
  const server = createServer(hub, bus, board, tips);
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
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void bus.stop().finally(() => process.exit(0));
  };
  // Shutdown when the MCP transport closes (parent exited / stdin closed).
  server.onclose = () => shutdown();
  process.stdin.on('close', () => shutdown());
  process.stdin.on('end', () => shutdown());

  // Parent death watchdog: if the spawning process dies, exit.
  // On Windows, stdin close is not always delivered reliably.
  if (process.ppid) {
    const parentPid = process.ppid;
    const watchdog = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        clearInterval(watchdog);
        shutdown();
      }
    }, 5000);
    watchdog.unref(); // Don't keep the process alive just for the watchdog.
  }
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
