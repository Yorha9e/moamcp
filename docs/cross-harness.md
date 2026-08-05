# 跨 harness 挂载（cross-harness，0.12.0）

moamcp 是一个 **stdio MCP server**，本身不绑定任何宿主 CLI——Kimi Code / omkc、
Claude Code、Codex（以及任何会讲 MCP 的 agent harness）都可以把它挂载成工具面，
共用同一块"黑板 + 交接"协调设施。本文是外家（非 kimi 系）挂载的最小说明。

> [!WARNING]
> **所有 harness 的 `MOAMCP_HOME` 必须指向同一个目录。**
> 协调链路的全部持久化（黑板、tips、handoff、项目注册表）都落在 `MOAMCP_HOME`
> 之下。只要有一个 harness 的 `MOAMCP_HOME` 指向别处，它看到的就是另一块黑板：
> 写下去的东西别家看不见、发出去的 handoff 静默丢失——**协调链路不报错，只是悄悄断**。
> 这是跨 harness 踩坑的第一名，挂载前先核对每个配置里的 `MOAMCP_HOME`。
> 默认值（未设置时）是 `~/.moamcp`，所以"碰巧各用各的默认"就等于各用各的黑板。

## 挂载示例

统一入口：`node <moamcp 仓库>/dist/server.js`（stdio 模式）。`dist` 由仓库根目录
`npm run build` 产出；版本从 `package.json` 读取（当前 0.12.0，`/health` 可区分
各 harness 拉起的是同一版本）。

### Claude Code

编辑项目级 `.claude/settings.json`（或用户级 `~/.claude/settings.json`）：

```json
{
  "mcpServers": {
    "moamcp": {
      "command": "node",
      "args": ["D:/path/to/moamcp/dist/server.js"],
      "env": {
        "MOAMCP_HOME": "D:/shared/.moamcp"
      }
    }
  }
}
```

等价 CLI（`claude mcp add`，`-e` 传环境变量）：

```bash
claude mcp add moamcp -e MOAMCP_HOME=D:/shared/.moamcp -- \
  node D:/path/to/moamcp/dist/server.js
```

### Codex

编辑 `~/.codex/config.toml`（或项目级 `config.toml`）：

```toml
[mcp_servers.moamcp]
command = "node"
args = ["D:/path/to/moamcp/dist/server.js"]
env = { MOAMCP_HOME = "D:/shared/.moamcp" }
```

## workspace 传参约定

tips / handoff 工具（以及 board 工具的 workspace scope）用**绝对项目路径**定位
"当前项目"：

- **永远传项目绝对路径**，最省事也最稳的是把 `pwd` 原样传进去。
- **不要手工改大小写 / 斜杠**（尤其 Windows）：路径先经 `resolve()` 归一化再做
  sidecar id，但大小写不同写法仍会算出两个不同的 id。跨 harness 传同一个目录的
  两种写法 = 两个 workspace = 两块互不可见的 workspace 黑板。统一"传 `pwd` 原样"
  即可避免。
- sidecar id 的算法：`sha1(normalize(绝对路径))[0:16]`——纯路径哈希，与宿主
  harness、session 树、机器都无关；同一条路径在任何 harness 里算出的 id 都一样。
- 首次写入会自动注册 workspace（`ws-<hash>.meta.json`），不需要任何预注册；
  查当前已注册的 workspace / 项目用 `moa_projects_list`。

## 多实例共存

同一台机器上多个 harness 各自拉起 moamcp 进程时，Bus 端口竞争由 **reuse 模式 +
takeover** 自动处理（端口被占则复用、转发事件；宿主进程死了自动接管端口），
**无需用户操心**；BoardStore 跨进程一致性靠 append-lock + fold 刷新保证。
只要 `MOAMCP_HOME` 一致，多家 harness 就是同一块黑板上的多个会话。

## 工具速查

| 工具 | 作用 | 必填 workspace |
| --- | --- | --- |
| `moa_projects_list` | 只读聚合本项目库所有项目 + workspace（发 handoff 前查目标 `projectId`） | 无 |
| `moa_board_write` / `read` / `list` / `wait` / `delete` | 共享黑板：契约、决定、状态、指针（key 级 last-write-wins，≤32KB） | 仅 workspace scope 时传 |
| `moa_tip_create` / `read` / `list` / `update` / `archive` | 项目级跨会话上下文卡片 | 是（除 `list` 外的工具均需） |
| `moa_handoff_send` | 向目标项目发定向交接（`toProject`：projectId 或 `user-global`） | 是（发送方身份） |
| `moa_handoff_inbox` | 列出本项目收件；v2 可传 `agent` 按 toAgent 精确过滤 | 是 |
| `moa_handoff_read` / `consume` / `archive` | 读全文 / 消费 / 归档一条交接 | 是 |

### handoff v2 agent 寻址（0.12.0）

`moa_handoff_send` 可带可选的 `toAgent` / `fromAgent`，形状为
`<label>:<sessionId>:<agentId>`（label 是自由文本 `[a-z0-9-]+`，如
`claude-code:sess-b:sub-1`）——只做形状校验，不做注册表解析。投递仍按 `toProject`
落到项目 inbox；`agent` 只是投递标签（条目带 `agent:<toAgent>` tag）+ 收件过滤
（`moa_handoff_inbox` 传 `agent` 自报地址做精确匹配）。

**妥协语义**：写错地址 = 收件人按该地址过滤 inbox 为空，**不报错**（无注册表时
无法更强）。缓解办法是回显——回信时把对方的 `fromAgent` 原样抄进自己的
`toAgent`，收发双方靠回显互相校准地址。
