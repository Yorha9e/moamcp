---
description: 列出当前工作区未归档的 Tips（可带 status/tags/module 过滤）
---

列出当前工作区的 Tips 清单。执行步骤：

1. 取系统提示中当前 Working Directory 的**绝对路径**作为 `workspace`（moamcp 进程的 cwd 是插件根，不是项目根，不可用作 workspace）。
2. 调用 `moa_tip_list`，传 `workspace`；`$ARGUMENTS` 为可选的过滤条件（如 `status=planned`、`tags=moa,frontend`、`module=moa/frontend`，空格分隔；缺省列出未归档 Tips）。
3. 把结果整理成简短列表展示给用户：`id`、`title`、`status`、`module`、`tags`、`updatedAt`。
4. 不要自动读取每个 Tip 的完整内容；用户点选后再用 `/moamcp:tip-show <id>` 或 `moa_tip_read` 获取。
