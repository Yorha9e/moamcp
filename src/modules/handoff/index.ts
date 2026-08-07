/**
 * Handoff module: the five directed-handoff MCP tools
 * (moa_handoff_send / inbox / read / consume / archive) over HandoffStore
 * (mailbox task 3). Handoffs are delivered into the TARGET project's board;
 * they never participate in recall/indexing and never merge projects.
 * v2 (0.12.0): optional toAgent/fromAgent agent addresses
 * (`<label>:<sessionId>:<agentId>`, shape-checked only) for inbox filtering.
 */
import type { BoardStore } from '../../core/store/board.js';
import type { MoaModule, MoaToolDef } from '../types.js';
import {
  HANDOFF_STATES,
  HANDOFF_USER_GLOBAL,
  type HandoffListOptions,
  type HandoffSendInput,
  type HandoffState,
  type HandoffStore,
} from './handoff.js';

const HANDOFF_STATE = { type: 'string', enum: [...HANDOFF_STATES] } as const;
const HANDOFF_WORKSPACE = {
  type: 'string',
  description:
    'Absolute path of the CURRENT project (sender identity for send; the inbox scope for inbox/read/consume/archive). ' +
    'Handoff tools never infer a workspace from the MCP process cwd.',
} as const;
const HANDOFF_TO_PROJECT = {
  type: 'string',
  description:
    `Target of the handoff: a projectId (p_<12 hex chars>) or "${HANDOFF_USER_GLOBAL}" (the user-global cross-project inbox). v1 supports a single target only.`,
} as const;
const HANDOFF_ACTOR = {
  type: 'string',
  description: 'Who performs this transition (recorded in BoardEntry.author; default "anonymous").',
} as const;
const HANDOFF_AGENT_ADDRESS = {
  type: 'string',
  description:
    'Agent address in v2 shape `<label>:<sessionId>:<agentId>` (label is free text `[a-z0-9-]+`; e.g. `claude-code:sess-a:sub-1`). ' +
    'Opaque — shape-checked only, never resolved against a registry.',
} as const;

export function handoffTools(store: HandoffStore): MoaToolDef[] {
  return [
    {
      name: 'moa_handoff_send',
      description:
        'Send a directed handoff (title/summary/optional context) into the TARGET project\'s inbox (toProject: projectId or "user-global"). ' +
        'The entry is written to the target project\'s board under handoff/<id> with fromProject = the current workspace\'s project alias (or ws:<pathHash>). ' +
        'v2 (optional): pass toAgent/fromAgent as `<label>:<sessionId>:<agentId>` for agent-level addressing — the entry is tagged agent:<toAgent> and the ' +
        'recipient filters its inbox by self-reported agent. Compromise: a misspelled address is silently missed (no registry to catch it) — align via fromAgent echo. ' +
        'Handoffs never participate in recall/indexing and never merge projects — they are pull-on-demand messages the target session consumes explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: HANDOFF_WORKSPACE,
          toProject: HANDOFF_TO_PROJECT,
          title: { type: 'string', description: 'Short handoff title' },
          summary: { type: 'string', description: 'What the target session needs to know/do' },
          context: { type: 'string', description: 'Optional longer context (the whole entry is capped at 96KB)' },
          author: { type: 'string', description: 'Sender identity recorded on the entry (default "anonymous")' },
          toAgent: {
            ...HANDOFF_AGENT_ADDRESS,
            description: HANDOFF_AGENT_ADDRESS.description + ' Recipient agent address (delivery still routes via toProject).',
          },
          fromAgent: {
            ...HANDOFF_AGENT_ADDRESS,
            description: HANDOFF_AGENT_ADDRESS.description + ' Sender agent address; lets the recipient reply by echoing it.',
          },
        },
        required: ['workspace', 'toProject', 'title', 'summary'],
        additionalProperties: false,
      },
      handler: (a) => {
        const { workspace, ...input } = a;
        return store.send(input as HandoffSendInput, workspace as string);
      },
    },
    {
      name: 'moa_handoff_inbox',
      description:
        'List handoffs addressed to the current project (newest first; id/title/summary/state/fromProject metadata, no context). ' +
        'Archived rows are hidden by default — pass state to filter exactly (pending/consumed/archived). ' +
        'v2: pass agent (your self-reported `<label>:<sessionId>:<agentId>` address) to filter exactly on toAgent — ' +
        'a misspelled address returns an empty inbox rather than an error, so echo the sender\'s fromAgent when replying. ' +
        'Handoffs never participate in recall/indexing.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: HANDOFF_WORKSPACE,
          state: HANDOFF_STATE,
          limit: { type: 'number', description: 'Max rows to return (default 100, hard cap 1000)' },
          agent: {
            ...HANDOFF_AGENT_ADDRESS,
            description:
              HANDOFF_AGENT_ADDRESS.description + ' Exact filter on toAgent (only entries addressed to this agent address are returned).',
          },
        },
        required: ['workspace'],
        additionalProperties: false,
      },
      handler: (a) => {
        const options: HandoffListOptions = {};
        if (a.state !== undefined) options.state = a.state as HandoffState;
        if (a.limit !== undefined) options.limit = a.limit as number;
        if (a.agent !== undefined) options.agent = a.agent as string;
        return store.inbox(a.workspace as string, options);
      },
    },
    {
      name: 'moa_handoff_read',
      description:
        'Read one complete handoff from the current project\'s inbox, including the context payload. Returns null when the id is unknown here. ' +
        'Handoffs never participate in recall/indexing.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: HANDOFF_WORKSPACE,
          id: { type: 'string', description: 'Handoff id (ho_<12 hex chars>)' },
        },
        required: ['workspace', 'id'],
        additionalProperties: false,
      },
      handler: (a) => store.read(a.id as string, a.workspace as string),
    },
    {
      name: 'moa_handoff_consume',
      description:
        'Mark a pending handoff consumed (terminal state; records consumedAt). Only pending → consumed | archived transitions are legal; anything else errors. ' +
        'Handoffs never participate in recall/indexing.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: HANDOFF_WORKSPACE,
          id: { type: 'string', description: 'Handoff id (ho_<12 hex chars>)' },
          actor: HANDOFF_ACTOR,
        },
        required: ['workspace', 'id'],
        additionalProperties: false,
      },
      handler: (a) => store.consume(a.id as string, a.workspace as string, a.actor as string | null | undefined),
    },
    {
      name: 'moa_handoff_archive',
      description:
        'Archive a pending handoff (terminal state) without changing its content; hidden from the default inbox view afterwards. ' +
        'Only pending → consumed | archived transitions are legal; anything else errors. Handoffs never participate in recall/indexing.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: HANDOFF_WORKSPACE,
          id: { type: 'string', description: 'Handoff id (ho_<12 hex chars>)' },
          actor: HANDOFF_ACTOR,
        },
        required: ['workspace', 'id'],
        additionalProperties: false,
      },
      handler: (a) => store.archive(a.id as string, a.workspace as string, a.actor as string | null | undefined),
    },
  ];
}

/**
 * Create the handoff module. `board` is accepted for symmetry with the other
 * module factories (task 4's Control Plane routes will wire through it); the
 * tools only need the HandoffStore, which already carries its BoardStore.
 */
export function createHandoffModule(store: HandoffStore, _board?: BoardStore): MoaModule {
  return {
    id: 'handoff',
    tier: 'stable',
    tools: handoffTools(store),
  };
}
