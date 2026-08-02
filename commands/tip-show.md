---
description: 读取一个 Tip 的完整内容（可附关联文档）
---

读取指定 Tip 的完整内容。执行步骤：

1. 取系统提示中当前 Working Directory 的**绝对路径**作为 `workspace`（moamcp 进程的 cwd 是插件根，不是项目根，不可用作 workspace）。
2. `$ARGUMENTS` 为 Tip id；缺省时先调用 `moa_tip_list`（传 `workspace`）让用户选择。
3. 调用 `moa_tip_read`（传 `workspace` 与 id），完整展示 `title`/`summary`/`context`/`status`/`module`/`tags`/`nextAction`/`documentRefs`/`sourceRefs`/`relatedTipIds`。
4. 用户要求或确实需要时，再按 `documentRefs` 用 Read 读取关联文档（路径相对项目根，基于 workspace 解析）；不要无条件读全部关联文档。
