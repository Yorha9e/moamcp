---
description: 从当前讨论起草并新建一个 Tip（先给用户确认草案，确认后才保存）
---

从当前讨论整理并新建一个项目级 Tip。执行步骤：

1. 取系统提示中当前 Working Directory 的**绝对路径**作为 `workspace`（moamcp 进程的 cwd 是插件根，不是项目根，不可用作 workspace）。
2. 根据 `$ARGUMENTS` 的描述（缺省为当前讨论内容）整理草案：`title`（简短）、`summary`（几句话说明目标与预期价值）、`context`（足够恢复讨论的大概背景，4–8 KiB 以内，**不复制完整对话**）、`status`（默认 `captured`）、`module`/`tags`（如有）、`documentRefs`/`sourceRefs`/`relatedTipIds`（如有；文档路径用相对项目根）。
3. 把草案展示给用户确认，明确告知"保存为项目级 Tip，跨 Session 可见，可后续查阅/归档"。
4. 用户确认后调用 `moa_tip_create`（传 `workspace` 与完整字段）保存；**未经用户确认绝不静默保存**。普通临时对话、一次性指令不得写入 Tip。
