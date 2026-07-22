/**
 * Smoke test: in-process server (InMemoryTransport), 3 agents, 1 round.
 * Covers: init → start_debate → round-robin waits/submits → wrong-turn
 * rejection → debate_complete wake-up → archive files → unknown ids error.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { DebateHub } from '../src/state.js';

let client: Client;
let logsDir: string;

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0].text;
  return JSON.parse(text);
}

beforeAll(async () => {
  logsDir = await mkdtemp(join(tmpdir(), 'moamcp-test-'));
  // Short cap so the timeout path is testable; logs go to a temp dir.
  const hub = new DebateHub({ waitCapMs: 300, logsDir });
  const server = createServer(hub);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'smoke-test', version: '0.0.1' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await rm(logsDir, { recursive: true, force: true });
});

it('runs a full 3-agent, 1-round mailbox debate and archives it', async () => {
  const task = 'smoke-1';
  const agents = ['agent_A', 'agent_B', 'agent_C'];

  // init + start_debate
  expect(await call('moa_init', { task_id: task, preset_config: { agents, debate: { rounds: 1 } } }))
    .toEqual({ ok: true });
  expect(await call('moa_start_debate', { task_id: task, reference_results: ['ref A', 'ref B'] }))
    .toEqual({ ok: true });

  // B waits first — must stay suspended (not its turn).
  let bResolved = false;
  const bWait = call('moa_wait_turn', { task_id: task, agent_id: 'agent_B' }).then((r) => {
    bResolved = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(bResolved).toBe(false);

  // A waits — it is A's turn, resolves immediately.
  const aTurn = await call('moa_wait_turn', { task_id: task, agent_id: 'agent_A' });
  expect(aTurn.status).toBe('your_turn');
  expect(aTurn.speaker_id).toBe('agent_A');
  expect(aTurn.round).toBe(1);
  expect(aTurn.full_context.reference_results).toEqual(['ref A', 'ref B']);
  expect(bResolved).toBe(false); // B still suspended while A holds the turn

  // Wrong-turn submit is rejected (B submits while A is the speaker).
  expect(await call('moa_submit_turn', { task_id: task, agent_id: 'agent_B', content: 'too early' }))
    .toEqual({ error: 'not_your_turn' });
  expect(bResolved).toBe(false);

  // A submits → B's pending wait wakes with the turn.
  const aSubmit = await call('moa_submit_turn', { task_id: task, agent_id: 'agent_A', content: 'A: found a flaw in db.go' });
  expect(aSubmit).toMatchObject({ accepted: true, next_speaker: 'agent_B', round: 1 });
  const bTurn = await bWait;
  expect(bTurn.status).toBe('your_turn');
  expect(bTurn.speaker_id).toBe('agent_B');
  expect(bTurn.full_context.transcript).toHaveLength(1);

  // B and C take their turns; A waits again and is woken by debate completion.
  expect(await call('moa_submit_turn', { task_id: task, agent_id: 'agent_B', content: 'B: agree, also handler.go' }))
    .toMatchObject({ accepted: true, next_speaker: 'agent_C' });
  const aWaitAgain = call('moa_wait_turn', { task_id: task, agent_id: 'agent_A' });
  const cSubmit = await call('moa_submit_turn', { task_id: task, agent_id: 'agent_C', content: 'C: concur, plus tests missing' });
  expect(cSubmit).toMatchObject({ accepted: true, debate_complete: true });

  const aDone = await aWaitAgain;
  expect(aDone.status).toBe('debate_complete');
  expect(aDone.transcript).toHaveLength(3);
  expect(aDone.transcript.map((t: any) => t.speaker)).toEqual(agents);

  // After completion, wait_turn returns debate_complete immediately.
  const late = await call('moa_wait_turn', { task_id: task, agent_id: 'agent_C' });
  expect(late.status).toBe('debate_complete');

  // moa_complete writes the three-layer archive.
  const done = await call('moa_complete', { task_id: task });
  expect(done.ok).toBe(true);

  const probe = JSON.parse(await readFile(join(logsDir, task, 'probe.json'), 'utf8'));
  expect(Object.keys(probe.agents)).toEqual(agents);
  expect(probe.agents.agent_A.initialized_at).toBeTruthy();

  const events = (await readFile(join(logsDir, task, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  expect(events).toHaveLength(3);
  expect(events[0]).toMatchObject({ turn: 1, round: 1, speaker: 'agent_A' });
  expect(events.every((e: any) => typeof e.timestamp === 'string')).toBe(true);

  const result = JSON.parse(await readFile(join(logsDir, task, 'result.json'), 'utf8'));
  expect(result).toMatchObject({ task_id: task, rounds_configured: 1, turns: 3 });
});

it('rejects unknown task_id / agent_id with an MCP error', async () => {
  await expect(call('moa_wait_turn', { task_id: 'nope', agent_id: 'agent_A' })).rejects.toThrow(/unknown task_id/);
  await expect(call('moa_wait_turn', { task_id: 'smoke-1', agent_id: 'agent_X' })).rejects.toThrow(/unknown agent_id/);
  await expect(call('moa_submit_turn', { task_id: 'smoke-1', agent_id: 'agent_X', content: 'x' })).rejects.toThrow(/unknown agent_id/);
});

it('suspended wait returns {status:"timeout", retry:true} at the safety cap', async () => {
  await call('moa_init', { task_id: 'smoke-2', preset_config: { agents: ['a1', 'a2'], debate: { rounds: 2 } } });
  await call('moa_start_debate', { task_id: 'smoke-2', reference_results: [] });
  // a2 is not the speaker; nobody submits → cap fires (hub configured with 300ms).
  const res = await call('moa_wait_turn', { task_id: 'smoke-2', agent_id: 'a2' });
  expect(res).toEqual({ status: 'timeout', retry: true });
});
