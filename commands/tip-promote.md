---
description: 把一个 Tip 提升为当前 Session 的执行 Todo（read → 用户确认 → 宿主 TodoList → update planned）
---

把一个 Tip 提升为当前 Session 的执行 Todo。后端**没有**独立的 promote 工具，按以下编排执行：

1. 取系统提示中当前 Working Directory 的**绝对路径**作为 `workspace`（moamcp 进程的 cwd 是插件根，不是项目根，不可用作 workspace）。
2. `$ARGUMENTS` 为 Tip id；缺省时先调用 `moa_tip_list`（传 `workspace`）让用户选择。
3. 调用 `moa_tip_read`（传 `workspace` 与 id），向用户展示 `title`、`summary`、`nextAction` 与当前 `status`，说明提升后的效果：Tip 状态改为 `planned`，并在当前 Session 创建一条 Todo。
4. 用户确认后：
   - 调用宿主的 `TodoList` 工具新增一条 todo：title 默认使用 Tip 的 `title`；若 `nextAction` 对执行必要，把它压缩进同一个简短 title（例如 `实现 X：先做 Y`）或在创建前单独展示——宿主 TodoList 只有 `title`/`status` 两个字段，**不要假设存在 description 字段**；
   - 调用 `moa_tip_update`（传 `workspace`、id、`status="planned"`）。
5. 向用户总结：Tip 继续保留项目级背景，Todo 只负责当前执行；实现完成后可再把 Tip 更新为 `implemented` 并记录 `sourceRefs`。
