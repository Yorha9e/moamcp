/**
 * Workspace → project migration (mailbox task 2c).
 *
 * Adopts an existing workspace board (`ws-<hash>.jsonl`) into a project:
 *   1. The workspace path's hash is aliased to the project in the registry
 *      (idempotent when already aliased).
 *   2. Every record — tombstones included — is rewritten with its `scope`
 *      field set to `project:<id>` and appended to `project-<id>.jsonl`,
 *      preserving complete history (append-only semantics make dedup moot).
 *   3. The target's size growth is verified against the bytes written before
 *      the alias is registered; on any failure the target is truncated back
 *      to its pre-migration size and no alias is left behind.
 *   4. The legacy files are NOT deleted: they are renamed to
 *      `*.migrated-<epoch-ms>` so the original records stay recoverable.
 */
import { appendFile, mkdir, readFile, rename, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { moamcpHome } from '../bus/registry.js';
import { withAppendLock } from './append-lock.js';
import { normalizeWorkspacePath, workspaceIdForPath } from './board.js';
import { ProjectRegistry } from './project-registry.js';

export interface WorkspaceMigrationOptions {
  /** Target project id; a fresh project (optionally `name`d) is created when omitted. */
  projectId?: string;
  /** Name used only when a new project is created. */
  name?: string;
  /** Brand home holding `boards/` + `registry.jsonl`. Default `moamcpHome()` at call time. */
  homeDir?: string;
  /** Registry to alias through. Default: a fresh ProjectRegistry bound to `homeDir`. */
  registry?: ProjectRegistry;
}

export interface WorkspaceMigrationResult {
  projectId: string;
  /** Records rewritten into the project board (0 on idempotent re-runs). */
  moved: number;
}

async function fileSizeOrZero(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/** Restore the target to exactly `size` bytes (removing it when that is zero). */
async function rollbackToSize(file: string, size: number): Promise<void> {
  if (size === 0) {
    await unlink(file).catch(() => {});
    return;
  }
  await truncate(file, size).catch(() => {});
}

/** Archive-rename a legacy file; an absent file is simply skipped. */
async function archiveRename(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Record the migrated cwd in the project's `cwds[]` sidecar
 * (`project-<id>.meta.json`), creating it when missing. Migration bypasses
 * BoardStore's scope machinery (which normally writes the sidecar), so the
 * Control Plane's `project:<id>` browsing — which reads `cwds[0]` to find a
 * path the alias resolves — depends on this record existing (mailbox task 5b).
 * The read-modify-write runs under the meta file's append lock, mirroring
 * BoardStore.ensureProjectSidecar.
 */
async function ensureProjectMetaCwd(boardsDir: string, projectId: string, cwd: string): Promise<void> {
  const metaFile = join(boardsDir, `project-${projectId}.meta.json`);
  await withAppendLock(metaFile, async () => {
    let doc: { projectId: string; cwds: string[]; created_at: string } | undefined;
    try {
      const parsed = JSON.parse(await readFile(metaFile, 'utf8')) as Record<string, unknown>;
      if (
        parsed.projectId === projectId &&
        Array.isArray(parsed.cwds) &&
        parsed.cwds.every((entry) => typeof entry === 'string') &&
        typeof parsed.created_at === 'string'
      ) {
        doc = parsed as unknown as { projectId: string; cwds: string[]; created_at: string };
      }
    } catch {
      // Missing or corrupt sidecar: rewrite it (mirrors ensureProjectSidecar).
    }
    if (doc !== undefined && doc.cwds.includes(cwd)) return; // already recorded
    const next = doc ?? { projectId, cwds: [] as string[], created_at: new Date().toISOString() };
    if (!next.cwds.includes(cwd)) next.cwds = [...next.cwds, cwd];
    await writeFile(metaFile, JSON.stringify(next, null, 2));
  });
}

/**
 * Migrate `workspace`'s board into a project, aliasing the workspace path so
 * future workspace-scope operations resolve to the project board. Idempotent:
 * re-running returns the existing alias with `moved: 0` (and rejects when
 * `opts.projectId` conflicts with the existing alias).
 */
export async function migrateWorkspaceToProject(
  workspace: string,
  opts: WorkspaceMigrationOptions = {},
): Promise<WorkspaceMigrationResult> {
  const homeDir = opts.homeDir ?? moamcpHome();
  const registry = opts.registry ?? new ProjectRegistry({ homeDir });
  const cwd = normalizeWorkspacePath(workspace);
  const pathHash = workspaceIdForPath(cwd);
  const boardsDir = join(homeDir, 'boards');
  const sourceFile = join(boardsDir, `ws-${pathHash}.jsonl`);
  const sourceMeta = join(boardsDir, `ws-${pathHash}.meta.json`);

  // 1. Idempotency/conflict gate on the current projection; addAlias re-checks
  //    under the registry lock, so a racing peer aliasing surfaces as a
  //    conflict error (rolled back below), not a silent second owner.
  await registry.refreshIfStale();
  const existing = registry.resolveCached(pathHash);
  if (existing !== undefined) {
    if (opts.projectId !== undefined && opts.projectId !== existing) {
      throw new Error(
        `workspace ${cwd} is already aliased to project ${existing}; refusing to migrate it to ${opts.projectId}`,
      );
    }
    // Repair path: migrations predating the meta record (task 5b) may lack
    // it; browsing needs cwds[0]. Best-effort — the alias itself is intact.
    await ensureProjectMetaCwd(boardsDir, existing, cwd).catch(() => {});
    return { projectId: existing, moved: 0 };
  }

  // 2. Resolve or create the target project.
  let projectId: string;
  if (opts.projectId !== undefined) {
    if (typeof opts.projectId !== 'string' || !/^p_[0-9a-f]{12}$/.test(opts.projectId)) {
      throw new Error(`invalid projectId: ${String(opts.projectId)} (expected p_<12 hex chars>)`);
    }
    projectId = opts.projectId;
    const known = (await registry.listProjects()).some((project) => project.projectId === projectId);
    if (!known) throw new Error(`unknown projectId: ${projectId} (create it first or omit projectId)`);
  } else {
    projectId = await registry.createProject(opts.name);
  }

  const targetFile = join(boardsDir, `project-${projectId}.jsonl`);

  // The lock file lives beside the target board, so the boards dir must exist
  // before acquisition (a never-written workspace has no boards/ yet).
  await mkdir(boardsDir, { recursive: true });

  // 3+4. Move + verify + alias under the target board's append lock, so no
  // concurrent BoardStore append can slip between the write and the size check.
  return withAppendLock(targetFile, async () => {
    const beforeSize = await fileSizeOrZero(targetFile);

    let raw = '';
    try {
      raw = await readFile(sourceFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // No legacy board file: the alias alone adopts the (empty) workspace.
    }

    let moved = 0;
    let body = '';
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        record = undefined;
      }
      if (typeof record === 'object' && record !== null) {
        // Rewrite the scope field, preserving everything else (including
        // tombstone deletes) so the project board replays the full history.
        body += JSON.stringify({ ...(record as Record<string, unknown>), scope: `project:${projectId}` }) + '\n';
        moved += 1;
      } else {
        body += line + '\n'; // unverifiable bytes preserved verbatim (the fold skips them with a warning)
      }
    }

    try {
      if (body.length > 0) await appendFile(targetFile, body, 'utf8');
      const written = Buffer.byteLength(body, 'utf8');
      const afterSize = await fileSizeOrZero(targetFile);
      if (afterSize - beforeSize !== written) {
        throw new Error(
          `migration size check failed for ${targetFile}: expected +${written} bytes, observed +${afterSize - beforeSize}`,
        );
      }
      await registry.addAlias(projectId, pathHash);
      // Record the cwd in the project's cwds sidecar so the Control Plane can
      // browse the project via `project:<id>` (task 5b). A failure unwinds our
      // freshly registered alias: migration stays all-or-nothing. (removeAlias
      // runs only on this path — when addAlias itself throws, the hash may be
      // owned by another project and must not be touched.)
      try {
        await ensureProjectMetaCwd(boardsDir, projectId, cwd);
      } catch (metaErr) {
        await registry.removeAlias(pathHash).catch(() => {});
        throw metaErr;
      }
    } catch (err) {
      // Leave the error scene, but never a grown target or a half-registered alias.
      await rollbackToSize(targetFile, beforeSize);
      throw err;
    }

    // 5. Archive (never delete) the legacy workspace files. A failure here
    //    unwinds the alias + target growth so the migration stays all-or-nothing.
    const stamp = Date.now();
    try {
      await archiveRename(sourceFile, `${sourceFile}.migrated-${stamp}`);
      await archiveRename(sourceMeta, `${sourceMeta}.migrated-${stamp}`);
    } catch (err) {
      await registry.removeAlias(pathHash).catch(() => {});
      await rollbackToSize(targetFile, beforeSize);
      throw err;
    }

    return { projectId, moved };
  });
}
