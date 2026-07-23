# moamcp

MOA（Multi-Agent Orchestration，多代理辩论）MCP 插件，为 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) 与其社区版 [omkc](https://github.com/Yorha9e/oh-my-kimi-code) 提供结构化的多代理辩论能力：多个子代理以轮转辩论的方式交叉审查同一目标（安全审计、设计评审、高风险改动的正确性核验），分歧与结论全程可视。

- **邮箱式辩论枢纽**：辩手通过 MCP 工具收发轮次（`moa_wait_turn` 长轮询 / `moa_submit_turn` 提交），状态机保证严格的轮转顺序，辩手之间互不串供。
- **辩论卡片**：同进程拉起一个本地 HTTP Bus（SSE + 静态页面），`moa_init` 返回 `card_url`，浏览器打开即可实时观看进度条（共识 → Reference → 辩论 R N/M → 聚合 → 结论）、preset/配置快照、辩手阵容、逐轮 transcript 与裁决 + findings；探测到 omkc-status 时还会多出 agent 状态墙与工具调用日志两个可选面板（见下）。不带 `task_id` 打开是任务选择页（每 3s 静默刷新任务列表，无任务时不闪屏）。
- **三层归档**：`moa_complete` 落盘 `probe.json`（辩手档案）/ `events.jsonl`（全量事件流）/ `result.json`（裁决），事后可完整回放。
- **多实例共存**：实例注册表 + 端口退让 + Bus 复用，同机开多个 CLI 会话不会端口打架，也不会留下孤儿 Bus。

## 工作原理

```text
宿主 CLI（kimi / omkc）
  │ spawn（stdio，MCP 协议）
  ▼
moamcp 进程
  ├── MCP 工具（moa_init / moa_start_debate / moa_wait_turn /
  │              moa_submit_turn / moa_complete / moa_status）
  │        ↕ 驱动
  │   辩论状态机（轮转、轮次、超时上限、归档）
  │
  ├── own 模式：监听 127.0.0.1:8913（Bus）
  │      ├── GET /            辩论卡片（SSE 实时刷新）
  │      ├── GET /tasks       活跃任务列表
  │      ├── GET /subscribe   SSE 事件流（迟到者自动重放）
  │      ├── GET /archive     三层归档只读访问
  │      └── POST /publish    事件扇入（复用模式转发用）
  │
  └── reuse 模式：端口已被另一个 moamcp 占用时不再监听，
         域事件经 POST /publish 尽力转发给占用端口的 Bus，
         card_url 指向该 Bus —— 卡片上照样看得到本进程的任务。
```

辩手由宿主 CLI 的子代理充当：orchestrator 发起辩论并并行派发辩手，每个辩手在自己的上下文里循环 `wait_turn → 发言 → submit_turn`，直到辩论结束。除 `@modelcontextprotocol/sdk` 外零运行时依赖。

## 安装

插件清单为仓库根目录的 `kimi.plugin.json`（声明 stdio MCP server：`node ./dist/server.js`；`toolTimeoutMs: 1800000` 是因为 `moa_wait_turn` 长轮询）。`dist/server.js` 是**已提交的单文件 bundle**（esbuild 打包，自包含），从 GitHub 直接安装无需任何构建步骤。

### omkc（社区版，推荐）

```text
/plugins install https://github.com/Yorha9e/moamcp
/reload
```

或钉住分支 / tag / commit：

```text
/plugins install https://github.com/Yorha9e/moamcp/tree/main
```

### 官方 kimi-code

命令相同，安装方式完全一致：

```text
/plugins install https://github.com/Yorha9e/moamcp
/reload
```

无 release 时 `/plugins install <repo-url>` 回落安装默认分支；第三方来源会先弹出信任确认。安装后可在 `/plugins` 面板（`M` 键）管理 MCP server 的启用/禁用。

### 本地安装（开发 / 离线）

```text
git clone https://github.com/Yorha9e/moamcp.git
# 在 kimi / omkc 中：
/plugins install /绝对路径/moamcp
/reload
```

本地安装会被拷贝到 `$KIMI_CODE_HOME/plugins/managed/moamcp/`，改动源码后需重新安装才生效。

> 注意：官方 kimi 与 omkc 的插件系统相同，但**能力不完全相同**，见下节。

## 能力降级矩阵

moamcp 本身（MCP 工具 + Bus + 卡片 + 归档）在两个版本上完全一致；差异全部来自宿主 CLI 的子代理体系：

| 能力 | 官方 kimi-code | omkc（社区版） |
|---|---|---|
| MCP 工具全集（`moa_*` 六个） | ✅ | ✅ |
| 辩论 Bus、浏览器卡片、SSE、三层归档 | ✅ | ✅ |
| 辩手模型 | **继承主代理模型**（单模型 MOA） | `binding_slot` 命名槽位 → 每个辩手可绑定不同模型与思考强度（多模型 MOA） |
| 角色化 profile（orchestrator / critic / synthesizer） | 需手动把本仓库 `agents/*.md` 复制到 agent 目录（`~/.kimi-code/agents/` 或项目 `.kimi-code/agents/`） | 内置，开箱即用 |
| 桌面悬浮卡片 moa-card（实时辩论进度） | ❌（仅浏览器卡片） | ✅ 交互启动时自动拉起（`tui.toml` 的 `[moa] card`，默认开） |
| `/subagent-model` 绑定管理命令 | ❌ | ✅ |

即：官方 kimi 上可以完整跑通 MOA 辩论流程，但所有辩手共用主代理的模型（单模型多视角）；omkc 上才是完整形态——不同辩手由不同模型扮演（如强模型正方 / 强模型反方 / 快模型魔鬼代言人），配合角色化 profile 与桌面卡片。

> 官方版本备注：截至 0.29.0，上游官方仓库**尚不含**子代理模型绑定机制（相关 PR [#1928](https://github.com/MoonshotAI/kimi-code/pull/1928) / [#2034](https://github.com/MoonshotAI/kimi-code/pull/2034) 仍在 open 状态）。因此官方版本目前只支持单模型 MOA；多模型槽位绑定是 omkc 社区版独有的能力。

## 使用

### 1. 配置命名槽位（仅 omkc）

在工作区 `.kimi-code/local.toml` 中声明槽位（绑定是用户配置，spawn 时机械生效）：

```toml
[subagent-slot.debate-strong]
model = "kimi-code/kimi-for-coding"
thinking_effort = "high"

[subagent-slot.debate-fast]
model = "kimi-code/kimi-for-coding"
thinking_effort = "low"
```

omkc 中也可以用 `/subagent-model set slot debate-strong` 交互式配置。单模型场景（官方默认）可跳过此步，`agents` 直接写字符串数组。

### 2. 发起辩论（orchestrator 视角）

```jsonc
// moa_init
{
  "task_id": "auth-review-1",
  "preset_config": {
    "agents": [
      { "id": "debater-a", "binding_slot": "debate-strong" },
      { "id": "debater-b", "binding_slot": "debate-strong" },
      { "id": "debater-c", "binding_slot": "debate-fast" }
    ],
    "debate": { "rounds": 2 }
  }
}
```

返回 `{ok, card_url, agents}`：`card_url` 是辩论卡片地址（浏览器打开实时观看），`agents` 是派发映射 `[{id, binding_slot?}]`——派发每个辩手子代理时按其中的 `binding_slot` 传参。简单场景的等价写法：`"agents": ["debater-a", "debater-b", "debater-c"]`。

随后：

1. `moa_start_debate(task_id, reference_results)` —— 注入参考材料（验证目标、范围、各辩手立场、每轮要求）并启动状态机。
2. 并行派发辩手子代理（`run_in_background=true`），每个辩手循环：`moa_wait_turn` → 阅读 `full_context` 中已有发言 → `moa_submit_turn` 提交本轮论点。非首轮必须先回应对方上一轮。
3. `wait_turn` 返回 `{status:"debate_complete", transcript}` 时辩论结束。
4. `moa_complete(task_id)` —— 写三层归档到 `<MOAMCP_LOGS_DIR>/{task_id}/`，关闭任务，唤醒所有等待者。

### MCP 工具一览

| 工具 | 调用方 | 作用 |
|---|---|---|
| `moa_init` | orchestrator | 初始化任务（辩手列表 + 辩论参数），返回 `{ok, card_url, agents}` |
| `moa_start_debate` | orchestrator | 注入参考结果，启动状态机 `{turn:1, round:1, speaker:首个辩手}` |
| `moa_wait_turn` | 辩手 | 长轮询至轮到自己 / 辩论结束 / 安全上限（默认 25 分钟，`MOAMCP_WAIT_CAP_MS` 可调） |
| `moa_submit_turn` | 辩手 | 提交本轮发言，校验轮转顺序（乱序返回 `{error:"not_your_turn"}`） |
| `moa_complete` | orchestrator | 写三层归档并关闭任务 |
| `moa_status` | 任意 | Bus 端口、模式（own/reuse）、活跃任务、进程信息 |

`agents/` 目录附带三个配套角色 profile（`orchestrator.md` / `critic.md` / `synthesizer.md`），含完整的邮箱辩论 playbook 与辩手派发模板。omkc 已内置同名角色；官方版本可将其复制到 agent 目录（`~/.kimi-code/agents/` 用户级，或项目 `.kimi-code/agents/`）后使用。

### Bus 端点

| 端点 | 说明 |
|---|---|
| `GET /?task_id=<id>` | 辩论卡片：进度条、preset/配置快照（含实时 round/speaker）、辩手阵容、实时发言流、裁决 + findings。不带 `task_id` 时为任务选择页 |
| `GET /tasks` | `{tasks: string[]}` 活跃任务列表（健康探针也用它） |
| `GET /subscribe?task_id=<id>` | SSE 事件流；迟到订阅者自动重放（每任务保留最近 200 帧） |
| `GET /archive?task_id=<id>&file=...` | `moa_complete` 后的归档文件（白名单：`probe.json` / `events.jsonl` / `result.json`，防路径穿越） |
| `POST /publish` | `{task_id, event}` 事件扇入（复用模式转发 / 预留） |

Bus 只绑定 `127.0.0.1`（环回），不对局域网暴露。

卡片另有两块**可选**面板——agent 状态墙与工具调用日志，数据来自 **omkc-status** 状态服务（见伴生项目）。卡片自动探测 `http://127.0.0.1:39627/health`（500ms 超时）：可达则订阅其 SSE `/events`（首帧为全量 snapshot，可能数百 KB，解析容错；之后是逐 agent 增量帧），每个 agent 一行展示 model、busy/phase、context tokens、最近工具调用（`stale` 半透明、`isError` 标红），`scan.scanning` 时显示"扫描中…"；不可达则两面板完全静默隐藏、断线 3 次才退避重探。装插件即可用，omkc-status 只是可选增强而非依赖。

### 端口规则与实例发现

- **默认端口 8913**，可用 `MOAMCP_BUS_PORT` 覆盖。
- 每个实例在绑定**之前**先写注册表 `<MOAMCP_HOME>/instances/<pid>.json`（`{id, pid, port, started_at, version}`），并发启动的同伴在绑定窗口内就能互相看见；写入为原子 rename，无锁。
- 绑定失败（`EADDRINUSE`）时查注册表：
  - 端口被**另一个活的 moamcp** 持有（注册表条目 + pid 存活 + `GET /tasks` 健康探针通过）→ 进入 **reuse 模式**：本进程不监听，事件尽力转发给对方的 Bus（超时 / 失败只记 warning 丢弃，由对方的 SSE 重放缓冲与共享归档兜底），`card_url` 指向对方端口；
  - 条目对应进程已死、或占用者不是 moamcp → 清掉该条目，端口 **+1 重试**（最多 100 次，耗尽则报错退出，退出前先释放注册表条目）。
- 被杀死的宿主留下的 Windows 孤儿 Bus 因此成为可复用资产，而不是残骸。`{cwd}/bus.port` 在 own 模式下仍会写（兼容旧约定），不再是主要发现通道。

### 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `MOAMCP_HOME` | `~/.moamcp` | 实例注册表根目录（`<home>/instances`） |
| `MOAMCP_LOGS_DIR` | `<MOAMCP_HOME>/logs` | 三层归档根目录（所有实例共享，reuse 模式的 `/archive` 依赖它） |
| `MOAMCP_BUS_PORT` | `8913` | 期望的 Bus 端口 |
| `MOAMCP_WAIT_CAP_MS` | 25 分钟 | `moa_wait_turn` 长轮询安全上限 |

## 伴生项目

- [oh-my-kimi-code](https://github.com/Yorha9e/oh-my-kimi-code) —— Kimi Code 社区 fork（omkc）：子代理模型绑定全家桶、内置 MOA 角色 profile、桌面悬浮卡片 moa-card。moamcp 的完整形态依赖它。
- **omkc-status** —— 独立状态服务：只读监听会话持久化文件，对外提供 HTTP `/state` 与 SSE `/events`，不依赖 CLI 进程存活。辩论卡片的 agent 状态墙与工具调用日志面板会自动接入它作为可选数据源。（仓库待发布）
- **kimi-copilot** —— 桌面悬浮卡片（moa-card widget 的独立演进版本）。（仓库待发布）

## 开发

```sh
npm install
npm run build   # tsc 类型检查 + esbuild 打包 → dist/server.js（单文件 bundle，已提交入库）
npm test        # vitest：smoke（邮箱流程）+ registry + bus（HTTP/SSE）+ reuse（两个真实进程）四套，共 37 例
npm start       # node dist/server.js
```

`dist/server.js` 作为构建产物提交在仓库中（GitHub 直装插件依赖它）；修改 `src/` 后请运行 `npm run build` 并保持 `dist/` 同步提交。测试套件会自行重建 dist 再 spawn 真实进程验证复用模式。

## License

[MIT](./LICENSE)
