/**
 * Locale dictionaries for the Model Orchestrator client surfaces.
 *
 * These are the ONLY user-facing strings the plugin renders. Behavioral strings
 * that a model reads — tool descriptions, the tool parameter specs, the routing
 * prompt section, and every persona — are deliberately NOT here: they are
 * instructions to the model, stay English, and must not follow the UI language.
 *
 * The namespace is registered through `ctx.locale.register(ns, { zh, en })`, and
 * the lookup chain falls back to the shared `common` namespace and finally to the
 * key itself, so a missing key degrades to a readable identifier rather than a
 * blank. Both dictionaries must carry exactly the same key set.
 *
 * Placeholders use the `{name}` form the harness interpolates.
 *
 * @module dsh-model-orchestrator/locales
 */

/** Dictionary namespace owned by this plugin. */
export const LOCALE_NAMESPACE = 'modelOrchestrator'

/**
 * English dictionary. This is the source of truth for the key set.
 * @type {Record<string, string>}
 */
export const en = {
  // ---- document / status --------------------------------------------------
  'doc.title': 'Model Orchestrator',
  'doc.subtitle':
    'Discovers the models this harness actually has and routes each unit of work to the best available one. No model is named anywhere in the selection logic.',
  'doc.loading': 'Loading the live model pool…',
  'doc.refresh': 'Refresh pool',
  'doc.refreshing': 'Re-reading…',

  // ---- health chips -------------------------------------------------------
  'health.host': 'host {version}',
  'health.requires': 'requires {range}',
  'health.pool': 'pool {count}',
  'health.optionalAbsent': '{name} absent',
  'health.unknown': 'unknown',
  'health.state': 'State: {message}',

  // ---- mode ---------------------------------------------------------------
  'mode.title': 'Mode',
  'mode.description':
    'Choose how a model is picked. Auto reads each task and decides by itself. Guided adds the capability areas below as a standing cue: they appear once Guided is chosen, and the live pool still decides which model serves each one.',
  'mode.auto': 'Auto',
  'mode.autoHint': 'Read each task and choose a model for every piece of work automatically.',
  'mode.guided': 'Guided',
  'mode.guidedHint': 'Reveal the capability areas and match models against them.',
  'mode.guidedActive': 'Guided: the areas you set below shape every match.',
  'mode.guidedReveals': 'Capability areas apply in Guided mode — choose Guided to set them.',

  // ---- capability areas ---------------------------------------------------
  'capability.title': 'Capability areas',
  'capability.selectedCount': '{count} selected',
  'capability.description':
    'These shape matching in Guided mode. They are capability descriptors, never model names: the model behind each one is re-matched from the live pool every run.',
  'capability.filterPlaceholder': 'Filter capabilities…',
  'capability.empty': 'No capability matches that filter.',
  'capability.learned': ' ·new',
  'capability.learnedTitle': 'Learned at runtime for a capability the taxonomy did not have.',

  // ---- model pool ---------------------------------------------------------
  'pool.title': 'Model pool',
  'pool.summary': '{models} model(s) · {providers} provider(s)',
  'pool.description':
    'The orchestrator re-reads the models this harness offers every time it runs, and matches them to what a task needs. Only the routes this deployment makes selectable for subagents are listed.',
  'pool.empty':
    'No model is currently discoverable. Routing cannot select anything until a provider answers a listing.',
  'pool.columnRoute': 'Route',
  'pool.columnContext': 'Context',
  'pool.columnImage': 'Image',
  'pool.columnReasoning': 'Reasoning',
  'pool.yes': 'yes',
  'pool.no': 'no',
  'pool.unknown': 'unknown',
  'pool.noValue': '—',
  'pool.contextValue': '{value}k',

  // ---- preferences --------------------------------------------------------
  'preferences.title': 'Preferences',
  'preferences.preferCheaper': 'Prefer lower-cost routes',
  'preferences.preferCheaperHint':
    'Shapes tie-breaks only, and only between routes whose measured tier differs. It never overrides a hard requirement, and it does nothing at all when every route in the pool shares one tier.',
  'preferences.allowMultiAgent': 'Allow multi-agent plans',
  'preferences.allowMultiAgentHint':
    'When off, complex tasks run as one specialist instead of several.',
  'preferences.calibrationEnabled': 'Keep calibrations aligned with the pool',
  'preferences.calibrationEnabledHint':
    'Prunes learned profiles whose route left the pool.',
  'preferences.maxParallel': 'Max parallel',
  'preferences.maxParallelHint': 'Concurrent specialist subagents.',
  'preferences.maxAgentsPerRun': 'Max agents/run',
  'preferences.maxAgentsPerRunHint': 'Specialists per orchestration run.',

  // ---- routing preview ----------------------------------------------------
  'preview.title': 'Routing preview',
  'preview.description':
    'Describe a task to see which tier and which live model the orchestrator would choose. This spawns nothing.',
  'preview.placeholder':
    'e.g. Research the topic, then analyze the data, then review the report',
  'preview.action': 'Preview',
  'preview.busy': 'Planning…',
  'preview.unitCount': '{count} unit(s)',
  'preview.poolCount': 'pool {count}',
  'preview.noDelegation':
    'No delegation needed: this tier runs on the current model.',
  'preview.columnUnit': 'Unit',
  'preview.columnCapability': 'Capability',
  'preview.columnRoute': 'Matched route',
  'preview.columnWhy': 'Why',
  'preview.unrouted': 'unrouted',

  // ---- routing capacity ---------------------------------------------------
  'capacity.title': 'Routing capacity',
  'capacity.inFlight': '{count} delegation(s) in flight',
  'capacity.capabilities': '{count} capabilit(ies)',
  'capacity.note':
    'Task lists, step status, and progress are DSH-native and are shown by DSH itself. This orchestrator only routes model work, so it keeps no task state of its own.',

  'health.missingDeps': '{count} optional service(s) this deployment does not provide',
  'health.disabledOne': '{name} disabled: {reason}',
  'health.degradedOne': '{name} degraded: {reason}',
  'health.allActive': 'Every subsystem is active.',
  'health.subsystems': 'Subsystems',
  'board.reasonUnknown': 'the harness does not report what this delegation is doing',
  'board.reasonNoRun': 'no orchestration run has been recorded for this session yet',
  'board.dragHint': 'drag a node to move it',
  'board.legendEdges': 'Edges',
  'board.legendStatus': 'Status',
  'board.legendNodes': 'Nodes',
  'board.runElapsed': 'run {time}',
  'board.statReviews': '{count} review(s)',
  'board.statQuestions': '{count} question(s)',
  'board.statFailed': '{count} failed',
  'board.statCompleted': '{count} completed',
  'board.artifactLabel': 'artifact',
  'board.questionsAnswered': 'answered {count}',
  'board.questionsAsked': 'asked {count}',
  'board.rounds': '{count} round(s)',
  'board.elapsedSeconds': '{seconds}s',
  'board.elapsedMs': '{ms} ms',
  'board.verdict.unknown': 'unknown',
  'board.verdict.reject': 'reject',
  'board.verdict.approve': 'approve',
  'board.reviewEdge': 'round {round} · {verdict}',
  'board.outputWaiting': 'waiting for every unit to settle',
  'board.waitingFor': 'waiting for {names}',
  'board.taskPlaceholder': 'No task recorded yet',
  'board.edge.output': 'output',
  'board.edge.review': 'review',
  'board.edge.question': 'question',
  'board.edge.dependency': 'dependency',
  'board.edge.dispatch': 'dispatch',
  'board.edge.task': 'task',
  'board.status.unknown': 'unknown',
  'board.status.failed': 'failed',
  'board.status.completed': 'completed',
  'board.status.running': 'running',
  'board.status.notStarted': 'not started',
  'board.status.waiting': 'waiting',
  'board.node.output': 'Final output',
  'board.node.session': 'Native delegation',
  'board.node.unit': 'Routed unit',
  'board.node.captain': 'Captain',
  'board.node.task': 'Task',
  'command.routing': 'Routing through the orchestrator: {task}',
  'command.messageFailed': 'Could not build the routing message: {message}',
  'command.noAgent': 'No live agent is attached to this session, so the task cannot be routed.',
  'command.statusResearchUnconfirmed': '{count} unconfirmed',
  'command.statusResearched': 'researched: {count} route(s)',
  'command.statusAssignmentsUnassigned': '{count} route(s) unassigned',
  'command.statusAssignmentsUnresolved': '{count} unresolved',
  'command.statusAssignments': 'assignments: {count}',
  'command.status': 'Model Orchestrator — mode {mode} · {models} model(s) · {capabilities} capabilit(ies) · {inFlight} delegation(s) in flight',
  'command.usage': 'Usage: /model-orchestrator <task> — route one task through the orchestrator.\n/model-orchestrator status — show the current routing state.',
  'command.hintLabel': 'Input',
  'command.usageLabel': 'Usage',
  'command.hint': '[<task> | status]',
  'command.summary': 'route one task through the Model Orchestrator instead of delegating it yourself',
  'command.title': 'Slash command',
  'capability.assignHint': 'These areas decide what is IN SCOPE for this session. Who does each one is set below, under Capability assignments — the two are different questions and do not compete.',
  'pool.effortManualHint': 'This provider exposes no levels to choose from, so this was set by hand and cannot be checked. It is sent as-is; if the provider rejects it, the delegation fails with its error.',
  'pool.effortManual': 'manual: {effort}',
  'capability.label.capacity.very_long': 'Very large input',
  'capability.label.depth.routine': 'Routine, well-specified work',
  'capability.label.depth.difficult': 'Difficult, compounding reasoning',
  'capability.label.throughput.bulk': 'High-volume routine work',
  'capability.label.long.context': 'Very long context',
  'capability.label.multimodal.screenshot': 'Screenshot and UI reading',
  'capability.label.multimodal.vision': 'Image understanding',
  'capability.label.writing.translation': 'Translation and localization',
  'capability.label.writing.production': 'Writing and editing',
  'capability.label.document.processing': 'Document processing',
  'capability.label.web.information': 'Web information retrieval',
  'capability.label.research.investigation': 'Research and investigation',
  'capability.label.science.technical': 'Science and engineering analysis',
  'capability.label.reasoning.mathematics': 'Mathematics',
  'capability.label.reasoning.general': 'Difficult general reasoning',
  'capability.label.data.statistics': 'Statistics and inference',
  'capability.label.data.visualization': 'Data visualization',
  'capability.label.data.analysis': 'Data analysis',
  'capability.label.software.operations': 'Build, deploy, and operations',
  'capability.label.software.testing': 'Testing and verification',
  'capability.label.software.review': 'Code review and verification',
  'capability.label.software.architecture': 'Architecture and design',
  'capability.label.software.debugging': 'Debugging and diagnosis',
  'capability.label.software.implementation': 'Software implementation',
  'pool.researchNote': 'Public names and costs come from Sync, not from the host. Everything without a source stays blank.',
  'pool.reasoningAutomaticHint': 'This provider reasons without exposing a level to pick, so there is no level to configure. It still counts as reasoning capability when a task needs it.',
  'pool.reasoningAutomatic': 'automatic',
  'pool.costHint': 'About {percent}% of the dearest route in this pool',
  'pool.priceUnknown': 'no published price',
  'pool.columnCost': 'Cost ($/M tok)',
  'pool.columnPublic': 'Public model',
  'pool.priceLine': '{input} / {output}',
  'pool.researchedUnconfirmed': 'public identity unconfirmed',
  'pool.syncIdle': 'Nothing to do: {reason}',
  'pool.syncError': 'Sync failed: {message}',
  'pool.syncDone': 'Researched {stored} route(s); {unmatched} could not be confirmed and stay unconfirmed.',
  'pool.syncRunning': 'Researching {total} route(s)… this takes a few minutes.',
  'pool.syncAllHint': 'Re-research every route, including ones already known',
  'pool.syncAll': 'Re-check all',
  'pool.syncHint': 'Read public model names and prices from the web, using a model to reconcile the sources. The one action in this plugin that touches the network, and it only runs when you press it.',
  'pool.syncing': 'Syncing…',
  'pool.sync': 'Sync',
  'assignment.allResolved': 'Every target resolves against the live pool.',
  'assignment.cannotResolve': 'cannot resolve',
  'assignment.resolvesTo': 'now resolves to',
  'assignment.clearHint': 'Clear this entry; the capability goes back to the measured ranking',
  'assignment.clear': 'clear',
  'assignment.removeHint': 'Remove {model} from this assignment',
  'assignment.pickModelHint': 'Add a model from the live pool to the selected capability. Picking a model again appends it as a lower-priority fallback.',
  'assignment.allAssigned': 'Every capability already has an assignment',
  'assignment.count': '{count} assigned',
  'assignment.familyHint': 'Also match a later version of the same model (gpt-5.6 → gpt-5.7). Off by default: a version bump is usually the same model, but not always.',
  'assignment.family': 'follow the family',
  'assignment.unassigned': '{count} live route(s) no assignment mentions',
  'assignment.unresolved': '{count} target(s) match nothing in the live pool',
  'assignment.addModel': 'Add a model…',
  'assignment.empty': 'No assignment yet. Routing falls back to the measured ranking.',
  'assignment.description': 'Your standing division of labour: which model serves which kind of work. An entry is a capability (or a whole group) with an ordered list of models. Models are stored as identities, not routes, so renaming, moving provider or bumping a version does not break the table — and anything that stops matching is reported below instead of silently ignored.',
  'assignment.title': 'Capability assignments',
  'pool.effortIgnored': 'configured "{effort}" is no longer advertised by this route, so it is ignored',
  'pool.effortHint': 'Reasoning level this route is dispatched with. "default" lets the model resolve its own.',
  'pool.effortDefaultWith': 'default ({effort})',
  'pool.effortDefault': 'default',
  'pool.filteredByPreference': '{count} hidden by your route preferences',
  'pool.policyFiltered': 'Showing the {kept} route(s) this deployment offers for subagents; {dropped} advertised route(s) are not selectable.',
  'board.poolMeter': '{count} models available',
  'board.updatedEvery': 'refreshed every {seconds}s',
  'board.legendSource': 'topology read from the harness session tree',
  'board.legendContinuable': 'resumable',
  'board.legendIdle': 'the harness reports this session as no longer active, so its outcome is not recorded',
  'board.legendRunning': 'a running node keeps its wires flowing',
  'board.emptyTitle': 'Nothing delegated yet',
  'board.hasChildren': 'has nested delegations',
  'board.nativeDelegation': 'native delegation',
  'board.nativeDelegationHint':
    'DSH started this child on its own; the orchestrator did not choose its route',
  'board.generalWork': 'General work',
  'board.rootLabel': 'Captain: this session',
  'board.statContinuable': '{count} resumable',
  'board.statRunningSuffix': 'running',
  'board.activityInactive': 'inactive',
  'board.activityRunning': 'running',
  'board.modeContinuable': 'continuable',
  'board.modeOneShot': 'one-shot',
  'board.statRoots': '{count} branch(es)',
  'board.statDelegated': '{count} delegated',
  'board.mode': 'mode {mode}',
  'board.unavailable': 'The delegation graph is unavailable: {message}',
  'board.truncated': 'The graph was truncated: too many nodes to display at once.',
  'board.noSession': 'Open a session to see its delegation graph.',
  'board.empty': 'Nothing has been delegated yet. The orchestrator starts a subagent only when a task needs a capability the current model is not the best fit for.',
  'board.graphTitle': 'Delegation graph',
  'board.description': 'How this task was delegated, left to right: the task, the captain that owns the answer, every unit the orchestrator routed, every native delegation the harness started by itself, and the final output. Wires are dispatches, dependencies, questions and reviews: a dependency is drawn heaviest and a review carries its verdict. Boxes can be dragged, and a wire has a wide hit area that lights up both of its ends.',
  'board.title': 'Model Orchestrator',
  'board.tab': 'Orchestrator',
  // ---- per-session strip --------------------------------------------------
  'strip.modelCount': '{count} model(s)',

  // ---- tiers --------------------------------------------------------------
  'tier.direct': 'direct',
  'tier.specialist': 'specialist',
  'tier.multiAgent': 'multi-agent',
  'tier.unknown': 'unknown',
}

/**
 * Simplified Chinese dictionary.
 * @type {Record<string, string>}
 */
export const zh = {
  // ---- document / status --------------------------------------------------
  'doc.title': '模型编排器',
  'doc.subtitle':
    '自动发现当前 Harness 实际可用的模型，并把每一项工作路由给最合适的模型。选型逻辑中不写死任何模型名称。',
  'doc.loading': '正在读取实时模型池…',
  'doc.refresh': '刷新模型池',
  'doc.refreshing': '重新读取中…',

  // ---- health chips -------------------------------------------------------
  'health.host': 'host {version}',
  'health.requires': 'requires {range}',
  'health.pool': '模型池 {count}',
  'health.optionalAbsent': '{name} 未挂载',
  'health.unknown': '未知',
  'health.state': '状态：{message}',

  // ---- mode ---------------------------------------------------------------
  'mode.title': '模式',
  'mode.description':
    '选择如何挑模型。自动：逐条读懂任务自行决定。引导：把下面的能力领域作为长期提示——选中「引导」后该面板才会展开，具体由哪个模型来做仍由实时模型池决定。',
  'mode.auto': '自动',
  'mode.autoHint': '自动读懂每条任务，并为每一项工作挑好模型。',
  'mode.guided': '引导',
  'mode.guidedHint': '展开能力领域面板，并据此匹配模型。',
  'mode.guidedActive': '引导模式：下面勾选的领域会参与每一次匹配。',
  'mode.guidedReveals': '能力领域只在「引导」模式下生效——选「引导」即可展开设置。',

  // ---- capability areas ---------------------------------------------------
  'capability.title': '能力领域',
  'capability.selectedCount': '已选 {count} 项',
  'capability.description':
    '这些只影响「引导」模式下的匹配。它们是能力描述符，而不是模型名称：每一项背后的模型都会在每次运行时从实时模型池重新匹配。',
  'capability.filterPlaceholder': '筛选能力…',
  'capability.empty': '没有符合该筛选条件的能力。',
  'capability.learned': ' ·新增',
  'capability.learnedTitle': '运行时为分类体系尚未覆盖的能力自动生成。',

  // ---- model pool ---------------------------------------------------------
  'pool.title': '模型池',
  'pool.summary': '{models} 个模型 · {providers} 个 provider',
  'pool.description': '编排器每次运行都会重新读取当前可用的模型，再按任务需要匹配。这里只列出本部署可为子代理选用的路由。',
  'pool.empty': '当前没有可发现的模型。在任一 provider 返回模型列表之前，路由无法选择任何模型。',
  'pool.columnRoute': 'Route',
  'pool.columnContext': '上下文',
  'pool.columnImage': '图像',
  'pool.columnReasoning': '推理',
  'pool.yes': '支持',
  'pool.no': '不支持',
  'pool.unknown': '未知',
  'pool.noValue': '—',
  'pool.contextValue': '{value}k',

  // ---- preferences --------------------------------------------------------
  'preferences.title': '偏好设置',
  'preferences.preferCheaper': '优先选择成本更低的路由',
  'preferences.preferCheaperHint': '只在实测档位不同的路由之间打破平局。它永远不会覆盖硬性要求；当池内所有路由档位相同时，它不产生任何影响。',
  'preferences.allowMultiAgent': '允许多智能体编排',
  'preferences.allowMultiAgentHint': '关闭后，复杂任务会交由单个专家完成，而不是拆给多个。',
  'preferences.calibrationEnabled': '保持校准数据与模型池同步',
  'preferences.calibrationEnabledHint': '自动清理已离开模型池的路由所对应的学习画像。',
  'preferences.maxParallel': '最大并发',
  'preferences.maxParallelHint': '同时运行的专家子智能体数量。',
  'preferences.maxAgentsPerRun': '单次上限',
  'preferences.maxAgentsPerRunHint': '每次编排运行最多派发的专家数量。',

  // ---- routing preview ----------------------------------------------------
  'preview.title': '路由预览',
  'preview.description':
    '描述一个任务，即可看到编排器会选择的档位与实时模型。此操作不会派发任何子智能体。',
  'preview.placeholder': '例如：先调研该主题，再分析数据，最后复核报告',
  'preview.action': '预览',
  'preview.busy': '规划中…',
  'preview.unitCount': '{count} 个工作单元',
  'preview.poolCount': '模型池 {count}',
  'preview.noDelegation': '无需委派：该档位由当前模型直接执行。',
  'preview.columnUnit': '单元',
  'preview.columnCapability': '能力',
  'preview.columnRoute': '匹配 Route',
  'preview.columnWhy': '原因',
  'preview.unrouted': '未匹配',

  // ---- routing capacity ---------------------------------------------------
  'capacity.title': '路由容量',
  'capacity.inFlight': '{count} 项委派进行中',
  'capacity.capabilities': '{count} 项能力',
  'capacity.note':
    '任务列表、步骤状态和进度都由 DSH 原生负责展示。本编排器只负责为模型工作选择路由，自身不保存任何任务状态。',

  'health.missingDeps': '本部署未提供 {count} 个可选服务',
  'health.disabledOne': '{name} 已禁用：{reason}',
  'health.degradedOne': '{name} 已降级：{reason}',
  'health.allActive': '所有子系统均已启用。',
  'health.subsystems': '子系统',
  'board.reasonUnknown': 'Harness 未报告该委派当前的状态',
  'board.reasonNoRun': '本会话尚未记录任何编排运行',
  'board.dragHint': '可拖动节点',
  'board.legendEdges': '连线',
  'board.legendStatus': '状态',
  'board.legendNodes': '节点',
  'board.runElapsed': '运行 {time}',
  'board.statReviews': '{count} 个评审',
  'board.statQuestions': '{count} 个提问',
  'board.statFailed': '失败 {count}',
  'board.statCompleted': '已完成 {count}',
  'board.artifactLabel': '产物',
  'board.questionsAnswered': '收到提问 {count}',
  'board.questionsAsked': '提问 {count}',
  'board.rounds': '{count} 轮',
  'board.elapsedSeconds': '{seconds} 秒',
  'board.elapsedMs': '{ms} 毫秒',
  'board.verdict.unknown': '未知',
  'board.verdict.reject': '驳回',
  'board.verdict.approve': '通过',
  'board.reviewEdge': '第 {round} 轮 · {verdict}',
  'board.outputWaiting': '等待所有单元结束',
  'board.waitingFor': '等待 {names}',
  'board.taskPlaceholder': '尚未记录任务',
  'board.edge.output': '产出',
  'board.edge.review': '评审',
  'board.edge.question': '提问',
  'board.edge.dependency': '依赖',
  'board.edge.dispatch': '派发',
  'board.edge.task': '任务',
  'board.status.unknown': '未知',
  'board.status.failed': '失败',
  'board.status.completed': '已完成',
  'board.status.running': '运行中',
  'board.status.notStarted': '未开始',
  'board.status.waiting': '等待中',
  'board.node.output': '最终产出',
  'board.node.session': '原生委派',
  'board.node.unit': '编排单元',
  'board.node.captain': '主控',
  'board.node.task': '任务',
  'command.routing': '正在通过编排器路由：{task}',
  'command.messageFailed': '无法构建路由消息：{message}',
  'command.noAgent': '当前会话没有可用的智能体，无法路由该任务。',
  'command.statusResearchUnconfirmed': '{count} 条未确认',
  'command.statusResearched': '已调研：{count} 条路由',
  'command.statusAssignmentsUnassigned': '{count} 条路由未分配',
  'command.statusAssignmentsUnresolved': '{count} 条未命中',
  'command.statusAssignments': '能力分工：{count} 条',
  'command.status': '模型编排器 —— 模式 {mode} · {models} 个模型 · {capabilities} 项能力 · {inFlight} 个进行中的委派',
  'command.usage': '用法：/model-orchestrator <任务> —— 把一条任务交给编排器路由。\n/model-orchestrator status —— 查看当前路由状态。',
  'command.hintLabel': '输入',
  'command.usageLabel': '用法',
  'command.hint': '[<任务> | status]',
  'command.summary': '把一条任务交给模型编排器路由，而不是自己直接派发子代理',
  'command.title': '斜杠指令',
  'capability.assignHint': '这里决定本次会话「有哪些工作」，至于「谁来做」在下面的「能力分工」里设置 —— 两者是不同的问题，不会互相冲突。',
  'pool.effortManualHint': '该 provider 不提供可选档位，因此这是手动指定的、无法校验的值。它会原样下发；若 provider 不接受，该次委派会以它的报错失败。',
  'pool.effortManual': '手动：{effort}',
  'capability.label.capacity.very_long': '超大规模输入',
  'capability.label.depth.routine': '例行明确的工作',
  'capability.label.depth.difficult': '高难度复合推理',
  'capability.label.throughput.bulk': '高批量例行工作',
  'capability.label.long.context': '超长上下文',
  'capability.label.multimodal.screenshot': '截图与界面解读',
  'capability.label.multimodal.vision': '图像理解',
  'capability.label.writing.translation': '翻译与本地化',
  'capability.label.writing.production': '写作与编辑',
  'capability.label.document.processing': '文档处理',
  'capability.label.web.information': '网络信息检索',
  'capability.label.research.investigation': '调研与论证',
  'capability.label.science.technical': '科学与工程分析',
  'capability.label.reasoning.mathematics': '数学',
  'capability.label.reasoning.general': '通用难题推理',
  'capability.label.data.statistics': '统计与推断',
  'capability.label.data.visualization': '数据可视化',
  'capability.label.data.analysis': '数据分析',
  'capability.label.software.operations': '构建、部署与运维',
  'capability.label.software.testing': '测试与验证',
  'capability.label.software.review': '代码审查与验证',
  'capability.label.software.architecture': '架构与设计',
  'capability.label.software.debugging': '调试与定位',
  'capability.label.software.implementation': '软件实现',
  'pool.researchNote': '公开名称与成本来自「同步」，不是宿主上报的。没有来源的一律留空。',
  'pool.reasoningAutomaticHint': '该 provider 会自动推理但不提供可选档位，因此没有档位可配置。任务需要推理能力时它仍然算满足。',
  'pool.reasoningAutomatic': '自动',
  'pool.costHint': '约为本池最贵路由的 {percent}%',
  'pool.priceUnknown': '无公开价格',
  'pool.columnCost': '成本（$/M tok）',
  'pool.columnPublic': '公开名称',
  'pool.priceLine': '{input} / {output}',
  'pool.researchedUnconfirmed': '公开身份未能确认',
  'pool.syncIdle': '无需操作：{reason}',
  'pool.syncError': '同步失败：{message}',
  'pool.syncDone': '已核对 {stored} 条路由；另有 {unmatched} 条无法确认，保持未确认状态。',
  'pool.syncRunning': '正在核对 {total} 条路由…需要几分钟。',
  'pool.syncAllHint': '重新核对所有路由，包括已经查过的',
  'pool.syncAll': '全部重查',
  'pool.syncHint': '用大模型联网核对模型的公开名称与公开价格。这是本插件唯一会联网的动作，且只在你按下时才会执行。',
  'pool.syncing': '同步中…',
  'pool.sync': '同步',
  'assignment.allResolved': '所有目标都能在当前模型池里命中。',
  'assignment.cannotResolve': '无法命中',
  'assignment.resolvesTo': '当前命中',
  'assignment.clearHint': '清除这条分工；该能力退回按实测能力排序',
  'assignment.clear': '清除',
  'assignment.removeHint': '把 {model} 从这条分工里移除',
  'assignment.pickModelHint': '把实时模型池里的某个模型加到所选能力上。再加一个则会作为优先级更低的备选追加在后面。',
  'assignment.allAssigned': '所有能力都已分工',
  'assignment.count': '已分工 {count} 项',
  'assignment.familyHint': '同时匹配同一模型的后续版本（如 gpt-5.6 → gpt-5.7）。默认关闭：升版本通常是同一个模型，但不总是。',
  'assignment.family': '跟随系列',
  'assignment.unassigned': '{count} 条池内路由未被任何分工提及',
  'assignment.unresolved': '{count} 个目标在当前模型池里匹配不到',
  'assignment.addModel': '添加模型…',
  'assignment.empty': '还没有任何分工。选路由会退回按实测能力排序。',
  'assignment.description': '你的长期分工：哪一类工作交给哪个模型。一条 = 一个能力（或整个能力组）+ 一串按优先级排序的模型。存的是模型身份而不是路由，所以改名、换 provider、升版本都不会让这张表失效；匹配不上的会在下面如实列出，而不是悄悄忽略。',
  'assignment.title': '能力分工',
  'pool.effortIgnored': '已配置的"{effort}"该路由当前已不再提供，已忽略',
  'pool.effortHint': '这条路由派发时使用的推理档位。选"默认"则由模型自行决定。',
  'pool.effortDefaultWith': '默认（{effort}）',
  'pool.effortDefault': '默认',
  'pool.filteredByPreference': '{count} 条被你的路由偏好隐藏',
  'pool.policyFiltered': '仅显示本部署可为子代理选用的 {kept} 条路由；另有 {dropped} 条已注册路由不可选。',
  'board.poolMeter': '当前有 {count} 个模型可用',
  'board.updatedEvery': '每 {seconds} 秒刷新',
  'board.legendSource': '拓扑来自 Harness 会话树',
  'board.legendContinuable': '可继续会话',
  'board.legendIdle': 'Harness 报告该会话已不再活动，因此没有记录它是否成功',
  'board.legendRunning': '节点运行中时，它的连线会持续流动',
  'board.emptyTitle': '尚未发生委派',
  'board.hasChildren': '含下级委派',
  'board.nativeDelegation': '原生委派',
  'board.nativeDelegationHint': '这个子代理由 DSH 原生启动，编排器没有为它分配路由',
  'board.generalWork': '通用工作',
  'board.rootLabel': '主控：本会话',
  'board.statContinuable': '{count} 个可继续',
  'board.statRunningSuffix': ' 运行中',
  'board.activityInactive': '未运行',
  'board.activityRunning': '运行中',
  'board.modeContinuable': '可继续',
  'board.modeOneShot': '一次性',
  'board.statRoots': '{count} 条分支',
  'board.statDelegated': '已委派 {count}',
  'board.mode': '模式 {mode}',
  'board.unavailable': '无法读取委派关系图：{message}',
  'board.truncated': '关系图已截断：节点过多，无法一次性显示。',
  'board.noSession': '打开一个会话即可查看它的委派关系图。',
  'board.empty': '目前还没有任何委派。只有当任务需要当前模型并不擅长的能力时，编排器才会启动子代理。',
  'board.graphTitle': '委派关系图',
  'board.description': '本任务的委派关系，从左到右：任务、负责最终答复的主控、编排器派发的每个单元、Harness 自行启动的原生委派，以及最终产出。连线表示派发、依赖、提问与评审：依赖线最粗，评审线带结论。节点可以拖动，连线有较宽的点击区域，悬停会同时点亮两端节点。',
  'board.title': '模型编排器',
  'board.tab': '编排看板',
  // ---- per-session strip --------------------------------------------------
  'strip.modelCount': '{count} 个模型',

  // ---- tiers --------------------------------------------------------------
  'tier.direct': '直接执行',
  'tier.specialist': '单专家',
  'tier.multiAgent': '多智能体',
  'tier.unknown': '未知',
}

/** Both dictionaries, in the shape `ctx.locale.register` expects. */
export const DICTIONARIES = { zh, en }

/** Languages this plugin ships. The first entry is the harness's default. */
export const LANGUAGES = Object.freeze(['en', 'zh'])

/**
 * Interpolate `{name}` placeholders in one template.
 *
 * The harness's own interpolator is single-pass and leaves an unknown name literal;
 * this mirrors that so a host-side translation and a browser-side one read the same.
 *
 * @param template - the template string.
 * @param params - the values to substitute.
 * @returns the rendered string.
 */
export function interpolate(template, params) {
  const text = String(template ?? '')
  if (params === undefined || params === null) return text
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

/**
 * Look one key up in the dictionary for `language`.
 *
 * The HOST half of the plugin needs this: `/model-orchestrator` replies and the
 * command's own description are rendered by the harness, which does not translate a
 * third-party command's copy for us. The lookup falls back to English — the harness
 * default — and then to the key itself, so a missing translation is a readable
 * identifier rather than a blank.
 *
 * @param language - `'en'` or `'zh'`.
 * @param key - the dictionary key.
 * @param params - optional interpolation values.
 * @returns the rendered string.
 */
export function translate(language, key, params) {
  const dictionary = language === 'zh' ? zh : en
  return interpolate(dictionary[key] ?? en[key] ?? key, params)
}
