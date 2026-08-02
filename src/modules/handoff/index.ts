/**
 * Handoff module: the five directed-handoff MCP tools
 * (moa_handoff_send / inbox / read / consume / archive) over HandoffStore
 * (mailbox task 3). Handoffs are delivered into the TARGET project's board;
 * they never participate in recall/indexing and never merge projects.
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

export function handoffTools(store: HandoffStore): MoaToolDef[] {
  return [
    {
      name: 'moa_handoff_send',
      description:
        'Send a directed handoff (title/summary/optional context) into the TARGET project\'s inbox (toProject: projectId or "user-global"). ' +
        'The entry is written to the target project\'s board under handoff/<id> with fromProject = the current workspace\'s project alias (or ws:<pathHash>). ' +
        'Handoffs never participate in recall/indexing and never merge projects — they are pull-on-demand messages the target session consumes explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: HANDOFF_WORKSPACE,
          toProject: HANDOFF_TO_PROJECT,
          title: { type: 'string', description: 'Short handoff title' },
          summary: { type: 'string', description: 'What the target session needs to know/do' },
          context: { type: 'string', description: 'Optional longer context (the whole entry is capped at 32KB)' },
          author: { type: 'string', description: 'Sender identity recorded on the entry (default "anonymous")' },
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
        'Archived rows are hidden by default — pass state to filter exactly (pending/consumed/archived). Handoffs never participate in recall/indexing.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: HANDOFF_WORKSPACE,
          state: HANDOFF_STATE,
          limit: { type: 'number', description: 'Max rows to return (default 100, hard cap 1000)' },
        },
        required: ['workspace'],
        additionalProperties: false,
      },
      handler: (a) => {
        const options: HandoffListOptions = {};
        if (a.state !== undefined) options.state = a.state as HandoffState;
        if (a.limit !== undefined) options.limit = a.limit as number;
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
