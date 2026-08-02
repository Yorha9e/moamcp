/**
 * In-memory, read-only projection of MoA run events.
 *
 * This module deliberately has no Bus or ControlPlane dependency. Callers feed
 * it the flattened envelopes produced by Bus (`task_id`, `ts`, and event
 * fields), then obtain detached JSON summaries through read/list.
 */

export type RunStatus = 'initialized' | 'debating' | 'complete' | 'closed';

export interface RunAgentSpec {
  id: string;
  binding_slot?: string;
}

export interface RunSummary {
  taskId: string;
  status: RunStatus;
  agents: string[];
  agentSpecs: RunAgentSpec[];
  roundsConfigured: number | null;
  round: number | null;
  turn: number | null;
  currentSpeaker: string | null;
  turnCount: number;
  signoffCount: number;
  createdAt: string;
  updatedAt: string;
  lastEvent: string;
  early?: boolean;
  reason?: string;
}

/** The minimum Bus envelope contract; event payload fields remain untrusted. */
export interface RunEventEnvelope {
  task_id: string;
  ts: string;
  type?: string;
  [key: string]: unknown;
}

type JsonObject = Record<string, unknown>;

type RunState = Omit<RunSummary, 'signoffCount'> & { signoffs: Set<string> };

const KNOWN_EVENTS = new Set([
  'task_initialized',
  'debate_started',
  'turn_submitted',
  'turn_advanced',
  'signoff_reset',
  'debate_complete',
  'task_closed',
]);

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = nonEmptyString(item);
    if (text !== undefined && !seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

function agentSpecList(value: unknown): RunAgentSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: RunAgentSpec[] = [];
  const positions = new Map<string, number>();
  for (const item of value) {
    const source = objectValue(item);
    const id = nonEmptyString(source?.id);
    if (source === undefined || id === undefined) continue;
    const bindingSlot = typeof source.binding_slot === 'string' ? source.binding_slot : undefined;
    const previous = positions.get(id);
    if (previous === undefined) {
      const spec: RunAgentSpec = { id };
      if (bindingSlot !== undefined) spec.binding_slot = bindingSlot;
      positions.set(id, result.length);
      result.push(spec);
    } else if (result[previous].binding_slot === undefined && bindingSlot !== undefined) {
      result[previous].binding_slot = bindingSlot;
    }
  }
  return result;
}

function specsForAgents(agents: string[]): RunAgentSpec[] {
  return agents.map((id) => ({ id }));
}

function mergeAgentsIntoSpecs(specs: RunAgentSpec[], agents: string[]): RunAgentSpec[] {
  const result = specs.map((spec) => ({ ...spec }));
  const known = new Set(result.map((spec) => spec.id));
  for (const id of agents) {
    if (!known.has(id)) {
      known.add(id);
      result.push({ id });
    }
  }
  return result;
}

function initialState(taskId: string, ts: string, type: string): RunState {
  return {
    taskId,
    status: 'initialized',
    agents: [],
    agentSpecs: [],
    roundsConfigured: null,
    round: null,
    turn: null,
    currentSpeaker: null,
    turnCount: 0,
    signoffs: new Set(),
    createdAt: ts,
    updatedAt: ts,
    lastEvent: type,
  };
}

function detachedSummary(state: RunState): RunSummary {
  return {
    taskId: state.taskId,
    status: state.status,
    agents: [...state.agents],
    agentSpecs: state.agentSpecs.map((spec) => ({ ...spec })),
    roundsConfigured: state.roundsConfigured,
    round: state.round,
    turn: state.turn,
    currentSpeaker: state.currentSpeaker,
    turnCount: state.turnCount,
    signoffCount: state.signoffs.size,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastEvent: state.lastEvent,
    ...(state.early === undefined ? {} : { early: state.early }),
    ...(state.reason === undefined ? {} : { reason: state.reason }),
  };
}

/**
 * Reducer-backed run projection. Invalid envelopes are ignored and never
 * throw. A recognized event can bootstrap a task when replay begins after its
 * initialization event; an unknown event only updates an already-known task.
 */
export class RunReadModel {
  private readonly tasks = new Map<string, RunState>();

  constructor(events?: Iterable<unknown>) {
    if (events !== undefined) for (const event of events) this.ingest(event);
  }

  /** Apply one flattened Bus event. Returns false when the envelope is ignored. */
  ingest(envelope: unknown): boolean {
    const event = objectValue(envelope);
    const taskId = nonEmptyString(event?.task_id);
    const ts = validTimestamp(event?.ts);
    const type = nonEmptyString(event?.type);
    if (event === undefined || taskId === undefined || ts === undefined || type === undefined || taskId.startsWith('@')) {
      return false;
    }

    let state = this.tasks.get(taskId);
    if (state === undefined) {
      if (!KNOWN_EVENTS.has(type)) return false;
      state = initialState(taskId, ts, type);
      this.tasks.set(taskId, state);
    }

    switch (type) {
      case 'task_initialized':
        this.initialize(state, event);
        break;
      case 'debate_started':
        this.startDebate(state, event);
        break;
      case 'turn_submitted':
        this.submitTurn(state, event);
        break;
      case 'turn_advanced':
        this.advanceTurn(state, event);
        break;
      case 'signoff_reset':
        state.signoffs.clear();
        break;
      case 'debate_complete':
        this.completeDebate(state, event);
        break;
      case 'task_closed':
        state.status = 'closed';
        state.currentSpeaker = null;
        break;
      default:
        // Unknown events are activity markers only: no lifecycle fields change.
        break;
    }

    state.updatedAt = ts;
    state.lastEvent = type;
    return true;
  }

  /** Alias useful to reducer-style callers. */
  apply(envelope: unknown): boolean {
    return this.ingest(envelope);
  }

  /** Read one task by id. The returned object is fully detached. */
  read(taskId: string): RunSummary | undefined {
    const state = this.tasks.get(taskId);
    return state === undefined ? undefined : detachedSummary(state);
  }

  /** List all tasks by updatedAt descending; equal timestamps retain insertion order. */
  list(): RunSummary[] {
    return [...this.tasks.values()]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .map(detachedSummary);
  }

  private initialize(state: RunState, event: JsonObject): void {
    state.status = 'initialized';
    const specs = agentSpecList(event.agent_specs);
    const listedAgents = stringList(event.agents);
    const agents = listedAgents !== undefined && listedAgents.length > 0
      ? listedAgents
      : specs?.map((spec) => spec.id);
    if (agents !== undefined) state.agents = agents;
    if (specs !== undefined && specs.length > 0) {
      state.agentSpecs = mergeAgentsIntoSpecs(specs, state.agents);
    } else if (listedAgents !== undefined) {
      state.agentSpecs = specsForAgents(state.agents);
    }
    const rounds = positiveInteger(event.rounds);
    if (rounds !== undefined) state.roundsConfigured = rounds;
  }

  private startDebate(state: RunState, event: JsonObject): void {
    state.status = 'debating';
    const agents = stringList(event.agents);
    if (agents !== undefined && agents.length > 0) {
      state.agents = agents;
      state.agentSpecs = mergeAgentsIntoSpecs(state.agentSpecs, agents);
    }
    const rounds = positiveInteger(event.rounds);
    if (rounds !== undefined) state.roundsConfigured = rounds;
    state.round = positiveInteger(event.round) ?? 1;
    state.turn = positiveInteger(event.turn) ?? state.turn;
    state.currentSpeaker = nonEmptyString(event.speaker) ?? state.agents[0] ?? null;
    state.signoffs.clear();
    delete state.early;
    delete state.reason;
  }

  private submitTurn(state: RunState, event: JsonObject): void {
    const round = positiveInteger(event.round);
    const turn = positiveInteger(event.turn);
    if (round !== undefined) state.round = round;
    if (turn !== undefined) state.turn = turn;
    state.turnCount += 1;
    if (event.signoff === true) {
      const agentId = nonEmptyString(event.agent_id);
      if (agentId !== undefined) state.signoffs.add(agentId);
    }
    // Deliberately do not read content, excerpt, next_speaker, or speaker here.
  }

  private advanceTurn(state: RunState, event: JsonObject): void {
    const round = positiveInteger(event.round);
    const speaker = nonEmptyString(event.speaker);
    if (round !== undefined) state.round = round;
    if (speaker !== undefined) state.currentSpeaker = speaker;
  }

  private completeDebate(state: RunState, event: JsonObject): void {
    state.status = 'complete';
    state.currentSpeaker = null;
    if (typeof event.early === 'boolean') state.early = event.early;
    const reason = nonEmptyString(event.reason);
    if (reason !== undefined) state.reason = reason;
  }
}
