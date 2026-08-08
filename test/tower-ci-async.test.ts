/**
 * Tower CI async (M1) — the async moa_tower_ci contract over a REAL git temp
 * repo with a SLOW fake `node` CI command (~1.5s). Covers: moa_tower_ci
 * returns IMMEDIATELY with {run_id, started_at, status:"started"} while the
 * CI process is still running; the ci/<branchSlug> record does NOT exist yet
 * at return time; the record lands after completion with the correct
 * exitCode/commit (the landing record is the source of truth); and the merge
 * gate refuses to merge until the record lands, then passes once it does.
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
import { ciRunChainCount } from '../src/modules/tower/store.js';

vi.setConfig({ testTimeout: 30000 });

/** ~1.5s sleep then exit 0 — long enough to prove the tool returned while
 *  the process was still running, short enough to keep the suite fast. */
const CI_SCRIPTS: Record<'green' | 'red', string> = {
  green: 'setTimeout(() => { process.exit(0); }, 1500);\n',
  red: 'setTimeout(() => { process.exit(1); }, 1500);\n',
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

interface CiAsyncEnv {
  client: Client;
  close: () => Promise<void>;
  repoRoot: string;
  board: BoardStore;
}

async function makeEnv(ciKind: 'green' | 'red'): Promise<CiAsyncEnv> {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-ciasync-'));
  homes.push(home);
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await run(repoRoot, ['init', '-b', 'main']);
  await run(repoRoot, ['config', 'user.email', 'tower-test@example.com']);
  await run(repoRoot, ['config', 'user.name', 'Tower Test']);
  await writeFile(join(repoRoot, 'README.md'), '# tower ci async test\n');
  await run(repoRoot, ['add', '-A']);
  await run(repoRoot, ['commit', '-m', 'initial']);

  const name = `ci-${ciKind}.js`;
  await writeFile(join(repoRoot, name), CI_SCRIPTS[ciKind]);
  const ciCommand = `node ../../repo/${name}`;

  const board = new BoardStore({ homeDir: home, workspaceCwd: join(home, 'server-cwd'), waitCapMs: 200, pollIntervalMs: 15 });
  const controller = createTowerController();
  controller.mountBoard(board);
  const server = createServer(undefined, undefined, board, undefined, undefined, createTowerModule(controller));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'tower-ci-async-test', version: '0.0.1' });
  await client.connect(clientTransport);

  const boot = await call(client, 'moa_tower_boot', {
    workspace: repoRoot,
    tower_agent_id: 'agent-orch',
    ci_command: ciCommand,
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

/** Plan M1, spawn+register worker, commit in-scope work, clean review. */
async function readyBranch(env: CiAsyncEnv): Promise<{ branch: string; worktree: string }> {
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

/** The ci/<branchSlug> board key for the test branch. */
function ciKey(repoRoot: string): string {
  return `tower/${towerRepoKey(repoRoot)}/ci/feat-m1-build-the-parser`;
}

it('moa_tower_ci returns immediately with run_id/started_at/status=started while the CI process still runs; the record lands after completion', async () => {
  const env = await makeEnv('green');
  const { client, repoRoot } = env;
  const { branch } = await readyBranch(env);
  const tip = (await run(repoRoot, ['rev-parse', branch])).trim();

  const t0 = Date.now();
  const ci = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  const elapsed = Date.now() - t0;
  // The fake command sleeps 1500ms — the tool MUST have returned long before
  // the process exited (validation + spawn are quick; generous bound).
  expect(elapsed).toBeLessThan(900);
  expect(ci).toMatchObject({ status: 'started', branch });
  expect(typeof ci.run_id).toBe('string');
  expect(typeof ci.started_at).toBe('string');

  // The run is in flight → the per-worktree chain entry exists (not yet pruned).
  expect(ciRunChainCount()).toBeGreaterThanOrEqual(1);

  // The record must NOT have landed yet — the run is still in flight.
  const rowsBefore = await env.board.read(ciKey(repoRoot), undefined, 'workspace', 1, repoRoot);
  expect(rowsBefore).toHaveLength(0);

  // The record lands after completion (the source of truth), with the
  // correct exitCode + tip commit, correlated by run_id.
  const rec = await call(client, 'moa_tower_wait', {
    workspace: repoRoot,
    caller_agent_id: 'agent-orch',
    wait: { kind: 'ci', branch },
    timeoutMs: 10_000,
  });
  expect(rec).toMatchObject({ status: 'ok', kind: 'ci', branch, commit: tip, exit_code: 0, dirty: false });
  expect(rec.run_id).toBe(ci.run_id);
  expect(typeof rec.log_ref).toBe('string');
  // The started call's started_at is stamped into the record as ranAt.
  expect(rec.ran_at).toBe(ci.started_at);

  const status = await call(client, 'moa_tower_status', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
  expect(status.ci['per-branch'][branch]).toMatchObject({ commit: tip, exitCode: 0 });

  // Once the run completes, its chain entry is pruned (module-level map).
  for (let i = 0; i < 100 && ciRunChainCount() > 0; i++) await sleep(50);
  expect(ciRunChainCount()).toBe(0);
  await env.close();
});

it('the merge gate refuses to merge until the record lands, then passes once it does', async () => {
  const env = await makeEnv('green');
  const { client, repoRoot } = env;
  const { branch } = await readyBranch(env);
  const ci = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(ci.status).toBe('started');

  // Immediately after start: no record yet → the hard CI gate blocks.
  const early = await call(client, 'moa_tower_merge', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(early.isError).toBe(true);
  expect(early.output).toMatch(/not green/);
  expect(early.output).toMatch(/no CI run recorded/);

  // Once the record lands → merge goes through.
  await call(client, 'moa_tower_wait', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', wait: { kind: 'ci', branch }, timeoutMs: 10_000,
  });
  const merged = await call(client, 'moa_tower_merge', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(merged.merged).toBe(true);
  await env.close();
});

it('a failing async run records exit_code 1 after completion (the record still lands)', async () => {
  const env = await makeEnv('red');
  const { client, repoRoot } = env;
  const { branch } = await readyBranch(env);
  const ci = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(ci.status).toBe('started');
  const rec = await call(client, 'moa_tower_wait', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', wait: { kind: 'ci', branch }, timeoutMs: 10_000,
  });
  expect(rec).toMatchObject({ status: 'ok', kind: 'ci', branch, exit_code: 1, dirty: false });
  const blocked = await call(client, 'moa_tower_merge', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(blocked.isError).toBe(true);
  expect(blocked.output).toMatch(/not green/);
  await env.close();
});
