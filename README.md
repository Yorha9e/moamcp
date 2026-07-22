# moamcp

Mailbox-style multi-agent debate hub (MOA), exposed as an MCP server over stdio.
Implements design doc `../MOA_FLOW_DESIGN.md` §4c (mailbox mode), §5.2 (three-layer
archive), §5.3 (tool list). Port discovery follows `../MOAMCP_PORT_DISCOVERY.md`.

## Startup behavior

`node dist/server.js` (as declared in `kimi.plugin.json` → `mcpServers.moamcp`) starts
**two channels in one process**:

- **MCP over stdio** — the 5 tools below. The plugin manifest declares
  `toolTimeoutMs: 1800000` because `moa_wait_turn` long-polls (design doc §4c.4).
- **Bus (SSE + frontend card) over HTTP** — default port `8913`
  (`MOAMCP_BUS_PORT` overrides); see "Instance discovery & port selection" for
  what happens when the port is taken.

Environment variables:

| Var | Default | Purpose |
|---|---|---|
| `MOAMCP_HOME` | `~/.moamcp` | Root for the instance registry (`<home>/instances`) |
| `MOAMCP_LOGS_DIR` | `<MOAMCP_HOME>/logs` | Archive root written by `moa_complete` |
| `MOAMCP_BUS_PORT` | `8913` | Intended Bus port |
| `MOAMCP_WAIT_CAP_MS` | 25 min | `moa_wait_turn` long-poll safety cap |

## Instance discovery & port selection

**Registry** — every instance registers `<MOAMCP_HOME>/instances/<pid>.json`
(`{id (ULID), pid, port, started_at, version}`) BEFORE binding, so concurrent
peers can see it during the bind window. Single-writer atomic (rename) writes,
no locking. Stale entries left by killed processes (Windows does not deliver
SIGTERM) are swept lazily on `register`/`listLive` with a `kill(pid, 0)` probe:
an entry is unlinked ONLY when the pid is positively dead (ESRCH); EPERM and
unparseable entries are conservatively kept.

**Port rules** — register (intended port) → bind:

1. Bind succeeds → own mode; the actually-bound port is written back to the
   registry entry (`update({port})`).
2. `EADDRINUSE` → consult the registry (excluding our own pid entry):
   - a live moamcp holds the port (entry + live pid + HTTP health probe
     `GET /tasks` passes, 200 ms timeout, 0 retries) → **reuse mode**;
   - a dead entry or a non-moamcp listener → delete/skip it and walk to
     port+1, capped at 100 retries (then exit with an error — the registry
     entry is released first, never left behind unbound).

**Reuse mode** — the new process does NOT bind a Bus. It remains a complete
MCP stdio server (independent debate state) and forwards its domain events to
the owning Bus via `POST /publish` — strictly best-effort: timeout / network
failure / non-200 logs a warning and drops the event (no blocking, no retry of
the MCP call chain). Dropped events are covered by the owning Bus's SSE replay
buffer (last 200 frames per task) and the archive. On entering reuse mode the
process deletes its own registry entry. `moa_init`'s `card_url` points at the
owning Bus's port, and both processes share the `MOAMCP_LOGS_DIR` archive root
so the old Bus's `/archive` serves the new process's tasks. Windows orphans
left behind by a hard-killed host CLI thus become reusable assets instead of
debris.

**Compat** — `{cwd}/bus.port` is still written in own mode (and removed on
clean shutdown where the platform delivers one), but it is no longer the
primary discovery channel; reuse mode never writes it.

**Cross-version publish** — events are open JSON; the frontend tolerates
unknown fields, so a newer reuser forwarding to an older owning Bus (or vice
versa) degrades gracefully. Registry entries carry `version` for diagnostics.

## MCP tools (§5.3)

| Tool | Caller | Purpose |
|---|---|---|
| `moa_init` | orchestrator | Initialize task state (agents, debate params); returns `{ok, card_url}` — the debate card URL to open (task_id percent-encoded) |
| `moa_start_debate` | orchestrator | Seed state machine with reference results |
| `moa_wait_turn` | debate agent | Long-poll until own turn / debate end / timeout |
| `moa_submit_turn` | debate agent | Submit turn, advance round-robin |
| `moa_complete` | orchestrator | Write three-layer archive, close task; returns `{ok, archive}` |

## Bus endpoints

- `GET /?task_id=<id>` — self-contained debate card (stage progress, preset/config, agent status, live transcript, verdict). Without `task_id` it renders a **task picker** listing active tasks (click to open)
- `GET /tasks` — `{tasks: string[]}` active task ids (derived from the event log)
- `GET /subscribe?task_id=<id>` — SSE stream of task events (late subscribers get a replay)
- `GET /archive?task_id=<id>&file=result.json|probe.json|events.jsonl` — archived files after `moa_complete` (whitelist, no traversal)
- `POST /publish` — `{task_id, event}` fan-out (internal: reuse-mode forwarding / future hub messages)

Domain events: `task_initialized`, `debate_started`, `turn_submitted`,
`turn_advanced`, `debate_complete`, `task_closed` — each fanned out as
`data: {"task_id", "ts", ...}` JSON frames.

## Archive (§5.2)

`moa_complete` writes `<MOAMCP_LOGS_DIR>/{task_id}/{probe.json, events.jsonl, result.json}`
(default root `~/.moamcp/logs`). Note: archives written by older versions under
`./logs` are NOT migrated — point `MOAMCP_LOGS_DIR` at the old directory to
read or serve them.

## Development

```
npm install
npm run build   # tsc → dist/
npm test        # vitest: smoke (mailbox flow) + registry + bus (HTTP/SSE) + reuse (two real processes) suites
npm start       # node dist/server.js
```

Zero runtime dependencies beyond `@modelcontextprotocol/sdk`.
