/**
 * DebateHub — mailbox-style debate state machine (design doc §4c).
 *
 * In-memory Map<taskId, DebateTask>. Round-robin speakers over the preset's
 * agent list; debate ends after `rounds` full rounds. Long-poll waiters are
 * stored as pending promises per task and resolved by submit/complete.
 */
import { join } from 'node:path';
import { moamcpHome } from './registry.js';

/** Safety cap for a single moa_wait_turn call (design doc §4c.4: 30min client timeout). */
export const DEFAULT_WAIT_CAP_MS = 25 * 60 * 1000;

/**
 * Behavioral contract injected into every wait_turn prompt. Debaters (LLM
 * subagents) have been observed ending the turn with the speech as plain
 * text instead of calling moa_submit_turn — the state machine never sees a
 * submission and the whole debate deadlocks. Restating the obligation on
 * every turn payload (not only in the orchestrator's dispatch brief) is the
 * structural fix.
 */
export const SUBMISSION_PROTOCOL = [
  '## ⚠️ SUBMISSION PROTOCOL / 提交协议',
  '',
  '- Submit your speech ONLY via the `moa_submit_turn` tool. Never output the speech as plain text and end the turn — end_turn without the tool call deadlocks the debate forever.',
  '  发言必须且只能通过 `moa_submit_turn` 工具提交；禁止将发言内容作为纯文本输出后 end_turn——不调用工具结束回合 = 辩论永久卡死。',
  '- After submitting, if the debate is not complete, call `moa_wait_turn` again to wait for your next turn.',
  '  提交后若 debate 未结束，继续调用 `moa_wait_turn` 等待下一回合。',
  '- A `not_your_turn` error means your turn was already handled — do NOT retry submit; go back to `moa_wait_turn` and wait.',
  '  `not_your_turn` 错误 = 你的回合已被处理，不要重试提交，回到 `moa_wait_turn` 等待。',
].join('\n');

/**
 * Unanimous-signoff early-close protocol, appended after SUBMISSION_PROTOCOL on
 * every wait_turn prompt. Codifies the pattern debaters already converge on
 * organically: once the debate has clearly reached consensus, anyone may
 * propose a signoff round and the debate closes early when everyone signs,
 * instead of burning the remaining scheduled rounds. The live N/M vote count is
 * prepended by buildPrompt; the rules below are static.
 */
export const SIGNOFF_PROTOCOL = [
  '## ✍ UNANIMOUS SIGNOFF / 全体签字提前闭合',
  '',
  '- When the debate has genuinely converged and more rounds would only repeat already-settled points, submit with `signoff: true` (put your final position / signoff statement in `content`) to cast an early-close vote.',
  '  当辩论已真正达成共识、继续下去只会重复已有结论时，在 `moa_submit_turn` 传 `signoff: true`（`content` 写你的最终立场 / 签字陈词）投提前闭合票。',
  '- Once EVERY debater has signed off, the debate closes immediately and is archived with `early: true, reason: "unanimous_signoff"` — no need to run out the scheduled rounds.',
  '  全体辩手都签字后，辩论立即提前闭合归档（`early: true, reason: "unanimous_signoff"`），无需跑满排定轮次。',
  '- Dissent: submitting a NORMAL turn (no `signoff`) counts as an objection and clears ALL accumulated signoffs; the debate then continues on its original schedule.',
  '  异议：提交一次**普通发言**（不传 `signoff`）即视为异议，已积累的签字全部清零，辩论按原轮次继续。',
  '- Do not sign off just to make up numbers — keep submitting normal turns until there is real consensus.',
  '  不要为凑数而签字——未达成共识前继续提交普通发言推进辩论。',
].join('\n');

/**
 * Archive root: `MOAMCP_LOGS_DIR` if set, else `<MOAMCP_HOME|~/.moamcp>/logs`
 * (port-discovery design §3.1 — a fixed root is what lets reuse mode serve a
 * reuser's archives from the owning Bus). Read at call time so tests can
 * redirect it. Archives written by older versions under `./logs` are NOT
 * migrated; point `MOAMCP_LOGS_DIR` at the old root to read them.
 */
export function defaultLogsDir(): string {
  return process.env.MOAMCP_LOGS_DIR ?? join(moamcpHome(), 'logs');
}

export interface AgentSpec {
  id: string;
  /** kimi-code subagent binding slot name; returned to orchestrator for model dispatch. */
  binding_slot?: string;
  [key: string]: unknown;
}

/** Passed inline to moa_init (no TOML loading in this iteration). */
export interface PresetConfig {
  agents: Array<string | AgentSpec>;
  debate?: { rounds?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface TurnRecord {
  turn: number;
  round: number;
  speaker: string;
  content: string;
  timestamp: string;
  /** Present (true) when this turn was a unanimous-signoff early-close vote. */
  signoff?: boolean;
}

export interface FullContext {
  reference_results: unknown;
  transcript: TurnRecord[];
}

export type WaitPayload =
  | { status: 'your_turn'; speaker_id: string; round: number; prompt: string; full_context: FullContext }
  | { status: 'debate_complete'; transcript: TurnRecord[] }
  | { status: 'timeout'; retry: true }
  | { status: 'closed' };

type TaskStatus = 'initialized' | 'debating' | 'complete' | 'closed';

interface Waiter {
  agentId: string;
  resolve: (payload: WaitPayload) => void;
  timer: NodeJS.Timeout;
}

export interface DebateTask {
  taskId: string;
  preset: PresetConfig;
  agents: AgentSpec[];
  agentIds: string[];
  rounds: number;
  status: TaskStatus;
  round: number; // 1-based
  turnIndex: number; // 0-based index into agentIds
  turn: number; // 1-based global turn counter
  referenceResults: unknown;
  transcript: TurnRecord[];
  probes: Record<string, unknown>;
  waiters: Set<Waiter>;
  createdAt: string;
  /**
   * Unanimous-signoff early-close votes: agentId → signoff statement. A signoff
   * turn records a vote; any normal (non-signoff) turn is a dissent that clears
   * the map. When the size reaches the agent count the debate closes early.
   */
  signoffs: Map<string, string>;
  /** Set when the debate closed early via unanimous signoff (drives result.json). */
  earlyClose?: { reason: 'unanimous_signoff' };
}

export interface HubOptions {
  waitCapMs?: number;
  /** Archive root. Default `defaultLogsDir()` (`MOAMCP_LOGS_DIR` or `<MOAMCP_HOME|~/.moamcp>/logs`). */
  logsDir?: string;
  /** Domain-event sink (wired to the Bus by the server). Additive: payload-free core stays unchanged. */
  emit?: (taskId: string, event: DomainEvent) => void;
  /** Builds the debate-card URL returned by moa_init (injected by the server once the port is known). */
  cardUrlFactory?: (taskId: string) => string;
}

/** Domain events emitted by the hub; the Bus adds task_id/ts when fanning out. */
export interface DomainEvent {
  type:
    | 'task_initialized'
    | 'debate_started'
    | 'turn_submitted'
    | 'turn_advanced'
    | 'signoff_reset'
    | 'debate_complete'
    | 'task_closed';
  [key: string]: unknown;
}

export class DebateHub {
  private tasks = new Map<string, DebateTask>();
  /** Per-task promise queue: serializes submit/complete/wait-check against each other. */
  private queues = new Map<string, Promise<unknown>>();
  private readonly waitCapMs: number;
  private readonly logsDir: string;
  private readonly emitFn?: (taskId: string, event: DomainEvent) => void;
  private readonly cardUrlFactory?: (taskId: string) => string;

  constructor(opts: HubOptions = {}) {
    this.waitCapMs = opts.waitCapMs ?? DEFAULT_WAIT_CAP_MS;
    this.logsDir = opts.logsDir ?? defaultLogsDir();
    this.emitFn = opts.emit;
    this.cardUrlFactory = opts.cardUrlFactory;
  }

  private emit(taskId: string, event: DomainEvent): void {
    this.emitFn?.(taskId, event);
  }

  // ---- control tools (orchestrator) ----

  /**
   * Returns `{ok, agents}` — `agents` is the dispatch map `[{id, binding_slot?}]`
   * the orchestrator uses to spawn each debater with its bound model. Plus
   * `card_url` when a `cardUrlFactory` was injected (port-discovery design
   * §3.4; additive field, older callers ignore it).
   */
  init(taskId: string, preset: PresetConfig): { ok: true; card_url?: string; agents: Array<{ id: string; binding_slot?: string }> } {
    if (this.tasks.has(taskId)) throw new Error(`task already exists: ${taskId}`);
    const agents = (preset.agents ?? []).map((a) => (typeof a === 'string' ? { id: a } : a));
    const agentDispatch = agents.map((a) => {
      const entry: { id: string; binding_slot?: string } = { id: a.id };
      if (a.binding_slot !== undefined) entry.binding_slot = a.binding_slot;
      return entry;
    });
    if (agents.length === 0) throw new Error('preset_config.agents must be a non-empty list');
    const ids = new Set<string>();
    for (const a of agents) {
      if (!a.id) throw new Error('every agent needs an id');
      if (ids.has(a.id)) throw new Error(`duplicate agent id: ${a.id}`);
      ids.add(a.id);
    }
    const probes: Record<string, unknown> = {};
    for (const a of agents) probes[a.id] = { ...a, initialized_at: new Date().toISOString() };
    this.tasks.set(taskId, {
      taskId,
      preset,
      agents,
      agentIds: agents.map((a) => a.id),
      rounds: preset.debate?.rounds ?? 2,
      status: 'initialized',
      round: 1,
      turnIndex: 0,
      turn: 1,
      referenceResults: null,
      transcript: [],
      probes,
      waiters: new Set(),
      createdAt: new Date().toISOString(),
      signoffs: new Map(),
    });
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(preset)) {
      if (k !== 'agents' && k !== 'debate') extras[k] = v;
    }
    this.emit(taskId, {
      type: 'task_initialized',
      agents: agents.map((a) => a.id),
      agent_specs: agents,
      rounds: preset.debate?.rounds ?? 2,
      extras,
    });
    if (this.cardUrlFactory === undefined) return { ok: true, agents: agentDispatch };
    return { ok: true, card_url: this.cardUrlFactory(taskId), agents: agentDispatch };
  }

  async startDebate(taskId: string, referenceResults: unknown): Promise<{ ok: true }> {
    return this.enqueue(taskId, () => {
      const task = this.getTask(taskId);
      if (task.status !== 'initialized') throw new Error(`task ${taskId} is not in initialized state (got ${task.status})`);
      task.referenceResults = referenceResults;
      task.status = 'debating';
      task.round = 1;
      task.turnIndex = 0;
      task.turn = 1;
      task.signoffs.clear();
      task.earlyClose = undefined;
      this.emit(taskId, { type: 'debate_started', agents: task.agentIds, rounds: task.rounds });
      return { ok: true as const };
    });
  }

  // ---- mailbox tools (debate agents) ----

  /**
   * Long-poll: resolves immediately if it is the agent's turn (or the debate
   * is over); otherwise suspends until a submit/complete wakes it, or the
   * safety cap fires with {status:'timeout', retry:true}.
   */
  async waitTurn(taskId: string, agentId: string): Promise<WaitPayload> {
    // The check runs inside the per-task queue (atomic w.r.t. submits), but
    // the suspended promise is returned in a holder so the queue itself does
    // NOT wait for it — otherwise every later call would queue behind it.
    type Outcome = { kind: 'now'; payload: WaitPayload } | { kind: 'suspended'; promise: Promise<WaitPayload> };
    const outcome = await this.enqueue<Outcome>(taskId, () => {
      const task = this.getTask(taskId);
      if (!task.agentIds.includes(agentId)) throw new Error(`unknown agent_id: ${agentId}`);
      if (task.status === 'debating' && this.currentSpeaker(task) === agentId) {
        return { kind: 'now', payload: this.turnPayload(task) };
      }
      if (task.status === 'complete') {
        return { kind: 'now', payload: { status: 'debate_complete', transcript: task.transcript } };
      }
      if (task.status === 'closed') return { kind: 'now', payload: { status: 'closed' } };
      const promise = new Promise<WaitPayload>((resolve) => {
        const waiter: Waiter = {
          agentId,
          resolve,
          timer: setTimeout(() => {
            task.waiters.delete(waiter);
            resolve({ status: 'timeout', retry: true });
          }, this.waitCapMs),
        };
        task.waiters.add(waiter);
      });
      return { kind: 'suspended', promise };
    });
    return outcome.kind === 'now' ? outcome.payload : outcome.promise;
  }

  async submitTurn(
    taskId: string,
    agentId: string,
    content: string,
    signoff = false,
  ): Promise<
    | { accepted: true; debate_complete?: boolean; early?: boolean; reason?: string; next_speaker?: string; round?: number }
    | { error: string }
  > {
    return this.enqueue(taskId, () => {
      const task = this.getTask(taskId);
      if (!task.agentIds.includes(agentId)) throw new Error(`unknown agent_id: ${agentId}`);
      if (task.status !== 'debating') return { error: 'debate_not_active' };
      if (this.currentSpeaker(task) !== agentId) {
        return { error: 'not_your_turn' };
      }
      const record: TurnRecord = {
        turn: task.turn,
        round: task.round,
        speaker: agentId,
        content,
        timestamp: new Date().toISOString(),
      };
      if (signoff) record.signoff = true;
      task.transcript.push(record);
      this.emit(taskId, {
        type: 'turn_submitted',
        agent_id: agentId,
        round: task.round,
        turn: task.turn,
        // Full text for the card; excerpt kept for backward compatibility with
        // older subscribers that only read `excerpt`.
        content,
        excerpt: content.length > 200 ? content.slice(0, 200) + '…' : content,
        ...(signoff ? { signoff: true } : {}),
      });
      // Unanimous-signoff bookkeeping: a signoff turn casts an early-close vote;
      // any normal (non-signoff) turn is a dissent that wipes accumulated votes.
      if (signoff) {
        task.signoffs.set(agentId, content);
      } else if (task.signoffs.size > 0) {
        const resetFrom = task.signoffs.size;
        task.signoffs.clear();
        this.emit(taskId, {
          type: 'signoff_reset',
          agent_id: agentId,
          round: task.round,
          reset_from: resetFrom,
        });
      }
      // Unanimous signoff → early close, ahead of the normal round advance.
      if (task.signoffs.size === task.agentIds.length) {
        task.status = 'complete';
        task.earlyClose = { reason: 'unanimous_signoff' };
        this.emit(taskId, {
          type: 'debate_complete',
          rounds: task.rounds,
          turns: task.transcript.length,
          early: true,
          reason: 'unanimous_signoff',
          signoffs: Object.fromEntries(task.signoffs),
        });
        this.wakeAll(task, { status: 'debate_complete', transcript: task.transcript });
        return { accepted: true as const, debate_complete: true, early: true, reason: 'unanimous_signoff' };
      }
      // Advance round-robin.
      task.turn += 1;
      task.turnIndex += 1;
      if (task.turnIndex >= task.agentIds.length) {
        task.turnIndex = 0;
        task.round += 1;
        if (task.round > task.rounds) {
          task.status = 'complete';
          this.emit(taskId, { type: 'debate_complete', rounds: task.rounds, turns: task.transcript.length });
          this.wakeAll(task, { status: 'debate_complete', transcript: task.transcript });
          return { accepted: true as const, debate_complete: true };
        }
      }
      const next = this.currentSpeaker(task);
      this.emit(taskId, { type: 'turn_advanced', round: task.round, speaker: next });
      this.wakeSpeaker(task, next);
      return { accepted: true as const, next_speaker: next, round: task.round };
    });
  }

  // ---- archive & close ----

  async complete(taskId: string): Promise<{ ok: true; archive: string }> {
    return this.enqueue(taskId, async () => {
      const task = this.getTask(taskId);
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const dir = resolve(this.logsDir, taskId);
      await mkdir(dir, { recursive: true });
      const finishedAt = new Date().toISOString();
      // Layer 1: agent startup snapshots (from moa_init).
      await writeFile(
        resolve(dir, 'probe.json'),
        JSON.stringify({ task_id: taskId, created_at: task.createdAt, agents: task.probes }, null, 2),
      );
      // Layer 2: full transcript, one JSON record per line.
      await writeFile(resolve(dir, 'events.jsonl'), task.transcript.map((t) => JSON.stringify(t)).join('\n') + '\n');
      // Layer 3: final state. An early unanimous-signoff close records the
      // rounds actually run (the signoff round terminates the debate, so it is
      // not counted as a completed debate round) plus the signoff roster.
      const result: Record<string, unknown> = {
        task_id: taskId,
        status: task.status,
        rounds_configured: task.rounds,
        rounds_completed: task.earlyClose
          ? task.round - 1
          : task.status === 'complete' || task.status === 'closed'
            ? task.rounds
            : task.round - 1,
        turns: task.transcript.length,
        finished_at: finishedAt,
      };
      if (task.earlyClose) {
        result.early = true;
        result.reason = task.earlyClose.reason;
        result.signoffs = Object.fromEntries(task.signoffs);
      }
      await writeFile(resolve(dir, 'result.json'), JSON.stringify(result, null, 2));
      task.status = 'closed';
      this.wakeAll(task, { status: 'closed' });
      this.emit(taskId, { type: 'task_closed', archive: dir, turns: task.transcript.length });
      return { ok: true as const, archive: dir };
    });
  }

  // ---- internals ----

  private getTask(taskId: string): DebateTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task_id: ${taskId}`);
    return task;
  }

  private currentSpeaker(task: DebateTask): string {
    return task.agentIds[task.turnIndex];
  }

  private turnPayload(task: DebateTask): WaitPayload {
    const speaker = this.currentSpeaker(task);
    return {
      status: 'your_turn',
      speaker_id: speaker,
      round: task.round,
      prompt: this.buildPrompt(task),
      full_context: { reference_results: task.referenceResults, transcript: task.transcript },
    };
  }

  /** Prompt strategy per design doc §4b.3; the submission protocol rides on every round. */
  private buildPrompt(task: DebateTask): string {
    let round: string;
    if (task.round <= 1) {
      round = 'Round 1: 审查其他 agent 结论的推理过程，找出逻辑漏洞、遗漏的检查点';
    } else if (task.round < task.rounds) {
      round = `Round ${task.round}: 回应对方的质疑`;
    } else {
      round = `Round ${task.round} (final): 考虑所有质疑后，重新给出最终结论`;
    }
    return `${round}\n\n${SUBMISSION_PROTOCOL}\n\n${this.signoffStatus(task)}\n\n${SIGNOFF_PROTOCOL}`;
  }

  /** Live signoff tally line prepended to the signoff protocol (N/M votes so far). */
  private signoffStatus(task: DebateTask): string {
    const signed = task.signoffs.size;
    const total = task.agentIds.length;
    return signed > 0
      ? `当前已有 ${signed}/${total} 个辩手签字同意提前闭合。你可以签字同意（\`signoff: true\`）促成提前闭合，或提交普通发言继续辩论（视为异议，清零已有签字）。`
      : `目前尚无辩手签字（0/${total}）。你可以签字同意提前闭合（\`signoff: true\`），或提交普通发言继续辩论。`;
  }

  private wakeSpeaker(task: DebateTask, speakerId: string): void {
    const payload = this.turnPayload(task);
    for (const waiter of [...task.waiters]) {
      if (waiter.agentId === speakerId) {
        task.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(payload);
      }
    }
  }

  private wakeAll(task: DebateTask, payload: WaitPayload): void {
    for (const waiter of [...task.waiters]) {
      task.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
    }
  }

  /** Serialize all state mutations for one task through a promise chain. */
  private enqueue<T>(taskId: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.queues.get(taskId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(
      taskId,
      next.catch(() => {}),
    );
    return next;
  }
}
