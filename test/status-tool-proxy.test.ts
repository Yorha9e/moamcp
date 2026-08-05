/**
 * Batch 1c P5: moa_status_agents reuse proxy. When the status controller is
 * not started locally but the assembly passed a known owner port, the tool
 * fetches the owning Bus's read-only /status and tags the result source:
 * 'remote'. A 503 (owner not ready), a timeout, or a connection error falls
 * back to an explicit local-empty state (source: 'local-empty'). Own/started
 * behaviour is unchanged (source: 'local'). The port seam is the controller's
 * setPort; the timeout is injectable via createStatusModule's option, so the
 * three states are exercised against a fake HTTP server.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore } from '../src/core/store/board.js';
import {
  createStatusController,
  createStatusModule,
  type StatusController,
} from '../src/modules/status/index.js';
import { createServer as createMcpServer } from '../src/server.js';

/** A representative /status snapshot as the owning Bus would serve it. */
const REMOTE_SNAPSHOT = {
  server: { pid: 999, port: 12345, started_at: '2026-07-22T00:00:00.000Z', uptime: 42 },
  scan: { scanning: false, homes: [] },
  sources: {
    wire: { sessions: 2, agents: 3 },
    omkc: {
      connected: false,
      port: null,
      pid: null,
      version: null,
      connectedAt: null,
      protocolVersion: null,
      legacy: false,
    },
  },
  sessions: [{ workDirHash: 'wd_x', sessionId: 's-remote', home: 'omkc' }],
  agents: [
    {
      sessionId: 's-remote',
      agentId: 'main',
      busy: true,
      subagents: [],
      lastSeen: 1,
      firstSeen: 1,
      source: 'wire',
      omkcTs: 0,
      stale: false,
    },
  ],
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

describe('moa_status_agents reuse proxy (batch 1c)', () => {
  let boardHome: string;
  let server: Awaited<ReturnType<typeof createMcpServer>> | undefined;
  let client: Client | undefined;
  let controller: StatusController | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    controller?.stop();
    if (boardHome) await rm(boardHome, { recursive: true, force: true });
    client = undefined;
    server = undefined;
    controller = undefined;
  });

  /** Hermetic controller: never watches a real ~/.omkc or probes a real omkc. */
  function makeController(): StatusController {
    const missing = join(tmpdir(), 'moamcp-tool-proxy-missing');
    return createStatusController({
      env: { OMKC_HOME: `${missing}-omkc`, KIMI_CODE_HOME: `${missing}-kimi` } as NodeJS.ProcessEnv,
      omkcProbeMin: 40000,
      omkcProbeMax: 40000,
      omkcProbeIntervalMs: 5000,
      omkcProbeTimeoutMs: 100,
    });
  }

  async function makeClient(ctrl: StatusController): Promise<void> {
    controller = ctrl;
    boardHome = await mkdtemp(join(tmpdir(), 'moamcp-tool-proxy-'));
    const board = new BoardStore({ homeDir: boardHome, workspaceCwd: process.cwd(), waitCapMs: 200, pollIntervalMs: 15 });
    server = createMcpServer(undefined, undefined, board, undefined, createStatusModule(ctrl, { remoteStatusTimeoutMs: 200 }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'status-proxy-test', version: '0.0.1' });
    await client.connect(clientTransport);
  }

  async function callAgents(args: Record<string, unknown> = {}): Promise<any> {
    const res = await client!.callTool({ name: 'moa_status_agents', arguments: args });
    return JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
  }

  it('proxies the owning Bus /status when not started (200 → remote)', async () => {
    const fake = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(REMOTE_SNAPSHOT));
    });
    const port = await listen(fake);
    const ctrl = makeController();
    ctrl.setPort(port); // the assembly seam (server.ts passes startResult.port)
    await makeClient(ctrl);
    try {
      const result = await callAgents();
      expect(result.source).toBe('remote');
      expect(result.server).toEqual({ pid: 999, port: 12345, started_at: '2026-07-22T00:00:00.000Z', uptime: 42 });
      expect(result.sources.wire).toEqual({ sessions: 2, agents: 3 });
      expect(result.agents).toHaveLength(1);
    } finally {
      fake.close();
    }
  });

  it('falls back to local-empty when the owner is not ready (503)', async () => {
    const fake = createHttpServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'status_not_ready', started: false }));
    });
    const port = await listen(fake);
    const ctrl = makeController();
    ctrl.setPort(port);
    await makeClient(ctrl);
    try {
      const result = await callAgents();
      expect(result.source).toBe('local-empty');
      expect(result.started).toBe(false);
      expect(result.agents).toEqual([]);
      expect(result.agentsTruncated).toBe(0);
    } finally {
      fake.close();
    }
  });

  it('falls back to local-empty when the owner times out', async () => {
    const fake = createHttpServer((_req, _res) => {
      // never respond: the 200ms client timeout must fire first
    });
    const port = await listen(fake);
    const ctrl = makeController();
    ctrl.setPort(port);
    await makeClient(ctrl);
    try {
      const result = await callAgents();
      expect(result.source).toBe('local-empty');
      expect(result.started).toBe(false);
      expect(result.agents).toEqual([]);
    } finally {
      fake.closeAllConnections();
      fake.close();
    }
  });

  it('keeps the local snapshot with source local once started (own-mode unchanged)', async () => {
    const ctrl = makeController();
    ctrl.start();
    await makeClient(ctrl);
    const result = await callAgents({ limit: 10 });
    expect(result.source).toBe('local');
    expect(result.started).toBe(true);
    expect(result.scanning).toBe(false);
  });
});
