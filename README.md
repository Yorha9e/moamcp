# moamcp

Mailbox-style multi-agent debate hub (MOA), exposed as an MCP server over stdio.
Implements design doc `../MOA_FLOW_DESIGN.md` §4c (mailbox mode), §5.2 (three-layer
archive), §5.3 (tool list).

## Startup behavior

`node dist/server.js` (as declared in `kimi.plugin.json` → `mcpServers.moamcp`) starts
**two channels in one process**:

- **MCP over stdio** — the 5 tools below. The plugin manifest declares
  `toolTimeoutMs: 1800000` because `moa_wait_turn` long-polls (design doc §4c.4).
- **Bus (SSE + frontend card) over HTTP** — default port `8913`, override with
  `MOAMCP_BUS_PORT`; if the port is taken a free one is chosen. The actual port is
  written to `{cwd}/bus.port` on every start (overwrite = discovery mechanism, design
  doc §1.3) and removed on clean shutdown where the platform delivers one.

Other env vars: `MOAMCP_WAIT_CAP_MS` (long-poll safety cap, default 25 min),
`MOAMCP_LOGS_DIR` (archive root, default `./logs`).

## MCP tools (§5.3)

| Tool | Caller | Purpose |
|---|---|---|
| `moa_init` | orchestrator | Initialize task state (agents, debate params) |
| `moa_start_debate` | orchestrator | Seed state machine with reference results |
| `moa_wait_turn` | debate agent | Long-poll until own turn / debate end / timeout |
| `moa_submit_turn` | debate agent | Submit turn, advance round-robin |
| `moa_complete` | orchestrator | Write three-layer archive, close task |

## Bus endpoints

- `GET /?task_id=<id>` — self-contained debate card (stage progress, preset/config, agent status, live transcript, verdict)
- `GET /subscribe?task_id=<id>` — SSE stream of task events (late subscribers get a replay)
- `GET /archive?task_id=<id>&file=result.json|probe.json|events.jsonl` — archived files after `moa_complete` (whitelist, no traversal)
- `POST /publish` — `{task_id, event}` fan-out (internal / future hub messages)

Domain events: `task_initialized`, `debate_started`, `turn_submitted`,
`turn_advanced`, `debate_complete`, `task_closed` — each fanned out as
`data: {"task_id", "ts", ...}` JSON frames.

## Archive (§5.2)

`moa_complete` writes `logs/{task_id}/{probe.json, events.jsonl, result.json}`.

## Development

```
npm install
npm run build   # tsc → dist/
npm test        # vitest: smoke (mailbox flow) + bus (HTTP/SSE) suites
npm start       # node dist/server.js
```

Zero runtime dependencies beyond `@modelcontextprotocol/sdk`.
