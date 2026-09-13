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
      'doc.refresh': 'Refresh',
      'doc.refreshing': 'Refreshing…',
      'doc.unavailable': 'Orchestrator unavailable: {message}',
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
      'pool.columnTier': 'Tier',
      'pool.columnContext': 'Context',
      'pool.columnImage': 'Image',
      'pool.columnReasoning': 'Reasoning',
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
      'capacity.calibrations': '{count} calibration(s)',
      'capacity.capabilities': '{count} capabilit(ies)',
      'capacity.note':
        'Task lists, step status, and progress are DSH-native and are shown by DSH itself. This orchestrator only routes model work, so it keeps no task state of its own.',
      'pool.effortIgnored': 'configured "{effort}" is no longer advertised by this route, so it is ignored',
      'pool.effortHint': 'Reasoning level this route is dispatched with. "default" lets the model resolve its own.',
      'pool.effortDefaultWith': 'default ({effort})',
      'pool.effortDefault': 'default',
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
      'board.nativeDelegation': 'native delegation',
      'board.nativeDelegationHint':
        'DSH started this child on its own; the orchestrator did not choose its route',
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
      'board.description': 'How this task was delegated: every subagent of this session, indented under the agent that started it. A delegation the orchestrator routed shows the model it selected; one DSH started by itself is marked a native delegation. Topology is read from the harness session tree every couple of seconds, so it shows the delegations that actually exist.',
      'board.title': 'Model Orchestrator',
      'board.tab': 'Orchestrator',
      'strip.modeLabel': 'Orchestrator · {mode}',
      'strip.modelCount': '{count} model(s)',
      'strip.areaCount': '{count} area(s)',
      'strip.details': 'details',
      'strip.hide': 'hide',
      'strip.moreInSettings': '+{count} more in Settings → Model Orchestrator',
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
      'doc.refresh': '刷新',
      'doc.refreshing': '刷新中…',
      'doc.unavailable': '编排器不可用：{message}',
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
      'pool.columnTier': '档位',
      'pool.columnContext': '上下文',
      'pool.columnImage': '图像',
      'pool.columnReasoning': '推理',
      'pool.yes': '支持',
      'pool.no': '不支持',
      'pool.unknown': '未知',
      'pool.noValue': '—',
      'pool.contextValue': '{value}k',
      'pool.tierDeep': '深度',
      'pool.tierBalanced': '均衡',
      'pool.tierFast': '快速',
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
      'capacity.calibrations': '{count} 条校准数据',
      'capacity.capabilities': '{count} 项能力',
      'capacity.note':
        '任务列表、步骤状态和进度都由 DSH 原生负责展示。本编排器只负责为模型工作选择路由，自身不保存任何任务状态。',
      'pool.effortIgnored': '已配置的"{effort}"该路由当前已不再提供，已忽略',
      'pool.effortHint': '这条路由派发时使用的推理档位。选"默认"则由模型自行决定。',
      'pool.effortDefaultWith': '默认（{effort}）',
      'pool.effortDefault': '默认',
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
      'board.nativeDelegation': '原生委派',
      'board.nativeDelegationHint': '这个子代理由 DSH 原生启动，编排器没有为它分配路由',
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
      'board.description': '本任务的委派情况：本会话的全部子代理，按“谁启动了它”缩进显示。由编排器分配的委派会标出它选定的模型；由 DSH 自己启动的则标记为原生委派。拓扑每两秒从 Harness 的会话树重新读取，因此展示的是真实存在的委派关系。',
      'board.title': '模型编排器',
      'board.tab': '编排看板',
      'strip.modeLabel': '编排器 · {mode}',
      'strip.modelCount': '{count} 个模型',
      'strip.areaCount': '{count} 个领域',
      'strip.details': '详情',
      'strip.hide': '收起',
      'strip.moreInSettings': '另有 {count} 个，见 设置 → 模型编排器',
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
      const template = zh[key] ?? en[key] ?? key
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

    /** Read the full orchestrator state. */
    const readState = () => requestJson(ROUTES.state, { method: 'GET' })

    /** Apply a preference patch. */
    const writeConfig = (patch) =>
      requestJson(ROUTES.configure, { method: 'POST', body: JSON.stringify(patch) })

    /** Ask what routing WOULD happen for a task. Read-only; spawns nothing. */
    const planTask = (task) =>
      requestJson(ROUTES.plan, { method: 'POST', body: JSON.stringify({ task }) })

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
    function poolTierLabel(tier, t) {
      switch (tier) {
        case 'deep':
          return t('pool.tierDeep')
        case 'balanced':
          return t('pool.tierBalanced')
        case 'fast':
          return t('pool.tierFast')
        default:
          return t('pool.unknown')
      }
    }

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

      const reload = React.useCallback(async (showBusy) => {
        if (showBusy) setBusy(true)
        try {
          const next = await readState()
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
              entry.label,
              entry.origin !== 'seed'
                ? h('span', { style: styles.mono, title: t('capability.learnedTitle') }, t('capability.learned'))
                : null,
            ),
          ),
          visible.length === 0 ? h('p', { style: styles.muted }, t('capability.empty')) : null,
        ),
      )
    }

    function PoolTable({ pool, onApply, t }) {
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
            { style: styles.pill },
            t('pool.summary', { models: pool.size, providers: pool.providers.length }),
          ),
        }),
        h('p', { style: styles.muted }, t('pool.description')),
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
            { style: { ...styles.table, minWidth: '520px' } },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { style: styles.th }, t('pool.columnRoute')),
                h('th', { style: styles.th }, t('pool.columnTier')),
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
                  h('td', { style: styles.td }, poolTierLabel(model.tier, t)),
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
                    (model.reasoningEfforts ?? []).length > 0
                      ? h(
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
                          h('td', { style: styles.td }, unit.capabilityLabel ?? unit.id),
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
                { type: 'button', style: styles.button, disabled: busy, onClick: () => void reload(true) },
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
          error ? h('p', { style: { ...styles.error, marginTop: '8px' } }, error) : null,
          actionError ? h('p', { style: { ...styles.error, marginTop: '8px' } }, actionError) : null,
          storageError
            ? h('p', { style: { ...styles.warn, marginTop: '8px' } }, t('health.state', { message: storageError }))
            : null,
          (state.pool?.problems ?? []).map((problem, index) =>
            h('p', { key: index, style: { ...styles.warn, marginTop: '6px' } }, problem),
          ),
        ),
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
        h(PoolTable, { pool: state.pool ?? { models: [], providers: [], problems: [] }, onApply: apply, t }),
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

/* ---- graph ---- */
.dshmo-graph{display:flex;flex-direction:column}
.dshmo-root{display:inline-flex;align-items:center;gap:8px;align-self:flex-start;border:1px solid var(--dsw-alias-brand-primary);border-radius:10px;padding:7px 12px;background:linear-gradient(180deg,var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-1));box-shadow:0 1px 2px rgba(0,0,0,.06)}
.dshmo-root-dot{width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.dshmo-root-label{font-weight:600}
.dshmo-spine{position:relative;margin:6px 0 6px 17px;padding-left:26px;border-left:2px solid var(--dsw-alias-border-l2)}
.dshmo-node{position:relative;margin:0 0 8px 0}
.dshmo-node:last-child{margin-bottom:0}
.dshmo-node::before{content:"";position:absolute;left:-26px;top:20px;width:24px;height:2px;background:var(--dsw-alias-border-l2)}
.dshmo-node.is-live::before{background:var(--dsw-alias-state-success-primary)}
.dshmo-node-depth2 .dshmo-nodecard{border-style:dashed}
.dshmo-nodecard{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:9px 11px;display:flex;flex-direction:column;gap:6px;transition:border-color .15s ease,box-shadow .15s ease}
.dshmo-nodecard:hover{border-color:var(--dsw-alias-brand-primary);box-shadow:0 2px 8px rgba(0,0,0,.07)}
.dshmo-nodecard.is-live{border-left-color:var(--dsw-alias-state-success-primary);background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent),transparent 60%)}
.dshmo-livebar{height:3px;width:132px;border-radius:3px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);position:relative}
.dshmo-livebar::after{content:"";position:absolute;inset:0;width:35%;border-radius:2px;background:var(--dsw-alias-state-success-primary);animation:dshmo-sweep 1.4s ease-in-out infinite}
@keyframes dshmo-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
.dshmo-noderow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshmo-ord{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:10px;color:var(--dsw-alias-label-secondary)}
.dshmo-ord.is-live{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base)}
.dshmo-cap{font-weight:600}
.dshmo-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.dshmo-dot-live{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 20%,transparent)}
.dshmo-dot-idle{background:var(--dsw-alias-border-l2)}
.dshmo-model{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshmo-model em{font-style:normal;color:var(--dsw-alias-label-secondary)}
.dshmo-native{font-family:inherit;border-style:dashed;color:var(--dsw-alias-label-secondary)}
.dshmo-badge{font-size:10px;border-radius:999px;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dshmo-badge-live{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dshmo-badge-cont{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshmo-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--dsw-alias-label-secondary)}
.dshmo-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;padding-top:9px;border-top:1px dashed var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshmo-legend span{display:inline-flex;align-items:center;gap:5px}
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

    /**
     * One delegation node.
     *
     * The row is deliberately information-dense: ordinal, live dot, capability
     * label, the model it was routed to, its mode, and the durable child id — the
     * facts a reader needs to tell two delegations apart at a glance.
     */
    function DelegationNode({ row, t }) {
      const live = row.activity === 'running'
      // The harness records a delegation label as "<capability> via <route>".
      // Splitting it lets the card show the capability as the title and the model
      // as its own chip, instead of one long undifferentiated string.
      const raw = typeof row.label === 'string' ? row.label : ''
      const marker = raw.lastIndexOf(ROUTE_MARKER)
      const capability = marker === -1 ? (raw === '' ? undefined : raw) : raw.slice(0, marker)
      const route = marker === -1 ? undefined : raw.slice(marker + ROUTE_MARKER.length)
      return h(
        'div',
        {
          className: `dshmo-node${live ? ' is-live' : ''}${row.depth > 1 ? ' dshmo-node-depth2' : ''}`,
        },
        h(
          'div',
          { className: `dshmo-nodecard${live ? ' is-live' : ''}` },
          h(
            'div',
            { className: 'dshmo-noderow' },
            h('span', { className: `dshmo-ord${live ? ' is-live' : ''}` }, String(row.ordinal)),
            h('span', {
              className: `dshmo-dot ${live ? 'dshmo-dot-live' : 'dshmo-dot-idle'}`,
              title: live ? t('board.activityRunning') : t('board.activityInactive'),
            }),
            h('span', { className: 'dshmo-cap' }, capability ?? t('board.generalWork')),
            h('span', {
              className: `dshmo-badge${live ? ' dshmo-badge-live' : ''}`,
            }, live ? t('board.activityRunning') : t('board.activityInactive')),
            h(
              'span',
              { className: `dshmo-badge${row.mode === 'continuable' ? ' dshmo-badge-cont' : ''}` },
              row.mode === 'continuable' ? t('board.modeContinuable') : t('board.modeOneShot'),
            ),
            h(ModelChip, { route, t }),
          ),
          h(
            'div',
            { className: 'dshmo-noderow' },
            h('span', { className: 'dshmo-id', title: row.id }, `#${String(row.id).slice(0, 10)}`),
            row.hasChildren === true ? h('span', { className: 'dshmo-sub' }, t('board.hasChildren')) : null,
          ),
          live ? h('div', { className: 'dshmo-livebar' }) : null,
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

      const chips = h(
        'div',
        { className: 'dshmo-chips' },
        h('span', { className: 'dshmo-chip' }, t('board.statDelegated', { count: counts.total })),
        h(
          'span',
          { className: `dshmo-chip${counts.running > 0 ? ' dshmo-chip-live' : ''}` },
          h('b', null, String(counts.running)),
          t('board.statRunningSuffix'),
        ),
        h('span', { className: 'dshmo-chip' }, t('board.statRoots', { count: counts.roots })),
        counts.continuable > 0
          ? h('span', { className: 'dshmo-chip' }, t('board.statContinuable', { count: counts.continuable }))
          : null,
        h(
          'button',
          { type: 'button', className: 'dshmo-btn', disabled: busy, onClick: () => void reload(true) },
          busy ? t('doc.refreshing') : t('doc.refresh'),
        ),
      )

      const graphBody =
        sessionId === undefined
          ? h('div', { className: 'dshmo-empty' }, t('board.noSession'))
          : rows.length === 0
            ? h(
                'div',
                { className: 'dshmo-empty' },
                h('div', null, t('board.emptyTitle')),
                h('div', { style: { marginTop: '6px' } }, t('board.empty')),
              )
            : h(
                'div',
                { className: 'dshmo-graph' },
                h(
                  'div',
                  { className: 'dshmo-root' },
                  h('span', { className: 'dshmo-root-dot' }),
                  h('span', { className: 'dshmo-root-label' }, t('board.rootLabel')),
                  h('span', { className: 'dshmo-id' }, `#${String(sessionId).slice(0, 10)}`),
                ),
                h(
                  'div',
                  { className: 'dshmo-spine' },
                  rows.map((row) => h(DelegationNode, { key: row.id, row, t })),
                ),
              )

      const legend = h(
        'div',
        { className: 'dshmo-legend' },
        h('span', null, h('span', { className: 'dshmo-dot dshmo-dot-live' }), t('board.legendRunning')),
        h('span', null, h('span', { className: 'dshmo-dot dshmo-dot-idle' }), t('board.legendIdle')),
        h('span', null, h('span', { className: 'dshmo-badge dshmo-badge-cont' }, t('board.modeContinuable')), t('board.legendContinuable')),
        h('span', null, t('board.legendSource')),
      )

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
