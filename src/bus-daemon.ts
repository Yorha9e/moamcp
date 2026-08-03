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
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Bus } from './core/bus/bus.js';
import { spawnBusDaemon } from './core/bus/daemon-spawn.js';
import { BoardStore } from './core/store/board.js';
import { TipStore } from './modules/tips/tips.js';
import { defaultLogsDir } from './modules/debate/state.js';

async function main(): Promise<void> {
  const cwd = process.cwd();
  const bus = new Bus({ cwd, logsDir: defaultLogsDir() });
  const board = new BoardStore({
    workspaceCwd: cwd,
    // The daemon owns the Bus, so board events fan out locally — same routing
    // as the MCP entry's own-mode sink (task scope → task channel, otherwise
    // the synthetic @board/<scope> channel for Control Plane invalidation).
    emit: (scope, event) => bus.publish(scope.kind === 'task' ? scope.taskId : `@board/${scope.key}`, event),
  });
  bus.mountControlPlane(board, new TipStore(board));

  const port = await bus.start();
  if (bus.startResult.mode !== 'own') {
    // A live owner already holds the port — this daemon is redundant.
    await bus.stop().catch(() => {});
    return;
  }

  // Chain restarts: when THIS daemon later serves a restart, its replacement
  // is spawned from whatever build is on disk at that moment.
  bus.onRelease = () => {
    spawnBusDaemon({ port, cwd });
  };
  // Lost ownership (a newer daemon took over after our own release): exit.
  bus.onTakeover = (result) => {
    if (result.mode === 'reuse') process.exit(0);
  };
  process.on('exit', () => rmSync(join(cwd, 'bus.port'), { force: true }));
  console.error(`[moamcp] bus daemon: owns http://127.0.0.1:${port}/ (pid ${process.pid})`);
}

main().catch((err) => {
  console.error('[moamcp] bus daemon failed:', err);
  process.exit(1);
});
