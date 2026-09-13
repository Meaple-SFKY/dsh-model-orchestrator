# dsh-model-orchestrator — Design

Generic Model Orchestrator plugin for the DeepSeek Harness (DSH).

This document records the **verified** host contracts the plugin is built against. Every
claim here was read from the installed DSH `0.1.5-rc.1` tree, not assumed.

## 1. Verified host facts

### 1.1 Plugin package shape

`package.json.dsh` is typed by `@deepseek-ai/dsh-package-manifest`
(`lib/types/types.d.ts`). A package may declare several roles at once:

| Key | Meaning |
|---|---|
| `dsh.bundle.patch` | Patch file path relative to the package root. The profile launcher layers it. |
| `dsh.profile.bundles` | Ordered bundle list (profile directories only). |
| `dsh.client.platform` | Client platform id; the Web consumer selects `web`. |
| `dsh.client.inject` | Informational package-name dependencies (not Cordis service injection). |
| `dsh.client.external` | Exact extra module-table requests beyond the implicit baseline. |
| `dsh.configTrees` | Config directories for the deployment-image packer. |

A bundle patch is a top-level YAML array of loader patch entries. The observed shape is:

```yaml
- insert:
    - id: <loader-entry-id>
      name: <npm package name>
      config: { ... }
```

Layer order (`apps/cli` README): each bundle in `dsh.profile.bundles` order, then the
profile's `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`, then `--patch` overlays.

### 1.2 Version compatibility convention

The community marketplace (`dshmarket/lib/discovery-compatibility.js`,
`lib/compatibility.js`) reads exactly two declaration sites from a plugin manifest:

- top-level `engines.dsh`
- `dsh.engines.dsh` (nested under the `dsh` field)

Top-level wins when both are present. `peerDependencies` ranges for `@deepseek-ai/*`
packages are a second, independent signal; a peer mismatch is only a *risk* when it is
below every alternative's lower bound, or above an explicit upper bound/exact pin.

**Therefore this plugin declares `engines.dsh`** as its authoritative host range, plus
`peerDependencies` for the host packages it actually imports.

### 1.3 Module resolution

A package installed into `$DSH_HOME/profiles/<name>/node_modules` resolves
`@deepseek-ai/*` from the DSH installation. Verified with
`createRequire` anchored at an installed third-party plugin: `@deepseek-ai/dsh-subagent`,
`@deepseek-ai/dsh-llm`, and `@deepseek-ai/schemastery` all resolve into the dsh install.
A plugin does **not** need its own copy of host packages.

### 1.4 Model discovery — `ctx.llm` (`@deepseek-ai/dsh-llm`)

```ts
listProviders(): LlmProviderInfo[]                       // { id, name }
listModels(provider: string): Promise<LlmModelInfo[]>    // { provider, id, name, description?, inputModalities? }
resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>
resolveCallConfig(config, signal?): Promise<LlmCallConfig>
```

`LlmResolvedModelInfo` adds:

```ts
context?: { contextWindow: number }
defaultMaxTokens?: number
reasoning?: { efforts: {id,name,description?}[], defaultEffort?: ReasoningEffortId }
systemPromptUpdate?: 'in-history'
```

`LlmModelInfo.inputModalities` is `('text'|'image')[] | undefined`. **Explicit absent
means unknown; explicit omission is negative capability** (source comment). Catalog
membership is advisory and does not control routing.

Event: `llm/adapters-updated()` fires (payload-free) when adapters register/unregister
routes. Consumers re-read `listProviders()`/`listModels()`.

This is the entire capability surface the host exposes. **There is no pricing, no
tool-calling flag, no reasoning-strength score.** Any richer profile must be inferred or
measured by the plugin — never invented.

### 1.5 Programmatic delegation — `ctx.subagents` (`@deepseek-ai/dsh-subagent`)

```ts
registerProvider(provider: SubagentProvider): () => void
getProvider(name: string): SubagentProvider | undefined
list(): string[]
start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>
sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options): Promise<MessageId>
interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void
listChildren(parentSessionId, signal?): Promise<SubagentListEntry[]>
listDescendants(rootSessionId, signal?): Promise<SubagentDescendantListEntry[]>
drainContinuableChildren(parent: Agent, childIds, ...): Promise<void>
```

`SubagentStartRequest` (one-shot): `{ label?, prompt: ContentBlock[], parent: Agent,
signal, agentOptions?: AgentOptions, outputSchema?, maxDepth?, toolFilter?, persona? }`.

### 1.5.1 The listing reports no route — the label is the only record

Verified against the host types (`dsh-subagent/lib/types/control-types.d.ts` and
`projection-types.d.ts`). `SubagentListEntry` carries exactly:

```ts
{ kind: 'child'; id; activity: 'running'|'inactive'; hasChildren: boolean }
  & ({ mode: 'one-shot'; label?: string } | { mode: 'continuable'; label: string })
```

`SubagentDescendantListEntry` adds only `parentId` and `depth`. The projection the listing is
served from (`SubagentIdentityProjection`) folds `mode` and `label` and nothing else.

A child's own `subagent/descriptor` event **does** carry the route — `{ version, mode, provider,
label, agentProvider?, agentModel?, agentReasoningEffort?, persona?, toolFilter? }` — but it is
not folded into that projection. So the board cannot read a delegation's route from the listing,
and a plugin that wants to show one must write it into the `label` at spawn time. Observed
descriptors confirm the split is not incidental:

| Delegation kind | `label` carries the route | `agentProvider`/`agentModel` present |
|---|---|---|
| `orchestrate_run` (one-shot) | yes, `<name> via <route>` | **no** |
| native `subagent` tool (continuable) | no, just the tool's `description` | yes |

The two sources are disjoint: the route is recorded exactly where the listing will not show it.
`delegationLabel` (host) and the board's `lastIndexOf(' via ')` (client) are therefore a matched
pair, and `test/plugin-shape.test.js` asserts they still name the same marker.

`AgentOptions` (`dsh-agent/lib/types/runtime-types.d.ts`) is exactly:

```ts
{ provider?: string; model?: string; reasoningEffort?: ReasoningEffortId; maxTokens?: number }
```

**This is the model-selection seam.** `agentOptions` requires
`SubagentCapabilities.agentOptions`. The in-process `spawn` provider declares all five
capabilities true:

```js
capabilities = { agentOptions: true, outputSchema: true, depthLimit: true,
                 toolFilter: true, persona: true }
```

`SubagentResult` = `{ output: ContentBlock[], structured?: unknown, diagnostic?: string,
stopReason: 'completed'|'aborted'|'error'|'max-tokens'|'refusal' }`.

`SubagentRun` = `{ id, localAgent, result: Promise<SubagentResult>, dispose() }`. Always
`dispose()` to reach quiescence.

**Critical**: `agentOptions` computed by a plugin bypasses the model-facing
`subagent-model-selection` allow-list, which is a *tool-level* policy
(`dsh-tool-subagent/lib/model-selection.js` gates the tool's own arguments). A plugin
calling `ctx.subagents.start` directly is the trusted seam.

### 1.6 Agent

`Agent` (`dsh-agent`): `{ id, options: AgentOptions, session, inbox, status, ctx,
cancel(), whenIdle(), runMaintenance(), send(), followup(), steer(), inject() }`.

The calling agent for a tool call is `exec.agent` (`ToolExecutionInput.agent`, "set by
the agent loop"). `ctx.agents.currentInitiator()` is the process-local causal parent.

### 1.7 Tools

`ctx.tools.register(definition): () => void`. Definitions come from `defineTool`
(`@deepseek-ai/dsh-tools`):

```ts
defineTool({
  name, description,
  parameters: { /* implicit open object root, `required: true` per property */ },
  output: { schema, render(args, value): ContentBlock[], presentationMeta? },
  timeoutMs?, isConcurrencySafe?(args), execute(args, exec): Promise<value>,
  finalizeContent?, presentCall?, presentResult?,
})
```

Argument specs are a restricted DSL; `type: 'object'` requires
`additionalProperties: boolean`; `type: 'json'` is unconstrained lossless JSON.

### 1.8 System prompt

`ctx.systemPrompt.section({ name, order, text, complete? })` →
`PromptSection`. Scoped sections shadow global ones with the same name. `text` may be a
function of the assembly context.

### 1.9 Client UI

- A static client half is a pre-built bundle calling
  `window.__ModuleLoader__.load({ id, factory })` where `factory(require)` returns
  `{ name, inject, apply }`. The client `apply(ctx)` may use `ctx.slots`.
- `ctx.slots.inject(key, () => ctx.slots.register({ name, id, order, label }, Component))`.
- Live slots confirmed present in this deployment: `settings.section` (list, root),
  `conversation.input.dock` (list, session), `shell.overlay` (list, root,
  `replaceRisk: none`).
- `settings.section` registration takes `{ id, order, label }` and the component receives
  `SettingsSectionOwnerProps` = `{ close }` plus standard hooks
  (`useSessions`, `useWorkspaces`, `useResource`, `usePanelInfo`, …).
- `conversation.input.dock` takes `{ id, order, label }` and its owner props are
  `InputZone` = `{ session, input }`, plus `useSession`, `sessionId`, `useProjection`, …
- `conversation.input.dock` is **session-scoped** — ideal for a per-session routing strip.
- Client→host transport: the established community pattern is a host HTTP route plus
  `fetch` from the client (`dsh-agent-teams` registers `/plugins/<pkg>/<action>` via the
  `webServer` service). Cordis Remotes (`TypertRemoteService`) are the other option.

### 1.10 Resolving `webServer` from a plugin — a real trap

This one cost the most time and is not obvious from any single file.

The web server is provided by a sibling row of the **same** composition, and it is
frequently registered *after* this plugin activates. From the plugin's own context:

- `ctx.get('webServer')` returns `undefined` — Cordis's property resolution walks the
  fiber chain, does not reach the provider, and a non-injected name throws
  `cannot get property "webServer" without inject`;
- `ctx.get('webServer', false)` (non-strict) returns the *plugin context* that
  registered under that name, not the service;
- an `internal/service` listener fires for `webServer` while `ctx.get` still cannot see it;
- wrapping `ctx.inject([...])` inside `ctx.effect` confines the service wait to the
  effect's scope, so the callback never runs.

The working pattern is the one the harness's own `dsh-client-modules` uses:

```js
if (ctx.get('webServer') === undefined) ctx.inject(['webServer'], register)
else register(ctx)                                  // fast path for a reload

// inside the callback the injected context exposes the service directly:
webCtx.effect(() => webCtx.webServer.register(route))
```

Two consequences are baked into `lib/routes.js`:

1. `installControlRoutesDeferred` must be called **directly** in `apply`, never inside
   `ctx.effect`, or the injection never fires.
2. The `connection` authentication overlay is **optional per deployment** — this
   deployment's service catalogue does not provide it at all. Requiring it in the same
   `inject` array would mean the routes never mount. It is therefore resolved per request,
   and when it is absent a same-origin loopback fence applies instead, which fails closed
   on a foreign or missing `Host` and on a cross-origin `Origin`.

## 2. Architecture

Host-only, single row, no realm (it consumes host registries and publishes nothing).

```
dsh-model-orchestrator (Host)
├─ compatibility gate      → blocks activation when the host is unsupported
├─ capability taxonomy     → open, extensible, domain-agnostic
├─ model discovery         → ctx.llm.listProviders/listModels/resolveModelInfo
├─ capability profiling    → metadata + optional self-description calibration
├─ task analysis           → task text → required capabilities + complexity
├─ matcher                 → deterministic capability/route scoring
├─ orchestrator            → direct | specialist | multi-agent execution
├─ persistence             → preferences + profiles (never the live pool)
├─ tools                  → orchestrate_*, discover_models, calibrate_models
├─ prompt section          → tells the calling agent when to orchestrate
└─ client UI               → settings page + per-session dock, over host RPC
```

### 2.1 Why tools and not a model interceptor

The host exposes no seam that lets a plugin retarget the *main* agent's model per turn;
`Agent.options` is fixed at creation. The supported seam for choosing a model is
`agentOptions` on a **child** agent (`ctx.subagents.start`). So the orchestrator works as:

1. The main agent (the task owner) keeps its own route and stays the user-facing surface.
2. The plugin selects a route per **unit of work** and spawns a child on it.
3. Expert output returns to the main agent as the tool result; the main agent finishes
   the delivery. This satisfies "experts return to the main task".

This is a deliberate consequence of the real API, not a simplification.

### 2.2 Captain

The captain is a **role**, not a model binding. It is the task owner: it understands,
decomposes, dispatches, aggregates, verifies, and closes. Two supported shapes:

- **Main-agent captain** (default): the session's own agent captains; the plugin supplies
  routing and dispatch.
- **Spawned captain**: for complex work the plugin selects a route for the captain role
  and runs the planning/reporting loop through a child. The captain route is recorded in
  the plan and is fully dynamic.

In both shapes the captain's model is chosen by the matcher from the live pool.

### 2.3 Capability model — open and extensible

Capabilities are *generic descriptors with an open key space*, never a fixed
model→domain table:

```
CapabilityDescriptor = {
  id: string            // any dot-free or dotted slug, e.g. 'reasoning', 'vision.ocr'
  label: string
  group: string         // broad family, free-form
  signals: Signal[]     // how the host could evidence it
  antiSignals?: Signal[]
  requiresModality?: ('text'|'image')[]
  minContextWindow?: number
  minOutputTokens?: number
  needsReasoning?: boolean
}
```

A `Signal` is a predicate over observable evidence:

- `modality` — `inputModalities` includes it
- `contextAtLeast` / `contextAtMost` — `context.contextWindow`
- `outputAtLeast` / `outputAtMost` — `defaultMaxTokens`
- `reasoning` / `reasoningLevels` — `reasoning.efforts`
- `nameMatches` — regex over `id`/`name`
- `selfReport` — the model's own calibrated claim

The seed taxonomy covers software, data, research, writing, math, science, multimodal,
documents, web, and engineering analysis as **starting descriptors**, and
`orchestrate_plan` may synthesize a **new descriptor** for an unrecognized domain, which
is persisted so the taxonomy genuinely grows. No model name appears in the taxonomy.

### 2.4 Profiling honesty

Per-model capability evidence is layered, weakest to strongest:

1. **Metadata** (authoritative): modality, context window, output cap, reasoning efforts.
2. **Declared description** (host-provided): matched against descriptor signals.
3. **Calibrated self-report** (measured, opt-in): the plugin asks each model to describe
   its own strengths against the current taxonomy and records the answer.

Nothing is invented. A missing `inputModalities` yields `unknown`, never `false`, so the
matcher can refuse to route an image task to an unverified model.

### 2.5 Matching

Deterministic and inspectable:

```
score(model, task) = Σ_cap weight(cap) · evidence(cap, model) · confidence
                   − penalty(missing required cap)          → hard reject
                   − costPenalty(tier) + preferenceBonus
```

Hard requirements (`requiresModality`, `minContextWindow`, `minOutputTokens`) reject
before scoring, so an unsuitable model is never silently downgraded.

### 2.6 Orchestration tiers

| Tier | Condition | Action |
|---|---|---|
| `direct` | no specialist capability needed, low complexity | Main agent executes; no child |
| `specialist` | one capability cluster dominates | One child on the matched route |
| `multi-agent` | ≥2 independent clusters or multi-step | DAG of children, aggregated by the captain |

`orchestrate_run` executes a plan: it spawns children (optionally in dependency waves),
collects `SubagentResult`s, and returns a structured aggregate. Every child is disposed.

### 2.7 Persistence

`$DSH_HOME/orchestrator/state.json`, written atomically (temp + rename):

```json
{
  "schemaVersion": 1,
  "mode": "auto",
  "guided": { "capabilities": [] },
  "preferences": { "maxParallel": 4, "preferCheaper": true, "deniedRoutes": [] },
  "taxonomy": { "custom": [] },
  "profiles": { "<provider>/<model>": { "...": "calibrated evidence" } },
  "runs": [ { "...": "bounded recent history" } ]
}
```

**The live model pool is never persisted.** Routes are re-discovered on every start,
every `llm/adapters-updated`, and on demand; a stored profile is keyed by route and is
dropped when the route disappears from the pool.

### 2.8 Compatibility gate

On activation, before any registration:

1. Resolve the running DSH version by resolving `@deepseek-ai/dsh/package.json` via
   `createRequire` from the plugin, then compare with `semver.satisfies` against
   `engines.dsh` read from the plugin's own manifest.
2. Probe the runtime contract: `llm` + `llm.listProviders`/`listModels`,
   `subagents` + `subagents.list`/`start`, `tools` + `tools.register`,
   `systemPrompt` + `systemPrompt.section`.
3. Probe at least one usable provider with a promise-returning `listModels`.

On any failure the plugin **must not** register anything, must log a precise reason
(satisfied range, found version, missing symbol), and must throw so the row fails loudly
instead of silently degrading. `apply` is wrapped so the failure is reported once, clearly.

## 3. Native task execution is not replaced

**Hard requirement:** the orchestrator must not damage the harness's native task
execution experience, and must not create a task-state system that conflicts with DSH's
native task list or progress.

The orchestrator therefore behaves as a **scheduler invoked inside** normal task
execution, never as a parallel task manager.

### What DSH keeps owning

| Concern | Owner | How the orchestrator respects it |
|---|---|---|
| Task list, plan, steps | DSH (`todo_write`, plan mode, the agent loop) | It registers no task, step, or plan tool. Its tools are all `orchestrate_*` routing tools. |
| Progress and step status | DSH | It renders no progress surface and emits no custom Cordis event. |
| Session transcript | DSH session log | It appends no custom session event, so no extra row appears in the conversation. |
| Subagent visibility | DSH (`ctx.subagents` catalog + subagent views) | It delegates through `ctx.subagents.start`, so every child is an ordinary DSH subagent attributed to the calling session and visible in the normal subagent UI. |
| What was done | DSH session log | It persists no run history. The durable record of a turn — the tool call, every child session, every result — is already in the log. |

### What the orchestrator owns

Only two things:

1. **Model selection** — which route runs a unit of work.
2. **Dispatch shape** — whether a task needs one specialist or several, and how those
   units are ordered.

### What it deliberately does not keep

- No task list, step status, or progress state, in memory or on disk.
- No run registry, no "live runs" listing, no run history (a bounded run history was
  removed during development precisely because it duplicated the session log).
- No custom session event, so the transcript is not polluted with routing rows.
- No client view of task state. The panel shows *routing capacity* — pool size, in-flight
  delegation count, calibrations — never what work is outstanding.

The only live bookkeeping is a set of abort controllers for delegations currently in
flight, used solely so plugin teardown can abort children instead of orphaning them. It
is not queryable and is never exposed as task state.

### How an expert result returns

The child runs on the harness's native path, so its result arrives as the **tool result**
of the `orchestrate_*` call the captain made. The captain then writes the final answer.
Nothing about the delegation bypasses or shadows the normal tool-result flow.

These guarantees are pinned by tests in `test/plugin-shape.test.js` (no task-like tool
name, no task parameter, no `session.append`, no `ctx.emit` from the plugin, no run
history in the panel) and by `test/persistence.test.js` (the state schema contains no
`runs`, `tasks`, `steps`, `progress`, `todo`, or `plan` key).

## 4. Deliberate non-goals

- No dependency on `@nanmicoder/dsh-agent-teams` or any third-party orchestrator.
- No hardcoded model names, no model→domain table, no provider allow-list.
- No modification of DSH core or `node_modules`.
- No domain specificity: the taxonomy is generic.
