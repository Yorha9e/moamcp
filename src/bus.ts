/**
 * Bus — SSE channel + frontend card, same process as the MCP stdio server
 * (design doc §1.2: Bus SSE on port 8913, address discovery via bus.port).
 *
 * Zero-dependency: node:http + hand-rolled SSE (`data: <json>\n\n` frames).
 * Endpoints:
 *   GET  /                     → self-contained debate card (frontend.ts)
 *   GET  /subscribe?task_id=X  → SSE stream of all events for that task
 *   GET  /archive?task_id=X&file=result.json|probe.json|events.jsonl
 *                              → archived files written by moa_complete
 *   POST /publish              → {task_id, event} fan-out (internal / future hub)
 *
 * Subscribers that connect late get the per-task event log replayed so the
 * card can render roster/history from a cold start.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { FRONTEND_HTML } from './frontend.js';

export interface BusOptions {
  /** Requested port; falls back to a free one when taken. Default 8913. */
  port?: number;
  /** Directory where bus.port is written. Default process.cwd(). */
  cwd?: string;
  /** Max events kept per task for replay to late subscribers. */
  replayLimit?: number;
  /** Archive root written by moa_complete (logs/{task_id}). Default 'logs'. */
  logsDir?: string;
}

/** Files the /archive endpoint is allowed to serve, with their content types. */
const ARCHIVE_FILES: Record<string, string> = {
  'result.json': 'application/json; charset=utf-8',
  'probe.json': 'application/json; charset=utf-8',
  'events.jsonl': 'application/x-ndjson; charset=utf-8',
};

export class Bus {
  private server: Server;
  private subscribers = new Map<string, Set<ServerResponse>>();
  /** Per-task serialized frames, replayed to late subscribers. */
  private eventLog = new Map<string, string[]>();
  private port = 0;
  private readonly requestedPort: number;
  private readonly cwd: string;
  private readonly replayLimit: number;
  private readonly logsDir: string;

  constructor(opts: BusOptions = {}) {
    this.requestedPort = opts.port ?? 8913;
    this.cwd = opts.cwd ?? process.cwd();
    this.replayLimit = opts.replayLimit ?? 200;
    this.logsDir = opts.logsDir ?? 'logs';
    this.server = createServer((req, res) => void this.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }));
  }

  get actualPort(): number {
    return this.port;
  }

  async start(): Promise<number> {
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => reject(err);
        this.server.once('error', onError);
        this.server.listen(port, () => {
          this.server.removeListener('error', onError);
          resolve((this.server.address() as AddressInfo).port);
        });
      });
    try {
      this.port = await listen(this.requestedPort);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      this.port = await listen(0); // port taken → pick a free one
    }
    await writeFile(join(this.cwd, 'bus.port'), String(this.port));
    return this.port;
  }

  /** Fan an event out to all subscribers of the task (and append to the replay log). */
  publish(taskId: string, event: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify({ task_id: taskId, ts: new Date().toISOString(), ...event })}\n\n`;
    const log = this.eventLog.get(taskId) ?? [];
    log.push(frame);
    if (log.length > this.replayLimit) log.shift();
    this.eventLog.set(taskId, log);
    for (const res of this.subscribers.get(taskId) ?? []) res.write(frame);
  }

  async stop(): Promise<void> {
    for (const subs of this.subscribers.values()) for (const res of subs) res.end();
    this.subscribers.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(join(this.cwd, 'bus.port'), { force: true });
  }

  private async handle(req: import('node:http').IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FRONTEND_HTML);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/subscribe') {
      const taskId = url.searchParams.get('task_id');
      if (!taskId) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'task_id query param required' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(':ok\n\n');
      for (const frame of this.eventLog.get(taskId) ?? []) res.write(frame); // replay
      let subs = this.subscribers.get(taskId);
      if (!subs) this.subscribers.set(taskId, (subs = new Set()));
      subs.add(res);
      req.on('close', () => {
        subs.delete(res);
        if (subs.size === 0) this.subscribers.delete(taskId);
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/archive') {
      const taskId = url.searchParams.get('task_id') ?? '';
      const file = url.searchParams.get('file') ?? '';
      const contentType = ARCHIVE_FILES[file];
      if (!taskId || /[\\/]|\.\./.test(taskId) || !contentType) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'valid task_id and file (result.json|probe.json|events.jsonl) required' }));
        return;
      }
      try {
        const content = await readFile(resolve(this.logsDir, taskId, file), 'utf8');
        res.writeHead(200, { 'content-type': contentType });
        res.end(content);
      } catch {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'archive not found' }));
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/publish') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { task_id: taskId, event } = JSON.parse(body) as { task_id?: string; event?: Record<string, unknown> };
      if (!taskId || !event) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'body must be {task_id, event}' }));
        return;
      }
      this.publish(taskId, event);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
}
