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
  'doc.refresh': 'Refresh',
  'doc.refreshing': 'Refreshing…',
  'doc.unavailable': 'Orchestrator unavailable: {message}',

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
    'Choose how the orchestrator picks a model. In Auto it reads the task and decides by itself, so you never choose a model by hand. In Guided it starts from the capability areas you select below, then still matches them against the live pool.',
  'mode.auto': 'Auto',
  'mode.autoHint': 'Read the task and choose a model for each piece of work automatically.',
  'mode.guided': 'Guided',
  'mode.guidedHint': 'Pick the capability areas below and match models against them.',

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
    'The orchestrator re-reads the models this harness offers every time it runs, and matches them to what a task needs. Capability is graded relative to the models available right now. The Basis column shows where each model’s assessment comes from, and Suitable for lists the domains a model declares for itself.',
  'pool.empty':
    'No model is currently discoverable. Routing cannot select anything until a provider answers a listing.',
  'pool.columnRoute': 'Route',
  'pool.columnTier': 'Tier',
  'pool.columnContext': 'Context',
  'pool.columnImage': 'Image',
  'pool.columnReasoning': 'Reasoning',
  'pool.columnEvidence': 'Basis',
  'pool.ratingNote': 'Capability is graded relative to the models available right now, not as an absolute score, and it is computed from what the harness measures: reasoning support, context window, output budget. A pool whose models measure the same shows no ranking rather than a tie at the top. Suitable for comes only from what a model’s own description states, so a model that states nothing shows none.',
  'pool.declaredNoneHint': 'This model states no description, so the harness has no declared domain information for it. Its rating comes from measurements alone.',
  'pool.declaredNone': 'not stated',
  'pool.starsFlat': 'All models in this pool are equivalent on measured capability, so there is no ranking to show.',
  'pool.starsAria': '{stars} out of 5, relative to the current pool',
  'pool.columnDeclared': 'Suitable for (stated)',
  'pool.columnStars': 'Capability',
  'pool.yes': 'yes',
  'pool.no': 'no',
  'pool.unknown': 'unknown',
  'pool.noValue': '—',
  'pool.contextValue': '{value}k',
  'pool.tierDeep': '深度',
  'pool.tierBalanced': '均衡',
  'pool.tierFast': '快速',
  'pool.tierDeep': 'deep',
  'pool.tierBalanced': 'balanced',
  'pool.tierFast': 'fast',

  // ---- preferences --------------------------------------------------------
  'preferences.title': 'Preferences',
  'preferences.preferCheaper': 'Prefer lower-cost routes',
  'preferences.preferCheaperHint':
    'Shapes tie-breaks only; it never overrides a hard requirement.',
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
  'capacity.calibrations': '{count} calibration(s)',
  'capacity.capabilities': '{count} capabilit(ies)',
  'capacity.note':
    'Task lists, step status, and progress are DSH-native and are shown by DSH itself. This orchestrator only routes model work, so it keeps no task state of its own.',

  'pool.filteredByPreference': '{count} hidden by your route preferences',
  'pool.policySource': 'follows the subagent route policy',
  'pool.policyFiltered': 'Showing the {kept} route(s) this deployment offers for subagents; {dropped} advertised route(s) are not selectable.',
  'board.poolMeter': '{count} models available',
  'board.updatedEvery': 'refreshed every {seconds}s',
  'board.legendSource': 'topology read from the harness session tree',
  'board.legendContinuable': 'resumable',
  'board.legendIdle': 'finished or idle',
  'board.legendRunning': 'running now',
  'board.emptyTitle': 'Nothing delegated yet',
  'board.hasChildren': 'has nested delegations',
  'board.noRoute': 'route not recorded',
  'board.generalWork': 'General work',
  'board.rootLabel': 'This task',
  'board.statDelegatedSuffix': 'delegated',
  'board.statContinuable': '{count} resumable',
  'board.statRunningSuffix': 'running',
  'board.activityInactive': 'inactive',
  'board.activityRunning': 'running',
  'board.modeContinuable': 'continuable',
  'board.modeOneShot': 'one-shot',
  'board.statRoots': '{count} branch(es)',
  'board.statRunning': '{count} running',
  'board.statDelegated': '{count} delegated',
  'board.mode': 'mode {mode}',
  'board.unavailable': 'The delegation graph is unavailable: {message}',
  'board.truncated': 'The graph was truncated: too many nodes to display at once.',
  'board.noSession': 'Open a session to see its delegation graph.',
  'board.empty': 'Nothing has been delegated yet. The orchestrator starts a subagent only when a task needs a capability the current model is not the best fit for.',
  'board.graphTitle': 'Delegation graph',
  'board.description': 'How this task was delegated: each node is a subagent the orchestrator started, indented under the agent that started it. Topology is read from the harness session tree every couple of seconds, so it shows the delegations that actually exist.',
  'board.title': 'Model Orchestrator',
  'board.tab': 'Orchestrator',
  // ---- per-session strip --------------------------------------------------
  'strip.modeLabel': 'Orchestrator · {mode}',
  'strip.modelCount': '{count} model(s)',
  'strip.areaCount': '{count} area(s)',
  'strip.details': 'details',
  'strip.hide': 'hide',
  'strip.moreInSettings': '+{count} more in Settings → Model Orchestrator',

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
  'doc.refresh': '刷新',
  'doc.refreshing': '刷新中…',
  'doc.unavailable': '编排器不可用：{message}',

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
    '选择编排器如何为任务挑模型。Auto 会自己读懂任务并决定，你不需要手动选模型；Guided 则以你下面勾选的能力领域为起点，再据此从当前可用的模型里匹配。',
  'mode.auto': '自动',
  'mode.autoHint': '自动读懂任务，并为每一项工作挑好模型。',
  'mode.guided': '引导',
  'mode.guidedHint': '先在下面勾选能力领域，再据此匹配模型。',

  // ---- capability areas ---------------------------------------------------
  'capability.title': '能力领域',
  'capability.selectedCount': '已选 {count} 项',
  'capability.description':
    '这些只影响 Guided 模式下的匹配。它们是能力描述符，而不是模型名称：每一项背后的模型都会在每次运行时从实时模型池重新匹配。',
  'capability.filterPlaceholder': '筛选能力…',
  'capability.empty': '没有符合该筛选条件的能力。',
  'capability.learned': ' ·新增',
  'capability.learnedTitle': '运行时为分类体系尚未覆盖的能力自动生成。',

  // ---- model pool ---------------------------------------------------------
  'pool.title': '模型池',
  'pool.summary': '{models} 个模型 · {providers} 个 provider',
  'pool.description': '编排器每次运行都会重新读取当前可用的模型，再按任务需要匹配。综合能力是相对当前可用模型的分级，不是绝对评分。“依据”列说明该模型的评估从哪来，“适用”列列出模型自己声明的领域。',
  'pool.empty': '当前没有可发现的模型。在任一 provider 返回模型列表之前，路由无法选择任何模型。',
  'pool.columnRoute': 'Route',
  'pool.columnTier': '档位',
  'pool.columnContext': '上下文',
  'pool.columnImage': '图像',
  'pool.columnReasoning': '推理',
  'pool.columnEvidence': '依据',
  'pool.ratingNote': '综合能力是相对当前可用模型的分级，不是绝对评分，由 Harness 能实测的信息推算：是否支持推理、上下文窗口、输出预算。若池中各模型实测指标相同，则不显示排序，而不是并列满分。“适用”只来自模型自己的描述，没有描述的模型就显示未说明。',
  'pool.declaredNoneHint': '该模型没有提供自述描述，因此 Harness 无法获得它声明的适用领域。它的星级仅来自实测指标。',
  'pool.declaredNone': '未说明',
  'pool.starsFlat': '本模型池中的模型在可测量指标上相当，因此没有可展示的排序。',
  'pool.starsAria': '{stars} / 5 星，相对当前模型池',
  'pool.columnDeclared': '适用（自述）',
  'pool.columnStars': '综合能力',
  'pool.yes': '支持',
  'pool.no': '不支持',
  'pool.unknown': '未知',
  'pool.noValue': '—',
  'pool.contextValue': '{value}k',
  'pool.tierDeep': '深度',
  'pool.tierBalanced': '均衡',
  'pool.tierFast': '快速',

  // ---- preferences --------------------------------------------------------
  'preferences.title': '偏好设置',
  'preferences.preferCheaper': '优先选择成本更低的路由',
  'preferences.preferCheaperHint': '仅用于打破评分平局，永远不会覆盖硬性要求。',
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
  'capacity.calibrations': '{count} 条校准数据',
  'capacity.capabilities': '{count} 项能力',
  'capacity.note':
    '任务列表、步骤状态和进度都由 DSH 原生负责展示。本编排器只负责为模型工作选择路由，自身不保存任何任务状态。',

  'pool.filteredByPreference': '{count} 条被你的路由偏好隐藏',
  'pool.policySource': '遵循子代理路由策略',
  'pool.policyFiltered': '仅显示本部署可为子代理选用的 {kept} 条路由；另有 {dropped} 条已注册路由不可选。',
  'board.poolMeter': '当前有 {count} 个模型可用',
  'board.updatedEvery': '每 {seconds} 秒刷新',
  'board.legendSource': '拓扑来自 Harness 会话树',
  'board.legendContinuable': '可继续会话',
  'board.legendIdle': '已结束或空闲',
  'board.legendRunning': '正在运行',
  'board.emptyTitle': '尚未发生委派',
  'board.hasChildren': '含下级委派',
  'board.noRoute': '未记录路由',
  'board.generalWork': '通用工作',
  'board.rootLabel': '本任务',
  'board.statDelegatedSuffix': ' 已委派',
  'board.statContinuable': '{count} 个可继续',
  'board.statRunningSuffix': ' 运行中',
  'board.activityInactive': '未运行',
  'board.activityRunning': '运行中',
  'board.modeContinuable': '可继续',
  'board.modeOneShot': '一次性',
  'board.statRoots': '{count} 条分支',
  'board.statRunning': '运行中 {count}',
  'board.statDelegated': '已委派 {count}',
  'board.mode': '模式 {mode}',
  'board.unavailable': '无法读取委派关系图：{message}',
  'board.truncated': '关系图已截断：节点过多，无法一次性显示。',
  'board.noSession': '打开一个会话即可查看它的委派关系图。',
  'board.empty': '目前还没有任何委派。只有当任务需要当前模型并不擅长的能力时，编排器才会启动子代理。',
  'board.graphTitle': '委派关系图',
  'board.description': '本任务的委派情况：每个节点都是编排器启动的一个子代理，并按“谁启动了它”缩进显示。拓扑每两秒从 Harness 的会话树重新读取，因此展示的是真实存在的委派关系。',
  'board.title': '模型编排器',
  'board.tab': '编排看板',
  // ---- per-session strip --------------------------------------------------
  'strip.modeLabel': '编排器 · {mode}',
  'strip.modelCount': '{count} 个模型',
  'strip.areaCount': '{count} 个领域',
  'strip.details': '详情',
  'strip.hide': '收起',
  'strip.moreInSettings': '另有 {count} 个，见 设置 → 模型编排器',

  // ---- tiers --------------------------------------------------------------
  'tier.direct': '直接执行',
  'tier.specialist': '单专家',
  'tier.multiAgent': '多智能体',
  'tier.unknown': '未知',
}

/** Both dictionaries, in the shape `ctx.locale.register` expects. */
export const DICTIONARIES = { zh, en }
