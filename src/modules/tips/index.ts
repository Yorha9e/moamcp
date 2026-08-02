/**
 * Tips module: the five project-Tip MCP tools
 * (moa_tip_create / read / list / update / archive) over TipStore.
 */
import { PROJECT_TIP_STATUSES, type TipCreateInput, type TipStore, type TipUpdateInput } from './tips.js';
import type { MoaModule, MoaToolDef } from '../types.js';

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

export function tipTools(tips: TipStore): MoaToolDef[] {
  return [
    {
      name: 'moa_tip_create',
      description: 'Create a project-level Tip in the explicitly selected workspace.',
      inputSchema: {
        type: 'object',
        properties: TIP_CREATE_PROPERTIES,
        required: ['workspace', 'title', 'summary'],
        additionalProperties: false,
      },
      handler: (a) => {
        const { workspace, ...input } = a;
        return tips.create(input as TipCreateInput, workspace as string);
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
      handler: (a) => tips.read(a.id as string, a.workspace as string),
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
      handler: (a) => {
        const { workspace, ...filters } = a;
        return tips.list(filters, workspace as string);
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
      handler: (a) => {
        const { workspace, id, ...patch } = a;
        return tips.update(id as string, patch as TipUpdateInput, workspace as string);
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
      handler: (a) => tips.archive(a.id as string, a.workspace as string, a.actor as string | null | undefined),
    },
  ];
}

export function createTipsModule(tips: TipStore): MoaModule {
  return {
    id: 'tips',
    tier: 'stable',
    tools: tipTools(tips),
  };
}
