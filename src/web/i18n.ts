export const LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_STORAGE_KEY = 'moamcp-locale';

type Dictionary = Record<string, string>;

/** Shared English source and Chinese translation used by every Web UI surface. */
export const I18N_DICTIONARIES: Record<Locale, Dictionary> = {
  en: {
    'app.brand': 'MOA Workspace', 'app.nav': 'Main navigation', 'app.debate': 'MOA Debate',
    'app.memory': 'Workspace Memory', 'app.runs': 'MoA Runs', 'app.status': 'Agent Status', 'app.system': 'System Health',
    'locale.group': 'Language', 'locale.zh': '中文', 'locale.en': 'EN',
    'theme.group': 'Theme', 'theme.option': 'Theme: {name}',
    'debate.title': 'MOA Debate', 'debate.context': 'Current debate context', 'debate.noTask': '(no task_id)',
    'debate.activeTasks': 'Active tasks', 'debate.loading': 'Loading…', 'debate.noActiveTasks': 'No active tasks.',
    'debate.tasksError': 'Failed to load /tasks.', 'debate.pickTask': 'Pick a task',
    'debate.progress': 'Stage Progress', 'debate.waitInit': 'Waiting for task initialization…',
    'debate.stage.consensus': 'Consensus', 'debate.stage.reference': 'Reference', 'debate.stage.debate': 'Debate',
    'debate.stage.aggregate': 'Aggregate', 'debate.stage.verdict': 'Verdict',
    'debate.stage.consensusTip': 'Consensus — prepare file consensus · Select for details',
    'debate.stage.referenceTip': 'Reference — reference pool · Select for details',
    'debate.stage.debateTip': 'Debate — debaters take turns · Select for details',
    'debate.stage.aggregateTip': 'Aggregate — synthesize the verdict · Select for details',
    'debate.stage.verdictTip': 'Verdict — VERDICT output · Select for details',
    'debate.currentStage': 'Current: {stage}', 'debate.allComplete': 'Complete — VERDICT is available',
    'debate.modeConfig': 'Mode / Configuration', 'debate.waitTaskEvent': 'Waiting for task_initialized…',
    'debate.round': 'Round', 'debate.speaker': 'Speaker', 'debate.turns': 'Turns', 'debate.debaters': 'Debaters',
    'debate.agentStatus': 'Agent Status', 'debate.transcript': 'Debate Transcript',
    'debate.noTurns': 'No turns yet. Waiting for the debate to start…', 'debate.fullTranscript': 'Load Full Transcript',
    'debate.toolLog': 'Tool Call Log', 'debate.waitTools': 'Waiting for tool calls…', 'debate.scanning': 'Scanning…',
    'debate.agentCount': '{count} agents', 'debate.toolCount': '{count} entries',
    'debate.state.done': 'Done', 'debate.state.active': 'In progress', 'debate.state.pending': 'Not started',
    'debate.enteredAt': 'Entered at {time}', 'debate.pending.0': 'Waiting for the page connection (starts on load)',
    'debate.pending.1': 'Waiting for moa_init to initialize the task (task_initialized)',
    'debate.pending.2': 'Waiting for moa_start_debate to inject references and start (debate_started)',
    'debate.pending.3': 'Waiting for the final debater to submit (debate_complete)',
    'debate.pending.4': 'Waiting for moa_complete to write the three-layer archive (task_closed)',
    'debate.notStarted': 'This stage has not started — {reason}',
    'debate.consensusDone': 'Task initialized; consensus preparation is complete',
    'debate.consensusActive': 'Connected; waiting for moa_init to initialize the task',
    'debate.referenceSummary': 'reference_results summary: {value}',
    'debate.referenceMissing': 'The snapshot has no reference_results (moa_start_debate injects it directly into debater context).',
    'debate.roundDetail': 'Round {round}/{rounds} · Current speaker {speaker} · {turns} turns submitted',
    'debate.aggregateDone': 'Archive written; verdict is available', 'debate.aggregateActive': 'Aggregating — waiting for moa_complete to write the archive',
    'debate.verdictLoading': 'Archive written; loading VERDICT details…', 'debate.speaking': 'speaking',
    'debate.waiting': 'waiting', 'debate.turnCount': '{count} turn', 'debate.turnCountPlural': '{count} turns',
    'debate.signoff': '✍ Sign-off', 'debate.closed': 'closed', 'debate.initialized': 'initialized',
    'debate.debating': 'debating', 'debate.debateComplete': 'debate complete', 'debate.earlyClose': 'Closed early (unanimous sign-off)',
    'debate.archiveWritten': 'Archive written · {archive}', 'debate.finishedAt': 'finished at', 'debate.archive': 'archive',
    'debate.signers': 'signers', 'debate.roundsLabel': 'Rounds', 'debate.turnsLabel': 'Turns',
    'debate.archivedAfterComplete': 'transcript archived on moa_complete.',
    'debate.signoffReset': 'Sign-offs reset ({agent} objected) — the debate continues on its original round plan',
    'debate.waitingBadge': 'waiting', 'debate.connecting': 'connecting', 'debate.connectedNoEventsBefore': 'Connected, but task ',
    'debate.connectedNoEventsAfter': ' has no events yet. The debate may not have started, or the Bus may have restarted (its event log is in memory). ',
    'debate.backToTasks': 'Back to task list', 'debate.transient': '○ interruption {count}/3',
    'debate.backoff': '○ reconnecting in {seconds}s', 'debate.error': '✗ error',
    'control.title': 'Workspace Control Plane', 'memory.workspaceLabel': 'Workspace · Memory & Agent config',
    'memory.workspaceAria': 'Select workspace', 'memory.tabs': 'Workspace Memory', 'memory.tips': 'Project Tips',
    'workspace.groupWorkspaces': 'Workspaces', 'workspace.groupProjects': 'Projects',
    'workspace.rename': 'Rename', 'workspace.renameTitle': 'Rename the selected workspace',
    'workspace.renamePlaceholder': 'Workspace name (empty clears)', 'workspace.renameSave': 'Save',
    'workspace.renamed': 'Workspace name updated.',
    'workspace.release': 'Release', 'workspace.releaseTitle': 'Release the selected workspace',
    'workspace.releaseConfirm': 'Release workspace {workspace}? The board is archived (never deleted), any project alias is removed, and the next write to this directory starts from an empty board.',
    'workspace.released': 'Workspace released; the board was archived.',
    'memory.board': 'Shared Board · Raw', 'common.status': 'Status', 'common.allStatuses': 'All statuses',
    'common.module': 'Module', 'common.tag': 'Tag', 'common.limit': 'Limit', 'memory.includeArchived': 'Include archived',
    'tips.new': '+ New Tip', 'tips.edit': 'Edit Tip', 'tips.title': 'Title *', 'tips.summary': 'Summary *',
    'tips.context': 'Context', 'tips.nextAction': 'Next action', 'tips.tags': 'Tags · comma or newline separated',
    'tips.sourceRefs': 'Source refs · comma or newline separated', 'tips.relatedTipIds': 'Related Tip IDs · comma or newline separated',
    'tips.relatedProjects': 'Related projects · comma or newline separated', 'tips.sourceSessionId': 'Source session ID',
    'tips.authorCreate': 'Author · create only', 'tips.documentRefs': 'Document refs · safe JSON array',
    'tips.save': 'Save Tip', 'common.cancel': 'Cancel', 'common.details': 'Details', 'common.archive': 'Archive',
    'common.edit': 'Edit', 'common.delete': 'Delete', 'common.refresh': 'Refresh', 'common.closeDetails': 'Close details',
    'tips.empty': 'No Tips match the current filters.', 'tips.noWorkspace': 'No workspace is available. Run /moamcp:tips in a project first.',
    'tips.createWorkspace': 'Run /moamcp:tips in a project first to create a workspace sidecar.',
    'tips.boardLink': 'View tips/{id} on Board', 'tips.archiveConfirm': 'Archive this Tip? It will be hidden from the default list.',
    'tips.required': 'Title and summary are required.', 'tips.documentJson': 'documentRefs must be valid JSON.',
    'tips.documentArray': 'documentRefs must be a JSON array.',
    'board.scope': 'Scope', 'board.keySearch': 'Key namespace / key', 'board.sort': 'Sort',
    'board.updatedDesc': 'Recently updated', 'board.updatedAsc': 'Oldest updated', 'board.keyAsc': 'key A–Z', 'board.keyDesc': 'key Z–A', 'board.new': '+ New Entry',
    'board.results': '{count} results', 'board.result': '{count} result', 'board.select': 'Select a Board entry to view its full value.',
    'board.empty': 'No Board entries match the key/tag filters.', 'board.newTitle': 'New Board Entry', 'board.editTitle': 'Edit Board Entry',
    'board.closeForm': 'Close Board form', 'board.value': 'Markdown value', 'board.valueSize': 'UTF-8 value size',
    'board.author': 'Author', 'board.external': 'Updated externally: your draft is preserved. Saving will confirm again and use the version stamp from when the form opened.',
    'board.reload': 'Reload current version', 'board.save': 'Save Entry', 'board.formClosed': 'Board form is not open.',
    'board.keyRequired': 'Key is required.', 'board.tooLarge': 'Value exceeds 32768 UTF-8 bytes.',
    'board.workspaceRequired': 'Workspace scope requires a registered workspace.',
    'board.externalConfirm': 'This Board entry changed externally. Try saving with the expectedTs from when it was opened?',
    'board.saved': 'Board entry saved.', 'board.missing': 'does not exist (it may have been deleted)',
    'board.conflict': 'CAS conflict. currentTs: {current}. Your draft is preserved.',
    'board.currentMissing': 'The current version does not exist and may have been deleted; your draft is preserved.',
    'board.reloaded': 'Reloaded currentTs: {current}', 'board.copyKey': 'Copy key', 'board.copyValue': 'Copy value',
    'board.backToTip': 'Back to typed Tip', 'board.deleteConfirm': 'Delete “{key}”? It will disappear from this view, but append-only history retains a tombstone.',
    'board.deleted': 'Board entry deleted; append-only history retains a tombstone.',
    'board.deleteConflict': 'Delete CAS conflict. currentTs: {current}. Refresh and try again.',
    'board.scopeNotice': 'Workspace scope requires a registered workspace; global scope remains available.',
    'common.copied': '{label} copied.', 'common.copyFailed': 'Clipboard access failed. Please copy manually.',
    'runs.intro': 'The run model is an in-memory event projection of the owner Bus. After a Bus restart, use Archives as the source of truth.',
    'runs.tabs': 'MoA Runs', 'runs.live': 'Live & Recent', 'runs.archives': 'Archives', 'runs.query': 'Query',
    'runs.queryPlaceholder': 'task id, agent, binding slot', 'runs.empty': 'No live or recent runs.',
    'runs.roundConfigured': 'round / configured', 'runs.turn': 'turn', 'runs.speaker': 'speaker',
    'runs.turnsSignoffs': 'turns / signoffs', 'runs.lastEvent': 'last event', 'runs.updated': 'updated',
    'runs.earlyReason': 'early reason', 'runs.copyTask': 'Copy task id', 'runs.openLive': 'Open live card',
    'runs.detailsError': 'Run details: ', 'runs.openError': 'Open live card: ',
    'archives.copy': 'Copy {file}', 'archives.download': 'Download {file}', 'archives.fileError': 'Archive file: ',
    'archives.updated': 'updated', 'archives.summary': 'result summary', 'archives.errors': 'Errors ({count})',
    'archives.notPresent': 'not present', 'archives.view': 'View', 'archives.empty': 'No archives found.',
    'archives.degraded': 'degraded', 'archives.available': 'available',
    'system.copyUrl': 'Copy Control Plane URL', 'system.openDebate': 'Open MOA Debate',
    'system.intro': 'Bus listener entries do not represent every Kimi Session or MCP process. This page is read-only and provides no dangerous mutations.',
    'system.unavailable': 'System Health unavailable: ', 'system.value': 'value',
    'system.version': 'Version',
    'busUpdate.banner': 'Newer build installed: v{disk} (running v{running}). Restart the backend to pick it up.',
    'busUpdate.restart': 'Restart backend',
    'busUpdate.restarting': 'Restarting backend…',
    'busUpdate.stale': 'An older process still holds the service — restart the session.',
    'memory.agents': 'Agents & Profiles',
    'agent.title': 'Agents & Profiles', 'agent.intro': 'Manage project-local Agent Markdown and local.toml bindings. Changes are written atomically to disk; the running Session adopts them only after /reload.',
    'agent.refresh': 'Refresh Agents', 'agent.new': '+ New Agent', 'agent.summary': 'Agent profiles',
    'agent.select': 'Select an Agent to load its Markdown.', 'agent.noAgents': 'No Agent Markdown files found.',
    'agent.name': 'Name *', 'agent.markdown': 'Agent Markdown', 'agent.description': 'Description', 'agent.slot': 'Slot',
    'agent.file': 'File', 'agent.hash': 'SHA-256', 'agent.size': 'Size', 'agent.valid': 'valid', 'agent.invalid': 'invalid',
    'agent.template': 'Use template', 'agent.save': 'Save Agent', 'agent.delete': 'Delete Agent',
    'agent.deleteConfirm': 'Delete Agent “{name}”? The project file will be removed.', 'agent.saved': 'Agent file saved to disk.',
    'agent.deleted': 'Agent file deleted from disk.', 'agent.reloadLatest': 'Load latest version',
    'agent.bindings': 'Per-type bindings', 'agent.slots': 'Named slots', 'agent.bindingName': 'Name', 'agent.model': 'Model',
    'agent.thinking': 'Thinking effort', 'agent.inherit': 'Inherit', 'agent.unset': 'unset',
    'agent.addBinding': 'Add binding', 'agent.saveBindings': 'Save bindings', 'agent.noBindings': 'No bindings in local.toml.',
    'agent.rawTitle': 'Raw local.toml', 'agent.rawHint': 'Complex TOML layouts are not rewritten by the structured editor. Use this validated raw editor instead.',
    'agent.loadRaw': 'Load local.toml', 'agent.rawEditor': 'local.toml source', 'agent.saveRaw': 'Save local.toml',
    'agent.layout': 'TOML layout', 'agent.layoutStandard': 'standard', 'agent.layoutComplex': 'complex — use raw editor',
    'agent.reloadBanner': 'Saved to disk. The current Session has not adopted this change yet; after the running turn finishes, run /reload. Multiple Sessions must each run /reload.',
    'agent.copyReload': 'Copy /reload', 'agent.conflict': 'Configuration changed externally. Your draft is preserved; load the latest version before saving again.',
    'agent.reloaded': 'Latest configuration loaded. Your previous draft was replaced.', 'agent.error': 'Agent configuration: ',
    'memory.projects': 'Projects', 'memory.inbox': 'Handoff Inbox',
    'projects.intro': 'Projects group one or more workspaces under a shared board. Migrating the current workspace aliases its path to the project so future workspace-scope reads/writes target the project board.',
    'projects.empty': 'No projects yet. Create one by migrating the current workspace.',
    'projects.createdAt': 'Created {createdAt}', 'projects.aliases': 'Aliases', 'projects.noAliases': 'no aliases yet',
    'projects.merge': 'Merge current workspace into this project',
    'projects.directories': 'Directories',
    'projects.unknownPath': 'unknown path',
    'projects.create': 'New project + merge current workspace',
    'projects.namePlaceholder': 'Project name (optional)',
    'projects.untitled': 'untitled project',
    'projects.createConfirm': 'Create new project {project} and merge the current workspace into it? This migration is immediate and cannot be automatically undone; the workspace board is archived (never deleted).',
    'projects.mergeConfirm': 'Merge the current workspace into project {project}? This migration is immediate and cannot be automatically undone; the workspace board is archived (never deleted).',
    'projects.merged': 'Workspace merged into {projectId} · {moved} records moved.',
    'projects.count': '{count} project', 'projects.countPlural': '{count} projects',
    'projects.renameTitle': 'Rename this project',
    'projects.renamePlaceholder': 'Project name',
    'projects.renameSave': 'Save', 'projects.renamed': 'Project name updated.',
    'projects.renameRequired': 'Project name cannot be empty.',
    'projects.detachAliasTitle': 'Detach this alias (un-merge)',
    'projects.detachConfirm': 'Detach alias {alias} from project {project}? Only the path-to-project binding is removed: the project keeps its existing board records, and the directory returns to its own independent workspace (future writes start from an empty board). No data is deleted.',
    'projects.detached': 'Alias detached; the directory is an independent workspace again.',
    'projects.archiveProject': 'Archive', 'projects.archiveTitle': 'Archive this project (soft delete)',
    'projects.archiveConfirm': 'Archive project {project}? It disappears from the project list and all of its aliases are removed; its data is archived (never deleted). v1 has no in-app restore — recover it manually from disk if needed.',
    'projects.archived': 'Project archived.',
    'inbox.state.pending': 'pending', 'inbox.state.consumed': 'consumed', 'inbox.state.archived': 'archived', 'inbox.state.all': 'all',
    'inbox.viewAria': 'Handoff view', 'inbox.inboxView': 'Inbox', 'inbox.outboxView': 'Outbox',
    'inbox.empty': 'No handoffs match the current filter.',
    'inbox.from': 'from {from}', 'inbox.to': 'to {to}',
    'inbox.consume': 'Consume', 'inbox.archive': 'Archive',
    'inbox.consumeConfirm': 'Mark this handoff as consumed? This is a terminal state.',
    'inbox.archiveConfirm': 'Archive this handoff? It will be hidden from the default inbox view.',
    'status.title': 'Agent Status Board', 'status.connecting': 'connecting',
    'status.notReady': 'Status controller is not running. Start or reuse a session to begin monitoring.',
    'status.scanning': 'Scanning workspaces…', 'status.empty': 'No agents observed yet.',
    'status.counts': '{agents} agents · {sessions} sessions',
    'status.sessionCount': '{count} agents',
    'status.activeSection': 'Active',
    'status.inactiveCount': '{count} inactive',
    'status.hiddenSessions': '{count} past sessions',
    'status.dirAgents': '{count} active',
    'status.unknownDir': 'Unknown directory',
    'status.lastSeen': 'Last seen',
    'status.colAgent': 'Agent', 'status.colKind': 'Kind', 'status.colModel': 'Model',
    'status.colStatus': 'Status', 'status.colTool': 'Last tool', 'status.colSeen': 'Seen',
    'status.main': 'main', 'status.sub': 'sub', 'status.ended': 'session ended',
    'status.stale': 'stale', 'status.busy': 'busy', 'status.idle': 'idle', 'status.running': 'running',
    'status.completed': 'completed', 'status.failed': 'failed', 'status.killed': 'killed',
    'status.suspended': 'suspended', 'status.unknown': 'unknown'
  },
  'zh-CN': {
    'app.brand': 'MOA 工作区', 'app.nav': '主导航', 'app.debate': 'MOA 辩论', 'app.memory': '工作区记忆', 'app.runs': 'MoA 运行', 'app.status': 'Agent 状态', 'app.system': '系统健康',
    'locale.group': '语言', 'locale.zh': '中文', 'locale.en': 'EN', 'theme.group': '主题', 'theme.option': '主题：{name}',
    'debate.title': 'MOA 辩论', 'debate.context': '当前辩论上下文', 'debate.noTask': '（无 task_id）',
    'debate.activeTasks': '活跃任务', 'debate.loading': '加载中…', 'debate.noActiveTasks': '暂无活跃任务。', 'debate.tasksError': '无法加载 /tasks。', 'debate.pickTask': '选择任务',
    'debate.progress': '阶段进度', 'debate.waitInit': '等待任务初始化…', 'debate.stage.consensus': '共识', 'debate.stage.reference': '参考', 'debate.stage.debate': '辩论', 'debate.stage.aggregate': '聚合', 'debate.stage.verdict': '结论',
    'debate.stage.consensusTip': '共识 — 文件共识准备 · 点击查看详情', 'debate.stage.referenceTip': '参考 — 参考池 · 点击查看详情', 'debate.stage.debateTip': '辩论 — 辩手轮流发言 · 点击查看详情', 'debate.stage.aggregateTip': '聚合 — 汇总裁决 · 点击查看详情', 'debate.stage.verdictTip': '结论 — VERDICT 输出 · 点击查看详情',
    'debate.currentStage': '当前：{stage}', 'debate.allComplete': '全部完成 — 裁决结果已就绪', 'debate.modeConfig': '模式 / 配置', 'debate.waitTaskEvent': '等待 task_initialized…',
    'debate.round': '轮次', 'debate.speaker': '发言人', 'debate.turns': '发言数', 'debate.debaters': '辩手', 'debate.agentStatus': 'Agent 状态', 'debate.transcript': '辩论记录', 'debate.noTurns': '尚无发言，等待辩论开始…', 'debate.fullTranscript': '加载完整辩论记录', 'debate.toolLog': '工具调用日志', 'debate.waitTools': '等待工具调用…', 'debate.scanning': '扫描中…',
    'debate.agentCount': '{count} 个 agent', 'debate.toolCount': '{count} 条', 'debate.state.done': '完成', 'debate.state.active': '进行中', 'debate.state.pending': '未开始', 'debate.enteredAt': '于 {time} 进入',
    'debate.pending.0': '等待页面连接建立（加载后自动连接）', 'debate.pending.1': '等待 moa_init 完成任务初始化（task_initialized）', 'debate.pending.2': '等待 moa_start_debate 注入参考池并启动辩论（debate_started）', 'debate.pending.3': '等待所有辩手完成发言（debate_complete）', 'debate.pending.4': '等待 moa_complete 写入三层归档（task_closed）',
    'debate.notStarted': '该阶段尚未开始 — {reason}', 'debate.consensusDone': '任务已初始化，共识准备完成', 'debate.consensusActive': '已连接，等待 moa_init 初始化任务', 'debate.referenceSummary': 'reference_results 摘要：{value}', 'debate.referenceMissing': '快照未携带 reference_results（moa_start_debate 会直接注入辩手上下文）。',
    'debate.roundDetail': '轮次 {round}/{rounds} · 当前发言人 {speaker} · 已提交 {turns} 次发言', 'debate.aggregateDone': '归档已写入，裁决已输出', 'debate.aggregateActive': '汇总中 — 等待 moa_complete 写入归档', 'debate.verdictLoading': '归档已写入，VERDICT 详情加载中…',
    'debate.speaking': '发言中', 'debate.waiting': '等待中', 'debate.turnCount': '{count} 次发言', 'debate.turnCountPlural': '{count} 次发言', 'debate.signoff': '✍ 签字', 'debate.closed': '已关闭', 'debate.initialized': '已初始化', 'debate.debating': '辩论中', 'debate.debateComplete': '辩论完成', 'debate.earlyClose': '提前结束（全体一致签字）',
    'debate.archiveWritten': '归档已写入 · {archive}', 'debate.finishedAt': '完成时间', 'debate.archive': '归档', 'debate.signers': '签字人', 'debate.roundsLabel': '轮次', 'debate.turnsLabel': '发言数', 'debate.archivedAfterComplete': '辩论记录将在 moa_complete 后归档。', 'debate.signoffReset': '签字重置（{agent} 提出异议）— 辩论按原定轮次继续',
    'debate.waitingBadge': '等待中', 'debate.connecting': '连接中…', 'debate.connectedNoEventsBefore': '已连接，但任务 ', 'debate.connectedNoEventsAfter': ' 还没有任何事件。辩论可能尚未开始，或 Bus 进程重启过（事件日志在内存中）。', 'debate.backToTasks': '返回任务列表', 'debate.transient': '○ 临时中断 {count}/3', 'debate.backoff': '○ {seconds} 秒后重连', 'debate.error': '✗ 错误',
    'control.title': '工作区控制台', 'memory.workspaceLabel': '工作区 · 记忆与 Agent 配置', 'memory.workspaceAria': '选择工作区', 'memory.tabs': '工作区记忆', 'memory.tips': '项目 Tips', 'memory.board': '共享黑板 · 原始数据',
    'workspace.groupWorkspaces': '工作区', 'workspace.groupProjects': '项目',
    'workspace.rename': '改名', 'workspace.renameTitle': '重命名选中的工作区',
    'workspace.renamePlaceholder': '工作区名称（留空清除）', 'workspace.renameSave': '保存',
    'workspace.renamed': '工作区名称已更新。',
    'workspace.release': '释放', 'workspace.releaseTitle': '释放选中的工作区',
    'workspace.releaseConfirm': '确认释放工作区 {workspace}？看板数据留档不删除，项目别名解除，该目录下次写入从空白看板开始。',
    'workspace.released': '工作区已释放，看板已留档。',
    'common.status': '状态', 'common.allStatuses': '全部状态', 'common.module': '模块', 'common.tag': '标签', 'common.limit': '数量上限', 'memory.includeArchived': '包含已归档',
    'tips.new': '+ 新建 Tip', 'tips.edit': '编辑 Tip', 'tips.title': '标题 *', 'tips.summary': '摘要 *', 'tips.context': '上下文', 'tips.nextAction': '下一步操作', 'tips.tags': '标签 · 用逗号或换行分隔', 'tips.sourceRefs': '来源引用 · 用逗号或换行分隔', 'tips.relatedTipIds': '相关 Tip ID · 用逗号或换行分隔', 'tips.relatedProjects': '相关项目 · 用逗号或换行分隔', 'tips.sourceSessionId': '来源 Session ID', 'tips.authorCreate': '作者 · 仅创建时', 'tips.documentRefs': '文档引用 · 安全 JSON 数组', 'tips.save': '保存 Tip',
    'common.cancel': '取消', 'common.details': '详情', 'common.archive': '归档', 'common.edit': '编辑', 'common.delete': '删除', 'common.refresh': '刷新', 'common.closeDetails': '关闭详情',
    'tips.empty': '没有符合筛选条件的 Tip。', 'tips.noWorkspace': '暂无工作区。请先在项目里运行 /moamcp:tips。', 'tips.createWorkspace': '请先在项目里运行 /moamcp:tips 创建工作区 sidecar。', 'tips.boardLink': '在黑板中查看 tips/{id}', 'tips.archiveConfirm': '确认归档此 Tip？归档后默认列表将不再显示。', 'tips.required': '标题和摘要不能为空。', 'tips.documentJson': 'documentRefs 必须是有效 JSON。', 'tips.documentArray': 'documentRefs 必须是 JSON 数组。',
    'board.scope': '作用域', 'board.keySearch': 'Key 命名空间 / key', 'board.sort': '排序', 'board.updatedDesc': '最近更新', 'board.updatedAsc': '最早更新', 'board.keyAsc': 'key A–Z', 'board.keyDesc': 'key Z–A', 'board.new': '+ 新建条目',
    'board.results': '{count} 条结果', 'board.result': '{count} 条结果', 'board.select': '选择一条黑板条目查看完整内容 (value)。', 'board.empty': '没有符合 key/tag 条件的黑板条目。', 'board.newTitle': '新建黑板条目', 'board.editTitle': '编辑黑板条目', 'board.closeForm': '关闭黑板表单', 'board.value': 'Markdown value', 'board.valueSize': 'UTF-8 value 大小', 'board.author': '作者',
    'board.external': '外部已更新：你的本地草稿已保留。保存时将再次确认，并使用打开表单时的版本戳。', 'board.reload': '重新载入当前版本', 'board.save': '保存条目', 'board.formClosed': '黑板表单未打开。', 'board.keyRequired': 'key 不能为空。', 'board.tooLarge': '内容超出 32768 字节 (UTF-8) 限制。', 'board.workspaceRequired': '工作区作用域需要先选择已注册的工作区。', 'board.externalConfirm': '此黑板条目已被外部修改。确认仍使用打开表单时的 expectedTs 尝试保存吗？', 'board.saved': '黑板条目已保存。', 'board.missing': '不存在（可能已删除）', 'board.conflict': 'CAS 版本冲突。当前版本时间戳 currentTs: {current}。草稿已保留。', 'board.currentMissing': '当前版本不存在，可能已删除；草稿继续保留。', 'board.reloaded': '已重新载入 currentTs: {current}', 'board.copyKey': '复制 key', 'board.copyValue': '复制 value', 'board.backToTip': '返回结构化 Tip', 'board.deleteConfirm': '确认删除“{key}”？它会从当前视图消失，但 append-only 历史会保留墓碑。', 'board.deleted': '黑板条目已删除；append-only 历史已保留墓碑。', 'board.deleteConflict': '删除 CAS 冲突。currentTs: {current}。请刷新后重试。', 'board.scopeNotice': '工作区作用域需要先注册工作区；你仍可切换至全局作用域。',
    'common.copied': '已复制{label}。', 'common.copyFailed': '无法访问剪贴板，请手动复制。',
    'runs.intro': '运行模型是 owner Bus 的内存事件投影；Bus 重启后请以归档为准。', 'runs.tabs': 'MoA 运行', 'runs.live': '实时与近期', 'runs.archives': '归档', 'runs.query': '搜索', 'runs.queryPlaceholder': 'task id、agent、binding slot', 'runs.empty': '暂无实时或近期运行。', 'runs.roundConfigured': '当前轮次 / 配置轮次', 'runs.turn': '当前发言 (turn)', 'runs.speaker': '发言人', 'runs.turnsSignoffs': '发言数 / 签字数', 'runs.lastEvent': '最近事件', 'runs.updated': '更新时间', 'runs.earlyReason': '提前结束原因', 'runs.copyTask': '复制 task id', 'runs.openLive': '打开实时卡片', 'runs.detailsError': '获取运行详情失败：', 'runs.openError': '无法打开实时卡片：',
    'archives.copy': '复制 {file}', 'archives.download': '下载 {file}', 'archives.fileError': '加载归档文件失败：', 'archives.updated': '更新时间', 'archives.summary': '结果摘要', 'archives.errors': '错误（{count}）', 'archives.notPresent': '不存在', 'archives.view': '查看', 'archives.empty': '未找到归档。',
    'archives.degraded': '退化', 'archives.available': '可用',
    'system.copyUrl': '复制控制台 URL', 'system.openDebate': '打开 MOA 辩论', 'system.intro': 'Bus listener 条目不等于全部 Kimi Session / MCP 进程。此页面只读，不提供危险操作。', 'system.unavailable': '系统健康信息暂不可用：', 'system.value': '值', 'system.version': '版本',
    'busUpdate.banner': '磁盘上已安装新版本 v{disk}（当前运行 v{running}）。重启后端后生效。',
    'busUpdate.restart': '立即重启后端',
    'busUpdate.restarting': '正在重启后端…',
    'busUpdate.stale': '仍有旧进程持有服务，请重启 session。',
    'memory.agents': 'Agent 与 Profile',
    'agent.title': 'Agent 与 Profile', 'agent.intro': '管理项目内的 Agent Markdown 与 local.toml binding。修改会原子写入磁盘；运行中的 Session 只有在执行 /reload 后才会采用。',
    'agent.refresh': '刷新 Agent', 'agent.new': '+ 新建 Agent', 'agent.summary': 'Agent Profile',
    'agent.select': '选择一个 Agent 以加载 Markdown 正文。', 'agent.noAgents': '没有找到 Agent Markdown 文件。',
    'agent.name': '名称 *', 'agent.markdown': 'Agent Markdown', 'agent.description': '描述', 'agent.slot': 'Slot',
    'agent.file': '文件', 'agent.hash': 'SHA-256', 'agent.size': '大小', 'agent.valid': '有效', 'agent.invalid': '无效',
    'agent.template': '使用模板', 'agent.save': '保存 Agent', 'agent.delete': '删除 Agent',
    'agent.deleteConfirm': '确认删除 Agent “{name}”？项目文件将被移除。', 'agent.saved': 'Agent 文件已保存到磁盘。',
    'agent.deleted': 'Agent 文件已从磁盘删除。', 'agent.reloadLatest': '加载最新版本',
    'agent.bindings': '按类型 binding', 'agent.slots': '命名 slot', 'agent.bindingName': '名称', 'agent.model': '模型',
    'agent.thinking': '思考强度', 'agent.inherit': '继承', 'agent.unset': '未设置',
    'agent.addBinding': '添加 binding', 'agent.saveBindings': '保存 binding', 'agent.noBindings': 'local.toml 中没有 binding。',
    'agent.rawTitle': '原文 local.toml', 'agent.rawHint': '复杂 TOML 布局不会由结构化编辑器重排，请改用这个经过校验的原文编辑器。',
    'agent.loadRaw': '加载 local.toml', 'agent.rawEditor': 'local.toml 原文', 'agent.saveRaw': '保存 local.toml',
    'agent.layout': 'TOML 布局', 'agent.layoutStandard': '标准', 'agent.layoutComplex': '复杂 — 请使用原文编辑器',
    'agent.reloadBanner': '已保存到磁盘。当前 Session 尚未采用此修改；运行中的 turn 完成后再执行 /reload。多个 Session 需要分别执行 /reload。',
    'agent.copyReload': '复制 /reload', 'agent.conflict': '配置已被外部修改。你的草稿已保留；加载最新版本后再保存。',
    'agent.reloaded': '已加载最新配置，之前的草稿已替换。', 'agent.error': 'Agent 配置：',
    'memory.projects': '项目', 'memory.inbox': '交接收件箱',
    'projects.intro': '项目把一个或多个工作区归到同一块共享看板。把当前工作区合并进项目后，其路径会绑定为项目别名，后续工作区作用域的读写都指向项目看板。',
    'projects.empty': '暂无项目。可通过合并当前工作区创建项目。',
    'projects.createdAt': '创建于 {createdAt}', 'projects.aliases': '别名', 'projects.noAliases': '暂无别名',
    'projects.merge': '把当前工作区合并进此项目',
    'projects.directories': '目录详情',
    'projects.unknownPath': '未知路径',
    'projects.create': '新建项目并合并当前工作区',
    'projects.namePlaceholder': '项目名（可选）',
    'projects.untitled': '未命名项目',
    'projects.createConfirm': '确认新建项目 {project} 并把当前工作区合并进去？此迁移立即生效且无法自动撤销；原工作区看板会留档（不会删除）。',
    'projects.mergeConfirm': '确认把当前工作区合并进项目 {project}？此迁移立即生效且无法自动撤销；原工作区看板会留档（不会删除）。',
    'projects.merged': '工作区已合并进 {projectId} · 迁移 {moved} 条记录。',
    'projects.count': '{count} 个项目', 'projects.countPlural': '{count} 个项目',
    'projects.renameTitle': '重命名此项目',
    'projects.renamePlaceholder': '项目名称',
    'projects.renameSave': '保存', 'projects.renamed': '项目名称已更新。',
    'projects.renameRequired': '项目名称不能为空。',
    'projects.detachAliasTitle': '拆出此别名（取消合并）',
    'projects.detachConfirm': '确认把别名 {alias} 从项目 {project} 拆出？只解除路径与项目的绑定：项目看板里的既有记录保留在项目，该目录回到独立工作区（之后新写入从空白看板开始）。数据不删除。',
    'projects.detached': '别名已拆出，该目录已回到独立工作区。',
    'projects.archiveProject': '归档', 'projects.archiveTitle': '归档此项目（软删除）',
    'projects.archiveConfirm': '确认归档项目 {project}？项目将从列表消失、全部别名解除，数据留档（不删除）。v1 不提供界面恢复，如需找回请从磁盘手工恢复。',
    'projects.archived': '项目已归档。',
    'inbox.state.pending': '待处理', 'inbox.state.consumed': '已消费', 'inbox.state.archived': '已归档', 'inbox.state.all': '全部',
    'inbox.viewAria': '交接视图', 'inbox.inboxView': '收件箱', 'inbox.outboxView': '发件箱',
    'inbox.empty': '没有符合当前筛选条件的交接。',
    'inbox.from': '来自 {from}', 'inbox.to': '发给 {to}',
    'inbox.consume': '标记已消费', 'inbox.archive': '归档',
    'inbox.consumeConfirm': '确认将此交接标记为已消费？这是终态。',
    'inbox.archiveConfirm': '确认归档此交接？归档后将不在默认收件列表显示。',
    'status.title': 'Agent 状态看板', 'status.connecting': '连接中…',
    'status.notReady': '状态控制器未启动。请启动或复用会话后开始监控。',
    'status.scanning': '扫描工作区中…', 'status.empty': '尚未观测到任何 agent。',
    'status.counts': '{agents} 个 agent · {sessions} 个会话',
    'status.sessionCount': '{count} 个 agent',
    'status.activeSection': '活跃',
    'status.inactiveCount': '{count} 个不活跃',
    'status.hiddenSessions': '{count} 个历史 session',
    'status.dirAgents': '{count} 个活跃',
    'status.unknownDir': '未知目录',
    'status.lastSeen': '最后活跃',
    'status.colAgent': 'Agent', 'status.colKind': '类型', 'status.colModel': '模型',
    'status.colStatus': '状态', 'status.colTool': '最近工具', 'status.colSeen': '最近活跃',
    'status.main': '主', 'status.sub': '子', 'status.ended': '会话已结束',
    'status.stale': '陈旧', 'status.busy': '忙碌', 'status.idle': '空闲', 'status.running': '运行中',
    'status.completed': '已完成', 'status.failed': '失败', 'status.killed': '已终止',
    'status.suspended': '已挂起', 'status.unknown': '未知'
  }
};

export function translate(locale: Locale, key: string, values?: Record<string, string | number>): string {
  let text = I18N_DICTIONARIES[locale][key] ?? I18N_DICTIONARIES.en[key] ?? key;
  if (values) text = text.replace(/\{([^}]+)\}/g, (match, name: string) => values[name] === undefined ? match : String(values[name]));
  return text;
}

const SERIALIZED_DICTIONARIES = JSON.stringify(I18N_DICTIONARIES).replace(/</g, '\\u003c');

/** Sets lang before paint without touching independently persisted theme state. */
export const I18N_BOOTSTRAP = `<script>
(function () {
  try {
    var saved = null;
    try { saved = localStorage.getItem('${LOCALE_STORAGE_KEY}'); } catch (_) {}
    var langs = (typeof navigator !== 'undefined' && navigator.languages && navigator.languages.length) ? navigator.languages : [(typeof navigator !== 'undefined' && navigator.language) || ''];
    var fallback = langs.some(function (value) { return /^zh(?:-|$)/i.test(String(value)); }) ? 'zh-CN' : 'en';
    document.documentElement.lang = saved === 'zh-CN' || saved === 'en' ? saved : fallback;
  } catch (e) { try { document.documentElement.lang = 'en'; } catch (_) {} }
})();
</script>`;

/** Browser runtime: lookup, static bindings, persistence, accessible picker, and change events. */
export const I18N_JS = `
(function(window) {
  'use strict';
  var DICTS = ${SERIALIZED_DICTIONARIES};
  var KEY = ${JSON.stringify(LOCALE_STORAGE_KEY)};
  var VALID = ['zh-CN', 'en'];
  function valid(value) { return VALID.indexOf(value) !== -1; }
  function browserLocale() {
    try {
      var langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
      for (var i = 0; i < langs.length; i++) if (/^zh(?:-|$)/i.test(String(langs[i]))) return 'zh-CN';
    } catch (_) {}
    return 'en';
  }
  function initialLocale() {
    try { var saved = localStorage.getItem(KEY); if (valid(saved)) return saved; } catch (_) {}
    return browserLocale();
  }
  var locale = initialLocale();
  function t(key, values) {
    var text = (DICTS[locale] && DICTS[locale][key]) || DICTS.en[key] || key;
    if (values) text = text.replace(/\\{([^}]+)\\}/g, function(match, name) { return values[name] === undefined ? match : String(values[name]); });
    return text;
  }
  function applyStatic() {
    try {
      document.documentElement.lang = locale;
      var nodes = document.querySelectorAll('[data-i18n]');
      for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
      var attrs = [['data-i18n-aria', 'aria-label'], ['data-i18n-placeholder', 'placeholder'], ['data-i18n-title', 'title'], ['data-i18n-tip', 'data-tip']];
      for (var a = 0; a < attrs.length; a++) {
        var bound = document.querySelectorAll('[' + attrs[a][0] + ']');
        for (var j = 0; j < bound.length; j++) bound[j].setAttribute(attrs[a][1], t(bound[j].getAttribute(attrs[a][0])));
      }
      var picker = document.getElementById('localePicker');
      if (picker) picker.setAttribute('aria-label', t('locale.group'));
      var buttons = picker ? picker.children : [];
      for (var k = 0; k < buttons.length; k++) {
        var buttonLocale = buttons[k].getAttribute('data-locale');
        if (!valid(buttonLocale)) continue;
        var active = buttonLocale === locale;
        buttons[k].className = 'locale-pill' + (active ? ' active' : '');
        buttons[k].setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    } catch (_) {}
  }
  function setLocale(next, persist) {
    if (!valid(next)) next = browserLocale();
    locale = next;
    if (persist !== false) { try { localStorage.setItem(KEY, locale); } catch (_) {} }
    applyStatic();
    try {
      var event;
      if (typeof CustomEvent === 'function') event = new CustomEvent('moamcp:localechange', { detail: { locale: locale } });
      else { event = document.createEvent('Event'); event.initEvent('moamcp:localechange', false, false); event.detail = { locale: locale }; }
      window.dispatchEvent(event);
    } catch (_) {}
    return locale;
  }
  function initPicker() {
    try {
      var picker = document.getElementById('localePicker');
      if (picker) for (var i = 0; i < picker.children.length; i++) if (valid(picker.children[i].getAttribute('data-locale'))) picker.children[i].addEventListener('click', function() { setLocale(this.getAttribute('data-locale')); });
    } catch (_) {}
    applyStatic();
  }
  window.__moaI18n = { t: t, getLocale: function() { return locale; }, setLocale: setLocale, applyStatic: applyStatic, storageKey: KEY };
  initPicker();
})(typeof window !== 'undefined' ? window : this);
`;
