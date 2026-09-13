# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Model identity and assignment resolution** (`lib/model-identity.js`). The pool churns —
  models are added, renamed, moved behind another provider, and bumped to a new version — so a
  capability→model assignment cannot be stored against a route without rotting silently. It is
  therefore stored against a model *identity* and resolved against the live pool every time.
  Identity is mechanical and answers only "is this still the same model": case, separators and
  parenthetical vendor tags collapse, a route answers to several keys so that
  `deepseek/deepseek-v4.1-flash` and its declared name `DeepSeek V4.1 Flash (CC)` meet, and a
  version-less family key lets one assignment survive a version bump **when the user opts into
  following the family**. Resolution walks route → identity → family and reports every failure
  as unresolved rather than guessing: a truncated spelling like `Qwen3.8-Max` for
  `Qwen/Qwen3.8-Max-0902` stays unresolved, because the prefix rules that would catch it are the
  same ones that silently route `gpt-5.6-sol` work to `gpt-5.6-sol-vision`. That boundary is the
  argument for the panel offering a picker over the live pool instead of a free-text field.
  **Not yet wired into routing** — persistence, the matcher, the cluster split, and the panel
  follow; this is the resolution core they are built on.

### Changed

- **The duplicated routing-capacity card is gone from the settings page.** Its three figures
  (in-flight, calibrations, capabilities) restated what the Orchestrator board already shows for
  the session being looked at. The one line worth keeping — that task lists, step status, and
  progress are DSH-native and the orchestrator keeps no task state of its own — stays as a plain
  note; it answers a boundary question, it is not a statistic. The board, not the settings page,
  is now the single place those figures live.
- **The model pool's Reasoning column no longer stretches the table.** The shared input style
  grows to a 180px minimum, which is right for a free-text field and wrong for a column whose
  content is at most four characters; the selector is now 84px. The cost preference's hint also
  states its real limit: it shapes tie-breaks between routes of differing measured tier, so with
  a pool where every route shares one tier it does nothing at all (see the reasoning-effort
  entry below for why cost cannot be measured here).

### Changed

- **The capability areas are now gated on Guided mode, and reveal themselves.** They were
  rendered unconditionally, so in Auto the page offered a control that changed nothing — a list
  whose contents are never consulted reads as broken. The panel is now collapsed in Auto behind
  a one-line explanation of where it went, and choosing Guided slides and fades it in over
  ~340 ms instead of swapping the layout. The transition is a stylesheet class rather than
  inline styles, because `prefers-reduced-motion: reduce` has to be able to switch it off. The
  panel's own mode copy was rewritten to match the buttons: the Chinese text used to say
  "Auto"/"Guided" while the buttons said 自动/引导, which made the two modes hard to follow —
  the same complaint that produced the earlier copy pass. The capability copy now says 引导 too,
  and two lines were added so the collapsed state explains itself rather than looking missing.

### Added

- **Reasoning level per route, chosen in the model pool and applied at dispatch.** The
  **Reasoning** column is now a selector whose options are the levels the host reports for that
  route (`reasoning.efforts`), plus **default** — "let the model resolve its own", labelled with
  the host's `reasoning.defaultEffort` when it reports one. The choice persists per
  `provider/model` and becomes `agentOptions.reasoningEffort` on every delegation to that route,
  so the captain dispatches at the level the user set. Resolution order is the calling model's
  own level for the unit, then the configured preference, then the capability descriptor's
  declared level, then the model default — and the unit result reports the level actually used.
  A level the route does not advertise is refused at configure time, and **ignored** if it goes
  stale, because sending an unsupported effort fails the child outright with
  `UNSUPPORTED_REASONING_EFFORT`; the pool reports such an entry instead of showing it as
  applied. Settable from the panel and from `orchestrate_configure`, through one shared
  validation module (`lib/reasoning-effort.js`).

### Fixed

- **`decisionCues` never survived a write, so the operator-replaceable cue vocabulary was
  impossible to keep.** `normalizePreferences` re-normalizes the preference block on every save
  *and* on read, and it did not carry `decisionCues` — so `orchestrate_configure` reported the
  replacement applied and it was gone before it could ever be consulted, leaving `status` and the
  panel reporting the built-in fallback forever. Caught by a new test that asserts every declared
  preference key survives a write and a reload, so the next key added cannot disappear quietly.
- **A caller's own reasoning level for a unit was dropped at intake.** `normalizeRequirement`
  carried capability, weight, floors, and modality, but not `reasoningEffort`, so a model that
  named a level for one unit could not actually enforce it.

### Added

- **`/model-orchestrator <task>`** — an explicit switch for the case the routing policy cannot
  force: the calling model deciding to delegate on its own. A command handler runs *without the
  command line reaching the model* (the host's command contract, verified against
  `@deepseek-ai/dsh-commands` and the shipped `/goal`), so the handler delivers the task itself
  as an ordinary user message — the same `agent.followup(...)` mechanism `/goal` uses — together
  with the instruction to call `orchestrate_run` and to name per-unit routes when the units
  differ in kind. `/model-orchestrator status` reports live routing capacity and opens no turn.
  `recordInput: false`, because the follow-up message owns the payload. `commands` is declared
  an optional service: without it the command is simply not registered and every tool, prompt
  section, and control route still works. The module imports nothing from the host at load time,
  so its tests run on a machine with no DSH installed.

### Fixed

- **A caller-supplied analysis was discarded whenever it stated no requirements.** The intake
  gated on the requirement count, so an analysis carrying a summary, a complexity and model
  preferences but no `requirements` fell through to the local vocabulary **whole**: the caller's
  complexity claim, and more damagingly its `modelPreference` / `unitModelPreference`, silently
  did nothing. Observed live — a plan whose preferences named two different routes routed both
  units to the same measured top model, and nothing in the result said so. The requirement set
  is the one field a caller may legitimately leave out, so it is now filled from the vocabulary
  while every other supplied field is kept, and the result reports `source: "model+local"`.

### Changed

- **The routing policy now says when to route instead of spawning natively.** Observed live: a
  captain delegated four heterogeneous research units through the native `subagent` tool with no
  route, so every child inherited the deployment's single default child model — four different
  research areas, one model. The section now states the trigger (units that differ in kind) and
  the failure it prevents (a child spawned without an explicit route inherits one default), and
  `orchestrate_run` / `orchestrate_dispatch` each say in their own description why they are
  preferable to a native `subagent` call when the model choice matters. The plugin cannot forbid
  the native tool — it must not replace DSH's native execution — so steering the captain is the
  only lever it has, and this is it.
- **Guided mode's prompt line was ungrammatical**: "Mode: Guides the user selected the
  capability areas…" now reads "Mode: Guided. The user selected the capability areas…".

### Fixed

- **`orchestrate_dispatch` delegations reached the board with no route.** The board recovers a
  delegation's route from its label, because the host's descendant listing
  (`ctx.subagents.listDescendants`) reports a child's `mode` and `label` and nothing about its
  provider or model — the descriptor that does carry `agentProvider` / `agentModel` is not folded
  into that listing. `orchestrate_run` wrote `<name> via <route>`; `orchestrate_dispatch` wrote a
  bare name, so one plugin showed a route for one delegation kind and none for the other. Both
  paths now build the label through a single `delegationLabel` helper, which bounds the name
  *before* appending the route so the spawn path's tail truncation cannot erase it.

### Changed

- **The board no longer claims every node is orchestrator work.** It lists every subagent of the
  session — including the ones DSH started by itself through the native `subagent` tool — while
  its copy asserted that "each node is a subagent the orchestrator started". The description now
  says what the board actually shows, and a delegation carrying no route is marked **native
  delegation** (「原生委派」, "由 DSH 原生启动") instead of "route not recorded", which read as
  lost data rather than as an accurate statement of provenance.

### Fixed

- **A Chinese charting task was read as a request to READ an image.** The tokenizer emits one
  token per CJK character, so a keyword was matched as a set of characters rather than a
  phrase: 图表 matched any text containing both 图 and 表 anywhere, and the single character
  图 in the vision keywords matched every compound containing it. `用 pandas 读取 csv 并画一张
  柱状图` therefore required an image-capable route, wrongly excluding every text-only model
  from a task that needs coding and numeric work. CJK keywords are now matched as contiguous
  substrings, the over-broad single character is gone, and genuinely visual phrasings
  (这张图, 看图, 附图, 截图, 图片) are named explicitly. The English path always agreed; the
  defect was Chinese-only.


### Added

- **`analysis.unitModelPreference` routes units individually.** A whole-task preference is
  too coarse for a plan that holds a vision unit and a maths unit. Each entry addresses a unit
  by exact capability id or by cluster, with the most specific target winning for the unit it
  names; units that match nothing keep the task-level preference or the measured ranking.
  Verified end to end against the live routes.

### Fixed

- **A model preference was being re-sorted away.** Candidates the caller named were still
  ordered by measured score, so a preference only took effect when the preferred model
  happened to score highest. The caller's relative order is now preserved among the
  candidates it named, and only the rest keep the measured ordering.
- **A caller-named capability did not inherit that capability's hard requirements.** Naming
  `multimodal.screenshot` meant "must read an image", but the descriptor's modality floor was
  only applied on the local analysis path — so a requirement was merely a preference, and a
  per-unit preference could place a text-only route on work it cannot do. Caller entries now
  inherit the descriptor's required modality and floors, and an ineligible name falls through
  to the caller's next name instead of being used.


### Fixed

- **A model's complexity judgement was being overruled.** The plugin took the maximum of the
  claimed and the locally observed level, framed as a safety net. With the levels ordered
  `trivial < simple < specialist < complex`, that silently DEMOTED a model claiming `complex`
  against a locally observed `specialist`, and promoted a claim of `trivial`. A model's
  reading of the task is now used as given; the local phrase list is consulted only when no
  analysis was supplied.

### Changed

- **Task judgement is the model's; the plugin's cue lists are a fallback.** The six
  hardcoded cue lists were decision heuristics that recognized only the wording their author
  happened to write. They now live in `lib/decision-vocabulary.js`, are documented as a
  fallback, and can be replaced through `orchestrate_configure`'s `decisionCues` (one group
  at a time, with an empty list ignored so a dimension cannot be disabled by omission).
  `orchestrate_status` reports whether the vocabulary is built-in or operator-owned, and
  which groups were replaced.


### Added

- **Model selection is now informed by the calling model, under the plugin's constraints.**
  The plugin measures what the harness exposes and enforces the deployment's route policy, but
  it cannot know that a given route id is a vision-strong or maths-strong public model — a
  judgement the calling model already has and the plugin must not invent. `orchestrate_run` and
  `orchestrate_plan` now accept `analysis.modelPreference`: named routes, most preferred first,
  with reasons. A preference reorders eligible candidates, can never revive a route that the
  requirements rejected, and any name the pool does not recognise is reported back rather than
  dropped. Malformed entries are discarded, and an absent preference leaves the measured
  ranking untouched. The tool description tells the calling model to use its own knowledge.

### Fixed

- **Capability-based allocation actually discriminated, which it did not before.** Three
  defects, all observed against the live pool of eleven routes:
  - A task that **stated its own size** ("900,000 token", "1.05m token") produced no capacity
    requirement at all, so a route with a 500K window stayed eligible. Explicit sizes in both
    English and Chinese are now read and enforced, while a bare small count ("12 items") is
    correctly ignored.
  - A **needs-image requirement was not derived from the task text** ("attached image",
    "附图"), so text-only routes competed for work they cannot do. With the live pool this now
    rejects them.
  - A descriptor with **no matching keyword scored a hard zero**, and because descriptors
    combine by geometric mean that single zero vetoed an eligible model outright — so routing
    turned on whose description happened to contain a keyword. Silence now scores a small
    floor: it cannot veto, and it cannot outrank stated evidence either.


### Fixed

- **Activation no longer performs network I/O, which was slowing every profile boot.**
  The compatibility gate probed each provider with `listModels()` to prove the pool was
  usable, and the bundled third-party provider refetches its catalog over HTTP on every
  call with a 10s timeout. Measured on a real profile: boot took **6.7s with the plugin
  versus 3.9s without**; after the fix it is **3.88s**, matching the baseline within 3ms.
  The gate now checks only that a provider route is registered and reports an unresponsive
  provider as a pool problem instead of refusing activation.
- **`/state` no longer re-discovers providers on every poll**, which made opening the
  settings page slow and hammered the provider. Re-discovery now happens only on an explicit
  `?force=1` (the panel's Refresh) or on an adapter-topology change. `/plan` no longer
  discovers at all.

### Changed

- **The board now follows the transcript width handle.** The shell's width handles resize
  the content column, and the board takes that same width, so dragging the handle resizes
  this view exactly as it resizes the Chat page's composer. Implemented as a CSS width
  chain — the shell's own variable, then an observed copy of it, then the shell's 920px
  ceiling — inside a clamp with a floor, so an unresolved variable can never collapse the
  view. The earlier fill-the-column layout put the board's content straight underneath
  those handles, which read as a stray draggable bar over the board.

### Removed

- The model-pool rating, and the "Suitable for (stated)" and "Basis" columns. All three
  read as low-value or misleading: the rating graded models only relative to the current
  pool (so one model scored 1 against everything else at 5, which reads as a verdict it
  does not support), and the domain and evidence columns were usually empty or expressed in
  internal vocabulary. The pool now shows Route, Tier, Context, Image, and Reasoning.


### Added

- **The model pool now follows the deployment's subagent route policy.** Discovery reads the
  LLM registry, which advertises every model every adapter has — so a profile with two
  providers mounted showed the same underlying model twice and listed routes the user never
  enabled. The pool is now narrowed by `subagentModelSelection.current()` (the exact routes
  the Settings page offers for subagent selection) and then by the user's own
  `allowedRoutes` / `deniedRoutes` preferences. The policy applies only when the service
  exists, is enabled, and names a route; an absent or empty policy leaves discovery intact
  rather than filtering everything out. Routes are matched exactly, so the same model id
  under two providers is never silently collapsed. `lib/route-policy.js`, ten tests, and a
  panel line that says which layer narrowed the pool.


### Fixed

- **Activation crashed in a real deployment.** A Cordis plugin context is a proxy:
  reading a name the composing plugin does not inject THROWS rather than returning
  `undefined`. The route installer used `ctx.webServer ?? ctx.get('webServer')`, and `??`
  evaluates its right-hand side whenever the left is nullish, so the boot failed with
  `cannot get property "webServer" without inject`. The service is now acquired with
  `ctx.inject(['webServer'], …)` unconditionally, and handed to the router as an explicit
  argument. Found by booting the plugin inside the deployment's own composition.

### Added

- `test/lifecycle.test.js` and `test/helpers/fake-context.js`. The lifecycle suite pins
  interruption behaviour: a cancelled delegation becomes a recorded failure and is still
  disposed, an infrastructure rejection is contained, `abortAll` is idempotent, a cold
  restart resumes purely from the state file, a truncated state file is tolerated and
  repaired, and a newer schema is refused. The fake context now reproduces the host's
  throwing service resolution **and** exposes granted services as context properties —
  the two contracts whose absence hid the activation bug.


### Added

- **Orchestrator board** — a Conversation view beside `Chat` and `Trajectory` showing the
  session's delegation graph, live stats, and routing capacity. The graph is built from the
  harness's own durable session tree (`ctx.subagents.listDescendants`); the plugin keeps no
  copy of the topology.
- `lib/agent-tree.js`: turns the flat descendant listing into a parent/child tree and
  display rows. Handles orphans (re-attached to the root rather than dropped), duplicates,
  cycles, malformed rows, and a node cap, each covered by tests.
- `scripts/locale-tool.py`: edits a locale value by key without disturbing neighbouring
  entries, because the dictionary exists twice (source of truth plus the self-contained
  client bundle).

### Changed

- The ambient composer strip is gone. The board replaces it and reads the live tree
  instead of a local mirror.
- **The board is now a real graph rather than a list.** A styled root task node, a
  vertical spine, and one card per delegation showing its ordinal, live status, the
  capability it was matched on, the model it was routed to, its mode, and the durable
  child id — with an animated activity bar on the running node, a legend, and a pool
  meter. Presentation is a namespaced stylesheet injected once, built on
  `--dsw-alias-*` tokens so both themes work. The `"<capability> via <route>"` label the
  harness records is split so the capability reads as the title and the model as its own
  chip.

### Fixed

- **Multi-unit plans now chain.** Chaining was gated on the routing tier, so a task judged
  `specialist` with several units ran every unit in parallel (`dependsOn: []`), and later
  stages never saw earlier findings — observed live on a "research, then review, then
  summarize" task. Serialization is now a property of the graph, not the tier.


### Added

- **Localization.** Every user-facing string now lives in the plugin's own
  `modelOrchestrator` locale namespace and follows the harness language setting, so the
  panel switches between Chinese and English with the rest of the UI. Strings a **model**
  reads (tool descriptions, parameter schemas, the routing prompt section, personas) stay
  English on purpose.
- A terminology policy with tests: generic vocabulary (`host`, `requires`) and
  harness/pipeline identifiers (`provider`, `Route`, deployment ids such as
  `workflowEngine`) are never translated, and version strings like `0.1.5-rc.1` pass
  through verbatim.

### Fixed

- The model-pool table now scrolls horizontally instead of squeezing its rightmost
  column out of view, and CJK column headers no longer wrap mid-word.


## [0.1.0] — 2026-09-13

Initial release. Generic, domain-agnostic Model Orchestrator for DSH `0.1.5-rc.1`.

### Added

- **Dynamic model discovery.** Reads the live LLM registry at activation and on every
  `llm/adapters-updated` event. No model name, provider, or vendor is hardcoded, and the
  pool is never persisted, so a restart always re-reads reality.
- **Capability profiling.** Builds a per-model profile from authoritative host facts
  (input modalities, context window, deployment output cap, exposed reasoning efforts) plus
  the provider's declared description, recording the evidence source for each.
- **Open capability taxonomy.** 25 seed descriptors spanning software, data, reasoning,
  science, research, writing, multimodal, document, web, throughput, depth, and capacity
  families — none tied to a model. Unknown domains mint a new descriptor from the task's
  own vocabulary, and learned descriptors persist across restarts.
- **Deterministic matching.** Conjunctive (geometric-mean) scoring so one failed
  requirement cannot be masked by strength elsewhere; hard requirements (modality, context
  floor, reasoning availability) reject before scoring; an unknown modality is treated as
  unknown rather than capable. Cost shaping only breaks ties.
- **Three orchestration tiers.** `direct` (no child), `specialist` (one child on the matched
  route), and `multi-agent` (several children, optionally in dependency waves).
- **Two modes.** Auto (infer requirements from the task) and Guided (seed matching with
  user-selected capability areas).
- **Dynamic captain.** The captain is a role, not a model binding; its route is selected by
  the matcher. Main-agent captain is the default.
- **Seven model-facing tools.** `orchestrate_run`, `orchestrate_dispatch`,
  `orchestrate_plan`, `orchestrate_models`, `orchestrate_capabilities`,
  `orchestrate_configure`, `orchestrate_status`.
- **Routing-policy prompt section.** Teaches the calling agent when to delegate, when not
  to, and that it owns the final answer.
- **Web control panel.** A `Model Orchestrator` settings page (mode, capability areas, live
  pool, preferences, routing preview, run history) and a compact per-session routing strip,
  served over authenticated host control routes.
- **Atomic persistence.** Preferences, learned descriptors, and per-route calibrations are
  written temp-then-rename. Run history is bounded. A newer on-disk schema is refused
  without overwriting the file, so a downgrade cannot corrupt state.
- **Activation compatibility gate.** Verifies the declared `engines.dsh` range against the
  running host using the host's own `semver`, probes every required Service and method by
  name, and requires at least one provider to answer a model listing. On any failure it
  registers nothing, reports every reason precisely, and throws rather than degrading.
- **68 dependency-free tests** covering the taxonomy, matching, engine, persistence,
  compatibility, plugin shape, and the client bundle — including executing the client
  bundle through a mock module loader.

### Notes

- Routing uses the harness's supported child-model seam (`ctx.subagents.start` with
  `agentOptions`). A running agent's own route cannot be retargeted per turn, which is why
  the orchestrator delegates rather than reassigning the caller.
- `defaultMaxTokens` is a deployment-chosen cap, not a model ceiling, so it is treated as
  soft evidence and can never hard-reject a model.
- Only `spawn` and `fork` subagent providers are consulted; any registered provider that
  advertises the `agentOptions` capability works.

[Unreleased]: https://github.com/example/dsh-model-orchestrator/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/example/dsh-model-orchestrator/releases/tag/v0.1.0
