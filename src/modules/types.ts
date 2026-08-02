/**
 * Module interface for the moamcp consumer layer (design: MOAMCP_REFACTOR §3).
 *
 * A module bundles a product feature's MCP tool definitions and/or HTTP route
 * definitions. Adapters aggregate modules — the MCP adapter turns `tools`
 * into the MCP server surface, the HTTP adapter registers `routes` — so a
 * module never imports an adapter. `init` receives shared infrastructure for
 * modules that wire up after construction; the current modules take their
 * services through their factory functions instead.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Bus } from '../core/bus/bus.js';
import type { BoardStore } from '../core/store/board.js';
import type { DebateHub, DomainEvent } from './debate/state.js';
import type { TipStore } from './tips/tips.js';

export type MoaTier = 'stable' | 'experimental';

/** JSON object accepted as an MCP tool request body. */
export type MoaToolArgs = Record<string, unknown>;

/** Plain JSON Schema (object shape) advertised to MCP clients. */
export interface MoaToolSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * One MCP tool: schema is advertised verbatim through ListTools, `handler`
 * receives the raw tool arguments and returns the JSON-encodable result
 * (undefined results are exposed as null over MCP by the adapter).
 */
export interface MoaToolDef {
  name: string;
  description: string;
  inputSchema: MoaToolSchema;
  handler(args: MoaToolArgs): unknown;
}

/** A JSON request body plus the adapter's shared validation helpers. */
export type JsonObject = Record<string, unknown>;

/**
 * Per-request context the HTTP adapter hands to a module route handler. The
 * adapter owns all transport policy (content-type/origin/size enforcement,
 * status-code mapping, JSON serialization); handlers orchestrate module
 * services through this seam and never touch request plumbing directly.
 */
export interface MoaRouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly serverPort?: number;
  /** Validated path parameter for pattern routes (undefined on exact routes). */
  readonly param?: string;
  /** Read and validate the JSON request body (adapter enforces transport policy). */
  jsonBody(): Promise<JsonObject>;
  /** Resolve a workspace sidecar id to an absolute cwd; 400-shaped id or unknown workspace throw. */
  resolveWorkspace(id: unknown): Promise<{ id: string; cwd: string }>;
  sendJson(status: number, body: unknown): void;
  /** Throw a request-validation error the adapter maps to HTTP 400. */
  badRequest(message: string): never;
  /** Reject `cwd`/`path` escape-hatch fields in browser mutation bodies (400). */
  rejectPathFields(body: JsonObject): void;
  /** Reject body fields outside `allowed` (400). */
  assertAllowedFields(body: JsonObject, allowed: readonly string[], label: string): void;
  /** Require an `expectedHash` field for configuration mutations; string or null (400 otherwise). */
  requireExpectedHash(body: JsonObject): string | null;
}

/**
 * One HTTP route contributed by a module. `path` is the exact pathname for
 * literal routes; parameterized routes additionally set `pattern` (anchored
 * full-path regex whose first capture is the raw, still-encoded parameter)
 * and `validateParam` to decode/validate that capture — a throw there rejects
 * the path before method matching.
 */
export interface MoaRouteDef {
  method: string;
  path: string;
  pattern?: RegExp;
  validateParam?(rawParam: string): string;
  handler(ctx: MoaRouteContext): Promise<void> | void;
}

/** Infrastructure injected into modules that wire through `init`. */
export interface MoaModuleContext {
  readonly board: BoardStore;
  readonly tips: TipStore;
  readonly hub: DebateHub;
  readonly bus?: Bus;
  readonly emit?: (taskId: string, event: DomainEvent) => void;
}

export interface MoaModule {
  /** 'debate' | 'board' | 'tips' | 'agentconfig' */
  id: string;
  tier: MoaTier;
  tools?: MoaToolDef[];
  routes?: MoaRouteDef[];
  init?(ctx: MoaModuleContext): void;
}
