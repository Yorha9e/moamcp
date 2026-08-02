# moamcp 前端 ↔ 后端接口契约汇总

> 用途：前端从零重构的唯一权威依据。新前端只需对齐本文档即可完整替代现有两页
> （`GET /` 辩论卡片、`GET /control-plane` 工作区控制面），不需要读旧前端代码。
> 所有引用均为 `src/` 下的 file:line（moamcp 仓库根为 `mcpexplore/moamcp/`）。
> omkc-status 契约见第 5 章（源码在独立仓库 `omkc-status/`）。

---

## 1. Bus HTTP 路由全表

Bus 只绑定 `127.0.0.1`（`src/bus.ts:333`）。默认端口 39813（`MOAMCP_BUS_PORT` 覆盖）。
路由分两类：Bus 直接挂载（`src/bus.ts:438-530`）与 Control Plane 代理的 `/control-plane` + `/api/*`（`src/control-plane.ts:249-303`）。

### 1.1 页面路由

| 方法 | 路径 | 查询参数 | 响应 | 来源 |
|---|---|---|---|---|
| GET | `/` | `task_id?` | `text/html` 自包含辩论卡片页；无 `task_id` 时是任务选择器（轮询 `/tasks`） | `bus.ts:441-445` |
| GET | `/control-plane` | `workspace?`（预选工作区） | `text/html` 控制面页，`Cache-Control: no-store` | `control-plane.ts:253-263` |

### 1.2 数据路由（Bus 直挂）

**`GET /tasks`**（`bus.ts:446-451`）
→ `{ tasks: string[] }` — 内存中的活跃任务 ID；`@board/*` 合成频道已被过滤。

**`GET /subscribe?task_id=<id>`**（SSE，`bus.ts:452-474`）
→ 详见第 2 章。缺 `task_id` 返回 400 `{ "error": "task_id query param required" }`。

**`POST /publish`**（reuse 转发用，`bus.ts:494-527`）
- 请求体：`{ task_id: string, event: Record<string, unknown> }`
- 响应：`{ "ok": true }`
- 错误：415（Content-Type 非 JSON）/ 403（Origin 校验失败）/ 400（体不合法）
- 前端一般不需要直接用；它是 reuse 模式实例间转发通道，但**也可用作向任意频道注入事件的通用入口**。

**`GET /archive?task_id=<id>&file=<name>`**（`bus.ts:475-493`）
- `file` 白名单：`result.json` / `probe.json` / `events.jsonl` / `board.jsonl`
- Content-Type：`.json` → `application/json`；`.jsonl` → `application/x-ndjson`
- 错误：400（参数/白名单/路径穿越）、404 `{ "error": "archive not found" }`

### 1.3 Control Plane API（`/api/*`，全部要求 16-hex workspace ID）

**`GET /api/workspaces`**（`control-plane.ts:337-342`）
```typescript
{ workspaces: Array<{ id: string /* 16-hex */, cwd: string, createdAt: string, updatedAt: string | null }> }
```
排序：最近活动优先（`updatedAt ?? createdAt` 降序）。

**`GET /api/tips`**（`control-plane.ts:344-362`）
- 查询：`workspace`（必）, `status?`, `module?`, `tag?`, `includeArchived?`, `limit?`（默认 100，上限 1000）
- status 枚举：`captured | exploring | planned | implemented | deferred | discarded | archived`
- 响应：`{ workspace, tips: Array<{ id, title, summary, status, createdAt, updatedAt, module?, tags?, nextAction?, author? }> }`（列表项**不含** context/documentRefs 等大字段）

**`POST /api/tips`**（创建，`control-plane.ts:372-380`，体上限 64KB）
- 必：`workspace`, `title`, `summary`；选：`status`, `context`(≤8KB), `module`, `tags`, `nextAction`, `documentRefs[{path, section?, note?, contentHash?}]`, `sourceRefs`, `relatedTipIds`, `relatedProjects`, `sourceSessionId`, `author`
- **禁传** `id/createdAt/updatedAt/creator/cwd/path`（400）
- 响应：完整 ProjectTip 对象

**`GET /api/tips/:id?workspace=<id>`** → 完整 ProjectTip（含 context、documentRefs 等）

**`PATCH /api/tips/:id`**（`tips.ts:383-415`）
- 必：`workspace`；可更新全字段，**显式 `null` 清除可选字段**；`actor?` 记录操作者
- 禁传：`id/createdAt/updatedAt/creator/author/cwd/path`

**`POST /api/tips/:id/archive`** — 体 `{ workspace, actor? }` → 返回 status=archived 的完整 Tip

**`GET /api/board`**（`control-plane.ts:405-432`）
- 查询：`scope?`（`workspace` 默认 | `global`；**禁止 `task:<id>`**）, `workspace`（scope=workspace 时必）, `key?`（前缀）, `tag?`, `limit?`
- 响应：`{ scope, workspace?, entries: Array<{ key, value, author, ts, tags, bytes }> }`

统一错误：`400` 参数 / `403` Origin / `404` workspace 或资源不存在 / `405` 方法 / `413` 超限 / `415` Content-Type / `503` stores 未挂载。错误体均为 `{ "error": string }`。

---

## 2. SSE 契约（`/subscribe`）

### 2.1 频道命名
- **任务频道**：`task_id` 原样（辩论事件流）
- **合成黑板频道**：`@board/global`、`@board/workspace:<16-hex>`——只做**失效通知**用，收到后应重新拉 REST，不要消费事件体当数据（`server.ts:501`）
- 合成频道不出现在 `/tasks` 与 `moa_status.tasks`

### 2.2 帧格式与重放
- 连接即发注释帧 `:ok\n\n`（`bus.ts:463`）
- 数据帧：`data: {"task_id":"...","ts":"<ISO>","type":"...", ...}\n\n`（`bus.ts:261`）
- **重放缓冲**：每频道内存保留最近 200 帧，晚到的订阅者先按序收完历史帧再收实时帧（`bus.ts:260-267, 464`）

### 2.3 DomainEvent 事件全集

| type | 关键字段 | 来源 |
|---|---|---|
| `task_initialized` | `agents: string[]`, `agent_specs: [{id, binding_slot?}]`, `rounds: number`, `extras: object` | `state.ts:230-236` |
| `debate_started` | `agents`, `rounds` | `state.ts:252` |
| `turn_submitted` | `agent_id`, `round`, `turn`（全局序号）, `content`（全文）, `excerpt`（前 200 字符）, `signoff?: true` | `state.ts:320-329` |
| `turn_advanced` | `round`, `speaker`（下一位） | `state.ts:373` |
| `signoff_reset` | `agent_id`, `round`, `reset_from` | `state.ts:338-343` |
| `debate_complete` | `rounds`, `turns`, `early?: true`, `reason?: "unanimous_signoff"`, `signoffs?: Record<agent_id, string>` | `state.ts:349-368` |
| `task_closed` | `archive`（绝对路径）, `turns` | `state.ts:423` |
| `board_updated` | `op: "write"\|"delete"`, `scope`, `key`, `author`, `ts` | `board.ts:106-113` |

---

## 3. 归档文件格式（`logs/<task_id>/`，经 `/archive` 访问）

| 文件 | 格式 | 内容 |
|---|---|---|
| `probe.json` | JSON | `{ task_id, created_at, agents: { <id>: { id, binding_slot?, initialized_at } } }` |
| `events.jsonl` | NDJSON | 每行 `{ turn, round, speaker, content, timestamp, signoff? }` |
| `result.json` | JSON | `{ task_id, status: "complete"\|"closed", rounds_configured, rounds_completed, turns, finished_at, early?, reason?, signoffs? }` |
| `board.jsonl` | NDJSON | 每行 `{ op, scope: "task:<id>", key, value?, author, ts, tags? }`（未用黑板则为空文件） |

归档根：`MOAMCP_LOGS_DIR` 或 `<MOAMCP_HOME|~/.moamcp>/logs`（`state.ts:62-64`）。

---

## 4. 安全与传输约束

1. **仅回环**：Bus 绑定 `127.0.0.1`，不监听外部网卡。
2. **Origin 校验**（`control-plane.ts:62-80`）：无 `Origin` 头（CLI/内部 fetch）放行；有则必须 `http:` + `127.0.0.1|localhost`，且与 `Host` 一致。作用于 `/publish` 与全部 `/api` 写操作。
3. **Content-Type 校验**：所有写操作必须 `application/json`，否则 415。
4. **体积上限**：API 请求体 64KB；Board value 32KB；Board key 512B；Tip context 8KB。
5. **渲染纪律**（现有前端遵循，新前端必须继承）：不可信内容（transcript、board value、tip 字段、task_id）一律 `textContent`，**禁止 `innerHTML`**（有测试断言）。
6. URL 中的 `task_id` 必须 `encodeURIComponent`。

### 实现易踩的坑
- **workspace 双重身份**：浏览器 API 只认 16-hex ID（`sha1(normalize(cwd))[0:16]`，`board.ts:71-73`）；请求体里带 `cwd/path` 直接 400。MCP 工具才接受绝对路径。
- **并发与顺序**：DebateHub 按任务、BoardStore 按作用域各有一条 promise 队列串行化；BoardStore 的 `ts` 保证同进程内严格递增。
- **reuse/takeover**：多实例时只有端口属主服务 HTTP；属主死亡后 reuser 每 10s 探测、连续 3 次失败接管（`bus.ts:358-425`）。前端不用关心，但要意识到**页面服务方可能换进程**。

---

## 5. omkc-status 外部契约（可选集成，独立服务）

源码：`omkc-status/src/`。仅回环。CORS 全放开（`Access-Control-Allow-Origin: *`），仅支持 GET/OPTIONS。

### 5.1 端点
- **`GET /health`** → `{ ok, protocolVersion: 1, uptime, sessions, agents, scanning, omkc }`（`server.ts:145-153`）
- **`GET /state`** → 全量内存快照 `{ server, scan, sources, sessions[], agents[] }`
- **`GET /events`** → SSE 流

### 5.2 SSE 帧
1. 连接即发 `event: snapshot` + 全量数据（**可能数百 KB**，解析必须 try/catch、逐项防御）；
2. 增量 `event: agent`（同一 agent 50ms 窗口合并防抖动）；
3. `event: status` 透传原始 omkc 源事件；
4. 每 15s 心跳注释 `: heartbeat <ts>`。

### 5.3 AgentState 字段（`fold.ts:34-69`）
`sessionId`, `agentId`, `home?`, `workDirHash?`, `parentAgentId?`, `kind?`（main/sub）, `model?`, `contextTokens?`, `maxContextTokens?`, `usage?`, `planMode?`, `phase?`（idle/thinking/executing/completed/suspended）, `busy`, `lastFinishReason?`, `lastTurnReason?`, `lastToolCall?: { name, ts, description?, isError? }`, `subagents: [{ subagentId, name?, description?, status, ts, resultSummary?, contextTokens?, error? }]`, `lastSeen`, `firstSeen`, `source: "wire"|"omkc"`, `omkcTs`, `stale`

### 5.4 端口与单实例
默认 39627（`OMKC_STATUS_PORT` 覆盖），冲突时 +1 最多试 100 次。单实例守卫：`~/.omkc/status/server.json`（pid+port 活性三重检查，重复启动直接退出 0）。

### 5.5 新鲜度语义
- **双源聚合**：wire 文件尾随 + omkc 实时 SSE；omkc 事件 30s 内对 model/usage/busy/phase 有独占优先权（`OMKC_PRIORITY_MS`）。
- **stale**：60s 无事件 → `stale: true`；stale agent **永不删除**，前端只做降透明度。
- `scanning` 只出现在 snapshot 和 /health，不在 agent 增量里——需定期轮询 /health 更新扫描标记。

### 5.6 消费方既有模式（值得继承）
- 启动先探 `/health`（500ms 超时），不可达则完全隐藏相关 UI（零痕迹，omkc-status 永远是可选增强）；
- SSE 失败重试 2 次（1s 间隔），3 连败后隐藏并转 30s 轮询 /health；
- 工具日志按 `sessionId:agentId` 对 `lastToolCall.ts` 去重；快照播种时忽略 5 分钟前的工具调用；UI 缓冲上限 ~150 条。

---

## 6. 现有两页的消费面（新前端的最小可行面）

**辩论卡片（`/`）**：`/tasks`（选择器）、`/subscribe?task_id=`（事件流驱动进度条/辩手/transcript/VERDICT）、`/archive?...file=result.json`（task_closed 后取裁决）、可选 omkc-status 两个端点。

**控制面（`/control-plane`）**：`/api/workspaces`、`/api/tips` 全家（GET list / GET one / POST / PATCH / archive）、`/api/board`、`/subscribe?task_id=@board/...`（失效通知→重拉）。

新前端只要不小于这个面即可做到功能对齐；超出部分（如 `/state`、`POST /publish` 注入、`events.jsonl` 回放）可作为增强空间。
