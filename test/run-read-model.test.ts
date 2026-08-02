import { describe, expect, it } from 'vitest';
import { RunReadModel, type RunEventEnvelope } from '../src/run-read-model.js';

const event = (
  task_id: string,
  ts: string,
  type: string,
  fields: Record<string, unknown> = {},
): RunEventEnvelope => ({ task_id, ts, type, ...fields });

describe('RunReadModel', () => {
  it('reduces a complete normal lifecycle without retaining transcript content', () => {
    const model = new RunReadModel();
    expect(model.ingest(event('run-1', '2026-01-01T00:00:00.000Z', 'task_initialized', {
      agents: ['reviewer', 'builder'],
      agent_specs: [
        { id: 'reviewer', binding_slot: 'opus', prompt: 'private configuration' },
        { id: 'builder' },
      ],
      rounds: 2,
    }))).toBe(true);
    model.ingest(event('run-1', '2026-01-01T00:00:01.000Z', 'debate_started', {
      agents: ['reviewer', 'builder'], rounds: 2,
    }));

    expect(model.read('run-1')).toMatchObject({
      status: 'debating',
      round: 1,
      currentSpeaker: 'reviewer',
      turnCount: 0,
    });

    model.ingest(event('run-1', '2026-01-01T00:00:02.000Z', 'turn_submitted', {
      agent_id: 'reviewer', round: 1, turn: 1, content: 'must never enter the projection', next_speaker: 'wrong',
    }));
    expect(model.read('run-1')).toMatchObject({ turn: 1, turnCount: 1, currentSpeaker: 'reviewer' });

    model.ingest(event('run-1', '2026-01-01T00:00:03.000Z', 'turn_advanced', {
      round: 1, speaker: 'builder',
    }));
    model.ingest(event('run-1', '2026-01-01T00:00:04.000Z', 'turn_submitted', {
      agent_id: 'builder', round: 1, turn: 2, content: 'also secret',
    }));
    model.ingest(event('run-1', '2026-01-01T00:00:05.000Z', 'turn_advanced', {
      round: 2, speaker: 'reviewer',
    }));
    model.ingest(event('run-1', '2026-01-01T00:00:06.000Z', 'debate_complete', { rounds: 2, turns: 2 }));
    model.ingest(event('run-1', '2026-01-01T00:00:07.000Z', 'task_closed', { archive: '/private/path' }));

    const summary = model.read('run-1');
    expect(summary).toEqual({
      taskId: 'run-1',
      status: 'closed',
      agents: ['reviewer', 'builder'],
      agentSpecs: [{ id: 'reviewer', binding_slot: 'opus' }, { id: 'builder' }],
      roundsConfigured: 2,
      round: 2,
      turn: 2,
      currentSpeaker: null,
      turnCount: 2,
      signoffCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:07.000Z',
      lastEvent: 'task_closed',
    });
    expect(JSON.stringify(summary)).not.toContain('secret');
    expect(JSON.stringify(summary)).not.toContain('content');
    expect(() => JSON.stringify(model.list())).not.toThrow();
  });

  it('deduplicates unanimous signoffs and exposes the early completion reason', () => {
    const model = new RunReadModel([
      event('signoff', '2026-02-01T00:00:00.000Z', 'task_initialized', { agents: ['a', 'b'], rounds: 5 }),
      event('signoff', '2026-02-01T00:00:01.000Z', 'debate_started'),
      event('signoff', '2026-02-01T00:00:02.000Z', 'turn_submitted', { agent_id: 'a', round: 1, turn: 1, signoff: true }),
      event('signoff', '2026-02-01T00:00:03.000Z', 'turn_submitted', { agent_id: 'a', round: 1, turn: 2, signoff: true }),
      event('signoff', '2026-02-01T00:00:04.000Z', 'turn_submitted', { agent_id: 'b', round: 1, turn: 3, signoff: true }),
      event('signoff', '2026-02-01T00:00:05.000Z', 'debate_complete', { early: true, reason: 'unanimous_signoff' }),
    ]);

    expect(model.read('signoff')).toMatchObject({
      status: 'complete',
      turnCount: 3,
      signoffCount: 2,
      early: true,
      reason: 'unanimous_signoff',
      currentSpeaker: null,
    });
  });

  it('clears all signatures on signoff_reset', () => {
    const model = new RunReadModel([
      event('reset', '2026-03-01T00:00:00.000Z', 'task_initialized', { agents: ['a', 'b'] }),
      event('reset', '2026-03-01T00:00:01.000Z', 'turn_submitted', { agent_id: 'a', signoff: true }),
      event('reset', '2026-03-01T00:00:02.000Z', 'signoff_reset', { reset_from: 1 }),
    ]);
    expect(model.read('reset')).toMatchObject({ signoffCount: 0, lastEvent: 'signoff_reset' });
  });

  it('tolerates missing and malformed fields, and unknown events only mark activity', () => {
    const model = new RunReadModel();
    model.ingest(event('safe', '2026-04-01T00:00:00.000Z', 'task_initialized', {
      agents: ['a', '', 3, 'a', 'b'],
      agent_specs: [
        null,
        { id: 'a', binding_slot: 42 },
        { id: 'a', binding_slot: 'real-slot' },
        { id: 'b' },
        { id: 9, binding_slot: 'bad' },
      ],
      rounds: Number.NaN,
    }));
    model.ingest(event('safe', '2026-04-01T00:00:01.000Z', 'debate_started', { rounds: '3' }));
    model.ingest(event('safe', '2026-04-01T00:00:02.000Z', 'turn_submitted', {
      round: false, turn: Infinity, signoff: true,
    }));

    const beforeUnknown = model.read('safe');
    model.apply(event('safe', '2026-04-01T00:00:03.000Z', 'legacy_client_note', {
      status: 'closed', agents: ['attacker'], content: 'ignored',
    }));
    expect(model.read('safe')).toEqual({
      ...beforeUnknown,
      updatedAt: '2026-04-01T00:00:03.000Z',
      lastEvent: 'legacy_client_note',
    });
    expect(model.read('safe')).toMatchObject({
      status: 'debating',
      agents: ['a', 'b'],
      agentSpecs: [{ id: 'a', binding_slot: 'real-slot' }, { id: 'b' }],
      roundsConfigured: null,
      round: 1,
      turn: null,
      turnCount: 1,
      signoffCount: 0,
    });

    expect(model.ingest(null)).toBe(false);
    expect(model.ingest({ task_id: 'safe', ts: 'not-a-date', type: 'task_closed' })).toBe(false);
    expect(model.ingest({ task_id: 'safe', ts: '2026-04-01T00:00:04.000Z' })).toBe(false);
    expect(model.ingest(event('stray', '2026-04-01T00:00:04.000Z', 'unknown'))).toBe(false);
    expect(model.read('stray')).toBeUndefined();
    expect(model.read('safe')?.status).toBe('debating');
  });

  it('ignores every system channel whose task id starts with @', () => {
    const model = new RunReadModel();
    expect(model.ingest(event('@board/global', '2026-05-01T00:00:00.000Z', 'task_initialized', { agents: ['x'] }))).toBe(false);
    expect(model.ingest(event('@system', '2026-05-01T00:00:01.000Z', 'task_closed'))).toBe(false);
    expect(model.list()).toEqual([]);
  });

  it('sorts by updatedAt descending with stable ties', () => {
    const model = new RunReadModel([
      event('first', '2026-06-01T00:00:00.000Z', 'task_initialized'),
      event('second', '2026-06-01T00:00:02.000Z', 'task_initialized'),
      event('third', '2026-06-01T00:00:02.000Z', 'task_initialized'),
      event('first', '2026-06-01T00:00:03.000Z', 'legacy_ping'),
    ]);
    expect(model.list().map((summary) => summary.taskId)).toEqual(['first', 'second', 'third']);
  });

  it('returns defensive copies from both read and list', () => {
    const model = new RunReadModel([
      event('copy', '2026-07-01T00:00:00.000Z', 'task_initialized', {
        agents: ['a'], agent_specs: [{ id: 'a', binding_slot: 'slot-a' }], rounds: 2,
      }),
    ]);

    const read = model.read('copy')!;
    read.status = 'closed';
    read.agents.push('intruder');
    read.agentSpecs[0].id = 'changed';
    read.agentSpecs.push({ id: 'new', binding_slot: 'fake' });

    const listed = model.list();
    listed[0].agents.length = 0;
    listed[0].agentSpecs[0].binding_slot = 'mutated';
    listed.push({ ...listed[0], taskId: 'fabricated' });

    expect(model.read('copy')).toMatchObject({
      status: 'initialized',
      agents: ['a'],
      agentSpecs: [{ id: 'a', binding_slot: 'slot-a' }],
    });
    expect(model.list()).toHaveLength(1);
  });
});
