---
description: 归档一个 Tip（不再出现在默认列表，历史记录保留）
---

归档指定 Tip。执行步骤：

1. 取系统提示中当前 Working Directory 的**绝对路径**作为 `workspace`（moamcp 进程的 cwd 是插件根，不是项目根，不可用作 workspace）。
2. `$ARGUMENTS` 为 Tip id；缺省时先调用 `moa_tip_list`（传 `workspace`）让用户选择。
3. 调用 `moa_tip_read`（传 `workspace` 与 id）确认内容，向用户确认要归档。
4. 调用 `moa_tip_archive`（传 `workspace` 与 id；若该工具不可用，则用 `moa_tip_update` 传 `status="archived"`）。
5. 告知用户：归档后不出现在默认列表，历史记录保留，之后可随时用 `moa_tip_update` 恢复为其他状态。
