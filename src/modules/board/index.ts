/**
 * Board module: the five raw blackboard MCP tools
 * (moa_board_write / read / list / wait / delete). No module-local service —
 * the tools are the core BoardStore directly tooled (design §1).
 */
import type { BoardStore } from '../../core/store/board.js';
import type { MoaModule, MoaToolDef } from '../types.js';

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

export function boardTools(store: BoardStore): MoaToolDef[] {
  return [
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
      handler: (a) => store.write(a.key, a.value, a.tags, a.author, a.scope, a.workspace),
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
      handler: (a) => store.read(a.key, a.tag, a.scope, a.limit, a.workspace),
    },
    {
      name: 'moa_board_list',
      description: 'Lightweight browse of the blackboard: one row per live key with {key, author, ts, tags, bytes} (no values).',
      inputSchema: {
        type: 'object',
        properties: { scope: BOARD_SCOPE, workspace: BOARD_WORKSPACE },
      },
      handler: (a) => store.list(a.scope, a.workspace),
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
      handler: (a) => store.wait(a.key, a.scope, a.timeoutMs, a.since, a.workspace),
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
      handler: (a) => store.delete(a.key, a.author, a.scope, a.workspace),
    },
  ];
}

export function createBoardModule(store: BoardStore): MoaModule {
  return {
    id: 'board',
    tier: 'stable',
    tools: boardTools(store),
  };
}
