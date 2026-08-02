# moamcp 前端 v3 设计契约（从零重构）

> 施工依据：`docs/frontend-bus-contract.md`（接口权威）+ 本文档（设计与实现契约）。
> 决策记录（用户已拍板）：vanilla 自包含 HTML（TS 模板字符串，无前端构建）；
> 两入口共享组件；重写 fake-DOM 行为测试适配新实现；omkc-status 集成对齐现状（两页保留）。
> 视觉要求：优雅美观，玻璃拟态深色 + 多彩极光 accent。

---

## 1. 技术形态与文件划分

构建仍是 `esbuild src/server.ts --bundle` 单文件产物，前端只能是 TS 模块导出的 HTML 字符串，零外链资产（不引外部字体/图标库，图标用内联 SVG 或纯 CSS 形状，禁 emoji 当图标）。

新增目录 `src/web/`：

| 文件 | 导出 | 职责 |
|---|---|---|
| `src/web/tokens.ts` | `TOKENS_CSS` | 设计 token（CSS 自定义属性）+ reset + 基础元素样式 |
| `src/web/components.ts` | `COMPONENTS_CSS` | 共享组件样式：玻璃卡片、徽章、按钮、表单、抽屉、模态、进度 Pills、notice |
| `src/web/lib.ts` | `LIB_JS` | 共享浏览器 JS：`el()` 创建助手、`api()` JSON fetch 封装、`fmtBytes/fmtTokens/fmtTime`、SSE 重连封装 `connectSSE(url, onEvent, onState)`、抽屉/模态行为 |
| `src/web/debate-card.ts` | `DEBATE_CARD_HTML` | 辩论卡片页（`GET /`） |
| `src/web/control-plane-page.ts` | `CONTROL_PLANE_HTML` | 控制面页（`GET /control-plane`） |

接线：

- `src/bus.ts` 改为 `import { DEBATE_CARD_HTML } from './web/debate-card.js'`，替换旧 `FRONTEND_HTML`。
- `src/control-plane.ts` 改为 `import { CONTROL_PLANE_HTML } from './web/control-plane-page.js'`。
- 删除 `src/frontend.ts` 与 `src/control-plane-frontend.ts`。

每个页面 HTML = `<style>TOKENS_CSS + COMPONENTS_CSS + 页面私有 CSS</style>` + 静态骨架 + `<script>LIB_JS + 页面私有 JS</script>`。页面私有部分可以为了可读性拆成同文件内的常量拼接。

## 2. 设计 Token（`tokens.ts`）

全部样式走语义 token，组件里禁止裸 hex。基调：OLED 级深色玻璃 + 极光 accent（绿→蓝→紫渐变），不用外链字体。

```css
:root {
  /* 背景与表面 */
  --bg: #07090f;            /* 页底，近黑带蓝 */
  --bg-aurora-1: #0d2818;   /* 极光晕染：绿 */
  --bg-aurora-2: #0b1e3a;   /* 蓝 */
  --bg-aurora-3: #1d1033;   /* 紫 */
  --surface: rgba(148, 163, 184, 0.06);      /* 卡片玻璃底 */
  --surface-strong: rgba(148, 163, 184, 0.10);
  --border: rgba(148, 163, 184, 0.14);
  --border-strong: rgba(148, 163, 184, 0.24);
  /* 文字 */
  --text: #e6ebf4;          /* 主文字，对 --bg 对比度 ≥ 12:1 */
  --text-dim: #94a3b8;      /* 次要文字，对 --bg ≥ 4.5:1 */
  --text-faint: #64748b;    /* 提示文字 */
  /* 语义色 */
  --accent-green: #34d399;  --accent-blue: #60a5fa;  --accent-purple: #a78bfa;
  --accent-amber: #fbbf24;  --accent-red: #f87171;
  --ok: var(--accent-green); --warn: var(--accent-amber); --err: var(--accent-red);
  --live: var(--accent-green); --done: var(--accent-blue);
  /* 极光渐变（仅点缀：品牌字、进度激活态、focus ring、主按钮） */
  --aurora: linear-gradient(100deg, #34d399, #60a5fa 50%, #a78bfa);
  /* 字体：系统栈，中文回退 */
  --font-ui: -apple-system, "Segoe UI", "Inter", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --font-mono: "Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace;
  /* 字阶 12/13/14/16/20/28；行高 1.5–1.6 */
  /* 间距：4px 基元 --sp1:4px … --sp6:24px --sp8:32px --sp12:48px */
  /* 圆角 --r-sm:8px --r-md:12px --r-lg:16px --r-pill:999px */
  /* 阴影 --shadow-1: 0 1px 2px rgba(0,0,0,.4); --shadow-2: 0 8px 24px rgba(0,0,0,.45); */
  /* 动效 --dur-fast:150ms --dur-med:250ms --ease-out:cubic-bezier(.22,1,.36,1) */
  /* 层级 --z-sticky:10 --z-drawer:40 --z-modal:50 --z-scrim:45 */
}
```

页面背景：`--bg` 纯色底 + 两个 `position:fixed` 极光晕染层（`radial-gradient`，绿/蓝/紫三个光斑，`filter: blur(80px)` 或低透明度，`pointer-events:none`）。晕染层是装饰静态层，不在滚动区内，无性能问题。

## 3. 玻璃与性能红线（硬约束）

- **backdrop-filter blur 只允许用在不随内容长滚动的 chrome 元素**：吸顶 header/workspace 条、右侧抽屉、模态 scrim、Toast。
- **长滚动区域禁用 backdrop-filter**：transcript、board value、tip 列表、omkc agent 墙、工具日志。这些卡片用 `--surface` 半透明纯色 + `--border` 即可（玻璃感靠边框高光和背景晕染透出）。
- 动画只动 `transform`/`opacity`，150–300ms，`--ease-out`；尊重 `prefers-reduced-motion`（媒体查询里关掉脉冲/闪烁/平滑滚动）。
- 每屏最多 1–2 个持续动画元素（如 live 脉冲点）。

## 4. 渲染纪律（硬约束，有测试断言）

- 不可信内容（task_id、transcript、tip 字段、board value、omkc 字段）一律 `textContent` / `document.createTextNode`。
- **两个页面 HTML 全文都不得出现字符串 `innerHTML`**（连注释里也不行）。
- URL 拼接 task_id 必须 `encodeURIComponent`。

## 5. 辩论卡片页（`GET /`）信息架构

布局：单列居中 `max-width: 880px`，吸顶玻璃 header。

- **Header（吸顶，玻璃 blur）**：左品牌 `MOA Debate`（极光渐变文字）+ 状态徽章 `#badge`；右导航 `<a href="/control-plane">Workspace Control Plane</a>` + 连接状态 `#conn`。
- **任务选择器 `#picker`**（无 task_id 时）：玻璃卡片列表，行为不变——3s 轮询 `/tasks`、JSON 签名防抖、点击跳 `location.href = '/?task_id=' + encodeURIComponent(id)`、失败显示一次 `failed to load /tasks`。
- **5 阶段进度条**：`#st0`…`#st4` Pills（共识/Reference/辩论/聚合/结论），三态圆点（done ✓ / active 脉冲 / pending 空心），点击或 Enter/Space 展开 `#stageDetail` 详情行并平滑滚动+闪光对应卡片。文案契约见 §7。
- **卡片**：`#config`（任务配置/extras）、`#agentsCard`（辩手 roster chips，当前发言人高亮）、`#transcriptCard`（发言流，round·turn 标头 + 时间 + 正文 + 签字徽章）、`#verdict`（统计 + 签字人 + findings + “加载完整 transcript”按钮）。
- **omkc 区**：`#omkcCard`（agent 墙）+ `#omkcToolsCard`（工具日志），探活失败零痕迹隐藏。

### 事件→渲染矩阵（功能不得小于旧版）

| 事件 | 渲染 |
|---|---|
| `task_initialized` | roster 落位（id + role/model/binding_slot 标签，turns=0）、rounds 落位、extras 快照存 Stage1 摘要、进度进 Stage1、badge `initialized` |
| `debate_started` | `curRound=1`、Stage2 标签 `辩论 1/<rounds>`、进度进 Stage2、badge `debating` |
| `turn_advanced` | 发言人 chip 高亮、轮次元数据刷新、已展开的 Stage2 详情行同步 |
| `turn_submitted` | turns 计数+1、transcript 追加卡片（`e.content` 回退 `e.excerpt`，signoff 加 `✍ 签字` 徽章）、自动滚到最新 |
| `signoff_reset` | stageHint：`签字清零（<agent_id> 提出异议）— 辩论按原轮次继续` |
| `debate_complete` | 进度进 Stage3、badge `debate complete`、`#verdict` 出现（轮次/发言数/early 原因） |
| `task_closed` | badge `closed`、进度进 Stage5；拉 `result.json` 填裁决、拉 `events.jsonl` 取末条截断 1200 字符填 findings、显示“加载完整 transcript”按钮 |

### SSE 重连（E1 准则，沿用）

首帧 3s 探测 → `showWaitingHint()`（含“返回任务列表”链接）；第 1–2 次失败 800ms 静默重试（`○ 瞬断 1/3`）；第 3 次起指数退避上限 15s（`○ 重连退避 X.Xs`）；收到消息即重置。

### omkc-status 集成（沿用旧行为）

启动 500ms 超时探 `http://127.0.0.1:39627/health`，失败隐藏两卡；`/events` SSE：`snapshot` 帧 try/catch 防御解析、按 `lastSeen` 降序铺 agent 墙；`agent` 增量按 `sessionId:agentId` upsert；字段：agentId（子 agent `⤷`）、model、phase/busy pill、context `12.5k / 128k`、lastToolCall（`isError` 加 `✗`）、stale 降透明度 0.4；`scanning` 黄色徽章（15s 轮询 /health）；工具日志 `HH:MM:SS | agentId | tool — desc | ✗` 上限 150 条；3 连败隐藏 + 30s 慢探。

## 6. 控制面页（`GET /control-plane`）信息架构

- **Header**：左品牌 `Workspace Control Plane`，右导航 `<a href="/">MOA Debate</a>`（互链保留）。
- **Workspace 选择条（吸顶玻璃化）**：`<select id="workspace">`（`<id> · <cwd>`）+ `#workspaceHint` 显示 cwd；URL `?workspace=` 预选、`history.replaceState` 同步；空 workspace 时禁用下拉 + `#notice` 警告 `请先在项目里运行 /moamcp:tips 创建 workspace sidecar。` + 空态文案。
- **全局通知 `#notice`** + `setNotice(message, isError)`；表单错误 `#formError`（`role="alert"`）。
- **Tabs**：`#tipsView` / `#boardView`，`switchView(view)` 切换。
- **Tips 视图**：过滤器（status/module/tag/includeArchived/limit）+ `+ New Tip` 主按钮（每屏唯一主 CTA，极光渐变）；Tip 卡片列表（标题、状态徽章 `.st-*`、summary、module/tags chips、updatedAt、详情/归档按钮）。
- **Tip 详情右侧浮层 `#tipDrawer`**（玻璃 blur，窄屏 <720px 退化为底部抽屉）：展示全部 15 字段，context/documentRefs 代码块样式；内置“编辑”按钮。
- **Tip 表单模态**：New/Edit 两态；title/summary 必填校验；documentRefs JSON 数组校验（报错文案 `documentRefs 必须是有效 JSON` / `documentRefs 必须是 JSON 数组`）；tags 等数组字段逗号/换行分隔；创建 POST、编辑 PATCH（留空可选字段传 `null`）。
- **归档**：`window.confirm('确认归档这个 Tip？归档后默认列表会隐藏它。')` → POST archive。
- **Board 视图**：`<select id="boardScope">`（global/workspace）+ key 前缀搜索 + 15s 轮询兜底；列表行（key mono 蓝、author、ts、`N B`）+ 点击 `.selected` + 右侧详情 `<pre class="board-value">`。
- **Board SSE 失效通知**：`getBoardChannel()` → `new EventSource('/subscribe?task_id=' + encodeURIComponent(channel)`，onmessage 只当失效信号 → `refreshActiveView()` 重拉 REST；切换 workspace/view/scope 或 `beforeunload` 时 `closeBoardSubscription()`；失效信号重拉需防抖（300ms）防后发先至。

## 7. DOM/JS 契约（测试锚点，新测试据此断言）

### 保留不变的锚点（降低成本，测试只需微调）

- 页面标题文案：`MOA Debate`、`Workspace Control Plane`。
- 互链：卡片页含 `href="/control-plane"`，控制面含 `href="/"`。
- 卡片页：`id="picker"`、`fetch('/tasks')`、`location.href = '/?task_id=' + encodeURIComponent(id)`、`EventSource('/subscribe?task_id=`。
- 控制面：`function getBoardChannel()`（含 `return '@board/global'` 与 `return currentWorkspace ? '@board/workspace:' + currentWorkspace : ''`）、`function switchView(view)`、`connectBoardSubscription()`、`document.getElementById('boardScope').addEventListener('change'`、`new EventSource('/subscribe?task_id=' + encodeURIComponent(channel)`、`textContent`、`document.createElement`；两页均**不含** `innerHTML`。
- 阶段详情文案（fake-DOM 行为断言继续用）：
  - 初始：`#st0` className 含 `active`，`#stageDetail` hidden。
  - Stage2 展开：`Round 1/2`、`a1`（agent id）、`已提交 0 个 turn`；transcript 滚动 + `.flash`；Pill `aria-expanded="true"`；turn_submitted 后变 `已提交 1 个 turn`；再点收起 `aria-expanded="false"`、detail hidden；`.flash` 动画结束后移除。
  - Stage1：`reference_results 摘要`，截断 500 字符（含 `R×500` 不含 `R×501`）；点击 detail 外部收起。
  - Stage0：`任务已初始化`。
  - 未开始阶段（Stage4）：`该阶段尚未开始`、`moa_complete`。
  - Stage3（Enter 触发）：`归档已写入，裁决已输出`，verdict 滚动。
  - task_closed 后 Stage4：`归档已写入 · logs/ui-1`。

### 新页面允许使用的 DOM API 面（fake-DOM 测试需模拟这些）

`document.getElementById`、`document.createElement`、`document.createTextNode`、`el.appendChild`、`el.textContent`(get/set)、`el.className`(get/set)、`el.classList`(add/remove/contains/toggle)、`el.setAttribute/getAttribute`、`el.addEventListener`、`el.hidden`、`el.scrollIntoView`、`el.querySelector`（仅限静态骨架内已存在元素，测试可不支持动态 query）、`el.style` 直接赋值、`document.body`、`location.search/href`、`history.replaceState`、`setTimeout/setInterval/clearTimeout`、`EventSource`、`fetch`、`AbortController`、`window.confirm`、`encodeURIComponent`。不使用 `innerHTML`、`insertAdjacentHTML`、`template`、`MutationObserver`。

## 8. 测试重写方案

- `test/bus.test.ts`：fake-DOM harness（`El`、`FakeEventSource`）补齐 `classList`、`hidden`、`scrollIntoView` 记录、`className` 语义；行为用例沿用 §7 的断言矩阵（初始态→点 Stage2→turn_submitted→收起→Stage1 截断→外部点击→Stage0→未开始 Stage4→Enter Stage3→task_closed 后 Stage4）。
- `test/control-plane.test.ts` / `test/reuse.test.ts`：字符串锚点按 §7“保留不变的锚点”核对，基本不动。
- 全程 `npm test` 90 例全绿为验收线。

## 9. 实施步骤

1. 新建 `src/web/` 五文件（tokens/components/lib/debate-card/control-plane-page）。
2. `bus.ts`、`control-plane.ts` 改 import 接线。
3. 删除 `src/frontend.ts`、`src/control-plane-frontend.ts`。
4. 重写/微调三个测试文件。
5. `npm test` 全绿 → `npm run build` → 临时起服务 curl `/` 与 `/control-plane` 验证 HTML 含锚点、无 `innerHTML`。
6. 回载部署（另行确认后执行）：cp `dist/server.js` → `~/.omkc/plugins/managed/moamcp/dist/` → 杀旧插件进程 → curl 验证 → `npm test`。

## 10. 优雅美观验收清单

- 极光渐变只用于：品牌字、主 CTA、进度激活态、focus ring；其余保持克制。
- 状态徽章、阶段圆点、roster 高亮使用语义 token，不靠颜色单独表意（配文字/图标）。
- 所有可点元素 `cursor: pointer` + hover 态（150–300ms 过渡）+ 可见 focus ring。
- 卡片 hover 微浮起（`translateY(-1px)` + 阴影加深），不改变布局尺寸。
- 动效尊重 `prefers-reduced-motion`；滚动长列表无 backdrop-filter。
- 字阶/间距/圆角全部走 token，无裸值。
