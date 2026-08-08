/**
 * Tower wait (M1) — moa_tower_wait over a REAL git temp repo with a fake
 * `node` CI command. Covers: kind=ci satisfied by a record matching the
 * current tip (wake + immediate-satisfy), NOT satisfied by a stale-tip record
 * (timeout until a fresh run lands), timeout path returns
 * {status:"timeout", retry:true}; kind=inbox wakes on a message send and
 * times out for an empty inbox; kind=mission wakes on a status change and
 * times out when the status never changes.
 *
 * Real git + node subprocesses → 30s file-level timeout.
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
import { createTowerController, createTowerModule, towerRepoKey } from '../src/modules/tower/index.js';

vi.setConfig({ testTimeout: 30000 });

const CI_SCRIPTS: Record<'green' | 'slow', string> = {
  green: 'process.exit(0);\n',
  slow: 'setTimeout(() => { process.exit(0); }, 800);\n',
};

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

interface WaitEnv {
  client: Client;
  close: () => Promise<void>;
  repoRoot: string;
  board: BoardStore;
}

async function makeEnv(ciKind: 'green' | 'slow' | 'none' = 'none'): Promise<WaitEnv> {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-wait-'));
  homes.push(home);
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await run(repoRoot, ['init', '-b', 'main']);
  await run(repoRoot, ['config', 'user.email', 'tower-test@example.com']);
  await run(repoRoot, ['config', 'user.name', 'Tower Test']);
  await writeFile(join(repoRoot, 'README.md'), '# tower wait test\n');
  await run(repoRoot, ['add', '-A']);
  await run(repoRoot, ['commit', '-m', 'initial']);

  let ciCommand: string | undefined;
  if (ciKind !== 'none') {
    const name = `ci-${ciKind}.js`;
    await writeFile(join(repoRoot, name), CI_SCRIPTS[ciKind]);
    ciCommand = `node ../../repo/${name}`;
  }

  const board = new BoardStore({ homeDir: home, workspaceCwd: join(home, 'server-cwd'), waitCapMs: 200, pollIntervalMs: 15 });
  const controller = createTowerController();
  controller.mountBoard(board);
  const server = createServer(undefined, undefined, board, undefined, undefined, createTowerModule(controller));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'tower-wait-test', version: '0.0.1' });
  await client.connect(clientTransport);

  const boot = await call(client, 'moa_tower_boot', {
    workspace: repoRoot,
    tower_agent_id: 'agent-orch',
    ...(ciCommand !== undefined ? { ci_command: ciCommand } : {}),
  });
  expect(boot).toMatchObject({ booted: true, base: 'main' });
  return { client, close: () => client.close(), repoRoot, board };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  return JSON.parse((response.content as Array<{ type: string; text: string }>)[0].text);
}

async function commitFile(worktree: string, relPath: string, content: string, message: string): Promise<void> {
  const file = join(worktree, relPath);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
  await run(worktree, ['add', '-A']);
  await run(worktree, ['commit', '-m', message]);
}

/** Plan M1, spawn+register a worker, commit in-scope work, clean review. */
async function readyBranch(env: WaitEnv): Promise<{ branch: string; worktree: string }> {
  const { client, repoRoot } = env;
  const branch = 'feat/M1-build-the-parser';
  await call(client, 'moa_tower_plan', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    missions: [{ title: 'Build the parser', scope: ['src/**'], tasks: ['parse'] }],
  });
  await call(client, 'moa_tower_spawn', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'w1', kind: 'worker', mission_id: 'M1',
  });
  await call(client, 'moa_tower_register', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'w1', agent_id: 'agent-w1',
  });
  const worktree = join(repoRoot, '..', 'repo-worktrees', 'wt-1');
  await commitFile(worktree, 'src/parser.ts', 'export const n = 1;\n', 'parser work');
  await call(client, 'moa_tower_spawn', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'rv1', kind: 'reviewer', review_target: branch,
  });
  await call(client, 'moa_tower_register', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'rv1', agent_id: 'agent-rv1',
  });
  await call(client, 'moa_tower_review', {
    workspace: repoRoot, caller_agent_id: 'agent-rv1', target: branch,
    status: 'clean', merge: 'merge', findings: 'none', decision: 'ok',
  });
  return { branch, worktree };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// kind=ci
// ---------------------------------------------------------------------------

it('wait kind=ci: a record matching the current tip satisfies the wait (wake path)', async () => {
  const env = await makeEnv('slow');
  const { client, repoRoot } = env;
  const { branch } = await readyBranch(env);
  const tip = (await run(repoRoot, ['rev-parse', branch])).trim();

  // Start the wait FIRST, then trigger the CI run — the waiter must wake when
  // the ci/<branchSlug> record lands (the slow script still runs for ~800ms).
  const waiting = call(client, 'moa_tower_wait', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    wait: { kind: 'ci', branch },
    timeoutMs: 10_000,
  });
  await sleep(150); // let the waiter register before the record exists
  const ci = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(ci).toMatchObject({ status: 'started' });

  const outcome = await waiting;
  expect(outcome.status).toBe('ok');
  expect(outcome.kind).toBe('ci');
  expect(outcome).toMatchObject({ branch, commit: tip, exit_code: 0, dirty: false });
  expect(outcome.run_id).toBe(ci.run_id);
  await env.close();
});

it('wait kind=ci: an already-landed matching record satisfies the wait immediately', async () => {
  const env = await makeEnv('green');
  const { client, repoRoot } = env;
  const { branch } = await readyBranch(env);
  const tip = (await run(repoRoot, ['rev-parse', branch])).trim();
  await call(client, 'moa_tower_ci', { workspace: repoRoot, caller_agent_id: 'agent-orch', branch });
  // Poll until the record lands (the record is the source of truth).
  for (let i = 0; i < 100; i++) {
    const rows = await env.board.read(
      `tower/${towerRepoKey(repoRoot)}/ci/feat-m1-build-the-parser`,
      undefined,
      'workspace',
      1,
      repoRoot,
    );
    if (rows.length > 0) break;
    await sleep(50);
  }
  const outcome = await call(client, 'moa_tower_wait', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    wait: { kind: 'ci', branch },
    timeoutMs: 2000,
  });
  expect(outcome).toMatchObject({ status: 'ok', kind: 'ci', branch, commit: tip, exit_code: 0 });
  await env.close();
});

it('wait kind=ci: a stale-tip record does NOT satisfy the wait (times out; a fresh run then satisfies it)', async () => {
  const env = await makeEnv('green');
  const { client, repoRoot } = env;
  const { branch, worktree } = await readyBranch(env);
  // Green record on tip1.
  await call(client, 'moa_tower_ci', { workspace: repoRoot, caller_agent_id: 'agent-orch', branch });
  await call(client, 'moa_tower_wait', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', wait: { kind: 'ci', branch }, timeoutMs: 5000,
  });
  // Move the tip — the existing record (tip1) is now stale and must NOT satisfy.
  await commitFile(worktree, 'src/parser2.ts', 'more\n', 'more work');
  const staleWait = await call(client, 'moa_tower_wait', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', wait: { kind: 'ci', branch }, timeoutMs: 700,
  });
  expect(staleWait).toEqual({ status: 'timeout', retry: true });
  // A fresh run on the new tip satisfies the wait.
  await call(client, 'moa_tower_ci', { workspace: repoRoot, caller_agent_id: 'agent-orch', branch });
  const outcome = await call(client, 'moa_tower_wait', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', wait: { kind: 'ci', branch }, timeoutMs: 5000,
  });
  expect(outcome.status).toBe('ok');
  expect(outcome.commit).toBe((await run(repoRoot, ['rev-parse', branch])).trim());
  await env.close();
});

it('wait kind=ci: times out with {status:"timeout", retry:true} when no record lands', async () => {
  const env = await makeEnv(); // no ci_command configured — no record will ever land
  const { client, repoRoot } = env;
  const { branch } = await readyBranch(env);
  const outcome = await call(client, 'moa_tower_wait', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', wait: { kind: 'ci', branch }, timeoutMs: 400,
  });
  expect(outcome).toEqual({ status: 'timeout', retry: true });
  await env.close();
});

it('wait kind=ci: rejects an unknown branch (no mission owns it)', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  await readyBranch(env);
  const outcome = await call(client, 'moa_tower_wait', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', wait: { kind: 'ci', branch: 'feat/nope' }, timeoutMs: 200,
  });
  expect(outcome.isError).toBe(true);
  expect(outcome.output).toMatch(/no tower mission owns branch/);
  await env.close();
});

// ---------------------------------------------------------------------------
// kind=inbox
// ---------------------------------------------------------------------------

it('wait kind=inbox: wakes when a message is sent to the caller', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  await readyBranch(env); // registers worker w1 ('agent-w1')
  const waiting = call(client, 'moa_tower_wait', {
    workspace: repoRoot,
    caller_agent_id: 'agent-w1',
    wait: { kind: 'inbox' },
    timeoutMs: 10_000,
  });
  await sleep(150); // let the waiter start polling before the message lands
  const sent = await call(client, 'moa_tower_send', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    to: 'w1',
    subject: 'heads up',
    body: 'please check the parser',
  });
  expect(sent.sent).toBe(true);

  const outcome = await waiting;
  expect(outcome.status).toBe('ok');
  expect(outcome.kind).toBe('inbox');
  expect(outcome.caller).toBe('w1');
  expect(outcome.count).toBe(1);
  expect(outcome.messages[0]).toMatchObject({ from: 'tower', to: 'w1', subject: 'heads up', body: 'please check the parser' });
  await env.close();
});

it('wait kind=inbox: times out when the inbox stays empty', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  await readyBranch(env); // w1 registered but nobody sends anything
  const outcome = await call(client, 'moa_tower_wait', {
    workspace: repoRoot, caller_agent_id: 'agent-w1', wait: { kind: 'inbox' }, timeoutMs: 400,
  });
  expect(outcome).toEqual({ status: 'timeout', retry: true });
  await env.close();
});

// ---------------------------------------------------------------------------
// kind=mission
// ---------------------------------------------------------------------------

it('wait kind=mission: wakes when the mission status changes from the call-time baseline', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  await call(client, 'moa_tower_plan', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    missions: [{ title: 'Build the parser', scope: ['src/**'] }],
  });
  const waiting = call(client, 'moa_tower_wait', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    wait: { kind: 'mission', id: 'M1' },
    timeoutMs: 10_000,
  });
  await sleep(150); // baseline captured while M1 is still 'planned'
  const patched = await call(client, 'moa_tower_mission', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', id: 'M1', status: 'active',
  });
  expect(patched.updated).toBe(true);

  const outcome = await waiting;
  expect(outcome.status).toBe('ok');
  expect(outcome.kind).toBe('mission');
  expect(outcome.mission_id).toBe('M1');
  expect(outcome.mission_status).toBe('active');
  expect(outcome.mission).toMatchObject({ id: 'M1', status: 'active' });
  await env.close();
});

it('wait kind=mission: a non-status patch does NOT satisfy the wait; a later status change does', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  await call(client, 'moa_tower_plan', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    missions: [{ title: 'Build the parser', scope: ['src/**'] }],
  });
  // Note patch: status stays 'planned' → must not wake the status wait.
  await call(client, 'moa_tower_mission', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', id: 'M1', note: 'investigating',
  });
  const waiting = call(client, 'moa_tower_wait', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    wait: { kind: 'mission', id: 'M1' },
    timeoutMs: 10_000,
  });
  await sleep(150);
  const patched = await call(client, 'moa_tower_mission', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', id: 'M1', status: 'paused',
  });
  expect(patched.updated).toBe(true);
  const outcome = await waiting;
  expect(outcome.status).toBe('ok');
  expect(outcome.mission_status).toBe('paused');
  await env.close();
});

it('wait kind=mission: times out when the status never changes', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  await call(client, 'moa_tower_plan', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    missions: [{ title: 'Build the parser', scope: ['src/**'] }],
  });
  const outcome = await call(client, 'moa_tower_wait', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', wait: { kind: 'mission', id: 'M1' }, timeoutMs: 400,
  });
  expect(outcome).toEqual({ status: 'timeout', retry: true });
  await env.close();
});

it('wait kind=mission: rejects an unknown mission id', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  const outcome = await call(client, 'moa_tower_wait', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', wait: { kind: 'mission', id: 'M99' }, timeoutMs: 200,
  });
  expect(outcome.isError).toBe(true);
  expect(outcome.output).toMatch(/unknown mission/);
  await env.close();
});
