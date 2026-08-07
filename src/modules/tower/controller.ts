/**
 * Tower module controller — own/reuse lifecycle mirroring the status
 * controller pattern (src/server.ts:90-139 / syncStatusOnTakeover):
 *
 *   - `start()`: this process owns the Bus — tower tools/routes serve the
 *     shared board directly (the board itself is process-shared via
 *     MOAMCP_HOME, so no per-process state needs starting); the status fold
 *     accessor becomes available for B2 identity checks.
 *   - `stop()`: reuse mode (another process owns the Bus) — the fold accessor
 *     returns undefined; the board reads still work (they are disk-backed),
 *     and identity cross-validation (①②③) degrades to verified:false.
 *
 * The controller is a thin seam: it carries the shared BoardStore (mounted
 * after the Bus is constructed — server.ts builds the board after bus.start(),
 * mirroring `bus.mountControlPlane`), the status fold accessor (injected from
 * `statusController.getFold()`; reuse/not-started → empty fold), the start/stop
 * lifecycle, and the B2 CI serial queue (`runCiSerial`).
 */
import type { BoardStore } from '../../core/store/board.js';
import type { StateFold } from '../status/state.js';

export interface TowerControllerOptions {
  /** Shared BoardStore all tower namespaces live in (mountBoard can supply it later). */
  board?: BoardStore;
  /**
   * Status fold accessor: returns the live StateFold while this process owns
   * the Bus and the status controller is running; undefined in reuse mode /
   * before start (B2 identity checks consume it).
   */
  foldAccessor?: () => StateFold | undefined;
}

export interface TowerController {
  /** Start (idempotent) — own-mode lifecycle half (mirrors StatusController.start). */
  start(): void;
  /** Stop (idempotent) — reuse-mode lifecycle half. */
  stop(): void;
  isStarted(): boolean;
  /** The live status fold while started, else undefined (B2 identity checks). */
  getFold(): StateFold | undefined;
  /** The shared BoardStore (undefined until the assembly mounts it). */
  getBoard(): BoardStore | undefined;
  /** Mount the shared BoardStore (server.ts mounts it after bus.start()). */
  mountBoard(board: BoardStore): void;
  /**
   * B2 CI: run one task in the process-internal SERIAL queue. CI runs against
   * the SAME worktree can never overlap within this process — but there is NO
   * cross-process mutex (单塔台单会话 assumption, 风险台账 9/11): two moamcp
   * processes reusing one tower could still run CI concurrently and LWW-stomp
   * `ci/<branchSlug>`. A multi-tower v2 must add a cross-process lock.
   */
  runCiSerial<T>(task: () => Promise<T>): Promise<T>;
}

export function createTowerController(opts: TowerControllerOptions = {}): TowerController {
  let started = false;
  let board: BoardStore | undefined = opts.board;
  const foldAccessor = opts.foldAccessor ?? (() => undefined);
  // In-process CI serial queue: each run chains after the previous one, and a
  // failing run does not poison the tail (the chain swallows rejections).
  let ciTail: Promise<unknown> = Promise.resolve();
  return {
    start(): void {
      started = true;
    },
    stop(): void {
      started = false;
    },
    isStarted: () => started,
    // Reuse / not-started → the fold is empty: B2 identity checks read
    // `getFold()` and must tolerate undefined (fold 滞后 → verified:false).
    getFold: () => (started ? foldAccessor() : undefined),
    getBoard: () => board,
    mountBoard: (mounted) => {
      board = mounted;
    },
    runCiSerial<T>(task: () => Promise<T>): Promise<T> {
      const run = ciTail.then(() => task());
      ciTail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
