/**
 * `tower` domain (protocol) — board key layout and naming (ported from
 * kimi-code `pr-2633-tower` `protocol/paths.ts`, 基准 decision 7).
 *
 * Every tower artifact lives under the workspace-scope board namespace
 * `tower/<repoKey>/…` where `repoKey = sha1(repoRoot)[:12]` (normalized
 * absolute path). Layout (基准 decision 7):
 *
 *   tower/<repoKey>/
 *     repo                 namespace identity doc (written at boot)
 *     state                TowerState doc (missions = ids, row 5 deviation)
 *     mission/<id>         one TowerMission doc per mission (M1, M2, …)
 *     inbox/<msgId>        one message per random UUID (row 18 deviation)
 *     finding/<id>         one finding per random UUID (row 18 deviation)
 *     review/<targetSlug>/<reviewer>-r<n>
 *                          review doc, round-scoped per reviewer
 *     log/<ts>-<rand>      one activity-log line per key
 *     ci/<branchSlug>      B2 CI result record (LWW latest run)
 *     ci/<branchSlug>/<ts>-<rand>
 *                          B2 CI run log (per run, truncated)
 *     progress/<missionId> B2 progress key (single LWW key per mission)
 *
 * All reads/writes go through `BoardStore` with the workspace **explicitly**
 * anchored at `repoRoot` (B1-1 scope anchoring — never the server's
 * workspaceCwd fallback).
 */

import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

/** Reserved roster name for the control tower (boot registers this entry). */
export const TOWER_NAME = 'tower';
/** Broadcast inbox recipient. */
export const BROADCAST_NAME = 'all';

/**
 * Worktree slots live in a sibling directory `<repoName>-worktrees/` of the
 * main checkout (基准 decision 8: `<repoRoot>` 同级 `<repoName>-worktrees/<slot>`).
 * This is the board-化 consequence of row 4 (we write no `.tower/` tree inside
 * the repo, so the official `<repoRoot>/.tower/worktrees/<slot>` layout is
 * replaced by the sibling directory).
 */
export function worktreesRoot(repoRoot: string): string {
  return join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`);
}

/** Absolute path of one worktree slot (`wt-<n>`). */
export function worktreePath(repoRoot: string, slot: string): string {
  return join(worktreesRoot(repoRoot), slot);
}

/**
 * Normalize a repo root the same way BoardStore normalizes workspaces
 * (`resolve` of an absolute path) so `C:/x/repo` and `C:/x/repo/` share one
 * namespace. Throws on non-absolute input — tower tools never silently fall
 * back to the server cwd (B1-1).
 */
export function normalizeTowerRoot(repoRoot: string): string {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0 || !/^[a-zA-Z]:[\\/]|^\//.test(repoRoot)) {
    throw new Error(`repoRoot must be an absolute path, got: ${JSON.stringify(repoRoot)}`);
  }
  return resolve(repoRoot);
}

/** Twelve-hex namespace key: `sha1(repoRoot)[:12]` (基准 decision 7). */
export function towerRepoKey(repoRoot: string): string {
  return createHash('sha1').update(normalizeTowerRoot(repoRoot)).digest('hex').slice(0, 12);
}

/** The `tower/<repoKey>` namespace prefix for a checkout. */
export function towerNamespace(repoRoot: string): string {
  return `tower/${towerRepoKey(repoRoot)}`;
}

/** One namespace-bound key-builder set (all keys relative to the repoKey prefix). */
export interface TowerKeys {
  readonly ns: string;
  /** Namespace identity document (`…/repo`). */
  repo(): string;
  /** TowerState document (`…/state`). */
  state(): string;
  /** One mission document (`…/mission/<id>`). */
  mission(id: string): string;
  /** One inbox message (`…/inbox/<msgId>`, random UUID — row 18 deviation). */
  inbox(msgId: string): string;
  /** One finding (`…/finding/<id>`, random UUID — row 18 deviation). */
  finding(id: string): string;
  /** One review (`…/review/<targetSlug>/<reviewer>-r<n>`). */
  review(targetSlug: string, reviewer: string, round: number): string;
  /** One activity-log line (`…/log/<ts>-<rand>`). */
  log(ts: number, rand: string): string;
  /** One CI result record (`…/ci/<branchSlug>`, LWW latest run — B2). */
  ci(branch: string): string;
  /** One CI run log (`…/ci/<branchSlug>/<ts>-<rand>`, per run — B2). */
  ciLog(branch: string, ts: number, rand: string): string;
  /** One progress key (`…/progress/<missionId>`, single LWW key — B2). */
  progress(missionId: string): string;
  /** Namespace prefix for namespace reads (`…/mission/`, `…/inbox/`, …). */
  prefix(kind: 'mission' | 'inbox' | 'finding' | 'review' | 'log' | 'ci' | 'progress'): string;
}

/** Build the key set for a checkout. */
export function towerKeys(repoRoot: string): TowerKeys {
  const ns = towerNamespace(repoRoot);
  return {
    ns,
    repo: () => `${ns}/repo`,
    state: () => `${ns}/state`,
    mission: (id) => `${ns}/mission/${id}`,
    inbox: (msgId) => `${ns}/inbox/${msgId}`,
    finding: (id) => `${ns}/finding/${id}`,
    review: (targetSlugged, reviewer, round) => `${ns}/review/${targetSlugged}/${reviewer}-r${round}`,
    log: (ts, rand) => `${ns}/log/${ts}-${rand}`,
    ci: (branch) => `${ns}/ci/${targetSlug(branch)}`,
    ciLog: (branch, ts, rand) => `${ns}/ci/${targetSlug(branch)}/${ts}-${rand}`,
    progress: (missionId) => `${ns}/progress/${missionId}`,
    prefix: (kind) => `${ns}/${kind}/`,
  };
}

/** Local YYYYMMDD, used inside finding content / review frontmatter dates. */
export function dateStamp(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** `YYYY-MM-DD` for review frontmatter. */
export function dateDash(now = new Date()): string {
  const stamp = dateStamp(now);
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
}

/**
 * Filesystem-safe slug: lowercase, alnum runs joined by `-`. CJK and other
 * non-ASCII letters are dropped so names stay greppable everywhere.
 */
export function slugify(text: string, maxLength = 60): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replaceAll(/-+$/g, '');
  return slug.length > 0 ? slug : 'item';
}

/** Branch/PR targets become filename segments: `feat/x` → `feat-x`, `#12` → `pr12`. */
export function targetSlug(target: string): string {
  const cleaned = target.trim().replace(/^#/, 'pr');
  return slugify(cleaned.replaceAll(/[/#]+/g, '-'));
}
