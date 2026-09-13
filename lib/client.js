/**
 * dsh-model-orchestrator — Client half.
 *
 * A static client bundle in the harness's own module-loader format. It renders
 * two seats:
 *
 *   - `settings.section`      — the full Orchestrator control page.
 *   - `conversation.input.dock` — a compact per-session routing strip.
 *
 * The panel cannot enumerate models for itself (the LLM listing surface is
 * host-only), so it reads state from the Host through this plugin's control
 * routes and never guesses.
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
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 500,
        padding: '4px 6px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      td: { padding: '4px 6px', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'top' },
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

    /** Render a route as `provider/model` with the model part emphasised. */
    function routeLabel(route) {
      if (typeof route !== 'string' || route === '') return '—'
      const slash = route.indexOf('/')
      return slash === -1 ? route : `${route.slice(0, slash)}/${route.slice(slash + 1)}`
    }

    /** The routing tier badge. */
    function tierLabel(tier) {
      switch (tier) {
        case 'direct':
          return 'direct'
        case 'specialist':
          return 'specialist'
        case 'multi-agent':
          return 'multi-agent'
        default:
          return tier ?? 'unknown'
      }
    }

    // ---- control page ------------------------------------------------------

    function useOrchestratorState(pollMs) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const reload = React.useCallback(
        async (showBusy) => {
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
        },
        [],
      )

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

      return { state, error, busy, reload, setState, setError, setBusy }
    }

    function ModeControl({ state, onApply }) {
      const mode = state.mode
      const option = (id, label, hint) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            style: mode === id ? { ...styles.button, ...styles.pillActive } : styles.button,
            title: hint,
            onClick: () => onApply({ mode: id }),
          },
          label,
        )
      return h(
        Card,
        null,
        h(SectionTitle, { title: 'Mode' }),
        h('p', { style: styles.muted }, 'Auto routes each unit of work automatically. Guided honours the capability areas you select for this session.'),
        h(
          'div',
          { style: { ...styles.row, marginTop: '8px' } },
          option('auto', 'Auto', 'Infer what the task needs and route without asking.'),
          option('guided', 'Guided', 'Seed routing with the capability areas you pick below.'),
        ),
      )
    }

    function CapabilityPicker({ state, onApply }) {
      const [filter, setFilter] = React.useState('')
      const selected = new Set(state.guidedCapabilities ?? [])
      const capabilities = state.capabilities ?? []
      const needle = filter.trim().toLowerCase()
      const visible = needle === ''
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
          title: 'Capability areas',
          right: h('span', { style: styles.pill }, `${selected.size} selected`),
        }),
        h(
          'p',
          { style: styles.muted },
          'These shape matching in Guided mode. They are capability descriptors, never model names: the model behind each one is re-matched from the live pool every run.',
        ),
        h('input', {
          style: { ...styles.input, marginTop: '8px', width: '100%' },
          placeholder: 'Filter capabilities…',
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
              entry.origin !== 'seed' ? h('span', { style: styles.mono }, ' ·new') : null,
            ),
          ),
          visible.length === 0 ? h('p', { style: styles.muted }, 'No capability matches that filter.') : null,
        ),
      )
    }

    function PoolTable({ pool }) {
      const models = pool.models ?? []
      if (models.length === 0) {
        return h(
          Card,
          null,
          h(SectionTitle, { title: 'Model pool' }),
          h('p', { style: styles.warn }, 'No model is currently discoverable. Routing cannot select anything until a provider answers a listing.'),
          (pool.problems ?? []).map((problem, index) => h('p', { key: index, style: styles.error }, problem)),
        )
      }
      return h(
        Card,
        null,
        h(SectionTitle, {
          title: 'Model pool',
          right: h('span', { style: styles.pill }, `${pool.size} model(s) · ${pool.providers.length} provider(s)`),
        }),
        h('p', { style: styles.muted }, 'Discovered live, never stored. Evidence shows what the profile is actually based on.'),
        h(
          'div',
          { style: { maxHeight: '260px', overflowY: 'auto', marginTop: '8px' } },
          h(
            'table',
            { style: styles.table },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { style: styles.th }, 'Route'),
                h('th', { style: styles.th }, 'Tier'),
                h('th', { style: styles.th }, 'Context'),
                h('th', { style: styles.th }, 'Image'),
                h('th', { style: styles.th }, 'Reasoning'),
                h('th', { style: styles.th }, 'Evidence'),
              ),
            ),
            h(
              'tbody',
              null,
              models.map((model) =>
                h(
                  'tr',
                  { key: model.route },
                  h('td', { style: styles.td }, h('div', { style: styles.mono }, routeLabel(model.route)), model.name !== model.model ? h('div', { style: styles.muted }, model.name) : null),
                  h('td', { style: styles.td }, model.tier),
                  h('td', { style: styles.td }, model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : '—'),
                  h(
                    'td',
                    { style: styles.td },
                    model.supportsImage === true ? 'yes' : model.supportsImage === false ? 'no' : h('span', { style: styles.muted }, 'unknown'),
                  ),
                  h('td', { style: styles.td }, (model.reasoningEfforts ?? []).length > 0 ? (model.reasoningEfforts ?? []).join('/') : h('span', { style: styles.muted }, '—')),
                  h('td', { style: styles.td }, (model.evidence ?? []).join(', ')),
                ),
              ),
            ),
          ),
        ),
      )
    }

    function PreferencesCard({ state, onApply }) {
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
        h(SectionTitle, { title: 'Preferences' }),
        h(
          'div',
          { style: { ...styles.row, gap: '14px', marginTop: '8px' } },
          toggle('preferCheaper', 'Prefer lower-cost routes', 'Shapes tie-breaks only; it never overrides a hard requirement.'),
          toggle('allowMultiAgent', 'Allow multi-agent plans', 'When off, complex tasks run as one specialist instead of several.'),
          toggle('calibrationEnabled', 'Keep calibrations aligned with the pool', 'Prunes learned profiles whose route left the pool.'),
          number('maxParallel', 'Max parallel', 1, 16, 'Concurrent specialist subagents.'),
          number('maxAgentsPerRun', 'Max agents/run', 1, 64, 'Specialists per orchestration run.'),
        ),
      )
    }

    function PlanPreview() {
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
        h(SectionTitle, { title: 'Routing preview' }),
        h('p', { style: styles.muted }, 'Describe a task to see which tier and which live model the orchestrator would choose. This spawns nothing.'),
        h(
          'div',
          { style: { ...styles.row, marginTop: '8px' } },
          h('input', {
            style: styles.input,
            placeholder: 'e.g. Research the topic, then analyze the data, then review the report',
            value: task,
            onChange: (event) => setTask(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void runPlan()
            },
          }),
          h('button', { type: 'button', style: styles.buttonPrimary, disabled: busy, onClick: () => void runPlan() }, busy ? 'Planning…' : 'Preview'),
        ),
        error ? h('p', { style: { ...styles.error, marginTop: '8px' } }, error) : null,
        plan
          ? h(
              'div',
              { style: { marginTop: '10px' } },
              h(
                'div',
                { style: styles.row },
                h('span', { style: { ...styles.pill, ...styles.pillActive } }, tierLabel(plan.tier)),
                h('span', { style: styles.pill }, `${(plan.units ?? []).length} unit(s)`),
                h('span', { style: styles.pill }, `pool ${plan.pool?.size ?? 0}`),
              ),
              (plan.warnings ?? []).map((warning, index) => h('p', { key: index, style: styles.warn }, warning)),
              (plan.units ?? []).length === 0
                ? h('p', { style: { ...styles.muted, marginTop: '6px' } }, 'No delegation needed: this tier runs on the current model.')
                : h(
                    'table',
                    { style: { ...styles.table, marginTop: '6px' } },
                    h(
                      'thead',
                      null,
                      h('tr', null, h('th', { style: styles.th }, 'Unit'), h('th', { style: styles.th }, 'Capability'), h('th', { style: styles.th }, 'Matched route'), h('th', { style: styles.th }, 'Why')),
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
                          h('td', { style: { ...styles.td, ...styles.mono } }, unit.route ? routeLabel(unit.route) : h('span', { style: styles.error }, 'unrouted')),
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
     * orchestrator itself knows, which is how many delegations are in flight and
     * what the current pool looks like.
     */
    function RoutingCapacity({ state }) {
      const inFlight = state.inFlight ?? 0
      const calibrations = Object.keys(state.calibrations ?? {}).length
      return h(
        Card,
        null,
        h(SectionTitle, { title: 'Routing capacity' }),
        h(
          'div',
          { style: { ...styles.row, marginTop: '6px' } },
          h('span', { style: styles.pill }, `${inFlight} delegation(s) in flight`),
          h('span', { style: styles.pill }, `${calibrations} calibration(s)`),
          h('span', { style: styles.pill }, `${(state.capabilities ?? []).length} capabilit(ies)`),
        ),
        h(
          'p',
          { style: { ...styles.muted, marginTop: '6px' } },
          'Task lists, step status, and progress are DSH-native and are shown by DSH itself. This orchestrator only routes model work, so it keeps no task state of its own.',
        ),
      )
    }

    function OrchestratorSettingsSection(props) {
      const { state, error, busy, reload } = useOrchestratorState(10000)
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
          h(Card, null, h(SectionTitle, { title: 'Model Orchestrator' }), h('p', { style: error ? styles.error : styles.muted }, error ?? 'Loading the live model pool…')),
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
            title: 'Model Orchestrator',
            right: h(
              'div',
              { style: styles.row },
              h('span', { style: styles.pill }, `${state.plugin?.name} ${state.plugin?.version}`),
              h('button', { type: 'button', style: styles.button, disabled: busy, onClick: () => void reload(true) }, busy ? 'Refreshing…' : 'Refresh'),
            ),
          }),
          h(
            'p',
            { style: styles.muted },
            'Discovers the models this harness actually has and routes each unit of work to the best available one. No model is named anywhere in the selection logic.',
          ),
          h(
            'div',
            { style: { ...styles.row, marginTop: '8px' } },
            h('span', { style: styles.pill }, `host ${compatibility.runningVersion ?? 'unknown'}`),
            h('span', { style: styles.pill }, `requires ${compatibility.declaredRange ?? '—'}`),
            h('span', { style: styles.pill }, `pool ${state.pool?.size ?? 0}`),
            (compatibility.optionalMissing ?? []).map((name) => h('span', { key: name, style: styles.pill }, `${name} absent`)),
          ),
          error ? h('p', { style: { ...styles.error, marginTop: '8px' } }, error) : null,
          actionError ? h('p', { style: { ...styles.error, marginTop: '8px' } }, actionError) : null,
          storageError ? h('p', { style: { ...styles.warn, marginTop: '8px' } }, `State: ${storageError}`) : null,
          (state.pool?.problems ?? []).map((problem, index) => h('p', { key: index, style: { ...styles.warn, marginTop: '6px' } }, problem)),
        ),
        h(ModeControl, { state, onApply: apply }),
        h(CapabilityPicker, { state, onApply: apply }),
        h(PoolTable, { pool: state.pool ?? { models: [], providers: [], problems: [] } }),
        h(PreferencesCard, { state, onApply: apply }),
        h(PlanPreview, null),
        h(RoutingCapacity, { state }),
      )
    }

    // ---- per-session dock --------------------------------------------------

    function OrchestratorDock() {
      // The dock is narrow and ambient: it shows the current routing state and
      // links to the full page rather than duplicating its controls.
      const { state, error } = useOrchestratorState(30000)
      const [open, setOpen] = React.useState(false)

      if (state === null) {
        return error === null
          ? null
          : h('div', { style: { ...styles.muted, padding: '2px 8px' } }, `Orchestrator unavailable: ${error}`)
      }

      const guided = (state.guidedCapabilities ?? []).length
      const poolSize = state.pool?.size ?? 0

      return h(
        'div',
        { style: { padding: '2px 8px' } },
        h(
          'div',
          { style: styles.row },
          h('span', { style: { ...styles.pill, ...(state.mode === 'auto' ? styles.pillActive : {}) } }, `Orchestrator · ${state.mode}`),
          h('span', { style: styles.pill }, `${poolSize} model${poolSize === 1 ? '' : 's'}`),
          state.mode === 'guided' ? h('span', { style: styles.pill }, `${guided} area${guided === 1 ? '' : 's'}`) : null,
          h(
            'button',
            {
              type: 'button',
              style: { ...styles.pill, cursor: 'pointer' },
              onClick: () => setOpen((value) => !value),
            },
            open ? 'hide' : 'details',
          ),
        ),
        open
          ? h(
              'div',
              { style: { ...styles.muted, marginTop: '4px' } },
              (state.pool?.models ?? []).slice(0, 6).map((model) =>
                h('div', { key: model.route, style: styles.mono }, `${routeLabel(model.route)} · ${model.tier}`),
              ),
              poolSize > 6 ? h('div', null, `+${poolSize - 6} more in Settings → Model Orchestrator`) : null,
            )
          : null,
      )
    }

    // ---- plugin ------------------------------------------------------------

    const name = 'dsh-model-orchestrator'

    // `slots` is the only hard service dependency; both seats live in slots the
    // shell already declares.
    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'model-orchestrator-settings', order: 45, label: 'Model Orchestrator' },
              OrchestratorSettingsSection,
            ),
          ),
        'dsh-model-orchestrator: settings section',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              { name: 'conversation.input.dock', id: 'model-orchestrator-session', order: 30, label: 'Model Orchestrator' },
              OrchestratorDock,
            ),
          ),
        'dsh-model-orchestrator: session dock',
      )
    }

    return { name, inject, apply }
  },
})
