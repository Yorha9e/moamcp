/**
 * Tower module MCP surface (B1's 12 tools) + /api/tower/* routes over a REAL
 * git temp repo (mkdtemp + git init + commit; 30s file-level timeout).
 *
 * Covers: B1-1 scope anchoring (workspace is required — the server cwd is
 * never a fallback), the protocol-layer gates (resolveCallerName / tower-only
 * tools), boot → plan → spawn → register (guard mirror) → mission → send →
 * inbox → finding → review (reviewedCommit resolved by the tool via git
 * rev-parse, not self-reported) → merge → status → teardown, plus the route
 * faces on a live Bus (state/missions/log, 400 without workspace, 503 before
 * the board is mounted).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BoardStore } from '../src/core/store/board.js';
import { Bus } from '../src/core/bus/bus.js';
import { createServer } from '../src/server.js';
import { createTowerController, createTowerModule } from '../src/modules/tower/index.js';
import * as git from '../src/modules/tower/git.js';
import { TowerStore } from '../src/modules/tower/store.js';
import { TipStore } from '../src/modules/tips/tips.js';

vi.setConfig({ testTimeout: 30000 });

const homes: string[] = [];
const buses: Bus[] = [];

afterEach(async () => {
  for (const bus of buses.splice(0)) await bus.stop().catch(() => undefined);
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

interface ToolEnv {
  client: Client;
  close: () => Promise<void>;
  repoRoot: string;
  board: BoardStore;
}

/** mkdtemp + git init + one commit + an MCP server with the tower module mounted. */
async function makeToolEnv(): Promise<ToolEnv> {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-tools-'));
  homes.push(home);
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await run(repoRoot, ['init', '-b', 'main']);
  await run(repoRoot, ['config', 'user.email', 'tower-test@example.com']);
  await run(repoRoot, ['config', 'user.name', 'Tower Test']);
  await writeFile(join(repoRoot, 'README.md'), '# tower tools test\n');
  await run(repoRoot, ['add', '-A']);
  await run(repoRoot, ['commit', '-m', 'initial']);

  const board = new BoardStore({ homeDir: home, workspaceCwd: join(home, 'server-cwd'), waitCapMs: 200, pollIntervalMs: 15 });
  const controller = createTowerController();
  controller.mountBoard(board);
  const server = createServer(undefined, undefined, board, undefined, undefined, createTowerModule(controller));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'tower-tools-test', version: '0.0.1' });
  await client.connect(clientTransport);
  return { client, close: () => client.close(), repoRoot, board };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  return JSON.parse((response.content as Array<{ type: string; text: string }>)[0].text);
}

/** Commit one file inside a worktree (worker action). */
async function commitFile(worktree: string, relPath: string, content: string, message: string): Promise<void> {
  const file = join(worktree, relPath);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
  await run(worktree, ['add', '-A']);
  await run(worktree, ['commit', '-m', message]);
}

/** Boot + plan one mission, then spawn+register a worker; returns tool results. */async function bootPlanSpawnRegister(env: ToolEnv): Promise<{
  boot: any;
  plan: any;
  worker: any;
}> {
  const { client, repoRoot } = env;
  const boot = await call(client, 'moa_tower_boot', { workspace: repoRoot, tower_agent_id: 'agent-orch' });
  expect(boot).toMatchObject({ booted: true, base: 'main', tower_agent_id: 'agent-orch' });
  const plan = await call(client, 'moa_tower_plan', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    missions: [{ title: 'Build the parser', scope: ['src/**'], tasks: ['parse', 'test'] }],
  });
  expect(plan).toMatchObject({ planned: 1 });
  expect(plan.missions[0]).toMatchObject({ id: 'M1', branch: 'feat/M1-build-the-parser', worktree: 'wt-1', status: 'planned' });
  const worker = await call(client, 'moa_tower_spawn', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    name: 'w1',
    kind: 'worker',
    mission_id: 'M1',
  });
  expect(worker).toMatchObject({ name: 'w1', kind: 'worker', mission_id: 'M1', agent_id: '', status: 'pending-register' });
  const registered = await call(client, 'moa_tower_register', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    name: 'w1',
    agent_id: 'agent-w1',
  });
  expect(registered).toMatchObject({ registered: true, name: 'w1', agent_id: 'agent-w1', kind: 'worker' });
  return { boot, plan, worker };
}

// ---------------------------------------------------------------------------
// B1-1 scope anchoring + protocol-layer gates
// ---------------------------------------------------------------------------

it('B1-1: every tool requires an explicit workspace — no server-cwd fallback', async () => {
  const env = await makeToolEnv();
  // The server's board is anchored at <home>/server-cwd, which is NOT the repo.
  const missing = await call(env.client, 'moa_tower_plan', {
    caller_agent_id: 'agent-orch',
    missions: [{ title: 'X', scope: ['a/**'] }],
  });
  expect(missing.isError).toBe(true);
  expect(missing.output).toMatch(/workspace.*required/i);
  // repo_root must resolve to the identical path as workspace.
  const mismatched = await call(env.client, 'moa_tower_boot', {
    workspace: env.repoRoot,
    repo_root: join(env.repoRoot, '..', 'other'),
    tower_agent_id: 'agent-orch',
  });
  expect(mismatched.isError).toBe(true);
  expect(mismatched.output).toMatch(/same absolute path/);
  await env.close();
});

it('protocol gates: non-tower callers are rejected at the protocol layer, not by profiles', async () => {
  const env = await makeToolEnv();
  await bootPlanSpawnRegister(env);
  const { client, repoRoot } = env;
  // The worker cannot plan / merge / teardown — tower-only levers.
  const planAsWorker = await call(client, 'moa_tower_plan', {
    workspace: repoRoot,
    caller_agent_id: 'agent-w1',
    missions: [{ title: 'X', scope: ['x/**'] }],
  });
  expect(planAsWorker.isError).toBe(true);
  expect(planAsWorker.output).toMatch(/not the control tower/);
  const mergeAsWorker = await call(client, 'moa_tower_merge', {
    workspace: repoRoot,
    caller_agent_id: 'agent-w1',
    branch: 'feat/M1-build-the-parser',
  });
  expect(mergeAsWorker.isError).toBe(true);
  expect(mergeAsWorker.output).toMatch(/not the control tower/);
  const teardownAsWorker = await call(client, 'moa_tower_teardown', {
    workspace: repoRoot,
    caller_agent_id: 'agent-w1',
  });
  expect(teardownAsWorker.isError).toBe(true);
  expect(teardownAsWorker.output).toMatch(/not the control tower/);
  // A caller outside the roster entirely is rejected too.
  const planAsStranger = await call(client, 'moa_tower_plan', {
    workspace: repoRoot,
    caller_agent_id: 'agent-stranger',
    missions: [{ title: 'X', scope: ['x/**'] }],
  });
  expect(planAsStranger.isError).toBe(true);
  expect(planAsStranger.output).toMatch(/not a tower participant/);
  await env.close();
});

// ---------------------------------------------------------------------------
// lifecycle chain: boot → plan → spawn → register → mission → send/inbox →
// finding → review → merge → status → teardown
// ---------------------------------------------------------------------------

it('register writes the guard mirror with worktrees; spawn created the physical worktree', async () => {
  const env = await makeToolEnv();
  await bootPlanSpawnRegister(env);
  const mirror = join(env.repoRoot, '.tower-guard.json');
  const raw = await readFile(mirror, 'utf8');
  const doc = JSON.parse(raw);
  expect(doc.repoRoot).toBe(env.repoRoot);
  expect(doc.agents.w1).toMatchObject({ agentId: 'agent-w1', kind: 'worker', missionId: 'M1', branch: 'feat/M1-build-the-parser' });
  expect(Array.isArray(doc.worktrees)).toBe(true);
  expect(doc.worktrees).toHaveLength(1);
  const branch = (await run(env.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  expect(branch).toBe('main'); // worktree creation never moves the main checkout
  await env.close();
});

it('B1R-3: spawn FAILS (does not continue) when worktree creation fails for a non-exists reason', async () => {
  const env = await makeToolEnv();
  const { client, repoRoot } = env;
  await call(client, 'moa_tower_boot', { workspace: repoRoot, tower_agent_id: 'agent-orch' });
  await call(client, 'moa_tower_plan', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    missions: [{ title: 'Build the parser', scope: ['src/**'] }],
  });
  // Simulate a genuine worktree-creation failure (permissions/disk — NOT the
  // "already exists" respawn case). The spawn must error, not continue.
  const spy = vi.spyOn(git, 'worktreeAdd').mockRejectedValueOnce(
    new Error('fatal: cannot create worktree: permission denied'),
  );
  try {
    const worker = await call(client, 'moa_tower_spawn', {
      workspace: repoRoot,
      caller_agent_id: 'agent-orch',
      name: 'w-fail',
      kind: 'worker',
      mission_id: 'M1',
    });
    expect(worker.isError).toBe(true);
    expect(worker.output).toMatch(/cannot create worktree/);
    // No half-registration: the mission stays planned and no roster entry exists.
    const status = await call(client, 'moa_tower_status', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
    expect(status.roster.map((r: any) => r.name)).not.toContain('w-fail');
    expect(status.missions[0].status).toBe('planned');
  } finally {
    spy.mockRestore();
  }
  await env.close();
});

it('B1R-1 spawn preflight: slug collision rejected BEFORE any side effect — no worktree/mission/roster residue', async () => {
  const env = await makeToolEnv();
  const { client, repoRoot } = env;
  await call(client, 'moa_tower_boot', { workspace: repoRoot, tower_agent_id: 'agent-orch' });
  await call(client, 'moa_tower_plan', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    missions: [{ title: 'Build the parser', scope: ['src/**'] }],
  });
  // The roster already holds "reviewer-a" (spawned + registered as a reviewer).
  await call(client, 'moa_tower_spawn', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'reviewer-a', kind: 'reviewer',
    review_target: 'feat/M1-build-the-parser',
  });
  await call(client, 'moa_tower_register', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'reviewer-a', agent_id: 'agent-ra',
  });
  // "Reviewer A" slugifies to the same "reviewer-a" — the preflight must fail
  // the spawn BEFORE building wt-1, activating M1, or registering an entry.
  const dup = await call(client, 'moa_tower_spawn', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'Reviewer A', kind: 'worker', mission_id: 'M1',
  });
  expect(dup.isError).toBe(true);
  expect(dup.output).toMatch(/collides with roster name "reviewer-a".*reviewer-a/);
  // Zero side effects: mission still planned, no roster entry, no worktree dir.
  const status = await call(client, 'moa_tower_status', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
  expect(status.missions[0].status).toBe('planned');
  expect(status.roster.map((r: any) => r.name)).not.toContain('Reviewer A');
  await expect(stat(join(repoRoot, '..', 'repo-worktrees', 'wt-1'))).rejects.toThrow();
  // Positive control: a non-colliding name for the same mission still spawns
  // cleanly — the rejection was the slug collision, not stale state.
  const ok = await call(client, 'moa_tower_spawn', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'w-b', kind: 'worker', mission_id: 'M1',
  });
  expect(ok).toMatchObject({ name: 'w-b', kind: 'worker', mission_id: 'M1', status: 'pending-register' });
  await env.close();
});

it('B1R-4: the B1 tool surface exposes no moa_tower_ci (B2 boundary locked)', async () => {
  const env = await makeToolEnv();
  const { tools } = await env.client.listTools();
  const names = tools.map((t) => t.name);
  expect(names).not.toContain('moa_tower_ci');
  expect(names).toContain('moa_tower_merge'); // the tower surface itself is live
  await env.close();
});

it('mission tool: read view, worker patches its own mission, tower-only scope change is logged', async () => {
  const env = await makeToolEnv();
  await bootPlanSpawnRegister(env);
  const { client, repoRoot } = env;
  const read = await call(client, 'moa_tower_mission', {
    workspace: repoRoot,
    caller_agent_id: 'agent-w1',
    id: 'M1',
  });
  expect(read.mission).toBe('M1');
  expect(read.view).toContain('Mission M1: Build the parser');
  expect(read.view).toContain('feat/M1-build-the-parser');
  const patch = await call(client, 'moa_tower_mission', {
    workspace: repoRoot,
    caller_agent_id: 'agent-w1',
    id: 'M1',
    status: 'active',
    task_done: 'parse',
  });
  expect(patch).toMatchObject({ updated: true, mission: 'M1', status: 'active', open_tasks: 1 });
  // Worker may not change scope.
  const scopeAsWorker = await call(client, 'moa_tower_mission', {
    workspace: repoRoot,
    caller_agent_id: 'agent-w1',
    id: 'M1',
    scope: ['src/**', 'leak/**'],
  });
  expect(scopeAsWorker.isError).toBe(true);
  expect(scopeAsWorker.output).toMatch(/only the tower/);
  // Tower scope change is allowed.
  const scopeAsTower = await call(client, 'moa_tower_mission', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    id: 'M1',
    scope: ['src/**', 'leak/**'],
  });
  expect(scopeAsTower).toMatchObject({ updated: true, mission: 'M1' });
  await env.close();
});

it('send/inbox/finding: recipient validation, self-send rejected, UUID keys, inbox scoping', async () => {
  const env = await makeToolEnv();
  await bootPlanSpawnRegister(env);
  const { client, repoRoot } = env;
  const toNobody = await call(client, 'moa_tower_send', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', to: 'nobody', subject: 'x', body: 'y',
  });
  expect(toNobody.isError).toBe(true);
  expect(toNobody.output).toMatch(/unknown recipient/);
  const selfSend = await call(client, 'moa_tower_send', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', to: 'tower', subject: 'x', body: 'y',
  });
  expect(selfSend.isError).toBe(true);
  expect(selfSend.output).toMatch(/to yourself/);
  const sent = await call(client, 'moa_tower_send', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', to: 'w1', subject: 'assignment', body: 'parse the input',
  });
  expect(sent.sent).toBe(true);
  expect(sent.file).toMatch(/^tower\/[0-9a-f]{12}\/inbox\/[0-9a-f-]{36}$/);
  const inbox = await call(client, 'moa_tower_inbox', { workspace: repoRoot, caller_agent_id: 'agent-w1' });
  expect(inbox.caller).toBe('w1');
  expect(inbox.count).toBeGreaterThanOrEqual(1);
  expect(inbox.messages[0]).toMatchObject({ from: 'tower', to: 'w1', subject: 'assignment', body: 'parse the input' });
  const finding = await call(client, 'moa_tower_finding', {
    workspace: repoRoot, caller_agent_id: 'agent-w1', type: 'bug', title: 'Off by one',
    summary: 'count starts at 1', details: 'see src/parser.ts:12', suggested_fix: 'start at 0',
  });
  expect(finding.filed).toBe(true);
  expect(finding.file).toMatch(/^tower\/[0-9a-f]{12}\/finding\/[0-9a-f-]{36}$/);
  await env.close();
});

it('review: the tool resolves reviewedCommit via git rev-parse — never a self-reported commit', async () => {
  const env = await makeToolEnv();
  await bootPlanSpawnRegister(env);
  const { client, repoRoot } = env;
  // Spawn + register a reviewer for the mission branch.
  const spawnReviewer = await call(client, 'moa_tower_spawn', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'rv1', kind: 'reviewer',
    review_target: 'feat/M1-build-the-parser',
  });
  expect(spawnReviewer).toMatchObject({ kind: 'reviewer', review_target: 'feat/M1-build-the-parser', agent_id: '' });
  await call(client, 'moa_tower_register', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'rv1', agent_id: 'agent-rv1',
  });
  // Worker commits on the branch (in its worktree), then the reviewer reviews.
  const workerWt = join(repoRoot, '..', 'repo-worktrees', 'wt-1');
  await commitFile(workerWt, 'src/parser.ts', 'export const n = 1;\n', 'parser work');
  const tip = (await run(repoRoot, ['rev-parse', 'feat/M1-build-the-parser'])).trim();
  const review = await call(client, 'moa_tower_review', {
    workspace: repoRoot, caller_agent_id: 'agent-rv1', target: 'feat/M1-build-the-parser',
    status: 'clean', merge: 'merge', findings: 'none', checks: ['tests pass'], decision: 'looks good',
  });
  expect(review.submitted).toBe(true);
  expect(review.round).toBe(1);
  expect(review.reviewed_commit).toBe(tip); // equals git rev-parse, not the caller's claim
  expect(review.file).toMatch(/\/review\/feat-m1-build-the-parser\/rv1-r1$/);
  await env.close();
});

it('merge (tower-only) passes the full gate and lands on the base branch; status reflects it; teardown cleans up', async () => {
  const env = await makeToolEnv();
  await bootPlanSpawnRegister(env);
  const { client, repoRoot } = env;
  const workerWt = join(repoRoot, '..', 'repo-worktrees', 'wt-1');
  // Worker commits in-scope work.
  await commitFile(workerWt, 'src/parser.ts', 'export const n = 1;\n', 'parser work');
  // Reviewer round 1 clean.
  await call(client, 'moa_tower_spawn', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'rv1', kind: 'reviewer',
    review_target: 'feat/M1-build-the-parser',
  });
  await call(client, 'moa_tower_register', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', name: 'rv1', agent_id: 'agent-rv1',
  });
  const review = await call(client, 'moa_tower_review', {
    workspace: repoRoot, caller_agent_id: 'agent-rv1', target: 'feat/M1-build-the-parser',
    status: 'clean', merge: 'merge', findings: 'none', decision: 'ok',
  });
  expect(review.submitted).toBe(true);
  const baseBefore = (await run(repoRoot, ['rev-parse', 'main'])).trim();
  const merged = await call(client, 'moa_tower_merge', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch: 'feat/M1-build-the-parser',
  });
  expect(merged.merged).toBe(true);
  expect(merged.merge_commit).not.toBe(baseBefore.slice(0, 7)); // --no-ff merge commit
  const baseAfter = (await run(repoRoot, ['rev-parse', 'main'])).trim();
  expect(baseAfter).toBe(merged.merge_commit);
  expect(merged.conflicts_with).toEqual([]);
  // Status reflects the merged mission + the roster.
  const status = await call(client, 'moa_tower_status', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
  expect(status).toMatchObject({ caller: 'tower', base: 'main', booted: true });
  expect(status.missions).toHaveLength(1);
  expect(status.missions[0]).toMatchObject({ id: 'M1', status: 'merged', branch: 'feat/M1-build-the-parser' });
  expect(status.roster.map((r: any) => r.name).sort()).toEqual(['rv1', 'tower', 'w1']);
  expect(status.review_gate).toEqual([]); // merged missions are excluded from the gate
  expect(status.inbox_count).toBe(0);
  expect(Array.isArray(status.recent_activity)).toBe(true);
  // Teardown (tower-only): worktree removed, namespace cleared.
  const torn = await call(client, 'moa_tower_teardown', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
  expect(torn.torn_down).toBe(true);
  expect(torn.report.some((line: string) => line.includes('removed wt-1'))).toBe(true);
  await env.close();
});

// ---------------------------------------------------------------------------
// /api/tower/* routes on a live Bus
// ---------------------------------------------------------------------------

async function startTowerBus(): Promise<{ bus: Bus; port: number; controller: ReturnType<typeof createTowerController> }> {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-routes-'));
  homes.push(home);
  const controller = createTowerController();
  const bus = new Bus({ port: 0, cwd: home, instancesDir: join(home, 'instances'), logsDir: join(home, 'logs'), towerController: controller });
  buses.push(bus);
  const port = await bus.start();
  // Deliberately NO mountBoard: the 503 test needs a controller without a board.
  return { bus, port, controller };
}

it('routes: /api/tower/* serves state/missions/log from the shared board', async () => {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-route-repo-'));
  homes.push(home);
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await run(repoRoot, ['init', '-b', 'main']);
  await run(repoRoot, ['config', 'user.email', 'tower-test@example.com']);
  await run(repoRoot, ['config', 'user.name', 'Tower Test']);
  await writeFile(join(repoRoot, 'README.md'), '# routes\n');
  await run(repoRoot, ['add', '-A']);
  await run(repoRoot, ['commit', '-m', 'initial']);
  const board = new BoardStore({ homeDir: home, workspaceCwd: join(home, 'cwd'), waitCapMs: 200, pollIntervalMs: 15 });
  const controller = createTowerController();
  controller.mountBoard(board);
  const bus = new Bus({ port: 0, cwd: home, instancesDir: join(home, 'instances'), logsDir: join(home, 'logs'), towerController: controller });
  buses.push(bus);
  const port = await bus.start();
  bus.mountControlPlane(board, new TipStore(board));

  const q = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
  // Not booted yet → booted:false shape, still 200.
  const before = await q(`/api/tower/state?workspace=${encodeURIComponent(repoRoot)}`);
  expect(before.status).toBe(200);
  expect(await before.json()).toMatchObject({ booted: false });

  // Boot through the store, then read the routes.
  const store = new TowerStore(repoRoot, board);
  await store.boot('agent-orch');
  await store.plan([{ title: 'Route mission', scope: ['src/**'] }]);
  await store.appendLog('tower', 'probe', { step: 1 });

  const stateRes = await q(`/api/tower/state?workspace=${encodeURIComponent(repoRoot)}`);
  expect(stateRes.status).toBe(200);
  const stateBody = await stateRes.json();
  expect(stateBody).toMatchObject({ booted: true, base: 'main', mode: 'branch', missions: ['M1'] });
  expect(stateBody.roster).toHaveLength(1);
  expect(stateBody.roster[0]).toMatchObject({ name: 'tower', agentId: 'agent-orch', kind: 'tower' });
  expect(typeof stateBody.worktreesRoot).toBe('string');

  const missionsRes = await q(`/api/tower/missions?workspace=${encodeURIComponent(repoRoot)}`);
  expect(missionsRes.status).toBe(200);
  const missionsBody = await missionsRes.json();
  expect(missionsBody.booted).toBe(true);
  expect(missionsBody.missions[0]).toMatchObject({ id: 'M1', title: 'Route mission', branch: 'feat/M1-route-mission', status: 'planned' });

  const logRes = await q(`/api/tower/log?workspace=${encodeURIComponent(repoRoot)}&lines=5`);
  expect(logRes.status).toBe(200);
  const logBody = await logRes.json();
  expect(logBody.booted).toBe(true);
  expect(logBody.lines.some((line: string) => line.includes('probe') && line.includes('step=1'))).toBe(true);

  // workspace is required — no server-cwd fallback on routes either.
  const noWs = await q('/api/tower/state');
  expect(noWs.status).toBe(400);
});

it('routes: 503 tower_not_ready while the tower has no board mounted', async () => {
  const { bus, port } = await startTowerBus();
  expect(bus.mode).toBe('own');
  const res = await fetch(`http://127.0.0.1:${port}/api/tower/state?workspace=${encodeURIComponent('C:/does/not/matter')}`);
  expect(res.status).toBe(503);
  expect(res.headers.get('retry-after')).toBe('2');
  expect(await res.json()).toEqual({ error: 'tower_not_ready', started: false });
});
