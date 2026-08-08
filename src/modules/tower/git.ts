/**
 * `tower` domain (protocol) — git plumbing for tower. Nearly verbatim port of
 * kimi-code `pr-2633-tower` `protocol/git.ts` (12 functions + GitError):
 * engine-internal operations (worktree add/remove, merge, diff) run through
 * `execFile` with a hard 60s timeout and 16MB maxBuffer — these are not
 * agent-invoked shell commands, so they never go through a Bash tool.
 */

import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 60_000;

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || 'unknown error'}`);
    this.name = 'GitError';
  }
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new GitError(args, stderr || error.message));
          return;
        }
        resolve(stdout.trimEnd());
      },
    );
  });
}

/** `git` that returns null instead of throwing when the command fails. */
export async function tryGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

export async function isInsideRepo(cwd: string): Promise<boolean> {
  return (await tryGit(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
}

export async function hasAnyCommit(cwd: string): Promise<boolean> {
  // NOTE: modern git exits 0 with EMPTY output for `rev-list -n 1 --all` on a
  // fresh repo, so the verbatim `!== null` check would wrongly report a commit
  // (row 2: init/boot requires ≥1 commit). The non-empty check keeps the
  // official 12-function shape and semantics on both old and new gits.
  const out = await tryGit(cwd, ['rev-list', '-n', '1', '--all']);
  return out !== null && out.trim().length > 0;
}

export async function currentBranch(cwd: string): Promise<string> {
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') throw new Error('cannot determine base branch from a detached HEAD');
  return branch;
}

export async function branchTip(cwd: string, ref: string): Promise<string> {
  return git(cwd, ['rev-parse', ref]);
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (
    (await tryGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) !== null
  );
}

export async function worktreeAdd(
  cwd: string,
  path: string,
  branch: string,
  base: string,
): Promise<void> {
  if (await branchExists(cwd, branch)) {
    await git(cwd, ['worktree', 'add', path, branch]);
    return;
  }
  await git(cwd, ['worktree', 'add', path, '-b', branch, base]);
}

export async function worktreeRemove(cwd: string, path: string, force: boolean): Promise<void> {
  await git(cwd, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
}

export async function isWorktreeDirty(path: string): Promise<boolean> {
  const status = await tryGit(path, ['status', '--porcelain']);
  return status !== null && status.trim().length > 0;
}

/**
 * M2 CI artifact self-clean: revert the worktree's known CI-generated paths
 * (`dist/` and `package-lock.json`) to HEAD. Dogfood evidence: `npm install`
 * touches package-lock.json and the vitest suite rebuilds `dist/`, so a CI
 * run dirties its own worktree and the NEXT ci/teardown/merge sees a dirty
 * tree. The CI path calls this BEFORE the dirty check (clearing leftovers of
 * a previous run) and AFTER the run completes (leaving the tree clean for
 * teardown / the next CI / the merge gate).
 *
 * Chosen over option (a) — exempting these paths from the dirty check — for
 * safety: the dirty check stays strict, so real uncommitted edits ANYWHERE
 * (including dist/) are still caught and reported; only the two known
 * CI-generated paths are physically reverted, never hidden. Errors are
 * tolerated: a repo without `dist/`/package-lock.json (or with them untracked)
 * makes `git checkout -- <path>` fail with a pathspec error — that is a no-op
 * here, and the strict dirty check still sees any untracked artifacts.
 */
export async function cleanCiArtifacts(cwd: string): Promise<void> {
  await tryGit(cwd, ['checkout', '--quiet', '--', 'dist/', 'package-lock.json']);
}

export async function mergeNoFf(cwd: string, branch: string): Promise<string> {
  await git(cwd, ['merge', '--no-ff', branch]);
  return branchTip(cwd, 'HEAD');
}

/** Changed files of `ref` relative to `base` (three-dot, i.e. since merge-base). */
export async function diffNameOnly(
  cwd: string,
  base: string,
  ref: string,
): Promise<readonly string[]> {
  const out = await git(cwd, ['diff', '--name-only', `${base}...${ref}`]);
  return out.length === 0 ? [] : out.split('\n').filter((line) => line.trim().length > 0);
}
