/**
 * Bus test: real HTTP/SSE against an in-process Bus wired to the hub's event
 * emitter. Asserts event order, the frontend card at /, the bus.port file,
 * replay to late subscribers, and POST /publish fan-out.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { DebateHub } from '../src/state.js';
import { Bus } from '../src/bus.js';

let bus: Bus;
let port: number;
let cwd: string;
let client: Client;

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
}

/** Open an SSE subscription; resolves once headers arrive (server has registered us). */
function subscribe(taskId: string): Promise<{ events: any[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = get(`http://127.0.0.1:${port}/subscribe?task_id=${taskId}`, (res) => {
      const events: any[] = [];
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line) events.push(JSON.parse(line.slice(6)));
        }
      });
      resolve({ events, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'moamcp-bus-'));
  bus = new Bus({ port: 0, cwd }); // port 0 = OS-assigned, avoids clobbering a real 8913
  port = await bus.start();
  const hub = new DebateHub({ emit: (taskId, event) => bus.publish(taskId, event) });
  const server = createServer(hub);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'bus-test', version: '0.0.1' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await bus.stop();
  await rm(cwd, { recursive: true, force: true });
});

it('writes the actual port to {cwd}/bus.port on startup', async () => {
  expect(await readFile(join(cwd, 'bus.port'), 'utf8')).toBe(String(port));
});

it('serves the frontend card at GET /', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
  const html = await res.text();
  expect(html).toContain('MOA Debate');
  expect(html).toContain("EventSource('/subscribe?task_id=");
});

it('fans out turn_submitted/turn_advanced in order over real SSE', async () => {
  const sub = await subscribe('bus-1');
  await call('moa_init', { task_id: 'bus-1', preset_config: { agents: ['a1', 'a2'], debate: { rounds: 1 } } });
  await call('moa_start_debate', { task_id: 'bus-1', reference_results: ['r1'] });
  const a1 = await call('moa_wait_turn', { task_id: 'bus-1', agent_id: 'a1' });
  expect(a1.status).toBe('your_turn');
  await call('moa_submit_turn', { task_id: 'bus-1', agent_id: 'a1', content: 'a1 speaks' });
  const a2 = await call('moa_wait_turn', { task_id: 'bus-1', agent_id: 'a2' });
  expect(a2.status).toBe('your_turn');
  await call('moa_submit_turn', { task_id: 'bus-1', agent_id: 'a2', content: 'a2 speaks' });
  await call('moa_complete', { task_id: 'bus-1' });
  await tick();
  sub.close();

  const types = sub.events.map((e) => e.type);
  expect(types).toEqual([
    'task_initialized',
    'debate_started',
    'turn_submitted',
    'turn_advanced',
    'turn_submitted',
    'debate_complete',
    'task_closed',
  ]);
  expect(sub.events[2]).toMatchObject({ task_id: 'bus-1', agent_id: 'a1', round: 1, turn: 1, excerpt: 'a1 speaks' });
  expect(sub.events[3]).toMatchObject({ round: 1, speaker: 'a2' });
  expect(sub.events[5]).toMatchObject({ rounds: 1, turns: 2 });
  expect(sub.events[0]).toMatchObject({ agents: ['a1', 'a2'], rounds: 1 });
  expect(sub.events[0].agent_specs).toEqual([{ id: 'a1' }, { id: 'a2' }]);
  expect(sub.events.every((e) => typeof e.ts === 'string')).toBe(true);

  // Late subscriber gets the per-task log replayed from the beginning.
  const late = await subscribe('bus-1');
  await tick();
  late.close();
  expect(late.events.map((e) => e.type)).toEqual(types);
});

it('POST /publish fans a custom event out to subscribers', async () => {
  const sub = await subscribe('bus-2');
  const res = await fetch(`http://127.0.0.1:${port}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_id: 'bus-2', event: { type: 'hub_note', msg: 'hello' } }),
  });
  expect(res.status).toBe(200);
  await tick();
  sub.close();
  expect(sub.events).toHaveLength(1);
  expect(sub.events[0]).toMatchObject({ type: 'hub_note', msg: 'hello', task_id: 'bus-2' });
});

it('serves archived files at GET /archive after moa_complete', async () => {
  // bus-1 was completed (and archived to ./logs/bus-1) in the SSE test above.
  const res = await fetch(`http://127.0.0.1:${port}/archive?task_id=bus-1&file=result.json`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/json');
  const json = (await res.json()) as Record<string, unknown>;
  expect(json).toMatchObject({ task_id: 'bus-1', status: 'complete', turns: 2 });

  const jsonl = await fetch(`http://127.0.0.1:${port}/archive?task_id=bus-1&file=events.jsonl`);
  expect(jsonl.status).toBe(200);
  expect(await jsonl.text()).toContain('"speaker":"a1"');

  // Whitelist + traversal guards.
  const badFile = await fetch(`http://127.0.0.1:${port}/archive?task_id=bus-1&file=../../package.json`);
  expect(badFile.status).toBe(400);
  const badTask = await fetch(`http://127.0.0.1:${port}/archive?task_id=..&file=result.json`);
  expect(badTask.status).toBe(400);
  const missing = await fetch(`http://127.0.0.1:${port}/archive?task_id=nope&file=result.json`);
  expect(missing.status).toBe(404);
});

it('deletes bus.port on clean shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moamcp-bus-stop-'));
  const b = new Bus({ port: 0, cwd: dir });
  await b.start();
  await b.stop();
  await expect(readFile(join(dir, 'bus.port'), 'utf8')).rejects.toThrow();
  await rm(dir, { recursive: true, force: true });
});
