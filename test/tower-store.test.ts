/**
 * TowerStore protocol tests over a REAL git repository (mkdtemp + git init +
 * commit; Windows cold-start git is slow, hence the 30s file-level timeout).
 *
 * Coverage contract (基准 TOWER_V1_IMPLEMENTATION_PLAN.md 附录 A): every row
 * gets at least one case; rows marked 偏差 carry the deliberate deviation's
 * test. Focus points: the three-chained stem-replace order (row 10), the
 * survey zero-diff noop BEFORE the review checks (row 16), two reviewers in
 * one round (row 16, B1-12), same-title branch collision (row 8, B1-8), and
 * scope anchoring — two BoardStore instances with different workspaceCwd
 * sharing one tower namespace (B1-1).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BOARD_VALUE_MAX_BYTES, BoardStore } from '../src/core/store/board.js';
import { TowerProtocolError, TowerStore } from '../src/modules/tower/store.js';
import * as git from '../src/modules/tower/git.js';
import {
  TOWER_NAME,
  slugify,
  targetSlug,
  towerKeys,
  towerRepoKey,
  worktreePath,
} from '../src/modules/tower/paths.js';

vi.setConfig({ testTimeout: 30000 });

const homes: string[] = [];

async function cleanAll(): Promise<void> {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

afterEach(() => void cleanAll());

/** Run one git command; rejects with a GitError-like message on failure. */
function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`git ${args.join(' ')} failed: ${String(stderr).trim()}`));
      else resolve(stdout);
    });
  });
}

interface RepoFixture {
  home: string;
  repoRoot: string;
  board: BoardStore;
  store: TowerStore;
}

/** mkdtemp + git init + one commit; returns boot-ready fixture. */
async function makeRepo(bootAgentId = 'agent-tower'): Promise<RepoFixture> {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-store-'));
  homes.push(home);
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await run(repoRoot, ['init', '-b', 'main']);
  await run(repoRoot, ['config', 'user.email', 'tower-test@example.com']);
  await run(repoRoot, ['config', 'user.name', 'Tower Test']);
  await writeFile(join(repoRoot, 'README.md'), '# tower store test\n');
  await run(repoRoot, ['add', '-A']);
  await run(repoRoot, ['commit', '-m', 'initial']);
  const board = new BoardStore({ homeDir: home, workspaceCwd: join(home, 'cwd'), waitCapMs: 200, pollIntervalMs: 15 });
  const store = new TowerStore(repoRoot, board);
  await store.boot(bootAgentId);
  return { home, repoRoot, board, store };
}

/** Commit one file inside a mission's worktree (worker action). */
async function commitInWorktree(repoRoot: string, slot: string, relPath: string, content: string, message: string): Promise<void> {
  const wt = worktreePath(repoRoot, slot);
  await mkdir(join(wt, relPath, '..'), { recursive: true });
  await writeFile(join(wt, relPath), content);
  await run(wt, ['add', '-A']);
  await run(wt, ['commit', '-m', message]);
}

/** Spawn the physical worktree + a reviewer, and return the reviewer name. */
async function withReviewer(fixture: RepoFixture, missionId: string, name: string): Promise<string> {
  const { store } = fixture;
  const state = await store.load();
  const missions = await store.loadMissions(state);
  const mission = missions.find((m) => m.id === missionId)!;
  await store.addWorktree(mission.worktree, mission.branch, state.base);
  await store.registerAgent({
    name,
    agentId: `engine-${name}`,
    kind: 'reviewer',
    reviewTarget: mission.branch,
    spawnedAt: new Date().toISOString(),
  });
  return name;
}

async function reviewClean(fixture: RepoFixture, reviewer: string, branch: string): Promise<string> {
  const tip = await git.branchTip(fixture.repoRoot, branch);
  await fixture.store.submitReview(
    reviewer,
    { target: branch, status: 'clean', merge: 'merge', findings: 'none', decision: 'looks good' },
    tip,
  );
  return tip;
}

// ---------------------------------------------------------------------------
// 附录 A rows 1-4 — boot lifecycle
// ---------------------------------------------------------------------------

it('row1: boot refuses a directory that is not inside a git repository', async () => {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-nogit-'));
  homes.push(home);
  const board = new BoardStore({ homeDir: home, workspaceCwd: home, waitCapMs: 200, pollIntervalMs: 15 });
  const store = new TowerStore(home, board);
  await expect(store.boot('agent-tower')).rejects.toThrow(/git repository/);
  await expect(store.isInitialized()).resolves.toBe(false);
});

it('row2: boot refuses a git repository with no commits yet', async () => {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-nocommit-'));
  homes.push(home);
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await run(repoRoot, ['init', '-b', 'main']);
  const board = new BoardStore({ homeDir: home, workspaceCwd: home, waitCapMs: 200, pollIntervalMs: 15 });
  const store = new TowerStore(repoRoot, board);
  await expect(store.boot('agent-tower')).rejects.toThrow(/no commits yet/);
});

it('row3: boot is idempotent — repeated boot errors, teardown re-enables boot', async () => {
  const { store, board, repoRoot } = await makeRepo();
  await expect(store.boot('agent-tower')).rejects.toThrow(/already booted/);
  await store.teardown();
  const rebooted = new TowerStore(repoRoot, board);
  const result = await rebooted.boot('agent-tower');
  expect(result.created).toBe(true);
  await expect(rebooted.load()).resolves.toMatchObject({ version: 1, base: 'main' });
});

it('row4 (deviation) + B2-12: no .tower/ tree is written; .git/info/exclude gains .tower-guard.json (idempotent, never .tower/)', async () => {
  const { store, board, repoRoot } = await makeRepo();
  // The repo must remain clean: no .tower/, and the guard mirror is excluded.
  expect((await run(repoRoot, ['status', '--porcelain'])).trim()).toBe('');
  await expect(readFile(join(repoRoot, '.tower', 'comms', 'state.json'), 'utf8')).rejects.toThrow();
  const exclude = await readFile(join(repoRoot, '.git', 'info', 'exclude'), 'utf8');
  const lines = exclude.split(/\r?\n/).map((line) => line.trim());
  expect(lines).not.toContain('.tower/');
  // B2-12: the guard mirror is appended exactly once.
  expect(lines.filter((line) => line === '.tower-guard.json')).toHaveLength(1);
  // Teardown → re-boot → still exactly one line (idempotent append).
  await store.teardown();
  const rebooted = new TowerStore(repoRoot, board);
  await rebooted.boot('agent-tower');
  const excludeAfter = await readFile(join(repoRoot, '.git', 'info', 'exclude'), 'utf8');
  expect(
    excludeAfter.split(/\r?\n/).filter((line) => line.trim() === '.tower-guard.json'),
  ).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// rows 5-7 — state shape, roster, caller identity
// ---------------------------------------------------------------------------

it('row5 (deviation): state.missions holds ids; missions live in mission/<id> documents', async () => {
  const { store, board, repoRoot } = await makeRepo();
  await store.plan([
    { title: 'Alpha', scope: ['src/alpha/**'] },
    { title: 'Beta', scope: ['src/beta/**'] },
  ]);
  const state = await store.load();
  expect(state.missions).toEqual(['M1', 'M2']);
  expect(state.roster.agents).toHaveLength(1);
  expect(state.roster.agents[0]).toMatchObject({ name: TOWER_NAME, agentId: 'agent-tower', kind: 'tower' });
  const ns = `tower/${towerRepoKey(repoRoot)}/`;
  const rows = await board.readNamespace(`${ns}mission/`, undefined, 'workspace', 1000, repoRoot);
  expect(rows.map((r) => r.key).sort()).toEqual([`${ns}mission/M1`, `${ns}mission/M2`]);
  const missions = await store.loadMissions(state);
  expect(missions.map((m) => m.id)).toEqual(['M1', 'M2']);
});

it('row6: roster names are unique — duplicate registration errors', async () => {
  const { store } = await makeRepo();
  await store.registerAgent({ name: 'w1', agentId: 'engine-w1', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() });
  await expect(
    store.registerAgent({ name: 'w1', agentId: 'engine-w1-again', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() }),
  ).rejects.toThrow(/already registered/);
});

it('B1R-1: register rejects names whose slug collides with a roster member or a reserved name', async () => {
  const { store } = await makeRepo();
  await store.registerAgent({
    name: 'Reviewer A',
    agentId: 'engine-ra',
    kind: 'reviewer',
    reviewTarget: 'feat/M1-x',
    spawnedAt: new Date().toISOString(),
  });
  // "reviewer-a" slugifies to the same "reviewer-a" as "Reviewer A" — the
  // error must name the conflicting roster object (LWW review-key hole).
  await expect(
    store.registerAgent({
      name: 'reviewer-a',
      agentId: 'engine-rb',
      kind: 'reviewer',
      reviewTarget: 'feat/M1-x',
      spawnedAt: new Date().toISOString(),
    }),
  ).rejects.toThrow(/collides with roster name "Reviewer A".*reviewer-a/);
  // Reserved slugs are off-limits even when the reserved name is not itself a
  // roster member ("all" is the broadcast recipient, not a roster entry).
  await expect(
    store.registerAgent({ name: 'All', agentId: 'engine-all', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() }),
  ).rejects.toThrow(/collides with reserved name "all"/);
  // "tower!" normalizes to "tower" — collides with the boot-registered tower.
  await expect(
    store.registerAgent({ name: 'tower!', agentId: 'engine-t', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() }),
  ).rejects.toThrow(/collides with roster name "tower"/);
});

it('row7 (deviation): resolveCallerName — booted tower maps to "tower", "main" rejected, unregistered ids rejected', async () => {
  const { store } = await makeRepo('agent-orch');
  const state = await store.load();
  expect(store.resolveCallerName(state, 'agent-orch')).toBe(TOWER_NAME);
  expect(store.resolveCallerName(state, TOWER_NAME)).toBe(TOWER_NAME);
  expect(() => store.resolveCallerName(state, 'main')).toThrow(/main.*is not the control tower|not the control tower/);
  expect(() => store.resolveCallerName(state, 'stranger')).toThrow(/not a tower participant/);
  await store.registerAgent({ name: 'w1', agentId: 'engine-w1', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() });
  expect(store.resolveCallerName(await store.load(), 'engine-w1')).toBe('w1');
  // Not-booted state (empty roster): literal 'tower' caller must fail — tower
  // 必须已 boot.
  const notBooted = {
    version: 1 as const,
    base: 'main',
    mode: 'branch' as const,
    createdAt: '',
    roster: { agents: [] },
    missions: [],
  };
  expect(() => store.resolveCallerName(notBooted, TOWER_NAME)).toThrow(/not booted/);
});

// ---------------------------------------------------------------------------
// rows 8-10 — plan
// ---------------------------------------------------------------------------

it('row8 (deviation, B1-8): branches are feat/M<n>-<slug>; same-title missions get distinct branches', async () => {
  const { store } = await makeRepo();
  const missions = await store.plan([
    { title: 'Vulkan build', scope: ['src/vk/**'] },
    { title: 'Vulkan build', scope: ['src/vk2/**'] },
  ]);
  expect(missions.map((m) => m.branch)).toEqual(['feat/M1-vulkan-build', 'feat/M2-vulkan-build']);
  expect(missions.map((m) => m.worktree)).toEqual(['wt-1', 'wt-2']);
  expect(missions[0].branch).not.toBe(missions[1].branch);
});

it('row9: deps must reference known mission ids (earlier or in this batch)', async () => {
  const { store } = await makeRepo();
  await expect(store.plan([{ title: 'Orphan', scope: ['a/**'], deps: ['M99'] }])).rejects.toThrow(
    /depends on unknown mission "M99"/,
  );
  // Same-batch dependency is fine; a later mission may depend on an earlier one.
  const planned = await store.plan([
    { title: 'First', scope: ['a/**'] },
    { title: 'Second', scope: ['b/**'], deps: ['M1'] },
  ]);
  expect(planned[1].deps).toEqual(['M1']);
});

it('row10: stem = three-chained replace in FIXED order; empty stem covers the whole repo', async () => {
  const { store } = await makeRepo();
  await store.plan([{ title: 'A', scope: ['src/**'] }]);
  // Same stem via the other wildcard tails — must collide with `src`.
  await expect(store.plan([{ title: 'B', scope: ['src/*'] }])).rejects.toThrow(/scopes overlap/);
  await expect(store.plan([{ title: 'C', scope: ['src/'] }])).rejects.toThrow(/scopes overlap/);
  // Empty stem = whole repo. (Note: bare `**` does NOT collapse to an empty
  // stem under the official order — `**` → `*` — so only `*` / `/` reach ''.)
  await expect(store.plan([{ title: 'D', scope: ['*'] }])).rejects.toThrow(/whole repo/);
  await expect(store.plan([{ title: 'E', scope: ['/'] }])).rejects.toThrow(/whole repo/);
  // Order-sensitivity: `lib/**/` must NOT collapse to `lib`. Official order:
  // `/\*\*?$/` first (no-op here, string ends in '/'), then `/\*$/` (no-op),
  // then `/\/+$/` strips the trailing slash → stem `lib/**`. If the trailing-
  // slash strip ran FIRST, the stem would be `lib` and the pair below would
  // collide (lib/a/... is inside lib/) — so this plan succeeding proves the
  // official replace order is preserved.
  const allowed = await store.plan([
    { title: 'F', scope: ['lib/**/'] },
    { title: 'G', scope: ['lib/a/**'] },
  ]);
  expect(allowed.map((m) => m.id)).toEqual(['M2', 'M3']);
});

// ---------------------------------------------------------------------------
// rows 11-12 — updateMission
// ---------------------------------------------------------------------------

it('row11: only the tower or the owning worker may update a mission', async () => {
  const { store } = await makeRepo();
  await store.plan([
    { title: 'A', scope: ['a/**'], tasks: ['build'] },
    { title: 'B', scope: ['b/**'], tasks: ['build'] },
  ]);
  await store.registerAgent({ name: 'w1', agentId: 'engine-w1', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() });
  await store.registerAgent({ name: 'w2', agentId: 'engine-w2', kind: 'worker', missionId: 'M2', spawnedAt: new Date().toISOString() });
  // w2 (owns M2) may not touch M1.
  await expect(store.updateMission('w2', 'M1', { status: 'active' })).rejects.toThrow(/does not own mission M1/);
  // The tower and the owner may.
  await store.updateMission('tower', 'M1', { owner: 'w1' });
  await store.updateMission('w1', 'M1', { status: 'active' });
  const missions = await store.loadMissions(await store.load());
  expect(missions).toHaveLength(2);
  expect(missions[0]).toMatchObject({ id: 'M1', owner: 'w1', status: 'active' });
});

it('row12: owner/scope are tower-only; blocker blocks; task_done matches; noop suppressed; pure task ticks are not logged', async () => {
  const { store } = await makeRepo();
  await store.plan([{ title: 'A', scope: ['a/**'], tasks: ['parse the input', 'run the tests'] }]);
  await store.plan([{ title: 'B', scope: ['b/**'] }]);
  await store.registerAgent({ name: 'w1', agentId: 'engine-w1', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() });

  // Worker may not assign ownership or change scope.
  await expect(store.updateMission('w1', 'M1', { owner: 'w1' })).rejects.toThrow(/only the tower sets owner/);
  await expect(store.updateMission('w1', 'M1', { scope: ['a/**', 'x/**'] })).rejects.toThrow(/only the tower widens a scope/);

  // Tower scope change re-runs the disjoint check — widening onto M2 must fail.
  await expect(store.updateMission('tower', 'M1', { scope: ['a/**', 'b/**'] })).rejects.toThrow(/scopes overlap/);
  await store.updateMission('tower', 'M1', { scope: ['a/**', 'a2/**'] });

  // Blocker sets status blocked.
  const blocked = await store.updateMission('w1', 'M1', { blocker: 'parser dependency missing' });
  expect(blocked.status).toBe('blocked');
  expect(blocked.blockers).toEqual(['parser dependency missing']);

  // task_done marks the first open task containing the text.
  const afterTask = await store.updateMission('w1', 'M1', { taskDone: 'parse the input' });
  expect(afterTask.tasks[0].done).toBe(true);
  expect(afterTask.tasks[1].done).toBe(false);
  await expect(store.updateMission('w1', 'M1', { taskDone: 'no such task' })).rejects.toThrow(/no open task matching/);

  // Pure task ticks are not logged; no-op patches are neither written nor logged.
  const logBefore = (await store.recentLog(1000)).length;
  await store.updateMission('w1', 'M1', { taskDone: 'run the tests' });
  expect((await store.recentLog(1000)).length).toBe(logBefore);
  const noop = await store.updateMission('w1', 'M1', { status: 'blocked' });
  expect(noop.status).toBe('blocked');
  expect((await store.recentLog(1000)).length).toBe(logBefore);
});

// ---------------------------------------------------------------------------
// rows 13-14 — inbox / findings
// ---------------------------------------------------------------------------

it('row13 (deviation): recipient validation, self-send forbidden, body capped at the board ceiling with a split hint', async () => {
  const { store } = await makeRepo();
  await store.registerAgent({ name: 'w1', agentId: 'engine-w1', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() });
  await expect(store.send('tower', { to: 'nobody', subject: 'x', body: 'y' })).rejects.toThrow(/unknown recipient/);
  await expect(store.send('tower', { to: TOWER_NAME, subject: 'x', body: 'y' })).rejects.toThrow(/to yourself/);
  const key = await store.send('tower', { to: 'w1', subject: 'hello', body: 'hi there' });
  expect(key).toMatch(/\/inbox\//);
  const inbox = await store.readInbox('w1', 10);
  expect(inbox[0]).toMatchObject({ from: 'tower', to: 'w1', subject: 'hello', body: 'hi there' });

  // Body at/above the ceiling errors with a split hint (official had no cap —
  // the board does).
  const tooBig = 'x'.repeat(BOARD_VALUE_MAX_BYTES + 1024);
  await expect(store.send('tower', { to: 'w1', subject: 'big', body: tooBig })).rejects.toThrow(/too large.*split/);
  const okBody = 'y'.repeat(90 * 1024);
  await expect(store.send('tower', { to: 'w1', subject: 'ok', body: okBody })).resolves.toMatch(/\/inbox\//);
});

it('row14: finding type must be bug | improve | vuln | idea', async () => {
  const { store } = await makeRepo();
  const input = {
    title: 'Race in the parser',
    summary: 's',
    details: 'd',
    suggestedFix: 'f',
  };
  await expect(store.fileFinding('tower', { ...input, type: 'bogus' as never })).rejects.toThrow(/bug \| improve \| vuln \| idea/);
  for (const type of ['bug', 'improve', 'vuln', 'idea'] as const) {
    const key = await store.fileFinding('tower', { ...input, type });
    expect(key).toMatch(/\/finding\//);
  }
});

it('row13c (B1R-4): a broadcast to "all" is visible to a non-tower roster member via readInbox', async () => {
  const { store } = await makeRepo();
  await store.registerAgent({ name: 'w1', agentId: 'engine-w1', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() });
  await store.send('tower', { to: 'all', subject: 'standup', body: 'everyone sync' });
  const inbox = await store.readInbox('w1', 10);
  expect(inbox.some((item) => item.to === 'all' && item.subject === 'standup' && item.body === 'everyone sync')).toBe(true);
});

// ---------------------------------------------------------------------------
// rows 15-16 — reviews + merge gate
// ---------------------------------------------------------------------------

it('row15: only assigned reviewers (or the tower) may review; status/merge enums; per-reviewer rounds; reviewedCommit required', async () => {
  const { store, repoRoot } = await makeRepo();
  await store.plan([{ title: 'A', scope: ['a/**'] }]);
  const state = await store.load();
  const missions = await store.loadMissions(state);
  const branch = missions[0]!.branch;
  await store.addWorktree(missions[0]!.worktree, branch, state.base);
  await commitInWorktree(repoRoot, 'wt-1', 'a/x.txt', 'x\n', 'work');
  await store.registerAgent({ name: 'r1', agentId: 'engine-r1', kind: 'reviewer', reviewTarget: branch, spawnedAt: new Date().toISOString() });
  await store.registerAgent({ name: 'r2', agentId: 'engine-r2', kind: 'reviewer', reviewTarget: branch, spawnedAt: new Date().toISOString() });
  await store.registerAgent({ name: 'w1', agentId: 'engine-w1', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() });
  const tip = await git.branchTip(repoRoot, branch);

  // A worker is not an assigned reviewer.
  await expect(
    store.submitReview('w1', { target: branch, status: 'clean', merge: 'merge', findings: 'none', decision: 'd' }, tip),
  ).rejects.toThrow(/not an assigned reviewer/);
  // Status / merge enums.
  await expect(
    store.submitReview('r1', { target: branch, status: 'so-so', merge: 'merge', findings: 'none', decision: 'd' }, tip),
  ).rejects.toThrow(/clean \| p1-Nitems \| p2-Nitems/);
  await expect(
    store.submitReview('r1', { target: branch, status: 'clean', merge: 'later', findings: 'none', decision: 'd' }, tip),
  ).rejects.toThrow(/merge \| fix-then-merge \| hold/);
  // reviewedCommit comes from the controller layer — an empty one is rejected.
  await expect(
    store.submitReview('r1', { target: branch, status: 'clean', merge: 'merge', findings: 'none', decision: 'd' }, ''),
  ).rejects.toThrow(/reviewedCommit/);

  // Per-reviewer rounds: r1 r1, r2 r1 (same round, two reviewers), r1 r2.
  await store.submitReview('r1', { target: branch, status: 'clean', merge: 'merge', findings: 'none', decision: 'ok' }, tip);
  await store.submitReview('r2', { target: branch, status: 'p1-2items', merge: 'fix-then-merge', findings: 'x', decision: 'fix' }, tip);
  await store.submitReview('r1', { target: branch, status: 'clean', merge: 'merge', findings: 'none', decision: 'ok' }, tip);
  const reviews = await store.reviewsFor(branch);
  expect(reviews.map((r) => `${r.reviewer}:r${r.round}`).sort()).toEqual(['r1:r1', 'r1:r2', 'r2:r1']);
  expect(reviews.every((r) => r.reviewedCommit === tip)).toBe(true);
  const latest = await store.latestReviewRound(branch);
  expect(latest.map((r) => `${r.reviewer}:r${r.round}`)).toEqual(['r1:r2']);
});

it('B1R-1: submitReview rejects when the deterministic review key already exists (no LWW overwrite)', async () => {
  const { store, board, repoRoot } = await makeRepo();
  await store.plan([{ title: 'A', scope: ['a/**'] }]);
  const state = await store.load();
  const missions = await store.loadMissions(state);
  const branch = missions[0]!.branch;
  await store.addWorktree(missions[0]!.worktree, branch, state.base);
  await commitInWorktree(repoRoot, 'wt-1', 'a/x.txt', 'x\n', 'work');
  await store.registerAgent({ name: 'r1', agentId: 'engine-r1', kind: 'reviewer', reviewTarget: branch, spawnedAt: new Date().toISOString() });
  const tip = await git.branchTip(repoRoot, branch);
  const keys = towerKeys(repoRoot);

  // Round 1 lands normally.
  const first = await store.submitReview('r1', { target: branch, status: 'clean', merge: 'merge', findings: 'none', decision: 'ok' }, tip);
  expect(first).toBe(keys.review(targetSlug(branch), slugify('r1', 30), 1));

  // Plant a stale review at the EXACT deterministic key round 2 would use.
  // Its frontmatter says reviewer "someone-else", so the naive per-reviewer
  // round counter would NOT count it and the computed round 2 key collides —
  // the old same-key LWW hole. submitReview must refuse to write over it.
  const collision = keys.review(targetSlug(branch), slugify('r1', 30), 2);
  await board.mutate(
    'workspace',
    (entries, ts) => {
      entries.set(collision, {
        key: collision,
        value: '---\nreviewer: someone-else\nround: 2\n---\nstale verdict\n',
        author: 'r1',
        ts,
        tags: ['review'],
      });
    },
    repoRoot,
  );
  await expect(
    store.submitReview('r1', { target: branch, status: 'clean', merge: 'merge', findings: 'none', decision: 'ok' }, tip),
  ).rejects.toThrow(/already exists/);
  // The stale key is the only blocker — once it is gone, the same round is
  // writable, so the error message's "submit the next round" guidance is real.
  await board.delete(collision, 'r1', 'workspace', repoRoot);
  await expect(
    store.submitReview('r1', { target: branch, status: 'clean', merge: 'merge', findings: 'none', decision: 'ok' }, tip),
  ).resolves.toBe(collision);
});

it('row16a: deps-unmerged blocks in Dependency Flow order and logs merge.blocked', async () => {
  const { store, repoRoot } = await makeRepo();
  await store.plan([
    { title: 'A', scope: ['a/**'] },
    { title: 'B', scope: ['b/**'], deps: ['M1'] },
  ]);
  const state = await store.load();
  const missions = await store.loadMissions(state);
  const b = missions.find((m) => m.id === 'M2')!;
  await store.addWorktree(b.worktree, b.branch, state.base);
  await commitInWorktree(repoRoot, 'wt-2', 'b/y.txt', 'y\n', 'work');
  await expect(store.merge(b.branch)).rejects.toThrow(/dependencies not merged yet \(M1\)/);
  expect((await store.blockedMergeLog()).some((line) => line.includes('reason=deps-unmerged'))).toBe(true);
});

it('row16b: survey zero-diff noop runs BEFORE the review checks (no review needed, no git merge)', async () => {
  const { store, repoRoot } = await makeRepo();
  await store.plan([{ title: 'Recon', scope: ['docs/**'], kind: 'survey' }]);
  const state = await store.load();
  const missions = await store.loadMissions(state);
  const survey = missions[0]!;
  // A survey branch exists with zero diff (nothing committed on it).
  await store.addWorktree(survey.worktree, survey.branch, state.base);
  const baseTip = await git.branchTip(repoRoot, state.base);
  const result = await store.merge(survey.branch);
  expect(result.noop).toBe(true);
  expect(result.mergeCommit).toBe(baseTip);
  const after = await store.loadMissions(await store.load());
  expect(after[0]!.status).toBe('merged');
  expect((await store.blockedMergeLog())).toHaveLength(0);
  expect((await store.recentLog(1000)).some((line) => line.includes('merge.noop'))).toBe(true);
});

it('row16b2 (B1R-4): a survey branch WITH changes is blocked (read-only-survey) and logs merge.blocked', async () => {
  const { store, repoRoot } = await makeRepo();
  await store.plan([{ title: 'Recon', scope: ['docs/**'], kind: 'survey' }]);
  const state = await store.load();
  const missions = await store.loadMissions(state);
  const survey = missions[0]!;
  await store.addWorktree(survey.worktree, survey.branch, state.base);
  await commitInWorktree(repoRoot, 'wt-1', 'docs/notes.md', 'drift\n', 'survey drift');
  await expect(store.merge(survey.branch)).rejects.toThrow(/read-only/);
  expect((await store.blockedMergeLog()).some((line) => line.includes('reason=read-only-survey'))).toBe(true);
  // The read-only survey must NOT be marked merged.
  const after = await store.loadMissions(await store.load());
  expect(after[0]!.status).not.toBe('merged');
});

it('row16c: no-review blocks a build branch', async () => {
  const { store, repoRoot } = await makeRepo();
  await store.plan([{ title: 'A', scope: ['a/**'] }]);
  const state = await store.load();
  const missions = await store.loadMissions(state);
  const m = missions[0]!;
  await store.addWorktree(m.worktree, m.branch, state.base);
  await commitInWorktree(repoRoot, 'wt-1', 'a/x.txt', 'x\n', 'work');
  await expect(store.merge(m.branch)).rejects.toThrow(/has no review/);
  expect((await store.blockedMergeLog()).some((line) => line.includes('reason=no-review'))).toBe(true);
});

it('row16d (B1-12): latest review = the HIGHEST round, and it must be ALL clean (two reviewers in one round)', async () => {
  const { store, repoRoot } = await makeRepo();
  await store.plan([{ title: 'A', scope: ['a/**'] }]);
  const state = await store.load();
  const missions = await store.loadMissions(state);
  const m = missions[0]!;
  await store.addWorktree(m.worktree, m.branch, state.base);
  await commitInWorktree(repoRoot, 'wt-1', 'a/x.txt', 'x\n', 'work');
  await store.registerAgent({ name: 'r1', agentId: 'engine-r1', kind: 'reviewer', reviewTarget: m.branch, spawnedAt: new Date().toISOString() });
  await store.registerAgent({ name: 'r2', agentId: 'engine-r2', kind: 'reviewer', reviewTarget: m.branch, spawnedAt: new Date().toISOString() });
  const tip = await git.branchTip(repoRoot, m.branch);
  await store.submitReview('r1', { target: m.branch, status: 'clean', merge: 'merge', findings: 'none', decision: 'ok' }, tip);
  await store.submitReview('r2', { target: m.branch, status: 'p1-2items', merge: 'fix-then-merge', findings: 'x', decision: 'fix' }, tip);
  // Same round, one dirty verdict — must block even though a clean review exists.
  await expect(store.merge(m.branch)).rejects.toThrow(/not fully clean/);
  expect((await store.blockedMergeLog()).some((line) => line.includes('reason=not-clean'))).toBe(true);
  // r2 re-reviews in round 2 (clean) → the highest round is now all clean.
  await store.submitReview('r2', { target: m.branch, status: 'clean', merge: 'merge', findings: 'none', decision: 'fixed' }, tip);
  const merged = await store.merge(m.branch);
  expect(merged.noop).toBeUndefined();
  expect(merged.mergeCommit).toEqual(expect.any(String));
});

it('row16e: tip-moved — reviewedCommit must equal the current branch tip', async () => {
  const { store, repoRoot } = await makeRepo();
  await store.plan([{ title: 'A', scope: ['a/**'] }]);
  const state = await store.load();
  const missions = await store.loadMissions(state);
  const m = missions[0]!;
  await store.addWorktree(m.worktree, m.branch, state.base);
  await commitInWorktree(repoRoot, 'wt-1', 'a/x.txt', 'x\n', 'work');
  await store.registerAgent({ name: 'r1', agentId: 'engine-r1', kind: 'reviewer', reviewTarget: m.branch, spawnedAt: new Date().toISOString() });
  await reviewClean({ repoRoot, store } as RepoFixture, 'r1', m.branch);
  // Move the tip after the clean review.
  await commitInWorktree(repoRoot, 'wt-1', 'a/y.txt', 'y\n', 'more work');
  await expect(store.merge(m.branch)).rejects.toThrow(/moved since the clean review/);
  expect((await store.blockedMergeLog()).some((line) => line.includes('reason=tip-moved'))).toBe(true);
});

it('row16f: out-of-scope — every changed file must match a scope glob (picomatch)', async () => {
  const { store, repoRoot } = await makeRepo();
  await store.plan([{ title: 'A', scope: ['src/**'] }]);
  const state = await store.load();
  const missions = await store.loadMissions(state);
  const m = missions[0]!;
  await store.addWorktree(m.worktree, m.branch, state.base);
  await commitInWorktree(repoRoot, 'wt-1', 'src/ok.txt', 'ok\n', 'in scope');
  await commitInWorktree(repoRoot, 'wt-1', 'leak.txt', 'bad\n', 'out of scope');
  await store.registerAgent({ name: 'r1', agentId: 'engine-r1', kind: 'reviewer', reviewTarget: m.branch, spawnedAt: new Date().toISOString() });
  await reviewClean({ repoRoot, store } as RepoFixture, 'r1', m.branch);
  await expect(store.merge(m.branch)).rejects.toThrow(/outside mission M1 scope.*leak\.txt/);
  expect((await store.blockedMergeLog()).some((line) => line.includes('reason=out-of-scope'))).toBe(true);
  // The tower widens the scope (logged) → the same branch now merges.
  await store.updateMission('tower', 'M1', { scope: ['src/**', 'leak.txt'] });
  await reviewClean({ repoRoot, store } as RepoFixture, 'r1', m.branch);
  await expect(store.merge(m.branch)).resolves.toMatchObject({ mergeCommit: expect.any(String) });
});

it('row16g: full gate pass — mergeNoFf lands the branch and reports conflictsWith', async () => {
  const { store, repoRoot } = await makeRepo();
  await store.plan([
    { title: 'A', scope: ['a/**'] },
    { title: 'B', scope: ['b/**'] },
  ]);
  const state = await store.load();
  const missions = await store.loadMissions(state);
  const a = missions.find((m) => m.id === 'M1')!;
  const b = missions.find((m) => m.id === 'M2')!;
  await store.addWorktree(a.worktree, a.branch, state.base);
  await store.addWorktree(b.worktree, b.branch, state.base);
  await commitInWorktree(repoRoot, 'wt-1', 'a/x.txt', 'x\n', 'M1 work');
  // M2's worker touches the SAME file (out of M2 scope — a worker violation
  // that only the merge gate would catch; here M2 is not being merged yet).
  await commitInWorktree(repoRoot, 'wt-2', 'a/x.txt', 'x\nconflict\n', 'M2 work');
  await store.registerAgent({ name: 'r1', agentId: 'engine-r1', kind: 'reviewer', reviewTarget: a.branch, spawnedAt: new Date().toISOString() });
  await reviewClean({ repoRoot, store } as RepoFixture, 'r1', a.branch);
  const before = await git.branchTip(repoRoot, state.base);
  const result = await store.merge(a.branch);
  expect(result.mergeCommit).not.toBe(before); // --no-ff creates a merge commit
  expect(result.conflictsWith).toEqual([{ branch: b.branch, files: ['a/x.txt'] }]);
  const after = await store.loadMissions(await store.load());
  expect(after.find((m) => m.id === 'M1')!.status).toBe('merged');
  expect((await store.recentLog(1000)).some((line) => line.includes(' merge ') && line.includes('merge_commit='))).toBe(true);
});

// ---------------------------------------------------------------------------
// rows 17-18 — teardown / UUID keys
// ---------------------------------------------------------------------------

it('row17: teardown keeps dirty worktrees unless force; deletes the guard mirror; clears the live namespace', async () => {
  const { store, repoRoot } = await makeRepo();
  await store.plan([{ title: 'A', scope: ['a/**'] }]);
  const state = await store.load();
  const missions = await store.loadMissions(state);
  const m = missions[0]!;
  await store.addWorktree(m.worktree, m.branch, state.base);
  await commitInWorktree(repoRoot, 'wt-1', 'a/x.txt', 'x\n', 'work');
  // Dirty the worktree with an uncommitted file.
  await writeFile(join(worktreePath(repoRoot, 'wt-1'), 'a', 'uncommitted.txt'), 'dirty\n');
  await store.syncGuardMirror();
  const mirror = join(repoRoot, '.tower-guard.json');
  await expect(readFile(mirror, 'utf8')).resolves.toContain('"worktrees"');

  const report = await store.teardown();
  expect(report.some((line) => line.includes('kept wt-1'))).toBe(true);
  // Guard mirror deleted + live namespace cleared (row 3: boot works again).
  await expect(readFile(mirror, 'utf8')).rejects.toThrow();
  await expect(store.load()).rejects.toThrow(/not booted/);
  await store.boot('agent-tower');
  await expect(store.load()).resolves.toMatchObject({ missions: [] });
});

it('row17b: teardown with force removes dirty worktrees', async () => {
  const { store, repoRoot } = await makeRepo();
  await store.plan([{ title: 'A', scope: ['a/**'] }]);
  const state = await store.load();
  const missions = await store.loadMissions(state);
  const m = missions[0]!;
  await store.addWorktree(m.worktree, m.branch, state.base);
  await writeFile(join(worktreePath(repoRoot, 'wt-1'), 'dirty.txt'), 'd\n');
  const report = await store.teardown({ force: true });
  expect(report.some((line) => line.includes('removed wt-1'))).toBe(true);
  await expect(readFile(join(worktreePath(repoRoot, 'wt-1'), 'dirty.txt'), 'utf8')).rejects.toThrow();
});

it('row18 (deviation): send/finding keys are random UUIDs, never date-based (no same-key LWW collisions)', async () => {
  const { store } = await makeRepo();
  await store.registerAgent({ name: 'w1', agentId: 'engine-w1', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() });
  const key1 = await store.send('tower', { to: 'w1', subject: 'one', body: 'a' });
  const key2 = await store.send('tower', { to: 'w1', subject: 'two', body: 'b' });
  const uuid = /^tower\/[0-9a-f]{12}\/inbox\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  expect(key1).toMatch(uuid);
  expect(key2).toMatch(uuid);
  expect(key1).not.toBe(key2);
  const finding1 = await store.fileFinding('w1', { type: 'bug', title: 'x', summary: 's', details: 'd', suggestedFix: 'f' });
  const finding2 = await store.fileFinding('w1', { type: 'bug', title: 'x', summary: 's', details: 'd', suggestedFix: 'f' });
  expect(finding1).toMatch(/^tower\/[0-9a-f]{12}\/finding\/[0-9a-f-]{36}$/);
  expect(finding2).toMatch(/^tower\/[0-9a-f]{12}\/finding\/[0-9a-f-]{36}$/);
  expect(finding1).not.toBe(finding2);
});

// ---------------------------------------------------------------------------
// B2 progress
// ---------------------------------------------------------------------------

it('B2 progress: owner/tower-only writes, LWW single key, byte truncation keeps the tail ≤80KB', async () => {
  const { store, board, repoRoot } = await makeRepo();
  await store.plan([{ title: 'A', scope: ['a/**'] }]);
  await store.registerAgent({
    name: 'w1',
    agentId: 'engine-w1',
    kind: 'worker',
    missionId: 'M1',
    worktree: 'wt-1',
    spawnedAt: new Date().toISOString(),
  });
  // Non-owner / unknown callers are rejected (row-11 ownership).
  await expect(store.updateProgress('stranger', 'M1', 'x')).rejects.toThrow(/does not own mission M1/);
  await expect(store.updateProgress('tower', 'M99', 'x')).rejects.toThrow(/unknown mission/);
  // Owner worker and tower both write to the SAME key (LWW accumulation).
  await store.updateProgress('w1', 'M1', 'first step');
  await store.updateProgress('tower', 'M1', 'tower note');
  const keys = towerKeys(repoRoot);
  const rows = await board.read(keys.progress('M1'), undefined, 'workspace', 1, repoRoot);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.value).toContain('first step');
  expect(rows[0]!.value).toContain('tower note');
  // A huge note is truncated: the stored value stays ≤80KB and the newest
  // content survives.
  const big = await store.updateProgress('w1', 'M1', 'z'.repeat(90 * 1024));
  expect(big.bytes).toBeLessThanOrEqual(80 * 1024);
  const rows2 = await board.read(keys.progress('M1'), undefined, 'workspace', 1, repoRoot);
  expect(Buffer.byteLength(rows2[0]!.value, 'utf8')).toBeLessThanOrEqual(80 * 1024);
  expect(rows2[0]!.value).toContain('z'.repeat(100));
});

// ---------------------------------------------------------------------------
// B1-1 scope anchoring
// ---------------------------------------------------------------------------

it('scope-anchoring (B1-1): two BoardStore instances with different workspaceCwd share one tower namespace', async () => {
  const home = await mkdtemp(join(tmpdir(), 'moamcp-tower-anchor-'));
  homes.push(home);
  const repoRoot = join(home, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await run(repoRoot, ['init', '-b', 'main']);
  await run(repoRoot, ['config', 'user.email', 'tower-test@example.com']);
  await run(repoRoot, ['config', 'user.name', 'Tower Test']);
  await writeFile(join(repoRoot, 'README.md'), '# anchor\n');
  await run(repoRoot, ['add', '-A']);
  await run(repoRoot, ['commit', '-m', 'initial']);

  // Two board instances anchored at DIFFERENT cwds (like two sessions).
  const boardA = new BoardStore({ homeDir: home, workspaceCwd: join(home, 'session-a'), waitCapMs: 200, pollIntervalMs: 15 });
  const boardB = new BoardStore({ homeDir: home, workspaceCwd: join(home, 'session-b'), waitCapMs: 200, pollIntervalMs: 15 });
  const storeA = new TowerStore(repoRoot, boardA);
  const storeB = new TowerStore(repoRoot, boardB);

  await storeA.boot('agent-orch');
  await storeA.plan([{ title: 'Shared', scope: ['src/**'] }]);
  await storeA.registerAgent({ name: 'w1', agentId: 'engine-w1', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() });

  // B reads the same namespace as A.
  const stateB = await storeB.load();
  expect(stateB.missions).toEqual(['M1']);
  expect((await storeB.loadMissions(stateB))[0]!.branch).toBe('feat/M1-shared');
  // B's write is visible to A.
  await storeB.send('tower', { to: 'w1', subject: 'cross-instance', body: 'hello' });
  const inboxA = await storeA.readInbox('w1', 10);
  expect(inboxA.some((item) => item.subject === 'cross-instance')).toBe(true);
  // Same board key on both instances.
  const ns = `tower/${towerRepoKey(repoRoot)}/`;
  const rowsA = await boardA.read(`${ns}state`, undefined, 'workspace', 1, repoRoot);
  const rowsB = await boardB.read(`${ns}state`, undefined, 'workspace', 1, repoRoot);
  expect(rowsA[0]!.key).toBe(rowsB[0]!.key);
  expect(rowsA[0]!.value).toBe(rowsB[0]!.value);
});
