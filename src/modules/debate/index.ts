/**
 * Debate module: the five mailbox-debate MCP tools over DebateHub
 * (moa_init / moa_start_debate / moa_wait_turn / moa_submit_turn / moa_complete).
 * Tool schemas and descriptions are the frozen MCP contract (design §0).
 */
import type { MoaModule, MoaToolDef } from '../types.js';
import type { DebateHub, PresetConfig } from './state.js';

const TASK_ID = { type: 'string', description: 'MOA task id' } as const;
const AGENT_ID = { type: 'string', description: 'Debate agent id (must be in preset agents)' } as const;

export function debateTools(hub: DebateHub): MoaToolDef[] {
  return [
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
      handler: (a) => hub.init(a.task_id as string, a.preset_config as PresetConfig),
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
      handler: (a) => hub.startDebate(a.task_id as string, a.reference_results),
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
      handler: (a) => hub.waitTurn(a.task_id as string, a.agent_id as string),
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
      handler: (a) => hub.submitTurn(a.task_id as string, a.agent_id as string, a.content as string, a.signoff === true),
    },
    {
      name: 'moa_complete',
      description: 'Write the archive to <logsDir>/{task_id}/ (probe.json, events.jsonl, result.json, plus board.jsonl — the task-scope blackboard notes; logsDir defaults to ~/.moamcp/logs, MOAMCP_LOGS_DIR overrides), close the task, wake remaining waiters (including board waiters, which get {status:"closed"}).',
      inputSchema: {
        type: 'object',
        properties: { task_id: TASK_ID },
        required: ['task_id'],
      },
      handler: (a) => hub.complete(a.task_id as string),
    },
  ];
}

export function createDebateModule(hub: DebateHub): MoaModule {
  return {
    id: 'debate',
    tier: 'stable',
    tools: debateTools(hub),
  };
}
