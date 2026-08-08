/**
 * Tower delegator channel (M1) — moa_tower_boot with delegator_agent_id
 * registers a roster entry {name:"delegator", kind:"delegator", agentId}.
 * Authorization: a delegator may ONLY call moa_tower_send, and only
 * addressed to the tower; every other tower tool rejects it with a clear
 * TowerProtocolError (requireTower tools: "not the control tower";
 * resolveCaller tools: "delegators may only call moa_tower_send"). Also
 * covers send-to-non-tower rejection and the tower inbox receiving the
 * delegator's message.
 *
 * Real git temp repo; no CI involved → 30s file-level timeout.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BoardStore } from '../src/core/store/board.js';
import { createServer } from '../src/server.js';
import { createTowerController, createTowerModule } from '../src/modules/tower/index.js';

vi.setConfig({ testTimeout: 30000 });

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
});

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`git ${args.join(' ')} failed: ${String(stderr).trim()}`));
      else resolve(stdout);
    });
  });
}

interface DelegatorEnv {
  client: Client;
  close: () => Promise<void>;
  repoRoot: string;
}

/** Boot with a delegator agent id (and a worker so send-to-non-tower has a
 *  real target). */
async function makeEnv(): Promise<DelegatorEnv> {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-delegator-'));
  homes.push(home);
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await run(repoRoot, ['init', '-b', 'main']);
  await run(repoRoot, ['config', 'user.email', 'tower-test@example.com']);
  await run(repoRoot, ['config', 'user.name', 'Tower Test']);
  await writeFile(join(repoRoot, 'README.md'), '# tower delegator test\n');
  await run(repoRoot, ['add', '-A']);
  await run(repoRoot, ['commit', '-m', 'initial']);

  const board = new BoardStore({ homeDir: home, workspaceCwd: join(home, 'server-cwd'), waitCapMs: 200, pollIntervalMs: 15 });
  const controller = createTowerController();
  controller.mountBoard(board);
  const server = createServer(undefined, undefined, board, undefined, undefined, createTowerModule(controller));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'tower-delegator-test', version: '0.0.1' });
  await client.connect(clientTransport);

  const boot = await call(client, 'moa_tower_boot', {
    workspace: repoRoot,
    tower_agent_id: 'agent-orch',
    delegator_agent_id: 'agent-deleg',
  });
  expect(boot).toMatchObject({ booted: true, base: 'main' });
  expect(boot.roster).toEqual(['tower', 'delegator']);

  // A real worker target for the send-to-non-tower rejection.
  await call(client, 'moa_tower_plan', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    missions: [{ title: 'Build the parser', scope: ['src/**'] }],
  });
  await call(client, 'moa_tower_spawn', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'w1', kind: 'worker', mission_id: 'M1',
  });
  await call(client, 'moa_tower_register', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'w1', agent_id: 'agent-w1',
  });
  return { client, close: () => client.close(), repoRoot };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  return JSON.parse((response.content as Array<{ type: string; text: string }>)[0].text);
}

it('boot with delegator_agent_id registers the delegator roster entry (status shows kind=delegator)', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  const status = await call(client, 'moa_tower_status', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
  const delegatorRow = status.roster.find((r: { name: string }) => r.name === 'delegator');
  expect(delegatorRow).toMatchObject({ name: 'delegator', kind: 'delegator', agentId: 'agent-deleg' });
  await env.close();
});

it('delegator can moa_tower_send to the tower; the tower inbox receives it', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  const sent = await call(client, 'moa_tower_send', {
    workspace: repoRoot,
    caller_agent_id: 'agent-deleg',
    to: 'tower',
    subject: 'handoff: mission M1',
    body: 'scope is ready for review',
    scope: 'M1',
  });
  expect(sent.sent).toBe(true);
  expect(sent.to).toBe('tower');

  const inbox = await call(client, 'moa_tower_inbox', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
  expect(inbox.count).toBeGreaterThanOrEqual(1);
  const message = inbox.messages.find((m: { from: string }) => m.from === 'delegator');
  expect(message).toMatchObject({
    from: 'delegator',
    to: 'tower',
    subject: 'handoff: mission M1',
    body: 'scope is ready for review',
    scope: 'M1',
  });
  await env.close();
});

it('delegator send is rejected when addressed anywhere but the tower', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  const toWorker = await call(client, 'moa_tower_send', {
    workspace: repoRoot,
    caller_agent_id: 'agent-deleg',
    to: 'w1',
    subject: 'hi',
    body: 'should be rejected',
  });
  expect(toWorker.isError).toBe(true);
  expect(toWorker.output).toMatch(/delegators may only send messages addressed to "tower"/);

  const toAll = await call(client, 'moa_tower_send', {
    workspace: repoRoot,
    caller_agent_id: 'agent-deleg',
    to: 'all',
    subject: 'broadcast',
    body: 'should be rejected',
  });
  expect(toAll.isError).toBe(true);
  expect(toAll.output).toMatch(/delegators may only send messages addressed to "tower"/);
  await env.close();
});

it('requireTower tools reject the delegator (plan / register / merge / ci / teardown)', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;

  const plan = await call(client, 'moa_tower_plan', {
    workspace: repoRoot,
    caller_agent_id: 'agent-deleg',
    missions: [{ title: 'Hijack', scope: ['src/**'] }],
  });
  expect(plan.isError).toBe(true);
  expect(plan.output).toMatch(/not the control tower/);

  const register = await call(client, 'moa_tower_register', {
    workspace: repoRoot, caller_agent_id: 'agent-deleg', name: 'w1', agent_id: 'agent-evil',
  });
  expect(register.isError).toBe(true);
  expect(register.output).toMatch(/not the control tower/);

  const merge = await call(client, 'moa_tower_merge', {
    workspace: repoRoot, caller_agent_id: 'agent-deleg', branch: 'feat/M1-build-the-parser',
  });
  expect(merge.isError).toBe(true);
  expect(merge.output).toMatch(/not the control tower/);

  const ci = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-deleg', branch: 'feat/M1-build-the-parser',
  });
  expect(ci.isError).toBe(true);
  expect(ci.output).toMatch(/not the control tower/);

  const teardown = await call(client, 'moa_tower_teardown', {
    workspace: repoRoot, caller_agent_id: 'agent-deleg',
  });
  expect(teardown.isError).toBe(true);
  expect(teardown.output).toMatch(/not the control tower/);
  await env.close();
});

it('caller-resolved tools reject the delegator (status / inbox / mission / finding / review / progress / wait)', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  const expected = /delegators may only call moa_tower_send/;

  const status = await call(client, 'moa_tower_status', { workspace: repoRoot, caller_agent_id: 'agent-deleg' });
  expect(status.isError).toBe(true);
  expect(status.output).toMatch(expected);

  const inbox = await call(client, 'moa_tower_inbox', { workspace: repoRoot, caller_agent_id: 'agent-deleg' });
  expect(inbox.isError).toBe(true);
  expect(inbox.output).toMatch(expected);

  const mission = await call(client, 'moa_tower_mission', {
    workspace: repoRoot, caller_agent_id: 'agent-deleg', id: 'M1',
  });
  expect(mission.isError).toBe(true);
  expect(mission.output).toMatch(expected);

  const finding = await call(client, 'moa_tower_finding', {
    workspace: repoRoot, caller_agent_id: 'agent-deleg', type: 'bug', title: 'x', summary: 's', details: 'd', suggested_fix: 'f',
  });
  expect(finding.isError).toBe(true);
  expect(finding.output).toMatch(expected);

  const review = await call(client, 'moa_tower_review', {
    workspace: repoRoot, caller_agent_id: 'agent-deleg', target: 'feat/M1-build-the-parser',
    status: 'clean', merge: 'merge', findings: 'none', decision: 'ok',
  });
  expect(review.isError).toBe(true);
  expect(review.output).toMatch(expected);

  const progress = await call(client, 'moa_tower_progress', {
    workspace: repoRoot, caller_agent_id: 'agent-deleg', mission_id: 'M1', note: 'nope',
  });
  expect(progress.isError).toBe(true);
  expect(progress.output).toMatch(expected);

  const wait = await call(client, 'moa_tower_wait', {
    workspace: repoRoot, caller_agent_id: 'agent-deleg', wait: { kind: 'inbox' }, timeoutMs: 200,
  });
  expect(wait.isError).toBe(true);
  expect(wait.output).toMatch(expected);
  await env.close();
});

it('an unregistered agent id is still not a participant (delegator_agent_id alone does not open the roster)', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  const send = await call(client, 'moa_tower_send', {
    workspace: repoRoot,
    caller_agent_id: 'agent-mallory',
    to: 'tower',
    subject: 'x',
    body: 'y',
  });
  expect(send.isError).toBe(true);
  expect(send.output).toMatch(/not a tower participant/);
  await env.close();
});
