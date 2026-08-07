#!/usr/bin/env node
/**
 * moamcp bus daemon — headless Bus owner without the MCP stdio server.
 *
 * Spawned by spawnBusDaemon() when a controlled restart (POST /api/bus/restart)
 * releases the port: the daemon binds it running the CURRENT DISK BUILD, so the
 * Control Plane / debate card come back on the new code immediately instead of
 * waiting for the user to reload a session (BUS_VERSION_RESTART.md task D).
 *
 * Lifecycle: a daemon that does not own the port has no purpose — it exits when
 * it starts in reuse mode (a live owner beat it to the bind) and when a later
 * restart hands ownership to a newer daemon (passive re-attach fires onTakeover
 * with mode 'reuse'). There is deliberately no stdin/parent watchdog: the whole
 * point is surviving the spawning process.
 */
import { Bus } from './core/bus/bus.js';
import { spawnBusDaemon } from './core/bus/daemon-spawn.js';
import { DAEMON_VERSION_CHECK_MS, diskVersionMismatch } from './core/bus/daemon-version-check.js';
import { readDiskVersion } from './core/bus/disk-version.js';
import { BoardStore } from './core/store/board.js';
import { createStatusController } from './modules/status/index.js';
import { createTowerController } from './modules/tower/index.js';
import { TipStore } from './modules/tips/tips.js';
import { defaultLogsDir } from './modules/debate/state.js';

async function main(): Promise<void> {
  const cwd = process.cwd();
  // Batch 1c P1: the status controller is built before the Bus so the daemon's
  // Control Plane serves /status; it starts once the daemon confirms it owns
  // the port (the daemon is batch-1c option ①'s folded owner).
  const statusController = createStatusController();
  // Tower module (B1): same seam — the daemon's Control Plane serves the
  // /api/tower/* routes; the controller starts once ownership is confirmed
  // (the board is process-shared under MOAMCP_HOME, so no per-process state
  // needs starting; B2 identity checks read getFold()).
  const towerController = createTowerController({
    foldAccessor: () => statusController.getFold(),
  });
  const bus = new Bus({ cwd, logsDir: defaultLogsDir(), statusController, towerController });
  const board = new BoardStore({
    workspaceCwd: cwd,
    // The daemon owns the Bus, so board events fan out locally — same routing
    // as the MCP entry's own-mode sink (task scope → task channel, otherwise
    // the synthetic @board/<scope> channel for Control Plane invalidation).
    emit: (scope, event) => bus.publish(scope.kind === 'task' ? scope.taskId : `@board/${scope.key}`, event),
  });
  towerController.mountBoard(board);
  bus.mountControlPlane(board, new TipStore(board));

  const port = await bus.start();
  if (bus.startResult.mode !== 'own') {
    // A live owner already holds the port — this daemon is redundant.
    await bus.stop().catch(() => {});
    return;
  }

  // Own confirmed: the status fold is this daemon's to serve (batch 1c P1).
  statusController.setPort(port);
  statusController.start();
  towerController.start();

  // Version self-check (batch 1c P4): every 60s compare the installed disk
  // build version against the running VERSION. A mismatch means a newer build
  // landed on disk after this daemon started — exit(0) so the next release
  // chain / fresh session rebuild takes the port. No logging: the daemon's
  // stdio is 'ignore', so a marker file would be the only observable side
  // effect (not required). MOAMCP_DAEMON_VERSION_CHECK_MS overrides the
  // interval (test seam).
  const versionCheckMs = (() => {
    const raw = Number(process.env.MOAMCP_DAEMON_VERSION_CHECK_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DAEMON_VERSION_CHECK_MS;
  })();
  const versionCheck = setInterval(() => {
    void readDiskVersion().then((diskVersion) => {
      if (diskVersionMismatch(diskVersion)) process.exit(0);
    });
  }, versionCheckMs);
  versionCheck.unref();

  // Chain restarts: when THIS daemon later serves a restart, its replacement
  // is spawned from whatever build is on disk at that moment.
  bus.onRelease = () => {
    spawnBusDaemon({ port, cwd });
  };
  // Lost ownership (a newer daemon took over after our own release): exit.
  bus.onTakeover = (result) => {
    if (result.mode === 'reuse') process.exit(0);
  };
  // P3: remove bus.port only while this daemon wrote and still owns it — after
  // a controlled release the replacement daemon owns the file and must keep it,
  // and a reuse-mode exit never touched it in the first place.
  process.on('exit', () => bus.removePortFileIfOwnedSync());
  console.error(`[moamcp] bus daemon: owns http://127.0.0.1:${port}/ (pid ${process.pid})`);
}

main().catch((err) => {
  console.error('[moamcp] bus daemon failed:', err);
  process.exit(1);
});
