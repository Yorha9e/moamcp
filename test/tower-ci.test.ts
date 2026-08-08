/**
 * Tower CI (B2) — moa_tower_ci over a REAL git temp repo with a fake `node -e`
 * CI command. Covers (基准 B2 list): green run + merge pass, red run blocks
 * the merge gate (reason=ci-failed), dirty-worktree interception (error +
 * dirty flag + gate block), 64KB log truncation (tail 200 lines + single-line
 * cap + ≤64KB total), gate commit-mismatch interception (recorded commit ≠
 * current tip → block; re-run unblocks), and the not-configured skip
 * (reason=ci-not-configured). Plus the B2-4 idempotent ci_command re-boot and
 * the B2R-2 caller-verified re-boot channel (non-tower id rejected) + B2R-8
 * non-tower moa_tower_ci rejection.
 *
 * Real git + node subprocesses → 30s file-level timeout.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BoardStore } from '../src/core/store/board.js';
import { createServer } from '../src/server.js';
import { createTowerController, createTowerModule, towerRepoKey } from '../src/modules/tower/index.js';

vi.setConfig({ testTimeout: 30000 });

/**
 * Fake CI commands as SCRIPT FILES inside the repo root, invoked with a
 * RELATIVE path (`node ../../repo/ci-<kind>.js` — the command runs with the
 * WORKTREE as cwd, so `../../repo` reaches the main checkout). Script files
 * avoid `cmd /c` quote-pass-through (Windows passes `"..."` verbatim into
 * `node -e`, turning the code into a no-op string literal).
 */
const CI_SCRIPTS: Record<'green' | 'red' | 'big', string> = {
  green: 'process.exit(0);\n',
  red: 'process.exit(1);\n',
  // ~2MB of output: exercises the 200-line / 64KB truncation double protection.
  big: 'for(let i=0;i<5000;i++)console.log(\'y\'.repeat(400));\n',
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

interface CiEnv {
  client: Client;
  close: () => Promise<void>;
  repoRoot: string;
  board: BoardStore;
}

async function makeEnv(ciKind: 'green' | 'red' | 'big' | 'none' = 'none'): Promise<CiEnv> {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-ci-'));
  homes.push(home);
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await run(repoRoot, ['init', '-b', 'main']);
  await run(repoRoot, ['config', 'user.email', 'tower-test@example.com']);
  await run(repoRoot, ['config', 'user.name', 'Tower Test']);
  await writeFile(join(repoRoot, 'README.md'), '# tower ci test\n');
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
  const client = new Client({ name: 'tower-ci-test', version: '0.0.1' });
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

/** Plan M1, spawn+register worker, commit in-scope work, clean review. */
async function readyBranch(env: CiEnv): Promise<{ branch: string; worktree: string }> {
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

/** Read the tower activity log off the board and assert a merge.blocked line. */
async function expectBlockedLog(env: CiEnv, reason: string): Promise<void> {
  const entries = await env.board.readNamespace(
    `tower/${towerRepoKey(env.repoRoot)}/log/`,
    undefined,
    'workspace',
    1000,
    env.repoRoot,
  );
  const lines = entries.map((row) => row.value);
  expect(lines.some((line) => line.includes('merge.blocked') && line.includes(`reason=${reason}`))).toBe(true);
}

it('green CI: moa_tower_ci records exit 0 + tip commit + logRef; status shows it; merge passes', async () => {
  const env = await makeEnv('green');
  const { client, repoRoot } = env;
  const { branch } = await readyBranch(env);
  const tip = (await run(repoRoot, ['rev-parse', branch])).trim();
  const ci = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(ci).toMatchObject({ ran: true, branch, exit_code: 0, dirty: false });
  expect(ci.commit).toBe(tip);
  expect(typeof ci.log_ref).toBe('string');
  expect(ci.log_ref).toMatch(/\/ci\/feat-m1-build-the-parser\/\d+-[0-9a-f]{8}$/);

  const status = await call(client, 'moa_tower_status', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
  expect(status.ci.configured).toBe(true);
  expect(status.ci['per-branch'][branch]).toMatchObject({ commit: tip, exitCode: 0 });

  const merged = await call(client, 'moa_tower_merge', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(merged.merged).toBe(true);
  await env.close();
});

it('red CI: exit 1 records a failed result and the merge gate blocks (reason=ci-failed)', async () => {
  const env = await makeEnv('red');
  const { client, repoRoot } = env;
  const { branch } = await readyBranch(env);
  const ci = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(ci.ran).toBe(true);
  expect(ci.exit_code).toBe(1);
  const blocked = await call(client, 'moa_tower_merge', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(blocked.isError).toBe(true);
  expect(blocked.output).toMatch(/not green/);
  await expectBlockedLog(env, 'ci-failed');
  await env.close();
});

it('dirty-tree interception: dirty worktree errors with a commit-first hint + dirty flag; gate blocks', async () => {
  const env = await makeEnv('green');
  const { client, repoRoot } = env;
  const { branch, worktree } = await readyBranch(env);
  await writeFile(join(worktree, 'src', 'uncommitted.txt'), 'dirty\n');
  const ci = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(ci.isError).toBe(true);
  expect(ci.dirty).toBe(true);
  expect(ci.output).toMatch(/uncommitted changes/);
  // The dirty run was recorded as failed → the gate blocks.
  const blocked = await call(client, 'moa_tower_merge', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(blocked.isError).toBe(true);
  expect(blocked.output).toMatch(/not green/);
  await expectBlockedLog(env, 'ci-failed');
  // Commit the file (this moves the tip) → re-review clean → a clean CI run
  // unblocks the gate.
  await commitFile(worktree, 'src/uncommitted.txt', 'dirty\n', 'commit the dirty file');
  await call(client, 'moa_tower_review', {
    workspace: repoRoot, caller_agent_id: 'agent-rv1', target: branch,
    status: 'clean', merge: 'merge', findings: 'none', decision: 'ok',
  });
  const clean = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(clean).toMatchObject({ ran: true, exit_code: 0, dirty: false });
  const merged = await call(client, 'moa_tower_merge', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(merged.merged).toBe(true);
  await env.close();
});

it('64KB truncation: the stored run log is ≤64KB, ≤200 lines, and every line is capped', async () => {
  const env = await makeEnv('big');
  const { client, repoRoot } = env;
  const { branch } = await readyBranch(env);
  const ci = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(ci.ran).toBe(true);
  const rows = await env.board.read(ci.log_ref, undefined, 'workspace', 1, repoRoot);
  expect(rows).toHaveLength(1);
  const value = rows[0]!.value;
  expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(64 * 1024);
  const lines = value.split('\n');
  expect(lines.length).toBeLessThanOrEqual(200);
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(1000 + 32); // line cap + truncation marker
  }
  await env.close();
});

it('gate commit mismatch: CI green on an old tip cannot merge after the tip moved (re-run unblocks)', async () => {
  const env = await makeEnv('green');
  const { client, repoRoot } = env;
  const { branch, worktree } = await readyBranch(env);
  const first = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(first.exit_code).toBe(0);
  // Move the tip, then re-review clean (so the review gate passes and the CI
  // gate is the one that must catch the stale record).
  await commitFile(worktree, 'src/parser2.ts', 'more\n', 'more work');
  await call(client, 'moa_tower_review', {
    workspace: repoRoot, caller_agent_id: 'agent-rv1', target: branch,
    status: 'clean', merge: 'merge', findings: 'none', decision: 'ok',
  });
  const blocked = await call(client, 'moa_tower_merge', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(blocked.isError).toBe(true);
  expect(blocked.output).toMatch(/not green/);
  await expectBlockedLog(env, 'ci-failed');
  // Re-run CI on the new tip → merge goes through.
  const second = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(second.commit).not.toBe(first.commit);
  const merged = await call(client, 'moa_tower_merge', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(merged.merged).toBe(true);
  await env.close();
});

it('not-configured skip: no ci_command → merge passes and logs reason=ci-not-configured', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  const { branch } = await readyBranch(env);
  const status = await call(client, 'moa_tower_status', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
  expect(status.ci.configured).toBe(false);
  const merged = await call(client, 'moa_tower_merge', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch,
  });
  expect(merged.merged).toBe(true);
  const entries = await env.board.readNamespace(
    `tower/${towerRepoKey(repoRoot)}/log/`,
    undefined,
    'workspace',
    1000,
    repoRoot,
  );
  const lines = entries.map((row) => row.value);
  expect(lines.some((line) => line.includes('merge.ci-skip') && line.includes('reason=ci-not-configured'))).toBe(true);
  await env.close();
});

it('B2-4: re-boot with ci_command idempotently updates the repo doc (no error)', async () => {
  const env = await makeEnv(); // booted without ci_command
  const { client, repoRoot } = env;
  const before = await call(client, 'moa_tower_status', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
  expect(before.ci.configured).toBe(false);
  const dummyCommand = 'node --version'; // never executed in this test — config channel only
  const reboot = await call(client, 'moa_tower_boot', {
    workspace: repoRoot,
    tower_agent_id: 'agent-orch',
    ci_command: dummyCommand,
  });
  expect(reboot).toMatchObject({ booted: true, ci_command_updated: true });
  const after = await call(client, 'moa_tower_status', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
  expect(after.ci.configured).toBe(true);
  // Repeated identical re-boot stays idempotent.
  const again = await call(client, 'moa_tower_boot', {
    workspace: repoRoot,
    tower_agent_id: 'agent-orch',
    ci_command: dummyCommand,
  });
  expect(again).toMatchObject({ booted: true, ci_command_updated: true });
  await env.close();
});

it('B2R-2: ci_command re-boot is caller-verified — a non-tower agent id is rejected, the booted id updates', async () => {
  const env = await makeEnv(); // booted without ci_command; tower agent id 'agent-orch'
  const { client, repoRoot } = env;
  const before = await call(client, 'moa_tower_status', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
  expect(before.ci.configured).toBe(false);

  // Any other MCP caller must not be able to implant a ciCommand via the
  // idempotent re-boot channel (it would later run with the server's full env).
  const hijack = await call(client, 'moa_tower_boot', {
    workspace: repoRoot,
    tower_agent_id: 'agent-mallory',
    ci_command: 'malicious-command',
  });
  expect(hijack.isError).toBe(true);
  expect(hijack.output).toMatch(/does not match the booted tower's registered agent id/);
  // The rejected attempt must not have touched the repo doc.
  const afterReject = await call(client, 'moa_tower_status', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
  expect(afterReject.ci.configured).toBe(false);

  // The booted tower id still gets the idempotent update.
  const reboot = await call(client, 'moa_tower_boot', {
    workspace: repoRoot,
    tower_agent_id: 'agent-orch',
    ci_command: 'node --version',
  });
  expect(reboot).toMatchObject({ booted: true, ci_command_updated: true });
  const after = await call(client, 'moa_tower_status', { workspace: repoRoot, caller_agent_id: 'agent-orch' });
  expect(after.ci.configured).toBe(true);
  await env.close();
});

it('B2R-8: moa_tower_ci rejects a non-tower caller (requireTower gate)', async () => {
  const env = await makeEnv('green');
  const { client, repoRoot } = env;
  await readyBranch(env); // registers worker 'w1' (agent id 'agent-w1')
  const ci = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-w1', branch: 'feat/M1-build-the-parser',
  });
  expect(ci.isError).toBe(true);
  expect(ci.output).toMatch(/not the control tower/);
  await env.close();
});

it('moa_tower_ci refuses without a configured ci_command', async () => {
  const env = await makeEnv();
  const { client, repoRoot } = env;
  await readyBranch(env);
  const ci = await call(client, 'moa_tower_ci', {
    workspace: repoRoot, caller_agent_id: 'agent-orch', branch: 'feat/M1-build-the-parser',
  });
  expect(ci.isError).toBe(true);
  expect(ci.output).toMatch(/no ci_command configured/);
  await env.close();
});
