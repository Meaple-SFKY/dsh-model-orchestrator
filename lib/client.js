/**
 * dsh-model-orchestrator — Client half.
 *
 * A static client bundle in the harness's own module-loader format. It renders
 * two seats:
 *
 *   - `settings.section`        — the full Orchestrator control page.
 *   - `conversation.view`      — the Orchestrator board, a sibling of Chat
 *                              and Trajectory.
 *
 * The panel cannot enumerate models for itself (the LLM listing surface is
 * host-only), so it reads state from the Host through this plugin's control
 * routes and never guesses.
 *
 * ## Language
 *
 * Every user-visible string is looked up in the plugin's own locale namespace and
 * therefore follows the harness language setting. The dictionaries below are
 * duplicated from `lib/locales.js` because this bundle is self-contained (a
 * static client package is served verbatim and imports nothing); `test/locale`
 * asserts the two copies are identical, so they cannot drift.
 *
 * Strings a MODEL reads — tool descriptions, parameter specs, the routing prompt
 * section, personas — are not here and must not follow the UI language.
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-orchestrator',
  factory: (require) => {
    const React = require('react')

    const ROUTES = {
      state: '/plugins/dsh-model-orchestrator/state',
      configure: '/plugins/dsh-model-orchestrator/configure',
      plan: '/plugins/dsh-model-orchestrator/plan',
      tree: '/plugins/dsh-model-orchestrator/tree',
      sync: '/plugins/dsh-model-orchestrator/sync',
      locale: '/plugins/dsh-model-orchestrator/locale',
    }

    const h = React.createElement

    // ---- locale ------------------------------------------------------------

    /** Dictionary namespace owned by this plugin. */
    const LOCALE_NAMESPACE = 'modelOrchestrator'

    // BEGIN GENERATED DICTIONARIES — kept identical to lib/locales.js by test/locale.test.js
    const en = {
      'doc.title': 'Model Orchestrator',
      'doc.subtitle':
        'Discovers the models this harness actually has and routes each unit of work to the best available one. No model is named anywhere in the selection logic.',
      'doc.loading': 'Loading the live model pool…',
      'doc.refresh': 'Refresh pool',
      'doc.refreshing': 'Re-reading…',
      'health.host': 'host {version}',
      'health.requires': 'requires {range}',
      'health.pool': 'pool {count}',
      'health.optionalAbsent': '{name} absent',
      'health.unknown': 'unknown',
      'health.state': 'State: {message}',
      'mode.title': 'Mode',
      'mode.description':
        'Choose how a model is picked. Auto reads each task and decides by itself. Guided adds the capability areas below as a standing cue: they appear once Guided is chosen, and the live pool still decides which model serves each one.',
      'mode.auto': 'Auto',
      'mode.autoHint': 'Read each task and choose a model for every piece of work automatically.',
      'mode.guided': 'Guided',
      'mode.guidedHint': 'Reveal the capability areas and match models against them.',
      'mode.guidedActive': 'Guided: the areas you set below shape every match.',
      'mode.guidedReveals': 'Capability areas apply in Guided mode — choose Guided to set them.',
      'capability.title': 'Capability areas',
      'capability.selectedCount': '{count} selected',
      'capability.description':
        'These shape matching in Guided mode. They are capability descriptors, never model names: the model behind each one is re-matched from the live pool every run.',
      'capability.filterPlaceholder': 'Filter capabilities…',
      'capability.empty': 'No capability matches that filter.',
      'capability.learned': ' ·new',
      'capability.learnedTitle': 'Learned at runtime for a capability the taxonomy did not have.',
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
      'preview.title': 'Routing preview',
      'preview.description':
        'Describe a task to see which tier and which live model the orchestrator would choose. This spawns nothing.',
      'preview.placeholder':
        'e.g. Research the topic, then analyze the data, then review the report',
      'preview.action': 'Preview',
      'preview.busy': 'Planning…',
      'preview.unitCount': '{count} unit(s)',
      'preview.poolCount': 'pool {count}',
      'preview.noDelegation': 'No delegation needed: this tier runs on the current model.',
      'preview.columnUnit': 'Unit',
      'preview.columnCapability': 'Capability',
      'preview.columnRoute': 'Matched route',
      'preview.columnWhy': 'Why',
      'preview.unrouted': 'unrouted',
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
      'strip.modelCount': '{count} model(s)',
      'tier.direct': 'direct',
      'tier.specialist': 'specialist',
      'tier.multiAgent': 'multi-agent',
      'tier.unknown': 'unknown',
    }

    const zh = {
      'doc.title': '模型编排器',
      'doc.subtitle':
        '自动发现当前 Harness 实际可用的模型，并把每一项工作路由给最合适的模型。选型逻辑中不写死任何模型名称。',
      'doc.loading': '正在读取实时模型池…',
      'doc.refresh': '刷新模型池',
      'doc.refreshing': '重新读取中…',
      'health.host': 'host {version}',
      'health.requires': 'requires {range}',
      'health.pool': '模型池 {count}',
      'health.optionalAbsent': '{name} 未挂载',
      'health.unknown': '未知',
      'health.state': '状态：{message}',
      'mode.title': '模式',
      'mode.description':
        '选择如何挑模型。自动：逐条读懂任务自行决定。引导：把下面的能力领域作为长期提示——选中「引导」后该面板才会展开，具体由哪个模型来做仍由实时模型池决定。',
      'mode.auto': '自动',
      'mode.autoHint': '自动读懂每条任务，并为每一项工作挑好模型。',
      'mode.guided': '引导',
      'mode.guidedHint': '展开能力领域面板，并据此匹配模型。',
      'mode.guidedActive': '引导模式：下面勾选的领域会参与每一次匹配。',
      'mode.guidedReveals': '能力领域只在「引导」模式下生效——选「引导」即可展开设置。',
      'capability.title': '能力领域',
      'capability.selectedCount': '已选 {count} 项',
      'capability.description':
        '这些只影响「引导」模式下的匹配。它们是能力描述符，而不是模型名称：每一项背后的模型都会在每次运行时从实时模型池重新匹配。',
      'capability.filterPlaceholder': '筛选能力…',
      'capability.empty': '没有符合该筛选条件的能力。',
      'capability.learned': ' ·新增',
      'capability.learnedTitle': '运行时为分类体系尚未覆盖的能力自动生成。',
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
      'strip.modelCount': '{count} 个模型',
      'tier.direct': '直接执行',
      'tier.specialist': '单专家',
      'tier.multiAgent': '多智能体',
      'tier.unknown': '未知',
    }
    // END GENERATED DICTIONARIES

    /**
     * Fallback translate used only while the locale service's dictionaries have
     * not reached this outlet yet (registration bumps the revision, so this is a
     * first-paint window, not a permanent state). It reads the same dictionaries
     * the service will hold, so the first paint is already correct.
     */
    function localTranslate(key, params) {
      // ENGLISH first, not Chinese. This runs in the window before the locale seat
      // arrives, when the active language is not yet known — and the harness's own
      // default is English, so preferring `zh` rendered a Chinese first paint for
      // every user regardless of their setting and flashed before the real locale
      // landed.
      const template = en[key] ?? zh[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      )
    }

    // ---- transport ---------------------------------------------------------

    async function requestJson(url, init) {
      const response = await fetch(url, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok) {
        const message = body && body.error ? body.error : `HTTP ${response.status}`
        throw new Error(message)
      }
      return body
    }

    /**
     * Read the full orchestrator state.
     *
     * `force` asks the host to re-discover the model pool first. It is what the panel's
     * Refresh means, and it used to be the one thing it did NOT do: the route has
     * supported `?force=1` all along, and the button only re-read the cached snapshot —
     * so changing a provider's models or the deployment's subagent policy looked like
     * it could not be refreshed at all.
     */
    const readState = (force) =>
      requestJson(force === true ? `${ROUTES.state}?force=1` : ROUTES.state, { method: 'GET' })

    /** Apply a preference patch. */
    const writeConfig = (patch) =>
      requestJson(ROUTES.configure, { method: 'POST', body: JSON.stringify(patch) })

    /** Ask what routing WOULD happen for a task. Read-only; spawns nothing. */
    const planTask = (task) =>
      requestJson(ROUTES.plan, { method: 'POST', body: JSON.stringify({ task }) })

    /**
     * Tell the host which language this page is rendering.
     *
     * The harness resolves the language as "explicit host setting → browser detection →
     * en" and never writes the browser-derived value back, so in the default case the
     * host has no way to know it — and everything the HOST renders (a slash command's
     * palette entry, its replies) stayed English inside a Chinese UI. Deliberately
     * fire-and-forget: a failed report costs nothing, because the host falls back.
     */
    function reportLocale(locale) {
      let active
      try {
        active = locale?.getLocale?.()?.active
      } catch {
        active = undefined
      }
      if (typeof active !== 'string' || active === '') return
      void requestJson(ROUTES.locale, {
        method: 'POST',
        body: JSON.stringify({ language: active }),
      }).catch(() => {})
    }

    /**
     * Read the delegation graph for one session.
     *
     * The topology comes from the harness's own durable session tree, so the board
     * shows the delegations that actually exist rather than a locally mirrored
     * copy of them.
     */
    const readTree = (sessionId) =>
      requestJson(`${ROUTES.tree}?session=${encodeURIComponent(sessionId)}`, { method: 'GET' })

    // ---- shared UI ---------------------------------------------------------

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      between: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      title: { fontSize: '13px', fontWeight: 600, margin: 0 },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', margin: 0 },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '999px',
        padding: '1px 8px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      pillActive: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '7px',
        padding: '5px 10px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      buttonPrimary: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        borderRadius: '7px',
        padding: '5px 10px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      toggle: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '7px',
        padding: '5px 12px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      toggleActive: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
      },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '7px',
        padding: '5px 8px',
        fontSize: '12px',
        minWidth: '180px',
        flex: '1 1 180px',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: {
        textAlign: 'left',
        // A CJK column header is wider than its English counterpart; without
        // this the table wraps a two-character label onto two lines.
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 500,
        padding: '4px 6px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      td: {
        padding: '4px 6px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        verticalAlign: 'top',
        // Short enum cells ("yes"/"no", a tier name) must not wrap: a CJK
        // translation is wider than its English counterpart and would break
        // mid-word in a narrow column.
        whiteSpace: 'nowrap',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', margin: 0 },
      warn: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: '12px', margin: 0 },
      ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: '12px', margin: 0 },
    }

    function Card(props) {
      return h('div', { style: styles.card }, props.children)
    }

    function SectionTitle(props) {
      return h(
        'div',
        { style: styles.between },
        h('p', { style: styles.title }, props.title),
        props.right ?? null,
      )
    }

    /** Render a route as `provider/model`. */
    function routeLabel(route) {
      if (typeof route !== 'string' || route === '') return '—'
      const slash = route.indexOf('/')
      return slash === -1 ? route : `${route.slice(0, slash)}/${route.slice(slash + 1)}`
    }

    /**
     * Localize a model's capability tier.
     *
     * The tier vocabulary lives in the host profile (`deep` / `balanced` / `fast`
     * / `unknown`), so the mapping is a translation, not a re-derivation.
     */
    /** Localized routing-tier name. */
    function tierLabel(tier, t) {
      switch (tier) {
        case 'direct':
          return t('tier.direct')
        case 'specialist':
          return t('tier.specialist')
        case 'multi-agent':
          return t('tier.multiAgent')
        default:
          return tier ?? t('tier.unknown')
      }
    }

    // ---- state -------------------------------------------------------------

    function useOrchestratorState(pollMs, t) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const reload = React.useCallback(async (showBusy, force) => {
        if (showBusy) setBusy(true)
        try {
          const next = await readState(force)
          setState(next)
          setError(null)
        } catch (failure) {
          setError(String(failure.message ?? failure))
        } finally {
          if (showBusy) setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        // A first read, then a slow poll so the panel follows the live pool.
        const tick = async () => {
          try {
            const next = await readState()
            if (alive) {
              setState(next)
              setError(null)
            }
          } catch (failure) {
            if (alive) setError(String(failure.message ?? failure))
          }
        }
        void tick()
        const timer = setInterval(tick, pollMs)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [pollMs])

      return { state, error, busy, reload }
    }

    /**
     * The `/model-orchestrator` command, described in the panel's own language.
     *
     * The harness renders a THIRD-PARTY command's description and input hint verbatim
     * in its command palette — it only translates built-in commands — so the plugin
     * cannot make that listing follow a language change. This card is the plugin's own
     * localized statement of the same thing, and because it renders through the `t`
     * seat it re-renders the moment the language does.
     */
    function CommandCard({ t }) {
      return h(
        Card,
        null,
        h(SectionTitle, { title: t('command.title') }),
        h('p', { style: styles.muted }, t('command.summary')),
        h(
          'div',
          { style: { ...styles.row, marginTop: '8px' } },
          h('span', { style: styles.pill }, `/model-orchestrator`),
          h('span', { style: styles.pill }, t('command.hint')),
        ),
        h(
          'p',
          { style: { ...styles.muted, marginTop: '8px', whiteSpace: 'pre-line' } },
          t('command.usage'),
        ),
      )
    }

    /**
     * What this plugin turned on, and what it could not.
     *
     * A subsystem that failed to register, or a service this deployment does not
     * provide, used to exist only as a log line — so a missing panel, or a Sync button
     * that could never work, looked like a plugin that simply did nothing. This lists
     * them, and says which ones are DEGRADED rather than off, because "partially
     * working, and here is why" is a different answer from "not available".
     */
    function HealthList({ health, t }) {
      if (health === undefined) return null
      const degraded = Array.isArray(health.degraded) ? health.degraded : []
      const disabled = Array.isArray(health.disabled) ? health.disabled : []
      const missing = Array.isArray(health.missingDependencies) ? health.missingDependencies : []
      const problems = [...degraded, ...disabled]
      return h(
        'div',
        { style: { marginTop: '8px' } },
        missing.length === 0
          ? null
          : h('p', { style: styles.muted }, t('health.missingDeps', { count: missing.length })),
        problems.length === 0
          ? h(
              'p',
              { style: styles.muted },
              `${t('health.subsystems')}: ${t('health.allActive')}`,
            )
          : h(
              'div',
              null,
              h('p', { style: styles.muted }, t('health.subsystems')),
              problems.map((entry, index) =>
                h(
                  'p',
                  { key: `${entry.name}-${index}`, style: styles.warn },
                  t(entry.status === 'degraded' ? 'health.degradedOne' : 'health.disabledOne', {
                    name: entry.name,
                    reason: entry.reason ?? t('health.unknown'),
                  }),
                ),
              ),
            ),
      )
    }

    // ---- sections ----------------------------------------------------------

    /**
     * Inject the panel's transition stylesheet once.
     *
     * The reveal is a class rather than an inline style for two reasons inline
     * styles cannot express: the `max-height` bound has to differ between the
     * collapsed and open states *with* a transition between them, and
     * `prefers-reduced-motion` has to be able to switch the motion off. This is
     * additive to the harness's own tokens, not a restyle of its components.
     */
    let panelStylesReady = false
    function ensurePanelStyles() {
      if (panelStylesReady || typeof document === 'undefined') return
      panelStylesReady = true
      const style = document.createElement('style')
      style.setAttribute('data-dshmo-panel', '')
      style.textContent = `
.dshmo-reveal{max-height:0;opacity:0;transform:translateY(-6px);overflow:hidden;
  transition:max-height 340ms cubic-bezier(.2,0,.2,1),opacity 200ms ease,
             transform 300ms cubic-bezier(.2,0,.2,1)}
.dshmo-reveal.is-open{max-height:1600px;opacity:1;transform:none}
.dshmo-reveal-inner{padding-top:10px}
@media (prefers-reduced-motion: reduce){.dshmo-reveal{transition:none}}
`
      document.head.appendChild(style)
    }

    /**
     * Presence with an exit transition.
     *
     * React unmounts a removed element immediately, so nothing can animate OUT
     * unless the element is kept mounted until its transition has finished. This
     * returns `{ mounted, open }`: `mounted` says whether to render at all, and
     * `open` flips one frame later so the browser observes the collapsed state
     * first and therefore runs a transition instead of jumping.
     *
     * The unmount delay is deliberately a little longer than the stylesheet's
     * 340ms transition: waiting exactly as long would occasionally cut the tail of
     * the collapse off on a slow frame.
     *
     * @param visible - whether the content should be present.
     * @returns the render state for the reveal wrapper.
     */
    function useReveal(visible) {
      const [mounted, setMounted] = React.useState(visible === true)
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => {
        if (visible === true) {
          setMounted(true)
          // One frame, not a timer: a timer can fire before the browser has painted
          // the collapsed state, and then the element mounts already open and there
          // is no transition left to run. A frame callback lands after that paint.
          if (typeof requestAnimationFrame === 'function') {
            const frame = requestAnimationFrame(() => setOpen(true))
            return () => cancelAnimationFrame(frame)
          }
          const timer = setTimeout(() => setOpen(true), 16)
          return () => clearTimeout(timer)
        }
        setOpen(false)
        const settle = setTimeout(() => setMounted(false), 360)
        return () => clearTimeout(settle)
      }, [visible])
      return { mounted, open }
    }

    function ModeControl({ state, onApply, t }) {
      const mode = state.mode
      const option = (id, label, hint, expanded) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            style: mode === id ? { ...styles.toggle, ...styles.toggleActive } : styles.toggle,
            title: hint,
            'aria-pressed': mode === id,
            // The Guided button owns the panel below it, so it reports whether
            // that panel is showing.
            ...(expanded === undefined ? {} : { 'aria-expanded': expanded }),
            onClick: () => onApply({ mode: id }),
          },
          label,
        )
      return h(
        Card,
        null,
        h(SectionTitle, { title: t('mode.title') }),
        h('p', { style: styles.muted }, t('mode.description')),
        h(
          'div',
          { style: { ...styles.row, marginTop: '8px' } },
          option('auto', t('mode.auto'), t('mode.autoHint')),
          option('guided', t('mode.guided'), t('mode.guidedHint'), mode === 'guided'),
        ),
        // Say where the capability areas went, instead of leaving their absence
        // to be interpreted as a missing feature.
        h(
          'p',
          { style: { ...styles.muted, marginTop: '6px' } },
          mode === 'guided' ? t('mode.guidedActive') : t('mode.guidedReveals'),
        ),
      )
    }

    function CapabilityPicker({ state, onApply, t }) {
      const [filter, setFilter] = React.useState('')
      const selected = new Set(state.guidedCapabilities ?? [])
      const capabilities = state.capabilities ?? []
      const needle = filter.trim().toLowerCase()
      const visible =
        needle === ''
          ? capabilities
          : capabilities.filter(
              (entry) =>
                entry.id.toLowerCase().includes(needle) ||
                String(entry.label).toLowerCase().includes(needle) ||
                capabilityLabel(entry, t).toLowerCase().includes(needle) ||
                String(entry.group).toLowerCase().includes(needle),
            )

      const toggle = (id) => {
        const next = new Set(selected)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        onApply({ guidedCapabilities: [...next] })
      }

      return h(
        Card,
        null,
        h(SectionTitle, {
          title: t('capability.title'),
          right: h(
            'span',
            { style: styles.pill },
            t('capability.selectedCount', { count: selected.size }),
          ),
        }),
        h('p', { style: styles.muted }, t('capability.description')),
        // Answer the obvious question right where it is asked: these two panels sit
        // next to each other and are about different things.
        h('p', { style: { ...styles.muted, marginTop: '4px' } }, t('capability.assignHint')),
        h('input', {
          style: { ...styles.input, marginTop: '8px', width: '100%' },
          placeholder: t('capability.filterPlaceholder'),
          value: filter,
          onChange: (event) => setFilter(event.target.value),
        }),
        h(
          'div',
          { style: { ...styles.row, marginTop: '8px', maxHeight: '190px', overflowY: 'auto' } },
          visible.map((entry) =>
            h(
              'button',
              {
                key: entry.id,
                type: 'button',
                title: entry.summary ?? entry.id,
                style: selected.has(entry.id)
                  ? { ...styles.pill, ...styles.pillActive, cursor: 'pointer' }
                  : { ...styles.pill, cursor: 'pointer' },
                onClick: () => toggle(entry.id),
              },
              capabilityLabel(entry, t),
              entry.origin !== 'seed'
                ? h('span', { style: styles.mono, title: t('capability.learnedTitle') }, t('capability.learned'))
                : null,
            ),
          ),
          visible.length === 0 ? h('p', { style: styles.muted }, t('capability.empty')) : null,
        ),
      )
    }

    /**
     * The standing division of labour, edited against the live pool.
     *
     * Every control offers what actually exists — capabilities from the vocabulary,
     * models from the live pool — rather than a free-text field. That is not a
     * convenience: identity matching is exact-on-normalised on purpose (a fuzzy
     * rule that caught `Qwen3.8-Max` would also route one model's work to its
     * vision variant), so the way to be right is to pick, not to type.
     *
     * The resolution status is the point of the section. The pool churns, so an
     * entry shows the route it resolves to right now, or names the target it
     * cannot resolve — a table that has stopped matching must say so.
     */
    function AssignmentCard({ state, onApply, t }) {
      const report = state.assignments ?? { entries: [], unresolved: [], unassigned: [] }
      const entries = report.entries ?? []
      const keys = state.assignmentKeys ?? []
      const models = state.pool?.models ?? []
      const [key, setKey] = React.useState('')
      const [model, setModel] = React.useState('')

      const labelFor = (id) => capabilityLabel(keys.find((entry) => entry.key === id) ?? id, t)
      const assigned = new Set(entries.map((entry) => entry.key))
      const available = keys.filter((entry) => entry.kind === 'capability' && !assigned.has(entry.key))
      const active = key === '' ? (available[0]?.key ?? '') : key

      const write = (target, value) => onApply({ capabilityAssignments: { [target]: value } })

      const addModel = (target, next) => {
        if (next === '' || target === '') return
        const entry = entries.find((candidate) => candidate.key === target)
        write(target, { models: [...(entry?.models ?? []), next], family: entry?.family === true })
        setModel('')
      }

      return h(
        Card,
        null,
        h(SectionTitle, {
          title: t('assignment.title'),
          right: h('span', { style: styles.pill }, t('assignment.count', { count: entries.length })),
        }),
        h('p', { style: styles.muted }, t('assignment.description')),

        // Add or extend: one capability, one model at a time.
        h(
          'div',
          { style: { ...styles.row, gap: '6px', marginTop: '8px' } },
          h(
            'select',
            {
              style: { ...styles.input, flex: '1 1 200px', minWidth: '140px' },
              value: active,
              onChange: (event) => setKey(event.target.value),
            },
            available.length === 0
              ? [h('option', { key: '', value: '' }, t('assignment.allAssigned'))]
              : available.map((entry) =>
                  h('option', { key: entry.key, value: entry.key }, `${labelFor(entry.key)} · ${entry.key}`),
                ),
          ),
          h(
            'select',
            {
              style: { ...styles.input, flex: '1 1 200px', minWidth: '140px' },
              value: model,
              title: t('assignment.pickModelHint'),
              onChange: (event) => addModel(active, event.target.value),
            },
            [
              h('option', { key: '', value: '' }, t('assignment.addModel')),
              ...models.map((entry) => h('option', { key: entry.route, value: entry.route }, entry.name ?? entry.route)),
            ],
          ),
        ),

        entries.length === 0
          ? h('p', { style: styles.muted }, t('assignment.empty'))
          : h(
              'div',
              { style: { marginTop: '8px' } },
              entries.map((entry) =>
                h(
                  'div',
                  {
                    key: entry.key,
                    style: { padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' },
                  },
                  h(
                    'div',
                    { style: { ...styles.row, gap: '6px' } },
                    h('span', { style: { fontWeight: 600 } }, labelFor(entry.key)),
                    (entry.models ?? []).map((target) =>
                      h(
                        'button',
                        {
                          key: target,
                          type: 'button',
                          title: t('assignment.removeHint', { model: target }),
                          style: { ...styles.pill, ...styles.pillActive, cursor: 'pointer' },
                          onClick: () =>
                            write(entry.key, {
                              models: entry.models.filter((value) => value !== target),
                              family: entry.family === true,
                            }),
                        },
                        `${target} ×`,
                      ),
                    ),
                    h(
                      'label',
                      {
                        style: { ...styles.row, gap: '4px', cursor: 'pointer' },
                        title: t('assignment.familyHint'),
                      },
                      h('input', {
                        type: 'checkbox',
                        checked: entry.family === true,
                        onChange: (event) =>
                          write(entry.key, { models: entry.models, family: event.target.checked }),
                      }),
                      h('span', { style: styles.muted }, t('assignment.family')),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: { ...styles.pill, cursor: 'pointer' },
                        title: t('assignment.clearHint'),
                        onClick: () => write(entry.key, null),
                      },
                      t('assignment.clear'),
                    ),
                  ),
                  // What this entry means right now.
                  (entry.routes ?? []).length > 0
                    ? h(
                        'div',
                        { style: { ...styles.mono, fontSize: '11px', marginTop: '2px' } },
                        `${t('assignment.resolvesTo')} ${entry.routes.join(', ')}`,
                      )
                    : null,
                  (entry.unresolved ?? []).length > 0
                    ? h(
                        'div',
                        { style: { ...styles.warn, fontSize: '11px', marginTop: '2px' } },
                        `${t('assignment.cannotResolve')} ${entry.unresolved.join(', ')}`,
                      )
                    : null,
                ),
              ),
            ),

        // The two summaries that make drift visible instead of felt.
        h(
          'p',
          {
            style: {
              ...((report.unresolved ?? []).length > 0 ? styles.warn : styles.muted),
              marginTop: '8px',
            },
          },
          (report.unresolved ?? []).length > 0
            ? t('assignment.unresolved', { count: report.unresolved.length })
            : t('assignment.allResolved'),
        ),
        h(
          'p',
          { style: { ...styles.muted, marginTop: '2px' } },
          t('assignment.unassigned', { count: (report.unassigned ?? []).length }),
        ),
      )
    }

    /**
     * The published cost of one route.
     *
     * The bar answers "is this expensive" against the dearest route in the same
     * pool, because an absolute figure means nothing without a scale — and the
     * scale is the choice actually on offer. Absent numbers stay absent: a price no
     * source stated is not shown as zero.
     */
    function ResearchedCost({ researched, dearest, t }) {
      const input = researched?.inputPerMTok
      const output = researched?.outputPerMTok
      if (input === undefined && output === undefined) {
        return h('span', { style: { ...styles.muted, fontSize: '11px' } }, t('pool.priceUnknown'))
      }
      const blended = input === undefined ? output : output === undefined ? input : (input + output) / 2
      const ratio = dearest > 0 ? blended / dearest : 0
      return h(
        'div',
        { title: t('pool.costHint', { percent: Math.round(ratio * 100) }) },
        h(
          'div',
          { style: { ...styles.mono, fontSize: '11px', whiteSpace: 'nowrap' } },
          t('pool.priceLine', {
            input: input === undefined ? '—' : `$${input}`,
            output: output === undefined ? '—' : `$${output}`,
          }),
        ),
        h(
          'div',
          { style: { height: '4px', borderRadius: '2px', background: 'var(--dsw-alias-bg-layer-2)', marginTop: '3px', width: '72px' } },
          h('div', {
            style: {
              height: '100%',
              width: `${Math.max(4, Math.round(ratio * 100))}%`,
              borderRadius: '2px',
              background: 'var(--dsw-alias-brand-primary)',
            },
          }),
        ),
      )
    }

    /**
     * The user-facing name of a capability.
     *
     * Capability labels are MODEL-facing in the taxonomy and deliberately stay
     * English there — they travel into child prompts and delegation labels. The
     * panel is the other audience, so the translation lives in the UI dictionary
     * under `capability.label.<id>` and falls back to the taxonomy's own label when
     * a learned capability has no entry yet. The comparison against the key is the
     * fallback test: `t` has no default-value argument.
     */
    function capabilityLabel(entry, t) {
      const id = typeof entry === 'string' ? entry : entry?.id ?? entry?.key
      if (typeof id !== 'string') return ''
      const key = `capability.label.${id}`
      const text = t(key)
      return text === key ? (typeof entry === 'string' ? id : entry?.label ?? id) : text
    }

    function PoolTable({ pool, onApply, onSync, sync, busy, t }) {
      const models = pool.models ?? []
      const filter = pool.filter
      if (models.length === 0) {
        return h(
          Card,
          null,
          h(SectionTitle, { title: t('pool.title') }),
          h('p', { style: styles.warn }, t('pool.empty')),
          (pool.problems ?? []).map((problem, index) =>
            h('p', { key: index, style: styles.error }, problem),
          ),
        )
      }
      // The relative scale for the cost column. Normalised against the dearest
      // route in THIS pool, because "expensive" only means anything in context.
      const dearest = models.reduce((highest, model) => {
        const entry = model.researched
        if (entry === undefined) return highest
        const input = Number.isFinite(entry.inputPerMTok) ? entry.inputPerMTok : undefined
        const output = Number.isFinite(entry.outputPerMTok) ? entry.outputPerMTok : undefined
        if (input === undefined && output === undefined) return highest
        const blended = input === undefined ? output : output === undefined ? input : (input + output) / 2
        return Math.max(highest, blended)
      }, 0)

      const yesNo = (value) =>
        value === true
          ? t('pool.yes')
          : value === false
            ? t('pool.no')
            : h('span', { style: styles.muted }, t('pool.unknown'))

      return h(
        Card,
        null,
        h(SectionTitle, {
          title: t('pool.title'),
          right: h(
            'span',
            { style: { ...styles.row, gap: '6px' } },
            h(
              'span',
              { style: styles.pill },
              t('pool.summary', { models: pool.size, providers: pool.providers.length }),
            ),
            // Sync is the ONE place this plugin touches the network, so it is a
            // button a person presses rather than anything automatic — and it says
            // what it is doing while it does it.
            h(
              'button',
              {
                type: 'button',
                style: { ...styles.pill, cursor: 'pointer' },
                title: t('pool.syncHint'),
                disabled: sync?.status === 'running' || busy === true,
                onClick: () => onSync(false),
              },
              sync?.status === 'running' ? t('pool.syncing') : t('pool.sync'),
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...styles.pill, cursor: 'pointer' },
                title: t('pool.syncAllHint'),
                disabled: sync?.status === 'running' || busy === true,
                onClick: () => onSync(true),
              },
              t('pool.syncAll'),
            ),
          ),
        }),
        // What the last sweep did, including what it could NOT confirm. A number
        // that came from the web must never read as if the host measured it.
        sync?.status === 'running'
          ? h('p', { style: styles.muted }, t('pool.syncRunning', { total: sync.total ?? 0 }))
          : null,
        sync?.status === 'done'
          ? h(
              'p',
              { style: styles.muted },
              t('pool.syncDone', {
                stored: sync.stored ?? 0,
                unmatched: sync.unmatched ?? 0,
              }),
            )
          : null,
        sync?.status === 'error'
          ? h('p', { style: styles.warn }, t('pool.syncError', { message: sync.error ?? '' }))
          : null,
        sync?.status === 'idle' && sync.reason !== undefined
          ? h('p', { style: styles.muted }, t('pool.syncIdle', { reason: sync.reason }))
          : null,
        sync !== undefined && sync.status === 'unavailable' ? null : null,
        h('p', { style: styles.muted }, t('pool.description')),
        // Say where the public column comes from, so nobody reads a researched
        // price as something the host measured.
        h('p', { style: { ...styles.muted, marginTop: '4px' } }, t('pool.researchNote')),
        // A smaller pool is a decision, not a fault: say where it came from.
        filter?.policy?.source === 'subagent'
          ? h(
              'p',
              { style: { ...styles.muted, marginTop: '4px' } },
              t('pool.policyFiltered', {
                kept: pool.size,
                dropped: (filter.droppedByPolicy ?? []).length,
              }),
            )
          : null,
        (filter?.droppedByPreference ?? []).length > 0
          ? h(
              'p',
              { style: { ...styles.muted, marginTop: '2px' } },
              t('pool.filteredByPreference', { count: filter.droppedByPreference.length }),
            )
          : null,
        h(
          'div',
          {
            style: {
              maxHeight: '260px',
              overflowY: 'auto',
              // A model table is wide and its CJK labels are wider still; let it
              // scroll sideways instead of squeezing a column out of sight.
              overflowX: 'auto',
              marginTop: '8px',
            },
          },
          h(
            'table',
            { style: { ...styles.table, minWidth: '720px' } },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { style: styles.th }, t('pool.columnRoute')),
                h('th', { style: styles.th }, t('pool.columnPublic')),
                h('th', { style: styles.th }, t('pool.columnCost')),
                h('th', { style: styles.th }, t('pool.columnContext')),
                h('th', { style: styles.th }, t('pool.columnImage')),
                h('th', { style: styles.th }, t('pool.columnReasoning')),
              ),
            ),
            h(
              'tbody',
              null,
              models.map((model) =>
                h(
                  'tr',
                  { key: model.route },
                  h(
                    'td',
                    { style: styles.td },
                    h(
                      'div',
                      { style: { ...styles.mono, overflowWrap: 'anywhere' } },
                      routeLabel(model.route),
                    ),
                    model.name !== model.model ? h('div', { style: styles.muted }, model.name) : null,
                  ),
                  // Who this publicly is. Absent until a sync, and explicitly
                  // unconfirmed when the researcher could not tie the route to a
                  // published model — never given a plausible name.
                  h(
                    'td',
                    { style: styles.td },
                    model.researched === undefined
                      ? h('span', { style: styles.muted }, t('pool.noValue'))
                      : model.researched.matched === true
                        ? h(
                            'div',
                            null,
                            h('div', null, model.researched.publicName ?? routeLabel(model.route)),
                            model.researched.vendor === undefined
                              ? null
                              : h('div', { style: { ...styles.muted, fontSize: '11px' } }, model.researched.vendor),
                          )
                        : h(
                            'span',
                            { style: { ...styles.muted, fontSize: '11px' }, title: model.researched.notes ?? '' },
                            t('pool.researchedUnconfirmed'),
                          ),
                  ),
                  // What it costs, as published. The number alone does not answer
                  // "is this expensive", so it is shown against the dearest route
                  // in this pool — the only scale that means anything here.
                  h(
                    'td',
                    { style: styles.td },
                    model.researched === undefined
                      ? h('span', { style: styles.muted }, t('pool.noValue'))
                      : h(ResearchedCost, { researched: model.researched, dearest, t }),
                  ),
                  h(
                    'td',
                    { style: styles.td },
                    model.contextWindow
                      ? t('pool.contextValue', { value: Math.round(model.contextWindow / 1000) })
                      : t('pool.noValue'),
                  ),
                  h('td', { style: styles.td }, yesNo(model.supportsImage)),
                  h(
                    'td',
                    { style: styles.td },
                    (model.reasoningEfforts ?? []).length > 0 ? h(
                          'select',
                          {
                            // The options are the levels this route advertises, from the
                            // host, plus the empty value: "let the model resolve its own".
                            // Narrow on purpose: the shared input style grows to fill the
                            // cell (min 180px), which made this column the widest in the
                            // table for the shortest content in it.
                            style: {
                              ...styles.input,
                              padding: '2px 4px',
                              width: '84px',
                              minWidth: '84px',
                              flex: '0 0 84px',
                            },
                            value: model.reasoningEffort ?? '',
                            title: t('pool.effortHint'),
                            onChange: (event) => {
                              const value = event.target.value
                              // An empty value clears the preference rather than storing a
                              // sentinel, so no effort id can ever collide with "default".
                              onApply({
                                reasoningEffort: { [model.route]: value === '' ? null : value },
                              })
                            },
                          },
                          [
                            h(
                              'option',
                              { key: '', value: '' },
                              model.defaultEffort
                                ? t('pool.effortDefaultWith', { effort: model.defaultEffort })
                                : t('pool.effortDefault'),
                            ),
                            ...(model.reasoningEfforts ?? []).map((effort) =>
                              h('option', { key: effort, value: effort }, effort),
                            ),
                          ],
                        )
                      : model.reasoningMode === 'automatic' && model.reasoningEffort !== undefined
                        ? h(
                            'span',
                            { style: styles.muted, title: t('pool.effortManualHint') },
                            t('pool.effortManual', { effort: model.reasoningEffort }),
                          )
                        : model.reasoningMode === 'automatic'
                        ? h(
                            'span',
                            { style: styles.muted, title: t('pool.reasoningAutomaticHint') },
                            t('pool.reasoningAutomatic'),
                          )
                        : h('span', { style: styles.muted }, t('pool.noValue')),
                    // A stored level the route no longer advertises is ignored at
                    // dispatch; say so rather than showing it as if it applied.
                    model.effortIgnored
                      ? h(
                          'div',
                          { style: { ...styles.muted, fontSize: '11px' } },
                          t('pool.effortIgnored', { effort: model.effortIgnored }),
                        )
                      : null,
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    }

    function PreferencesCard({ state, onApply, t }) {
      const preferences = state.preferences ?? {}
      const number = (key, label, min, max, hint) =>
        h(
          'label',
          { style: { ...styles.row, gap: '6px' } },
          h('span', { style: styles.muted }, label),
          h('input', {
            type: 'number',
            min,
            max,
            value: preferences[key],
            title: hint,
            style: { ...styles.input, minWidth: '64px', flex: '0 0 64px' },
            onChange: (event) => {
              const value = Number(event.target.value)
              if (Number.isFinite(value)) onApply({ [key]: value })
            },
          }),
        )

      const toggle = (key, label, hint) =>
        h(
          'label',
          { style: { ...styles.row, gap: '6px', cursor: 'pointer' }, title: hint },
          h('input', {
            type: 'checkbox',
            checked: preferences[key] !== false,
            onChange: (event) => onApply({ [key]: event.target.checked }),
          }),
          h('span', null, label),
        )

      return h(
        Card,
        null,
        h(SectionTitle, { title: t('preferences.title') }),
        h(
          'div',
          { style: { ...styles.row, gap: '14px', marginTop: '8px' } },
          toggle('preferCheaper', t('preferences.preferCheaper'), t('preferences.preferCheaperHint')),
          toggle('allowMultiAgent', t('preferences.allowMultiAgent'), t('preferences.allowMultiAgentHint')),
          toggle(
            'calibrationEnabled',
            t('preferences.calibrationEnabled'),
            t('preferences.calibrationEnabledHint'),
          ),
          number('maxParallel', t('preferences.maxParallel'), 1, 16, t('preferences.maxParallelHint')),
          number(
            'maxAgentsPerRun',
            t('preferences.maxAgentsPerRun'),
            1,
            64,
            t('preferences.maxAgentsPerRunHint'),
          ),
        ),
      )
    }

    function PlanPreview({ t }) {
      const [task, setTask] = React.useState('')
      const [plan, setPlan] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const runPlan = async () => {
        if (task.trim() === '') return
        setBusy(true)
        try {
          setPlan(await planTask(task))
          setError(null)
        } catch (failure) {
          setError(String(failure.message ?? failure))
          setPlan(null)
        } finally {
          setBusy(false)
        }
      }

      return h(
        Card,
        null,
        h(SectionTitle, { title: t('preview.title') }),
        h('p', { style: styles.muted }, t('preview.description')),
        h(
          'div',
          { style: { ...styles.row, marginTop: '8px' } },
          h('input', {
            style: styles.input,
            placeholder: t('preview.placeholder'),
            value: task,
            onChange: (event) => setTask(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void runPlan()
            },
          }),
          h(
            'button',
            { type: 'button', style: styles.buttonPrimary, disabled: busy, onClick: () => void runPlan() },
            busy ? t('preview.busy') : t('preview.action'),
          ),
        ),
        error ? h('p', { style: { ...styles.error, marginTop: '8px' } }, error) : null,
        plan
          ? h(
              'div',
              { style: { marginTop: '10px' } },
              h(
                'div',
                { style: styles.row },
                h('span', { style: { ...styles.pill, ...styles.pillActive } }, tierLabel(plan.tier, t)),
                h('span', { style: styles.pill }, t('preview.unitCount', { count: (plan.units ?? []).length })),
                h('span', { style: styles.pill }, t('preview.poolCount', { count: plan.pool?.size ?? 0 })),
              ),
              (plan.warnings ?? []).map((warning, index) =>
                h('p', { key: index, style: styles.warn }, warning),
              ),
              (plan.units ?? []).length === 0
                ? h('p', { style: { ...styles.muted, marginTop: '6px' } }, t('preview.noDelegation'))
                : h(
                    'table',
                    { style: { ...styles.table, marginTop: '6px' } },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        h('th', { style: styles.th }, t('preview.columnUnit')),
                        h('th', { style: styles.th }, t('preview.columnCapability')),
                        h('th', { style: styles.th }, t('preview.columnRoute')),
                        h('th', { style: styles.th }, t('preview.columnWhy')),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      (plan.units ?? []).map((unit) =>
                        h(
                          'tr',
                          { key: unit.id },
                          h('td', { style: styles.td }, capabilityLabel(unit.capabilityId ?? unit.id, t)),
                          h('td', { style: { ...styles.td, ...styles.mono } }, unit.capabilityId),
                          h(
                            'td',
                            { style: { ...styles.td, ...styles.mono } },
                            unit.route
                              ? routeLabel(unit.route)
                              : h('span', { style: styles.error }, t('preview.unrouted')),
                          ),
                          h('td', { style: styles.td }, unit.routeReason ?? ''),
                        ),
                      ),
                    ),
                  ),
            )
          : null,
      )
    }

    /**
     * Routing capacity.
     *
     * Deliberately NOT a task list or a progress view. DSH owns task lists, step
     * status, and progress rendering; this panel reports only what the
     * orchestrator itself knows.
     */
    /**
     * The routing-capacity note.
     *
     * The card this used to sit in was removed: its three figures (in-flight,
     * calibrations, capabilities) duplicated the Orchestrator board, which shows
     * them for the session being looked at. This one line is not a figure, it is
     * the boundary statement that answers "does this fight with DSH's own task
     * list" — so it stays, as a plain note rather than a card of its own.
     */
    function CapacityNote({ t }) {
      return h('p', { style: { ...styles.muted, marginTop: '4px' } }, t('capacity.note'))
    }

    function OrchestratorSettingsSection(props) {
      const t = props.t ?? localTranslate
      const { state, error, busy, reload } = useOrchestratorState(10000, t)
      const [actionError, setActionError] = React.useState(null)

      // Both hooks are called before the loading early-return below: a hook after a
      // conditional return changes the hook count between renders, which React
      // rejects outright.
      //
      // The capability areas belong to Guided: in Auto nothing in them is consulted,
      // so a list that changes nothing reads as a broken control. They are revealed
      // and collapsed with a transition instead of appearing instantly.
      const reveal = useReveal(state?.mode === 'guided')
      React.useEffect(() => {
        ensurePanelStyles()
      }, [])

      /**
       * Start a research sweep.
       *
       * Returns as soon as the host has accepted it — the sweep itself takes
       * minutes — and the panel then follows `state.sync` from the ordinary poll.
       */
      const onSync = async (force) => {
        try {
          await requestJson(ROUTES.sync, {
            method: 'POST',
            body: JSON.stringify({ force: force === true }),
          })
          setActionError(null)
          await reload(false)
        } catch (failure) {
          setActionError(String(failure.message ?? failure))
        }
      }

      const apply = async (patch) => {
        try {
          await writeConfig(patch)
          setActionError(null)
          await reload(false)
        } catch (failure) {
          setActionError(String(failure.message ?? failure))
        }
      }

      if (state === null) {
        return h(
          'div',
          { style: styles.root },
          h(
            Card,
            null,
            h(SectionTitle, { title: t('doc.title') }),
            h('p', { style: error ? styles.error : styles.muted }, error ?? t('doc.loading')),
          ),
        )
      }

      const compatibility = state.compatibility ?? {}
      const storageError = state.storage?.lastError

      return h(
        'div',
        { style: styles.root },
        h(
          Card,
          null,
          h(SectionTitle, {
            title: t('doc.title'),
            right: h(
              'div',
              { style: styles.row },
              h('span', { style: styles.pill }, `${state.plugin?.name} ${state.plugin?.version}`),
              h(
                'button',
                { type: 'button', style: styles.button, disabled: busy, onClick: () => void reload(true, true) },
                busy ? t('doc.refreshing') : t('doc.refresh'),
              ),
            ),
          }),
          h('p', { style: styles.muted }, t('doc.subtitle')),
          h(
            'div',
            { style: { ...styles.row, marginTop: '8px' } },
            h(
              'span',
              { style: styles.pill },
              t('health.host', { version: compatibility.runningVersion ?? t('health.unknown') }),
            ),
            h(
              'span',
              { style: styles.pill },
              t('health.requires', { range: compatibility.declaredRange ?? t('pool.noValue') }),
            ),
            h('span', { style: styles.pill }, t('health.pool', { count: state.pool?.size ?? 0 })),
            (compatibility.optionalMissing ?? []).map((name) =>
              h('span', { key: name, style: styles.pill }, t('health.optionalAbsent', { name })),
            ),
          ),
          h(HealthList, { health: state.health, t }),
          error ? h('p', { style: { ...styles.error, marginTop: '8px' } }, error) : null,
          actionError ? h('p', { style: { ...styles.error, marginTop: '8px' } }, actionError) : null,
          storageError
            ? h('p', { style: { ...styles.warn, marginTop: '8px' } }, t('health.state', { message: storageError }))
            : null,
          (state.pool?.problems ?? []).map((problem, index) =>
            h('p', { key: index, style: { ...styles.warn, marginTop: '6px' } }, problem),
          ),
        ),
        h(CommandCard, { t }),
        h(ModeControl, { state, onApply: apply, t }),
        reveal.mounted
          ? h(
              'div',
              {
                className: `dshmo-reveal${reveal.open ? ' is-open' : ''}`,
                'aria-hidden': reveal.open ? undefined : 'true',
              },
              h(
                'div',
                { className: 'dshmo-reveal-inner' },
                h(CapabilityPicker, { state, onApply: apply, t }),
              ),
            )
          : null,
        h(PoolTable, {
          pool: state.pool ?? { models: [], providers: [], problems: [] },
          onApply: apply,
          onSync,
          sync: state.sync,
          busy,
          t,
        }),
        h(AssignmentCard, { state, onApply: apply, t }),
        h(PreferencesCard, { state, onApply: apply, t }),
        h(PlanPreview, { t }),
        h(CapacityNote, { t }),
      )
    }

    // ---- board (a Conversation view, beside Chat and Trajectory) -------------

    /**
     * Presentation layer for the board.
     *
     * Injected once per document and namespaced, so the board can use real
     * selectors (pseudo-element connectors, gradients, hover states) without
     * reaching for a CSS-in-JS dependency. Every colour comes from a
     * `--dsw-alias-*` token, so light and dark themes both work.
     */
    const BOARD_CSS_ID = 'dsh-model-orchestrator-board-css'

    /**
     * Why the board is a centred, width-constrained column.
     *
     * The conversation shell renders the transcript's width handles absolutely,
     * positioned off the CONTENT column (`--dsh-chat-content-width`). A view that
     * paints full-bleed therefore draws its content straight under those handles,
     * which is why the shipped Chat and Trajectory views centre their content
     * too. Matching that constraint keeps this view visually consistent with them
     * and leaves the handles in the margin where they belong — rather than
     * hiding an element the shell owns.
     */
    function ensureBoardStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(BOARD_CSS_ID) !== null) return
      const style = document.createElement('style')
      style.id = BOARD_CSS_ID
      style.textContent = `
.dshmo-board{
  /* Centred, width-constrained column - see the note above this stylesheet.
     64% mirrors the shell adaptive content width and 920px is its ceiling;
     margin-inline auto centres without needing a flex parent. */
  /* Width chain, widest resolution first:
       1. the shell's own content width - follows the dragged width handle,
       2. this plugin's observed copy of that width,
       3. 920px, the shell's own ceiling.
     clamp keeps a floor so an unresolved variable cannot collapse the view. */
  width:clamp(320px, min(var(--dsh-chat-content-width, var(--dshmo-content-width, 920px)), 100%), 100%);
  margin-inline:auto;
  box-sizing:border-box;
  display:flex;flex-direction:column;gap:12px;padding:14px;font-size:13px;color:var(--dsw-alias-label-primary)
}
.dshmo-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px}
.dshmo-cardhead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.dshmo-title{margin:0;font-size:13px;font-weight:600}
.dshmo-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.dshmo-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshmo-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 9px;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:nowrap}
.dshmo-chip b{color:var(--dsw-alias-label-primary);font-weight:600}
.dshmo-chip-live{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dshmo-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 11px;font-size:12px;cursor:pointer}
.dshmo-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshmo-btn:disabled{opacity:.55;cursor:default}

/* ---- graph ----
   Absolutely positioned boxes over one SVG wire layer, both in the same pixel
   space: a dragged box carries its wires because every path is recomputed from
   state, so the board needs neither a graph library nor a DOM measurement pass.
   A box is a fixed size per kind so its label can be clamped inside a known
   height - a long CJK label must never grow the box or spill out of it. */
.dshmo-scroll{overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.dshmo-canvas{position:relative}
.dshmo-wires{position:absolute;left:0;top:0;pointer-events:none}
.dshmo-edge{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:1.6;stroke-linecap:round;transition:opacity .15s ease}
.dshmo-edge-hit{fill:none;stroke:transparent;stroke-width:16;pointer-events:stroke;cursor:pointer}
.dshmo-edge-task{stroke:var(--dsw-alias-label-secondary);stroke-dasharray:2 4}
.dshmo-edge-dispatch{stroke:var(--dsw-alias-border-l2)}
.dshmo-edge-dependency{stroke:var(--dsw-alias-brand-primary);stroke-width:2.8}
.dshmo-edge-question{stroke:var(--dsw-alias-state-warn-primary);stroke-width:1.8;stroke-dasharray:1 5}
.dshmo-edge-review{stroke:var(--dsw-alias-state-success-primary);stroke-width:2;stroke-dasharray:7 3}
.dshmo-edge-output{stroke:var(--dsw-alias-label-secondary);stroke-width:2.2}
.dshmo-edge.is-dim{opacity:.16}
.dshmo-edge.is-hot{stroke-width:3.6}
/* A wire touching a running box flows. The dash pattern is set here rather than
   per kind because only a dashed stroke has anything to animate; the reduced
   motion switch below turns the movement off without hiding the wire. */
.dshmo-edge.is-flow{stroke-dasharray:6 6;animation:dshmo-flow 1s linear infinite}
@keyframes dshmo-flow{to{stroke-dashoffset:-24}}
@media (prefers-reduced-motion: reduce){.dshmo-edge.is-flow{animation:none}}
.dshmo-edge-label{font-size:10px;fill:var(--dsw-alias-label-secondary);pointer-events:none;paint-order:stroke;stroke:var(--dsw-alias-bg-base);stroke-width:3px}
.dshmo-node{position:absolute;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:7px 9px;display:flex;flex-direction:column;gap:4px;overflow:hidden;cursor:grab;touch-action:none;transition:opacity .15s ease,border-color .15s ease,box-shadow .15s ease}
.dshmo-node:active{cursor:grabbing}
.dshmo-node.is-dim{opacity:.22}
.dshmo-node.is-hot{border-color:var(--dsw-alias-brand-primary);box-shadow:0 2px 10px rgba(0,0,0,.10)}
.dshmo-node-kind-task{border-style:dashed}
.dshmo-node-kind-captain{border-left:3px solid var(--dsw-alias-brand-primary)}
.dshmo-node-kind-unit{border-left:3px solid var(--dsw-alias-border-l2)}
.dshmo-node-kind-session{border-left:3px dotted var(--dsw-alias-label-secondary)}
.dshmo-node-kind-output{border-left:3px solid var(--dsw-alias-state-success-primary)}
.dshmo-node-head{display:flex;align-items:center;gap:5px;overflow:hidden}
.dshmo-node-label{font-weight:600;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dshmo-node-meta{display:flex;align-items:center;gap:4px;flex-wrap:wrap;overflow:hidden;max-height:38px}
.dshmo-node-detail{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.35;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dshmo-livebar{height:3px;width:52px;border-radius:3px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);position:relative}
.dshmo-livebar::after{content:"";position:absolute;inset:0;width:35%;border-radius:2px;background:var(--dsw-alias-state-success-primary);animation:dshmo-sweep 1.4s ease-in-out infinite}
@keyframes dshmo-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
.dshmo-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-border-l2)}
.dshmo-dot-running{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 20%,transparent)}
.dshmo-dot-waiting{background:var(--dsw-alias-state-warn-primary)}
.dshmo-dot-notStarted{background:var(--dsw-alias-border-l2)}
.dshmo-dot-completed{background:var(--dsw-alias-state-success-primary)}
.dshmo-dot-failed{background:var(--dsw-alias-state-error-primary)}
/* Unknown is deliberately not a filled dot: it must never read as a live one. */
.dshmo-dot-unknown{background:transparent;border:1px dashed var(--dsw-alias-label-secondary);box-sizing:border-box}
.dshmo-status{font-size:10px;border-radius:999px;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshmo-status-running{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dshmo-status-waiting{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dshmo-status-failed{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dshmo-status-unknown{border-style:dashed}
.dshmo-model{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dshmo-model em{font-style:normal;color:var(--dsw-alias-label-secondary)}
.dshmo-native{font-family:inherit;border-style:dashed;color:var(--dsw-alias-label-secondary)}
.dshmo-badge{font-size:10px;border-radius:999px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshmo-badge-cont{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshmo-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshmo-legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;padding-top:9px;border-top:1px dashed var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshmo-legend-group{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dshmo-legend-group + .dshmo-legend-group{border-left:1px solid var(--dsw-alias-border-l1);padding-left:12px}
.dshmo-legend-title{font-weight:600;color:var(--dsw-alias-label-primary)}
.dshmo-legend-item{display:inline-flex;align-items:center;gap:4px}
.dshmo-legend-wire{overflow:visible}
.dshmo-swatch{width:12px;height:12px;border-radius:3px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);box-sizing:border-box}
.dshmo-swatch-task{border-style:dashed}
.dshmo-swatch-captain{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.dshmo-swatch-unit{background:var(--dsw-alias-bg-layer-1)}
.dshmo-swatch-session{border-style:dotted}
.dshmo-swatch-output{border-color:var(--dsw-alias-state-success-primary)}
.dshmo-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:18px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.dshmo-meter{height:5px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:8px}
.dshmo-meter i{display:block;height:100%;background:var(--dsw-alias-brand-primary)}
`
      document.head.appendChild(style)
    }

    /**
     * The marker the host-side `delegationLabel` puts between a delegation's
     * name and its route. `ctx.subagents.listDescendants` reports a child's
     * `mode` and `label` and nothing about its model, so the label is the only
     * place a delegation's route survives — and a label without this marker
     * belongs to a delegation the orchestrator did not route.
     */
    const ROUTE_MARKER = ' via '

    /**
     * The chip for the route a delegation ran on.
     *
     * A missing route is not missing data: it means DSH itself started the
     * child, so the orchestrator never chose a model for it. Saying that is
     * honest; saying "route not recorded" read as a fault or a lost fact.
     */
    function ModelChip({ route, t }) {
      if (typeof route !== 'string' || route === '') {
        return h(
          'span',
          { className: 'dshmo-model dshmo-native', title: t('board.nativeDelegationHint') },
          t('board.nativeDelegation'),
        )
      }
      const slash = route.indexOf('/')
      if (slash === -1) return h('span', { className: 'dshmo-model' }, route)
      return h(
        'span',
        { className: 'dshmo-model', title: route },
        h('em', null, `${route.slice(0, slash)}/`),
        route.slice(slash + 1),
      )
    }

    /** Canvas geometry, in pixels. Boxes are a fixed size per kind so a label can be
     * clamped inside a known height, and so the wire layer can place a box and its
     * edges from the same numbers without measuring the DOM. The heights are the
     * worst case - two line label, two rows of pills, two line detail - so a long
     * Chinese label is ellipsised by its clamp instead of pushing the box open. */
    const NODE_W = 226
    const NODE_H = { task: 146, captain: 122, unit: 146, session: 146, output: 136 }
    const COLUMN_GAP = 128
    const ROW_GAP = 16
    const LANE_STEP = 9
    const CANVAS_PAD = 14
    const CORRIDOR_TOP = 16

    /** The whole graph vocabulary. The renderer and the legend both read these
     * lists, so a kind cannot exist in one of them and be missing from the other. */
    const NODE_KINDS = ['task', 'captain', 'unit', 'session', 'output']
    const LIFECYCLE = ['waiting', 'notStarted', 'running', 'completed', 'failed', 'unknown']
    const EDGE_KINDS = ['task', 'dispatch', 'dependency', 'question', 'review', 'output']

    /** The edge kinds that mean "this cannot start before that finished". They are
     * what lays the graph out left-to-right. A question is deliberately absent: it
     * is asked of a sibling that has already answered, so it must not push its
     * asker to the right. */
    const LAYERING_EDGES = new Set(['task', 'dispatch', 'dependency', 'review'])

    /** Describe a duration as time. `elapsedMs` is milliseconds, never a turn
     * count, and a board that says "3 turns" for 3 milliseconds is lying. */
    function elapsedLabel(ms, t) {
      if (!Number.isFinite(ms) || ms < 0) return ''
      if (ms < 1000) return t('board.elapsedMs', { ms: Math.round(ms) })
      return t('board.elapsedSeconds', { seconds: (ms / 1000).toFixed(1) })
    }

    /**
     * Split the harness delegation label back into its name and its route.
     *
     * `listDescendants` reports a child's mode and label and nothing about its
     * model, so the label is the only place a route survives — and a label without
     * the marker belongs to a delegation the orchestrator did not route.
     */
    function splitDelegationLabel(label) {
      const raw = typeof label === 'string' ? label : ''
      if (raw === '') return { name: undefined, route: undefined }
      const marker = raw.lastIndexOf(ROUTE_MARKER)
      if (marker === -1) return { name: raw, route: undefined }
      return { name: raw.slice(0, marker), route: raw.slice(marker + ROUTE_MARKER.length) }
    }

    /** The user-facing name of one journal unit. */
    function unitLabel(unit, t) {
      const label = capabilityLabel({ id: unit?.capabilityId, label: unit?.capabilityLabel }, t)
      return label === '' ? t('board.generalWork') : label
    }

    /**
     * A unit's place in the lifecycle.
     *
     * `pending` splits in two on purpose. A unit waiting on a dependency has an
     * answer to "waiting for what" and is named on the board; a unit with nothing
     * to wait for has simply not started. Collapsing those two is how a queued unit
     * came to read as idle work.
     */
    function unitLifecycle(unit) {
      if (unit?.status === 'running') return { status: 'running' }
      if (unit?.status === 'completed') return { status: 'completed' }
      if (unit?.status === 'failed') return { status: 'failed' }
      const waitingOn = Array.isArray(unit?.waitingOn) ? unit.waitingOn : []
      if (waitingOn.length > 0) return { status: 'waiting', waitingOn }
      return { status: 'notStarted' }
    }

    /**
     * A harness session's place in the lifecycle.
     *
     * The durable record says whether a session is RESIDENT, not whether it
     * succeeded: `inactive` means its driver is gone and no outcome was recorded,
     * so calling it completed would invent a result. It is reported as unknown, and
     * `unknown` is drawn as a hollow dotted dot precisely so it is never mistaken
     * for `running`. `board.legendIdle` predates the six-state vocabulary; its text
     * is the honest reading of that activity, so it is the reason shown here.
     */
    function sessionLifecycle(row, t) {
      if (row?.activity === 'running') return { status: 'running' }
      if (row?.activity === 'completed') return { status: 'completed' }
      if (row?.activity === 'failed') return { status: 'failed' }
      if (row?.activity === 'unknown') {
        return { status: 'unknown', reason: row.activityReason ?? t('board.reasonUnknown') }
      }
      return { status: 'unknown', reason: t('board.legendIdle') }
    }

    /**
     * The verdict carried by a review wire.
     *
     * The verdict is recorded on the REVIEW, not on the edge, so it is joined here
     * on the reviewer id. A reviewer that ran several rounds has one record per
     * round and the label shows the latest, because that is the judgement the
     * captain acted on. A verdict that could not be read renders as `unknown`
     * rather than as nothing: a missing label would read as "reviewed and fine",
     * which is exactly the lie the journal refuses to tell.
     */
    function reviewLabel(run, reviewer, t) {
      const records = (run?.reviews ?? []).filter((review) => review.reviewer === reviewer)
      if (records.length === 0) return undefined
      let latest = records[0]
      for (const record of records) {
        if ((record.round ?? 0) >= (latest.round ?? 0)) latest = record
      }
      const verdict = latest.verdict === 'approve' || latest.verdict === 'reject' ? latest.verdict : 'unknown'
      return t('board.reviewEdge', { round: latest.round ?? 1, verdict: t(`board.verdict.${verdict}`) })
    }

    /**
     * Join the harness tree and the run journal into one graph.
     *
     * Neither source is enough alone. The tree knows every durable child session
     * but nothing about why one unit waited for another; the journal knows the
     * dependency, question and review edges but only the sessions its own units ran
     * in. They are joined on `childId`, and a harness session no unit claims stays
     * a node of its own — that is what keeps a native delegation on the board
     * instead of letting it vanish because the orchestrator did not route it.
     */
    function buildGraph(tree, t) {
      const runs = tree?.journal?.runs ?? []
      const rows = tree?.rows ?? []
      const rootSession = typeof tree?.root === 'string' ? tree.root : undefined
      // The run THIS board is about: the newest one the root session itself started.
      // `view` returns runs in the order they began, and a unit that orchestrates its
      // own sub-run begins AFTER the run it belongs to — so taking the newest entry
      // outright would show a nested run's units and none of the outer graph. The
      // nested run is still represented, through its spawning unit and the harness
      // session that unit dispatched.
      const own = runs.filter((entry) => entry.sessionId !== undefined && entry.sessionId === rootSession)
      const run = own.length > 0 ? own[own.length - 1] : runs.length === 0 ? undefined : runs[runs.length - 1]
      const nodes = []
      const byId = new Map()
      const graphIdOfSession = new Map()
      if (rootSession !== undefined) graphIdOfSession.set(rootSession, 'captain')

      const add = (node) => {
        const record = { ...node, order: nodes.length }
        nodes.push(record)
        byId.set(record.id, record)
        return record
      }

      const taskText =
        run === undefined || typeof run.task !== 'string' || run.task.trim() === ''
          ? undefined
          : run.task.trim()
      const runStatus =
        run === undefined
          ? 'unknown'
          : run.status === 'running'
            ? 'running'
            : run.status === 'aborted'
              ? 'failed'
              : 'completed'
      // Without the run record the task's own outcome is not knowable — but a board
      // that is showing delegations must not call that task "not started", which is
      // what it did after every restart, since the run journal is in-memory.
      const taskStatus =
        runStatus === 'unknown' ? (rows.length > 0 ? 'unknown' : 'notStarted') : runStatus
      add({
        id: 'task',
        kind: 'task',
        label: taskText,
        tier: run?.tier,
        status: taskStatus,
        reason:
          runStatus === 'unknown' && rows.length > 0
            ? t('board.reasonNoRun')
            : run?.error,
      })
      // The captain is the session this board is rendering, so it is alive by
      // definition. Deriving its state from the run record made it read as "unknown"
      // after a restart — the one thing a viewer can rule out by looking at the page
      // they are on.
      add({
        id: 'captain',
        kind: 'captain',
        sessionId: rootSession,
        status: 'running',
      })

      const unitRows = new Map()
      for (const row of rows) unitRows.set(row.id, row)

      const unitNodes = new Map()
      for (const unit of run?.units ?? []) {
        const row = unit?.childId === undefined ? undefined : unitRows.get(unit.childId)
        const life = unitLifecycle(unit)
        const node = add({
          id: `unit:${unit.id}`,
          kind: 'unit',
          unit,
          sessionId: unit.childId,
          mode: row?.mode,
          route: typeof unit.route === 'string' && unit.route !== '' ? unit.route : undefined,
          rounds: unit.rounds ?? 0,
          elapsedMs: unit.elapsedMs,
          asked: (unit.questionsAsked ?? []).length,
          answered: (unit.questionsAnswered ?? []).length,
          artifactPath: unit.artifact?.path,
          summary: unit.summary,
          error: unit.error,
          stopReason: unit.stopReason,
          routeReason: unit.routeReason,
          decidedBy: unit.decidedBy,
          hasChildren: row?.hasChildren === true,
          status: life.status,
        })
        node.waitingOn = life.waitingOn ?? []
        unitNodes.set(unit.id, node)
        if (row !== undefined) graphIdOfSession.set(row.id, node.id)
      }

      for (const row of rows) {
        // A row its own unit already claims is drawn as that unit, not twice.
        if (graphIdOfSession.has(row.id)) continue
        const life = sessionLifecycle(row, t)
        add({
          id: `session:${row.id}`,
          kind: 'session',
          sessionId: row.id,
          label: row.label,
          mode: row.mode,
          hasChildren: row.hasChildren === true,
          ordinal: row.ordinal,
          status: life.status,
          reason: life.reason,
        })
        graphIdOfSession.set(row.id, `session:${row.id}`)
      }

      const unitList = run?.units ?? []
      const unfinished = unitList.some((unit) => unit.status === 'pending' || unit.status === 'running')
      let outputStatus = 'unknown'
      let outputReason = t('board.reasonNoRun')
      let outputSummary
      if (run !== undefined) {
        // The output must not look like it produced anything while an input is
        // still moving, and it says so instead of showing an empty summary.
        if (unfinished || run.output?.status === 'pending') {
          outputStatus = 'waiting'
          outputReason = t('board.outputWaiting')
        } else if (run.output?.status === 'done') {
          // A run that aborted can still have written an output record when its last
          // unit settled. Calling that completed would claim a final answer the run
          // never produced, so it is reported as failed with the run's own error.
          if (run.status === 'aborted') {
            outputStatus = 'failed'
            outputReason = run.error ?? t('board.reasonUnknown')
          } else {
            outputStatus = 'completed'
            outputSummary = run.output?.summary
          }
        } else {
          outputReason = t('board.reasonUnknown')
        }
      }
      add({ id: 'output', kind: 'output', status: outputStatus, reason: outputReason, summary: outputSummary })

      const edges = []
      const seen = new Set()
      const connect = (kind, from, to, extra) => {
        if (!byId.has(from) || !byId.has(to)) return
        const id = `${kind}:${from}->${to}`
        if (seen.has(id)) return
        seen.add(id)
        edges.push({ id, kind, from, to, ...(extra ?? {}) })
      }

      connect('task', 'task', 'captain')
      for (const unit of unitList) {
        const node = unitNodes.get(unit.id)
        if (node === undefined) continue
        if ((unit.dependsOn ?? []).length === 0) connect('task', 'task', node.id)
        connect('dispatch', 'captain', node.id)
      }
      // Every harness parent-to-child pair is a dispatch, so a native delegation
      // hangs off the parent that actually started it rather than off the root.
      const walkHarness = (children, parentSession) => {
        for (const child of children ?? []) {
          const from = parentSession === undefined ? 'captain' : graphIdOfSession.get(parentSession) ?? 'captain'
          const to = graphIdOfSession.get(child.id) ?? `session:${child.id}`
          connect('dispatch', from, to)
          walkHarness(child.children, child.id)
        }
      }
      walkHarness(tree?.nodes ?? [], rootSession)

      for (const edge of run?.edges ?? []) {
        // The journal's own `task` and `output` edges are ignored: the board
        // derives both from the rule above, so a run whose edges were recorded at
        // a different moment cannot place the task or the output anywhere else.
        if (edge.kind !== 'dependency' && edge.kind !== 'review' && edge.kind !== 'question') continue
        const from = unitNodes.get(edge.from)
        const to = unitNodes.get(edge.to)
        if (from === undefined || to === undefined) continue
        connect(edge.kind, from.id, to.id, edge.kind === 'review' ? { label: reviewLabel(run, edge.from, t) } : undefined)
      }
      // The output is fed by what settled. The captain's own wire is drawn only when
      // nothing else feeds it: a direct captain-to-output wire spans the whole graph,
      // and for two boxes that are alone in their columns it climbed to the corridor
      // above every box and came back down — which reads as a detour rather than as a
      // connection. The captain already reaches the output through everything it
      // dispatched, and with no run recorded the settled delegations feed it instead.
      const outputFeeders = []
      for (const unit of unitList) {
        const node = unitNodes.get(unit.id)
        if (node !== undefined && unit.status === 'completed') outputFeeders.push(node.id)
      }
      if (outputFeeders.length === 0) {
        for (const node of nodes) {
          if (node.kind === 'session' && node.status === 'completed') outputFeeders.push(node.id)
        }
      }
      if (outputFeeders.length === 0) outputFeeders.push('captain')
      for (const feeder of outputFeeders) connect('output', feeder, 'output')

      for (const node of nodes) {
        if (node.kind !== 'unit') continue
        // Name who a unit is waiting for: "waiting" without a name is not an answer.
        node.waitingNames = (node.waitingOn ?? []).map((id) => {
          const other = unitNodes.get(id)
          return other === undefined ? String(id) : unitLabel(other.unit, t)
        })
      }
      for (const edge of edges) {
        if (edge.kind !== 'dispatch') continue
        const parent = byId.get(edge.from)
        if (parent !== undefined) parent.dispatches = (parent.dispatches ?? 0) + 1
      }

      const stats = {
        delegated: 0,
        running: 0,
        completed: 0,
        failed: 0,
        waiting: 0,
        notStarted: 0,
        unknown: 0,
        continuable: 0,
        questions: run?.counts?.questions ?? 0,
        reviews: run?.counts?.reviews ?? 0,
        elapsedMs: undefined,
      }
      const running = new Set()
      for (const node of nodes) {
        if (node.status === 'running') running.add(node.id)
        if (node.kind !== 'unit' && node.kind !== 'session') continue
        stats.delegated += 1
        if (node.status === 'running') stats.running += 1
        else if (node.status === 'completed') stats.completed += 1
        else if (node.status === 'failed') stats.failed += 1
        else if (node.status === 'waiting') stats.waiting += 1
        else if (node.status === 'notStarted') stats.notStarted += 1
        else stats.unknown += 1
        if (node.mode === 'continuable') stats.continuable += 1
      }
      if (run !== undefined) {
        stats.elapsedMs =
          run.elapsedMs !== undefined
            ? run.elapsedMs
            : run.status === 'running' && Number.isFinite(run.startedAt)
              ? Date.now() - run.startedAt
              : undefined
      }

      return { run, nodes, edges, byId, stats, running }
    }

    /**
     * Columns, as the longest path from the task.
     *
     * A dependency and a review both mean "this cannot start before that finished",
     * so both feed the longest path; dispatch is structural and is what gives a
     * routed unit and a native delegation their column (which is why a unit with no
     * dependency still sits right of the captain that dispatched it). A question is
     * deliberately not layering: it is asked of a sibling that already answered, and
     * counting it would push the asker rightwards for no reason.
     */
    function layerColumns(nodes, edges) {
      const depth = new Map(nodes.map((node) => [node.id, 0]))
      const prerequisites = new Map(nodes.map((node) => [node.id, []]))
      const dependents = new Map(nodes.map((node) => [node.id, []]))
      for (const edge of edges) {
        if (!LAYERING_EDGES.has(edge.kind)) continue
        // A review is stored from the REVIEWER to the unit it reviewed, which is the
        // reverse of the order they run in: the reviewed unit finishes first.
        // Following the stored direction here would turn a review pair into a cycle
        // and feed the layout its own output.
        const before = edge.kind === 'review' ? edge.to : edge.from
        const after = edge.kind === 'review' ? edge.from : edge.to
        if (before === after || !depth.has(before) || !depth.has(after)) continue
        prerequisites.get(after).push(before)
        dependents.get(before).push(after)
      }

      // Longest path in topological order. A fixed-point relaxation would do the
      // same on a DAG, but a malformed run is not one — mutual reviews are enough —
      // and a relaxation that keeps finding a cycle pushes a node one column further
      // right on every pass until the canvas is thousands of pixels wide.
      const remaining = new Map()
      const ready = []
      for (const node of nodes) {
        const count = prerequisites.get(node.id).length
        remaining.set(node.id, count)
        if (count === 0) ready.push(node.id)
      }
      while (ready.length > 0) {
        const id = ready.shift()
        for (const after of dependents.get(id)) {
          const next = (depth.get(id) ?? 0) + 1
          if (next > (depth.get(after) ?? 0)) depth.set(after, next)
          const left = remaining.get(after) - 1
          remaining.set(after, left)
          if (left === 0) ready.push(after)
        }
      }

      // Whatever never reached in-degree zero is in a cycle, or downstream of one.
      // It gets ONE bounded pass from the depths its prerequisites already have:
      // being a column off on input that is already broken beats iterating on it.
      const stuck = nodes.filter((node) => remaining.get(node.id) > 0)
      for (const node of stuck) {
        for (const before of prerequisites.get(node.id)) {
          const next = (depth.get(before) ?? 0) + 1
          if (next > (depth.get(node.id) ?? 0)) depth.set(node.id, next)
        }
      }

      let deepest = 0
      for (const node of nodes) {
        if (node.kind === 'output') continue
        deepest = Math.max(deepest, depth.get(node.id) ?? 0)
      }
      // The output is rightmost by definition: it is what everything feeds.
      depth.set('output', deepest + 1)
      return depth
    }

    /** One lane index, centred on its group so a fan leaves symmetrically. */
    function laneIndex(group, edge) {
      return group.indexOf(edge) - (group.length - 1) / 2
    }

    /**
     * Fan wires apart.
     *
     * Wires leaving one box would otherwise be drawn on top of each other. Each is
     * given a lane centred on its group, and the lane offsets a wire's CONTROL
     * points only: moving a control point bends the curve without moving its
     * endpoint, which is what keeps a fan anchored to the box it came from. Applying
     * the lane to the ENDPOINT instead is how a run with many units pushed the outer
     * wires of its fan clear off the boxes they belong to.
     */
    function assignLanes(edges) {
      const bySource = new Map()
      const byTarget = new Map()
      for (const edge of edges) {
        if (!bySource.has(edge.from)) bySource.set(edge.from, [])
        bySource.get(edge.from).push(edge)
        if (!byTarget.has(edge.to)) byTarget.set(edge.to, [])
        byTarget.get(edge.to).push(edge)
      }
      const lanes = new Map()
      let widest = 0
      for (const edge of edges) {
        const from = laneIndex(bySource.get(edge.from), edge)
        const to = laneIndex(byTarget.get(edge.to), edge)
        lanes.set(edge.id, { from, to })
        widest = Math.max(widest, Math.abs(from), Math.abs(to))
      }
      return { lanes, widest }
    }

    /**
     * One wire.
     *
     * A wire between neighbouring columns is a single cubic whose two control
     * points sit inside that gap. Its x is monotonic from the source's right edge
     * to the target's left edge, so it can only ever travel through the empty gap:
     * it cannot enter a box, dragged or not.
     *
     * A wire that skips a column, or that points back at an earlier one (a review
     * is drawn reviewer-to-reviewed), cannot be drawn that way — it would have to
     * cross a whole column at some y, and no y is free of boxes. Those are routed
     * over the graph instead: out into the gap, up to a corridor above every box,
     * across, and down into the target. The corridor is the one horizontal line
     * guaranteed to be clear, and the canvas reserves room for it.
     */
    function edgePath(from, to, laneFrom, laneTo) {
      // Both anchors are ON the box, always. The fan's spread is expressed by bending
      // each wire away from its anchor, never by moving the anchor: an anchor that
      // leaves the box is a wire that starts in mid-air, which is what a run with many
      // units looked like — the outer wires of the fan hung above and below the boxes
      // they were supposed to come from.
      const x1 = from.x + from.w
      const y1 = from.y + from.h / 2
      const x2 = to.x
      const y2 = to.y + to.h / 2
      const span = x2 - x1
      if (span > 24 && span <= NODE_W + COLUMN_GAP + 4) {
        const reach = Math.max(2, Math.min(COLUMN_GAP * 0.5, span * 0.5))
        const c1x = x1 + reach
        const c1y = y1 + laneFrom * LANE_STEP
        const c2x = x2 - reach
        const c2y = y2 + laneTo * LANE_STEP
        return {
          d: `M ${x1} ${y1} C ${c1x} ${c1y} ${c2x} ${c2y} ${x2} ${y2}`,
          // The midpoint of a cubic is (P0 + 3P1 + 3P2 + P3) / 8, and it follows the
          // bend now that the bend carries the lane.
          labelAt: { x: (x1 + 3 * c1x + 3 * c2x + x2) / 8, y: (y1 + 3 * c1y + 3 * c2y + y2) / 8 },
        }
      }
      const channel = x1 + COLUMN_GAP * 0.5 + laneFrom * 2
      const landing = x2 - COLUMN_GAP * 0.5 + laneTo * 2
      const corridor = CORRIDOR_TOP + Math.abs(laneTo) * LANE_STEP
      const knee = 14
      const laneOut = y1 + laneFrom * LANE_STEP
      const laneIn = y2 + laneTo * LANE_STEP
      return {
        d:
          `M ${x1} ${y1} C ${x1 + knee} ${laneOut} ${channel - knee} ${laneOut} ${channel} ${laneOut}` +
          ` C ${channel} ${laneOut} ${channel} ${corridor} ${channel} ${corridor}` +
          ` L ${landing} ${corridor}` +
          ` C ${landing} ${corridor} ${landing} ${laneIn} ${landing} ${laneIn}` +
          ` C ${landing} ${laneIn} ${x2 - knee} ${laneIn} ${x2} ${y2}`,
        labelAt: { x: (channel + landing) / 2, y: corridor - 4 },
      }
    }

    /**
     * Place every box and route every wire.
     *
     * Board coordinates are pixels in one canvas shared by the absolutely
     * positioned boxes and the SVG wire layer, which is why dragging needs no
     * measurement: a position is state, and both the box and its wires are drawn
     * from it.
     */
    function layoutGraph(graph, offsets) {
      const depth = layerColumns(graph.nodes, graph.edges)
      const columns = new Map()
      for (const node of graph.nodes) {
        const column = depth.get(node.id) ?? 0
        if (!columns.has(column)) columns.set(column, [])
        columns.get(column).push(node)
      }

      let tallest = 0
      const columnHeights = new Map()
      for (const [column, bucket] of columns) {
        // Within a column the order is the order the graph was assembled in, sorted
        // by kind, which reads top-to-bottom as task, captain, routed units, native
        // sessions.
        bucket.sort(
          (left, right) =>
            NODE_KINDS.indexOf(left.kind) - NODE_KINDS.indexOf(right.kind) || left.order - right.order,
        )
        const height = bucket.reduce((total, node) => total + NODE_H[node.kind] + ROW_GAP, 0) - ROW_GAP
        columnHeights.set(column, height)
        tallest = Math.max(tallest, height)
      }

      const { lanes, widest } = assignLanes(graph.edges)
      // Column depth is what decides the route, and dragging a box does not change
      // it — so the corridor room reserved here stays correct while the graph is
      // rearranged by hand. Any edge that does not join neighbouring columns needs
      // the corridor: one that skips a column, one between two boxes of the same
      // column, and one that points backwards.
      const detours = graph.edges.some(
        (edge) => (depth.get(edge.to) ?? 0) - (depth.get(edge.from) ?? 0) !== 1,
      )
      // A corridor wire runs above every box, so the canvas reserves the room its
      // widest fan needs instead of letting it overlap the top row.
      const topPad = detours ? CORRIDOR_TOP + widest * LANE_STEP + 12 : CANVAS_PAD

      const placed = new Map()
      for (const [column, bucket] of columns) {
        const x = CANVAS_PAD + column * (NODE_W + COLUMN_GAP)
        let y = topPad + Math.max(0, Math.round((tallest - columnHeights.get(column)) / 2))
        for (const node of bucket) {
          const offset = offsets[node.id] ?? { dx: 0, dy: 0 }
          const boxHeight = NODE_H[node.kind]
          // Clamped at the origin so a box dragged past the edge cannot disappear
          // into a region the scroll container cannot reach.
          placed.set(node.id, {
            node,
            x: Math.max(0, x + offset.dx),
            y: Math.max(0, y + offset.dy),
            w: NODE_W,
            h: boxHeight,
          })
          y += boxHeight + ROW_GAP
        }
      }

      let maxX = 0
      let maxY = 0
      for (const box of placed.values()) {
        maxX = Math.max(maxX, box.x + box.w)
        maxY = Math.max(maxY, box.y + box.h)
      }

      const links = []
      for (const edge of graph.edges) {
        const from = placed.get(edge.from)
        const to = placed.get(edge.to)
        if (from === undefined || to === undefined) continue
        const lane = lanes.get(edge.id) ?? { from: 0, to: 0 }
        const path = edgePath(from, to, lane.from, lane.to)
        links.push({ edge, d: path.d, labelAt: path.labelAt, label: edge.label })
      }

      return {
        nodes: [...placed.values()],
        links,
        width: Math.max(NODE_W + CANVAS_PAD * 2, maxX + CANVAS_PAD),
        height: Math.max(120, maxY + CANVAS_PAD),
      }
    }

    /** The class list one wire is drawn with, from its kind and its live state. */
    function edgeClass(edge, dim, flowing, hot) {
      return `dshmo-edge dshmo-edge-${edge.kind}${dim ? ' is-dim' : ''}${flowing ? ' is-flow' : ''}${hot ? ' is-hot' : ''}`
    }

    /**
     * What one hover lights up.
     *
     * Hovering a box keeps it and its wires; hovering a wire keeps it and both of
     * its endpoints. Everything else dims — the only way to follow one path through
     * a graph where a box can be the source of six wires.
     */
    function relatedTo(hover, graph) {
      const nodes = new Set()
      const edges = new Set()
      if (hover === null) return { nodes, edges }
      if (hover.kind === 'node') {
        nodes.add(hover.id)
        for (const edge of graph.edges) {
          if (edge.from !== hover.id && edge.to !== hover.id) continue
          edges.add(edge.id)
          nodes.add(edge.from)
          nodes.add(edge.to)
        }
        return { nodes, edges }
      }
      for (const edge of graph.edges) {
        if (edge.id !== hover.id) continue
        edges.add(edge.id)
        nodes.add(edge.from)
        nodes.add(edge.to)
      }
      return { nodes, edges }
    }

    /** The primary line of a node: what it is called on the board. */
    function nodePrimary(node, t) {
      if (node.kind === 'task') return node.label ?? t('board.taskPlaceholder')
      if (node.kind === 'captain') return t('board.rootLabel')
      if (node.kind === 'output') return t('board.node.output')
      if (node.kind === 'session') {
        const parts = splitDelegationLabel(node.label)
        return parts.name ?? t('board.generalWork')
      }
      return unitLabel(node.unit, t)
    }

    /** The line under a node's pills: what this node has to say for itself. */
    function nodeDetail(node, t) {
      if (node.kind === 'output') {
        if (node.summary !== undefined && node.status === 'completed') return node.summary
        return node.status === 'waiting' ? t('board.outputWaiting') : node.reason
      }
      if (node.status === 'waiting' && (node.waitingNames ?? []).length > 0) {
        return t('board.waitingFor', { names: node.waitingNames.join(', ') })
      }
      if (node.error !== undefined) return node.error
      if (node.stopReason !== undefined) return node.stopReason
      if (node.summary !== undefined) return node.summary
      return node.reason
    }

    /** A path short enough for a badge; the full path stays in the title. */
    function shortPath(path) {
      const text = String(path)
      return text.length <= 26 ? text : `…${text.slice(text.length - 25)}`
    }

    /**
     * The pills under a node's name: the facts a reader compares between nodes.
     *
     * Long values go into `title` rather than into the box, and the box clips
     * whatever still does not fit — a CJK label must never grow it or spill out.
     */
    function nodeMeta(node, t) {
      const pills = [h('span', { key: 'kind', className: 'dshmo-badge' }, t(`board.node.${node.kind}`))]
      if (node.mode !== undefined) {
        const continuable = node.mode === 'continuable'
        pills.push(
          h(
            'span',
            {
              key: 'mode',
              className: `dshmo-badge${continuable ? ' dshmo-badge-cont' : ''}`,
              title: continuable ? t('board.legendContinuable') : undefined,
            },
            continuable ? t('board.modeContinuable') : t('board.modeOneShot'),
          ),
        )
      }
      if (node.kind === 'session') {
        pills.push(
          h(
            'span',
            { key: 'native', className: 'dshmo-badge dshmo-native', title: t('board.nativeDelegationHint') },
            t('board.nativeDelegation'),
          ),
        )
      }
      if (node.route !== undefined) pills.push(h(ModelChip, { key: 'route', route: node.route, t }))
      if (node.rounds > 0) {
        pills.push(h('span', { key: 'rounds', className: 'dshmo-badge' }, t('board.rounds', { count: node.rounds })))
      }
      if (node.elapsedMs !== undefined) {
        pills.push(h('span', { key: 'elapsed', className: 'dshmo-badge' }, elapsedLabel(node.elapsedMs, t)))
      }
      if (node.asked > 0) {
        pills.push(h('span', { key: 'asked', className: 'dshmo-badge' }, t('board.questionsAsked', { count: node.asked })))
      }
      if (node.answered > 0) {
        pills.push(
          h('span', { key: 'answered', className: 'dshmo-badge' }, t('board.questionsAnswered', { count: node.answered })),
        )
      }
      if (node.artifactPath !== undefined) {
        pills.push(
          h(
            'span',
            { key: 'artifact', className: 'dshmo-id', title: `${t('board.artifactLabel')}: ${node.artifactPath}` },
            shortPath(node.artifactPath),
          ),
        )
      }
      if (node.dispatches > 0) {
        pills.push(h('span', { key: 'children', className: 'dshmo-badge', title: t('board.hasChildren') }, `+${node.dispatches}`))
      }
      return h('div', { key: 'meta', className: 'dshmo-node-meta' }, pills)
    }

    /**
     * One box, draggable, in the canvas coordinate space.
     *
     * Pointer capture is what makes a drag survive the pointer leaving the box: the
     * moves keep arriving at the element that captured them, so no document-level
     * listener and no cleanup on unmount is needed.
     */
    function GraphNode(props) {
      const { node, t, x, y, w, h: boxHeight, dim, hot, onHover, onDragStart, onDragMove, onDragEnd } = props
      const primary = nodePrimary(node, t)
      const detail = nodeDetail(node, t)
      const title = [primary, node.routeReason, detail]
        .filter((part) => typeof part === 'string' && part !== '')
        .join(' — ')
      const statusTitle =
        node.status === 'running'
          ? t('board.activityRunning')
          : node.status === 'unknown'
            ? node.reason ?? t('board.activityInactive')
            : undefined
      const body = [
        h(
          'div',
          { key: 'head', className: 'dshmo-node-head' },
          h('span', { className: `dshmo-dot dshmo-dot-${node.status}`, title: statusTitle }),
          h('span', { className: `dshmo-status dshmo-status-${node.status}` }, t(`board.status.${node.status}`)),
          node.status === 'running' ? h('span', { key: 'live', className: 'dshmo-livebar' }) : null,
        ),
        h(
          'div',
          {
            key: 'label',
            className: 'dshmo-node-label',
            title: primary,
          },
          primary,
        ),
        nodeMeta(node, t),
        detail === undefined ? null : h('div', { key: 'detail', className: 'dshmo-node-detail', title: detail }, detail),
      ]
      return h(
        'div',
        {
          className: `dshmo-node dshmo-node-kind-${node.kind}${dim ? ' is-dim' : ''}${hot ? ' is-hot' : ''}`,
          style: { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${boxHeight}px` },
          title,
          onPointerDown: (event) => onDragStart(node.id, event),
          onPointerMove: onDragMove,
          onPointerUp: onDragEnd,
          onPointerCancel: onDragEnd,
          onMouseEnter: () => onHover({ kind: 'node', id: node.id }),
          onMouseLeave: () => onHover(null),
        },
        body,
      )
    }

    /**
     * The legend, built from the renderer's own vocabulary.
     *
     * Reading the three lists rather than repeating them is the point: a node kind
     * or an edge style that the graph draws but the legend does not explain cannot
     * happen, because both sides iterate the same arrays.
     */
    function BoardLegend(props) {
      const { t } = props
      const nodeItem = (kind) =>
        h(
          'span',
          { key: kind, className: 'dshmo-legend-item' },
          h('span', { className: `dshmo-swatch dshmo-swatch-${kind}` }),
          h('span', null, t(`board.node.${kind}`)),
        )
      const statusItem = (status) =>
        h(
          'span',
          { key: status, className: 'dshmo-legend-item' },
          h('span', { className: `dshmo-dot dshmo-dot-${status}` }),
          h('span', null, t(`board.status.${status}`)),
        )
      const edgeItem = (kind) =>
        h(
          'span',
          { key: kind, className: 'dshmo-legend-item' },
          h(
            'svg',
            { className: 'dshmo-legend-wire', width: 34, height: 12, viewBox: '0 0 34 12', 'aria-hidden': 'true' },
            h('path', { className: `dshmo-edge dshmo-edge-${kind}`, d: 'M 2 6 C 12 6 22 6 32 6' }),
          ),
          h('span', null, t(`board.edge.${kind}`)),
        )
      return h(
        'div',
        { className: 'dshmo-legend' },
        h(
          'div',
          { className: 'dshmo-legend-group' },
          h('span', { className: 'dshmo-legend-title' }, t('board.legendNodes')),
          NODE_KINDS.map(nodeItem),
          h('span', { className: 'dshmo-badge' }, t('board.modeOneShot')),
          h('span', { className: 'dshmo-badge dshmo-badge-cont' }, t('board.modeContinuable')),
        ),
        h(
          'div',
          { className: 'dshmo-legend-group' },
          h('span', { className: 'dshmo-legend-title' }, t('board.legendStatus')),
          LIFECYCLE.map(statusItem),
        ),
        h(
          'div',
          { className: 'dshmo-legend-group' },
          h('span', { className: 'dshmo-legend-title' }, t('board.legendEdges')),
          EDGE_KINDS.map(edgeItem),
          // The flowing style is a state, not a kind, so it gets its own sample
          // rather than a seventh entry in the edge vocabulary.
          h(
            'span',
            { className: 'dshmo-legend-item', title: t('board.legendRunning') },
            h(
              'svg',
              { className: 'dshmo-legend-wire', width: 34, height: 12, viewBox: '0 0 34 12', 'aria-hidden': 'true' },
              h('path', { className: 'dshmo-edge dshmo-edge-dependency is-flow', d: 'M 2 6 C 12 6 22 6 32 6' }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshmo-legend-group' },
          h('span', null, t('board.dragHint')),
          h('span', null, t('board.legendSource')),
        ),
      )
    }

    /**
     * The Orchestrator board.
     *
     * A first-class Conversation view rather than an ambient strip: it shows which
     * parts of the task were delegated, which model each one went to, how they
     * relate, and what is running right now. Topology is harness-native (`/tree`
     * reads the durable session tree), so nothing here is a parallel task tracker.
     */
    function OrchestratorBoard(props) {
      const t = props.t ?? localTranslate
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const { state, error, busy, reload } = useOrchestratorState(5000, t)
      const [tree, setTree] = React.useState(null)
      const [treeError, setTreeError] = React.useState(null)
      // Where the reader has moved each box, relative to its laid-out position. An
      // offset rather than an absolute position: the poll recomputes the layout
      // every two seconds, and a stored absolute position would fight it (or be
      // thrown away) on every tick.
      const [offsets, setOffsets] = React.useState({})
      const [hover, setHover] = React.useState(null)
      const dragRef = React.useRef(null)

      React.useEffect(() => {
        ensureBoardStyles()
      }, [])

      /**
       * Mirror the shell's content width onto this view.
       *
       * The stylesheet prefers the shell's own variable, which is inherited from
       * the conversation root and changes as the width handle is dragged. This is
       * the fallback layer: it reads the width the shell actually applied and
       * republishes it, so the board still tracks the handle if that variable is
       * ever renamed, moved, or resolved outside this view's scope.
       */
      const rootRef = React.useRef(null)
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const root = rootRef.current
        if (root === null) return undefined
        const owner = root.closest('.wSkVaW_root') ?? document.body

        const measure = () => {
          // The variable is DECLARED on the conversation root, so reading it
          // there yields the resolved value rather than a var() string.
          const declared = getComputedStyle(owner).getPropertyValue('--dsh-chat-content-width').trim()
          const resolved = Number.parseFloat(declared)
          if (Number.isFinite(resolved) && resolved > 0) {
            root.style.setProperty('--dshmo-content-width', `${Math.round(resolved)}px`)
          }
        }
        measure()

        // A style mutation is how a drag publishes intermediate widths; the
        // resize observer catches the column changing underneath.
        const mutations =
          typeof MutationObserver === 'function' ? new MutationObserver(measure) : undefined
        mutations?.observe(owner, { attributes: true, attributeFilter: ['style', 'class'] })
        const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined
        resizes?.observe(owner)
        return () => {
          mutations?.disconnect()
          resizes?.disconnect()
          root.style.removeProperty('--dshmo-content-width')
        }
      }, [])

      React.useEffect(() => {
        if (sessionId === undefined) return undefined
        let alive = true
        const tick = async () => {
          try {
            const next = await readTree(sessionId)
            if (alive) {
              setTree(next)
              setTreeError(null)
            }
          } catch (failure) {
            if (alive) setTreeError(String(failure.message ?? failure))
          }
        }
        void tick()
        // A live board is the point: poll fast enough that a running delegation
        // appears and turns grey promptly, without hammering the host.
        const timer = setInterval(tick, 2000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId])

      const rows = tree?.rows ?? []
      const counts = tree?.counts ?? { total: 0, running: 0, continuable: 0, roots: 0 }
      const poolSize = state?.pool?.size ?? 0
      const capabilities = (state?.capabilities ?? []).length

      /**
       * The graph is rebuilt from the polled payload instead of being kept in state:
       * `/tree` is the only source of truth for a live delegation, and a remembered
       * node would outlive the record it describes.
       */
      const graph = React.useMemo(() => buildGraph(tree, t), [tree, t])
      const layout = layoutGraph(graph, offsets)

      // One hover at a time, and it is either a box or a wire. Everything not
      // touching it dims — the only way to follow one path through a graph where a
      // box can be the source of six wires.
      const related = React.useMemo(() => relatedTo(hover, graph), [hover, graph])
      const isDimNode = (id) => hover !== null && !related.nodes.has(id)
      const isDimEdge = (id) => hover !== null && !related.edges.has(id)
      const isFlowing = (edge) => graph.running.has(edge.from) || graph.running.has(edge.to)

      // Takes the node id AND the pointer event: an earlier version returned a
      // handler that the box then never called, so pointer-down armed nothing and
      // every box looked draggable without moving.
      const startDrag = (nodeId, event) => {
        // Primary button only: a right-click on a box must keep its context menu.
        if (event.button !== undefined && event.button !== 0) return
        const element = event.currentTarget
        // Capture is what carries a drag past the edge of the box it started on:
        // the moves keep arriving here, so no document listener is needed.
        if (typeof element.setPointerCapture === 'function') element.setPointerCapture(event.pointerId)
        const base = offsets[nodeId] ?? { dx: 0, dy: 0 }
        dragRef.current = {
          id: nodeId,
          at: { x: event.clientX, y: event.clientY },
          dx: base.dx,
          dy: base.dy,
        }
      }
      const moveDrag = (event) => {
        const drag = dragRef.current
        if (drag === null) return
        setOffsets((previous) => ({
          ...previous,
          [drag.id]: {
            dx: drag.dx + (event.clientX - drag.at.x),
            dy: drag.dy + (event.clientY - drag.at.y),
          },
        }))
      }
      const endDrag = (event) => {
        const drag = dragRef.current
        if (drag === null) return
        dragRef.current = null
        const element = event?.currentTarget
        if (element === undefined || element === null) return
        if (typeof element.releasePointerCapture === 'function' && event.pointerId !== undefined) {
          try {
            element.releasePointerCapture(event.pointerId)
          } catch {
            // The capture is already gone (a cancelled pointer releases it), and
            // releasing it twice throws for no reason anyone needs to see.
          }
        }
      }

      const chips = h(
        'div',
        { className: 'dshmo-chips' },
        h('span', { className: 'dshmo-chip' }, t('board.statDelegated', { count: graph.stats.delegated })),
        h(
          'span',
          { className: `dshmo-chip${graph.stats.running > 0 ? ' dshmo-chip-live' : ''}` },
          h('b', null, String(graph.stats.running)),
          t('board.statRunningSuffix'),
        ),
        h('span', { className: 'dshmo-chip' }, t('board.statCompleted', { count: graph.stats.completed })),
        h('span', { className: 'dshmo-chip' }, t('board.statFailed', { count: graph.stats.failed })),
        h('span', { className: 'dshmo-chip' }, t('board.statQuestions', { count: graph.stats.questions })),
        h('span', { className: 'dshmo-chip' }, t('board.statReviews', { count: graph.stats.reviews })),
        graph.stats.elapsedMs === undefined
          ? null
          : h(
              'span',
              { className: 'dshmo-chip' },
              t('board.runElapsed', { time: elapsedLabel(graph.stats.elapsedMs, t) }),
            ),
        h('span', { className: 'dshmo-chip' }, t('board.statRoots', { count: counts.roots })),
        graph.stats.continuable > 0
          ? h('span', { className: 'dshmo-chip' }, t('board.statContinuable', { count: graph.stats.continuable }))
          : null,
        h(
          'button',
          { type: 'button', className: 'dshmo-btn', disabled: busy, onClick: () => void reload(true, true) },
          busy ? t('doc.refreshing') : t('doc.refresh'),
        ),
      )

      // A session with neither a harness child nor a recorded run has nothing to
      // draw: an empty canvas would read as a broken graph, so the board keeps its
      // "nothing delegated yet" state instead.
      const nothingYet = graph.run === undefined && rows.length === 0

      const graphBody =
        sessionId === undefined
          ? h('div', { className: 'dshmo-empty' }, t('board.noSession'))
          : nothingYet
            ? h(
                'div',
                { className: 'dshmo-empty' },
                h('div', null, t('board.emptyTitle')),
                h('div', { style: { marginTop: '6px' } }, t('board.empty')),
              )
            : h(
                'div',
                { className: 'dshmo-scroll' },
                h(
                  'div',
                  {
                    className: 'dshmo-canvas',
                    style: { width: `${layout.width}px`, height: `${layout.height}px` },
                  },
                  h(
                    'svg',
                    {
                      className: 'dshmo-wires',
                      width: layout.width,
                      height: layout.height,
                      viewBox: `0 0 ${layout.width} ${layout.height}`,
                      'aria-hidden': 'true',
                    },
                    layout.links.map((link) =>
                      h(
                        'g',
                        { key: link.edge.id },
                        h('path', {
                          className: edgeClass(
                            link.edge,
                            isDimEdge(link.edge.id),
                            isFlowing(link.edge),
                            hover !== null && hover.kind === 'edge' && hover.id === link.edge.id,
                          ),
                          d: link.d,
                        }),
                        // A 16px transparent copy of the same path: a 2px wire is
                        // impossible to hit, and this is the hit area that reveals
                        // the two boxes it connects.
                        h('path', {
                          className: 'dshmo-edge-hit',
                          d: link.d,
                          onMouseEnter: () => setHover({ kind: 'edge', id: link.edge.id }),
                          onMouseLeave: () => setHover(null),
                          onClick: () => setHover({ kind: 'edge', id: link.edge.id }),
                        }),
                        link.label === undefined
                          ? null
                          : h(
                              'text',
                              { className: 'dshmo-edge-label', x: link.labelAt.x, y: link.labelAt.y },
                              link.label,
                            ),
                      ),
                    ),
                  ),
                  layout.nodes.map((placed) =>
                    h(GraphNode, {
                      key: placed.node.id,
                      node: placed.node,
                      t,
                      x: placed.x,
                      y: placed.y,
                      w: placed.w,
                      h: placed.h,
                      dim: isDimNode(placed.node.id),
                      hot: hover !== null && hover.kind === 'node' && hover.id === placed.node.id,
                      onHover: setHover,
                      onDragStart: startDrag,
                      onDragMove: moveDrag,
                      onDragEnd: endDrag,
                    }),
                  ),
                ),
              )

      // Grouped, and read from the renderer's own vocabulary rather than retyped:
      // see BoardLegend.
      const legend = h(BoardLegend, { t })

      return h(
        'div',
        { className: 'dshmo-board', ref: rootRef },
        h(
          'div',
          { className: 'dshmo-card' },
          h(
            'div',
            { className: 'dshmo-cardhead' },
            h('p', { className: 'dshmo-title' }, t('board.title')),
            chips,
          ),
          h('p', { className: 'dshmo-sub' }, t('board.description')),
          error !== null || treeError !== null
            ? h('p', { style: { ...styles.error, marginTop: '6px' } }, error ?? treeError)
            : null,
          tree?.error !== undefined
            ? h('p', { style: { ...styles.warn, marginTop: '6px' } }, t('board.unavailable', { message: tree.error }))
            : null,
        ),
        h(
          'div',
          { className: 'dshmo-card' },
          h(
            'div',
            { className: 'dshmo-cardhead' },
            h('p', { className: 'dshmo-title' }, t('board.graphTitle')),
            h(
              'span',
              { className: 'dshmo-chip' },
              t('board.updatedEvery', { seconds: 2 }),
            ),
          ),
          graphBody,
          tree?.truncated === true
            ? h('p', { style: { ...styles.warn, marginTop: '6px' } }, t('board.truncated'))
            : null,
          legend,
        ),
        h(
          'div',
          { className: 'dshmo-card' },
          h('div', { className: 'dshmo-cardhead' }, h('p', { className: 'dshmo-title' }, t('capacity.title'))),
          h(
            'div',
            { className: 'dshmo-chips' },
            h('span', { className: 'dshmo-chip' }, t('board.mode', { mode: state?.mode ?? '—' })),
            h('span', { className: 'dshmo-chip' }, t('strip.modelCount', { count: poolSize })),
            h('span', { className: 'dshmo-chip' }, t('capacity.inFlight', { count: state?.inFlight ?? 0 })),
            h('span', { className: 'dshmo-chip' }, t('capacity.capabilities', { count: capabilities })),
          ),
          h(
            'div',
            { className: 'dshmo-meter', title: t('board.poolMeter', { count: poolSize }) },
            h('i', { style: { width: `${Math.min(100, poolSize * 4)}%` } }),
          ),
          h('p', { className: 'dshmo-sub', style: { marginTop: '8px' } }, t('capacity.note')),
        ),
      )
    }

    // ---- plugin ------------------------------------------------------------

    const name = 'dsh-model-orchestrator'

    // The harness's language service, plus the slot service both seats live in.
    const inject = ['slots', 'locale']

    function apply(ctx) {
      // Own dictionary namespace: registered for every built-in locale, so the
      // panel follows the harness language setting.
      ctx.effect(
        () => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }),
        'dsh-model-orchestrator: locale dictionaries',
      )

      const label = () => ctx.locale.bind(LOCALE_NAMESPACE)('doc.title')

      // Tell the host which language this page is rendering, now and on every switch.
      // `locale/change` fires on an active-locale switch; the initial report covers the
      // page that was already open in whatever the browser resolved.
      reportLocale(ctx.locale)
      ctx.effect(
        () => {
          const off = ctx.on('locale/change', () => reportLocale(ctx.locale))
          return () => {
            if (typeof off === 'function') off()
          }
        },
        'dsh-model-orchestrator: report the active language to the host',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'model-orchestrator-settings',
                order: 45,
                label,
                locale: LOCALE_NAMESPACE,
              },
              OrchestratorSettingsSection,
            ),
          ),
        'dsh-model-orchestrator: settings section',
      )

      // A first-class Conversation view, sitting beside the shipped Chat and
      // Trajectory tabs rather than floating above the composer.
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.view', () =>
            ctx.slots.register(
              {
                name: 'conversation.view',
                id: 'orchestrator',
                order: 20,
                label: () => ctx.locale.bind(LOCALE_NAMESPACE)('board.tab'),
                locale: LOCALE_NAMESPACE,
              },
              OrchestratorBoard,
            ),
          ),
        'dsh-model-orchestrator: conversation board',
      )
    }

    return { name, inject, apply }
  },
})
