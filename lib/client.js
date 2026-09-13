/**
 * dsh-model-orchestrator — Client half.
 *
 * A static client bundle in the harness's own module-loader format. It renders
 * two seats:
 *
 *   - `settings.section`        — the full Orchestrator control page.
 *   - `conversation.input.dock` — a compact per-session routing strip.
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
        'Auto routes each unit of work automatically. Guided honours the capability areas you select for this session.',
      'mode.auto': 'Auto',
      'mode.autoHint': 'Infer what the task needs and route without asking.',
      'mode.guided': 'Guided',
      'mode.guidedHint': 'Seed routing with the capability areas you pick below.',
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
        'Discovered live, never stored. Evidence shows what the profile is actually based on.',
      'pool.empty':
        'No model is currently discoverable. Routing cannot select anything until a provider answers a listing.',
      'pool.columnRoute': 'Route',
      'pool.columnTier': 'Tier',
      'pool.columnContext': 'Context',
      'pool.columnImage': 'Image',
      'pool.columnReasoning': 'Reasoning',
      'pool.columnEvidence': 'Evidence',
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
        'Auto 自动为每项工作选择路由。Guided 按你在本次会话中选定的能力领域进行匹配。',
      'mode.auto': '自动',
      'mode.autoHint': '自行判断任务需要什么并直接路由，不询问用户。',
      'mode.guided': '引导',
      'mode.guidedHint': '用下面选定的能力领域为路由提供起点。',
      'capability.title': '能力领域',
      'capability.selectedCount': '已选 {count} 项',
      'capability.description':
        '这些只影响 Guided 模式下的匹配。它们是能力描述符，而不是模型名称：每一项背后的模型都会在每次运行时从实时模型池重新匹配。',
      'capability.filterPlaceholder': '筛选能力…',
      'capability.empty': '没有符合该筛选条件的能力。',
      'capability.learned': ' ·新增',
      'capability.learnedTitle': '运行时为分类体系尚未覆盖的能力自动生成。',
      'pool.title': '模型池',
      'pool.summary': '{models} 个模型 · {providers} 个 provider',
      'pool.description': '实时发现，从不落盘保存。证据列显示该画像实际依据的来源。',
      'pool.empty': '当前没有可发现的模型。在任一 provider 返回模型列表之前，路由无法选择任何模型。',
      'pool.columnRoute': 'Route',
      'pool.columnTier': '档位',
      'pool.columnContext': '上下文',
      'pool.columnImage': '图像',
      'pool.columnReasoning': '推理',
      'pool.columnEvidence': '证据',
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
      'preferences.preferCheaperHint': '仅用于打破评分平局，永远不会覆盖硬性要求。',
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

    function ModeControl({ state, onApply, t }) {
      const mode = state.mode
      const option = (id, label, hint) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            style: mode === id ? { ...styles.toggle, ...styles.toggleActive } : styles.toggle,
            title: hint,
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
          option('guided', t('mode.guided'), t('mode.guidedHint')),
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

    function PoolTable({ pool, t }) {
      const models = pool.models ?? []
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
            { style: { ...styles.table, minWidth: '620px' } },
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
                h('th', { style: styles.th }, t('pool.columnEvidence')),
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
                      ? (model.reasoningEfforts ?? []).join('/')
                      : h('span', { style: styles.muted }, t('pool.noValue')),
                  ),
                  h(
                    'td',
                    { style: { ...styles.td, whiteSpace: 'normal' } },
                    (model.evidence ?? []).join(', '),
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
    function RoutingCapacity({ state, t }) {
      const inFlight = state.inFlight ?? 0
      const calibrations = Object.keys(state.calibrations ?? {}).length
      return h(
        Card,
        null,
        h(SectionTitle, { title: t('capacity.title') }),
        h(
          'div',
          { style: { ...styles.row, marginTop: '6px' } },
          h('span', { style: styles.pill }, t('capacity.inFlight', { count: inFlight })),
          h('span', { style: styles.pill }, t('capacity.calibrations', { count: calibrations })),
          h(
            'span',
            { style: styles.pill },
            t('capacity.capabilities', { count: (state.capabilities ?? []).length }),
          ),
        ),
        h('p', { style: { ...styles.muted, marginTop: '6px' } }, t('capacity.note')),
      )
    }

    function OrchestratorSettingsSection(props) {
      const t = props.t ?? localTranslate
      const { state, error, busy, reload } = useOrchestratorState(10000, t)
      const [actionError, setActionError] = React.useState(null)

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
        h(CapabilityPicker, { state, onApply: apply, t }),
        h(PoolTable, { pool: state.pool ?? { models: [], providers: [], problems: [] }, t }),
        h(PreferencesCard, { state, onApply: apply, t }),
        h(PlanPreview, { t }),
        h(RoutingCapacity, { state, t }),
      )
    }

    function OrchestratorDock(props) {
      // The dock is narrow and ambient: it shows the current routing state and
      // links to the full page rather than duplicating its controls.
      const t = props.t ?? localTranslate
      const { state, error } = useOrchestratorState(30000, t)
      const [open, setOpen] = React.useState(false)

      if (state === null) {
        return error === null
          ? null
          : h(
              'div',
              { style: { ...styles.muted, padding: '2px 8px' } },
              t('doc.unavailable', { message: error }),
            )
      }

      const guided = (state.guidedCapabilities ?? []).length
      const poolSize = state.pool?.size ?? 0

      return h(
        'div',
        { style: { padding: '2px 8px' } },
        h(
          'div',
          { style: styles.row },
          h(
            'span',
            { style: { ...styles.pill, ...(state.mode === 'auto' ? styles.pillActive : {}) } },
            t('strip.modeLabel', { mode: state.mode === 'auto' ? t('mode.auto') : t('mode.guided') }),
          ),
          h('span', { style: styles.pill }, t('strip.modelCount', { count: poolSize })),
          state.mode === 'guided'
            ? h('span', { style: styles.pill }, t('strip.areaCount', { count: guided }))
            : null,
          h(
            'button',
            {
              type: 'button',
              style: { ...styles.pill, cursor: 'pointer' },
              onClick: () => setOpen((value) => !value),
            },
            open ? t('strip.hide') : t('strip.details'),
          ),
        ),
        open
          ? h(
              'div',
              { style: { ...styles.muted, marginTop: '4px' } },
              (state.pool?.models ?? [])
                .slice(0, 6)
                .map((model) =>
                  h(
                    'div',
                    { key: model.route, style: styles.mono },
                    `${routeLabel(model.route)} · ${tierLabel(model.tier, t)}`,
                  ),
                ),
              poolSize > 6
                ? h('div', null, t('strip.moreInSettings', { count: poolSize - 6 }))
                : null,
            )
          : null,
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

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'model-orchestrator-session',
                order: 30,
                label,
                locale: LOCALE_NAMESPACE,
              },
              OrchestratorDock,
            ),
          ),
        'dsh-model-orchestrator: session dock',
      )
    }

    return { name, inject, apply }
  },
})
