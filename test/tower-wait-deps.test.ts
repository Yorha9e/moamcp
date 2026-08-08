/**
 * Tower wait kind=deps (M1/M3) — moa_tower_wait(wait={kind:'deps', mission_id})
 * over a REAL git temp repo. Covers the delegator contract:
 *  - deps already all-merged at call time → immediate ok (fast return, no block)
 *  - one unmerged dep → the waiter blocks; when the LAST dep merges (a real
 *    moa_tower_merge — the exact write a successful merge always produces) the
 *    waiter wakes with ok + the dep statuses observed
 *  - multi-dep: wakes only when ALL deps are merged (merging one dep while
 *    another is still unmerged keeps the wait pending)
 *  - timeout → {status:'timeout', retry:true}
 *  - unknown mission_id → protocol error
 *  - empty-deps mission → immediate ok (vacuously satisfied)
 *  - a dep id whose mission document is gone → protocol error at call time
 *    (deps are validated at plan time; a missing doc indicates corruption)
 *  - closed board scope → {status:'closed'} (surfaced distinctly, NOT a timeout)
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
import { slugify } from '../src/modules/tower/paths.js';

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

interface WaitEnv {
  client: Client;
  close: () => Promise<void>;
  repoRoot: string;
  board: BoardStore;
}

async function makeEnv(): Promise<WaitEnv> {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-wait-deps-'));
  homes.push(home);
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await run(repoRoot, ['init', '-b', 'main']);
  await run(repoRoot, ['config', 'user.email', 'tower-test@example.com']);
  await run(repoRoot, ['config', 'user.name', 'Tower Test']);
  await writeFile(join(repoRoot, 'README.md'), '# tower wait deps test\n');
  await run(repoRoot, ['add', '-A']);
  await run(repoRoot, ['commit', '-m', 'initial']);

  const board = new BoardStore({ homeDir: home, workspaceCwd: join(home, 'server-cwd'), waitCapMs: 200, pollIntervalMs: 15 });
  const controller = createTowerController();
  controller.mountBoard(board);
  const server = createServer(undefined, undefined, board, undefined, undefined, createTowerModule(controller));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'tower-wait-deps-test', version: '0.0.1' });
  await client.connect(clientTransport);

  const boot = await call(client, 'moa_tower_boot', {
    workspace: repoRoot,
    tower_agent_id: 'agent-orch',
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plan one batch of missions; deps may reference other ids in the same batch. */
async function planMissions(env: WaitEnv, missions: Array<{ title: string; scope: string[]; deps?: string[] }>): Promise<void> {
  const { client, repoRoot } = env;
  await call(client, 'moa_tower_plan', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    missions: missions.map((m) => ({
      title: m.title,
      scope: m.scope,
      ...(m.deps !== undefined && m.deps.length > 0 ? { deps: m.deps } : {}),
    })),
  });
}

/**
 * Prepare mission `missionId` for a clean merge: spawn+register a worker,
 * commit in-scope work, spawn+register a reviewer, review clean. Returns the
 * branch name (the merge gate still needs deps merged before it merges).
 */
async function readyMission(env: WaitEnv, missionId: string, title: string, file: string): Promise<string> {
  const { client, repoRoot } = env;
  const n = missionId.slice(1);
  const branch = `feat/M${n}-${slugify(title, 40)}`;
  const worktree = join(repoRoot, '..', 'repo-worktrees', `wt-${n}`);
  await call(client, 'moa_tower_spawn', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: `w${n}`, kind: 'worker', mission_id: missionId,
  });
  await call(client, 'moa_tower_register', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: `w${n}`, agent_id: `agent-w${n}`,
  });
  await commitFile(worktree, file, `export const n = ${n};\n`, `${title} work`);
  await call(client, 'moa_tower_spawn', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: `rv${n}`, kind: 'reviewer', review_target: branch,
  });
  await call(client, 'moa_tower_register', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: `rv${n}`, agent_id: `agent-rv${n}`,
  });
  await call(client, 'moa_tower_review', {
    workspace: repoRoot, caller_agent_id: `agent-rv${n}`, target: branch,
    status: 'clean', merge: 'merge', findings: 'none', decision: 'ok',
  });
  return branch;
}

async function mergeBranch(env: WaitEnv, branch: string): Promise<void> {
  const { client, repoRoot } = env;
  const merged = await call(client, 'moa_tower_merge', { workspace: repoRoot, caller_agent_id: 'agent-orch', branch });
  expect(merged.isError).toBeUndefined();
  expect(merged.merged).toBe(true);
}

async function waitDeps(env: WaitEnv, missionId: string, timeoutMs?: number): Promise<any> {
  const { client, repoRoot } = env;
  return call(client, 'moa_tower_wait', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    wait: { kind: 'deps', mission_id: missionId },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

// ---------------------------------------------------------------------------
// kind=deps
// ---------------------------------------------------------------------------

it('wait kind=deps: deps already all-merged at call time → immediate ok (no blocking)', async () => {
  const env = await makeEnv();
  await planMissions(env, [
    { title: 'Build the parser', scope: ['src/a/**'] },
    { title: 'Build the writer', scope: ['src/b/**'], deps: ['M1'] },
  ]);
  const branch = await readyMission(env, 'M1', 'Build the parser', 'src/a/parser.ts');
  await mergeBranch(env, branch);

  const started = Date.now();
  const outcome = await waitDeps(env, 'M2', 10_000);
  const elapsed = Date.now() - started;
  expect(outcome).toMatchObject({
    status: 'ok',
    kind: 'deps',
    mission_id: 'M2',
    deps: [{ id: 'M1', status: 'merged' }],
  });
  expect(elapsed).toBeLessThan(1000); // satisfied immediately, not after the 10s cap
  await env.close();
});

it('wait kind=deps: blocks while a dep is unmerged and wakes ok when the LAST dep merges', async () => {
  const env = await makeEnv();
  await planMissions(env, [
    { title: 'Build the parser', scope: ['src/a/**'] },
    { title: 'Build the writer', scope: ['src/b/**'], deps: ['M1'] },
  ]);
  await readyMission(env, 'M1', 'Build the parser', 'src/a/parser.ts');
  await readyMission(env, 'M2', 'Build the writer', 'src/b/writer.ts');

  // Start the wait FIRST (M1 is still planned) — the waiter must wake when the
  // merge writes the M1 mission doc with status merged.
  const waiting = waitDeps(env, 'M2', 10_000);
  await sleep(150); // let the waiter register before the merge lands
  await mergeBranch(env, 'feat/M1-build-the-parser');

  const outcome = await waiting;
  expect(outcome).toMatchObject({
    status: 'ok',
    kind: 'deps',
    mission_id: 'M2',
    deps: [{ id: 'M1', status: 'merged' }],
  });
  await env.close();
});

it('wait kind=deps: multi-dep wakes only when ALL deps are merged', async () => {
  const env = await makeEnv();
  await planMissions(env, [
    { title: 'Build the parser', scope: ['src/a/**'] },
    { title: 'Build the writer', scope: ['src/b/**'], deps: ['M1'] },
    { title: 'Build the formatter', scope: ['src/c/**'], deps: ['M1', 'M2'] },
  ]);
  await readyMission(env, 'M1', 'Build the parser', 'src/a/parser.ts');
  await readyMission(env, 'M2', 'Build the writer', 'src/b/writer.ts');
  await readyMission(env, 'M3', 'Build the formatter', 'src/c/formatter.ts');

  const waiting = waitDeps(env, 'M3', 10_000);
  await sleep(150);
  // Merge dep A only — B is still unmerged, so the wait must stay pending.
  await mergeBranch(env, 'feat/M1-build-the-parser');
  const stillWaiting = await Promise.race([waiting.then(() => 'resolved'), sleep(400).then(() => 'pending')]);
  expect(stillWaiting).toBe('pending');
  // Merge dep B → all deps now merged → the waiter wakes.
  await mergeBranch(env, 'feat/M2-build-the-writer');

  const outcome = await waiting;
  expect(outcome).toMatchObject({
    status: 'ok',
    kind: 'deps',
    mission_id: 'M3',
    deps: [
      { id: 'M1', status: 'merged' },
      { id: 'M2', status: 'merged' },
    ],
  });
  await env.close();
});

it('wait kind=deps: times out with {status:"timeout", retry:true} when a dep never merges', async () => {
  const env = await makeEnv();
  await planMissions(env, [
    { title: 'Build the parser', scope: ['src/a/**'] },
    { title: 'Build the writer', scope: ['src/b/**'], deps: ['M1'] },
  ]);
  await readyMission(env, 'M2', 'Build the writer', 'src/b/writer.ts');
  const outcome = await waitDeps(env, 'M2', 400);
  expect(outcome).toEqual({ status: 'timeout', retry: true });
  await env.close();
});

it('wait kind=deps: rejects an unknown mission_id', async () => {
  const env = await makeEnv();
  await planMissions(env, [{ title: 'Build the parser', scope: ['src/a/**'] }]);
  const outcome = await waitDeps(env, 'M99', 200);
  expect(outcome.isError).toBe(true);
  expect(outcome.output).toMatch(/unknown mission/);
  await env.close();
});

it('wait kind=deps: requires the mission_id argument', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  const outcome = await call(client, 'moa_tower_wait', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', wait: { kind: 'deps' }, timeoutMs: 200,
  });
  expect(outcome.isError).toBe(true);
  expect(outcome.output).toMatch(/wait kind=deps needs the mission id/);
  await env.close();
});

it('wait kind=deps: an empty-deps mission returns immediate ok (vacuously satisfied)', async () => {
  const env = await makeEnv();
  await planMissions(env, [{ title: 'Build the parser', scope: ['src/a/**'] }]);
  const started = Date.now();
  const outcome = await waitDeps(env, 'M1', 10_000);
  const elapsed = Date.now() - started;
  expect(outcome).toEqual({ status: 'ok', kind: 'deps', mission_id: 'M1', deps: [] });
  expect(elapsed).toBeLessThan(1000);
  await env.close();
});

it('wait kind=deps: a dep id with no mission document is a protocol error at call time (corruption)', async () => {
  const env = await makeEnv();
  await planMissions(env, [
    { title: 'Build the parser', scope: ['src/a/**'] },
    { title: 'Build the writer', scope: ['src/b/**'], deps: ['M1'] },
  ]);
  // Simulate corruption: remove the M1 mission document the way the store never
  // does (mission docs are written by plan and never deleted).
  const missionKey = `tower/${towerRepoKey(env.repoRoot)}/mission/M1`;
  await env.board.delete(missionKey, 'test', 'workspace', env.repoRoot);
  const outcome = await waitDeps(env, 'M2', 200);
  expect(outcome.isError).toBe(true);
  expect(outcome.output).toMatch(/no mission document exists/);
  await env.close();
});

it('wait kind=deps: a closed board scope is surfaced as {status:"closed"}, NOT a retryable timeout', async () => {
  const env = await makeEnv();
  await planMissions(env, [
    { title: 'Build the parser', scope: ['src/a/**'] },
    { title: 'Build the writer', scope: ['src/b/**'], deps: ['M1'] },
  ]);
  const waiting = waitDeps(env, 'M2', 10_000);
  await sleep(150); // the waiter is registered before the scope closes
  await env.board.close(); // resolves every suspended waiter with {status:'closed'}
  const outcome = await waiting;
  expect(outcome).toEqual({ status: 'closed', kind: 'deps', mission_id: 'M2' });
  // No further board calls after close — client.close() alone is safe.
  await env.close();
});
