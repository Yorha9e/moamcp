/**
 * Tower stdio bridge (standard, repo-root `scripts/`): speaks MCP over stdio
 * to the tower plugin's `dist/server.js`, so a session whose tool surface
 * lacks the `moa_tower_*` tools can still drive the tower through `Bash`.
 *
 * Usage:  node scripts/tower-cli.mjs <tool> '<json>|@file' [timeoutMs]
 *   <tool>      a moa_tower_* tool name, e.g. moa_tower_progress
 *   <json>      inline JSON payload — include `workspace` (absolute repo root)
 *               and `caller_agent_id` (the caller's engine agent id) in the
 *               payload; a `caller_agent_id` convenience is just part of the
 *               JSON, the CLI keeps no special handling.
 *   @file       same JSON, loaded from disk (`@<path>`) for large payloads.
 *   timeoutMs   optional per-call timeout (ms), with progress-reset.
 *
 * The spawned server's cwd is the REPO ROOT derived from THIS script's own
 * location (scripts/ is one level below the root) — never a hardcoded path,
 * so the bridge works from any checkout and from any invocation cwd.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [tool, argsJson, timeoutMs] = process.argv.slice(2);
if (tool === undefined) {
  console.error("usage: node scripts/tower-cli.mjs <tool> '<json>|@file' [timeoutMs]");
  process.exit(2);
}

// Repo root = the parent of scripts/ — derive, never hardcode.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverJs = join(repoRoot, "dist", "server.js");
const raw = argsJson === undefined ? "{}" : argsJson.startsWith("@") ? readFileSync(argsJson.slice(1), "utf8") : argsJson;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverJs],
  cwd: repoRoot,
});
const client = new Client({ name: "tower-cli", version: "0.0.1" });

let exitCode = 0;
try {
  await client.connect(transport);
  const opts = timeoutMs ? { timeout: Number(timeoutMs), resetTimeoutOnProgress: true } : undefined;
  const result = await client.callTool({ name: tool, arguments: JSON.parse(raw) }, undefined, opts);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`tower-cli ${tool} failed: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
process.exit(exitCode);
