# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.8] — 2026-09-14

### Fixed

- **A caller-supplied unit's `route` was ignored, and an omitted route was never routed — so every
  caller-supplied unit failed.** Reported from a real session whose caller supplied four units, each
  naming a route and no `provider`/`model`. The route was copied onto the unit but never resolved
  into the pair a dispatch needs, so all four reached the dispatch guard with no provider and came
  back as `error: "supplied by the caller"` and `cancelled: true`. Both behaviours are documented on
  the `units` parameter — pin a route, or omit it and be routed — and neither existed. A supplied
  unit now resolves its `route` (or an explicit provider and model) against the live pool, and
  otherwise is routed by the capability it names, with the caller's per-capability preference
  honoured. A named route that is no longer in the pool degrades to capability routing and reports
  `routeRequested`, because the pool changes under a session and a stale name should not cost a unit.
- **The refusal for an unroutable unit reported a route REASON as its error, and claimed it had been
  cancelled.** `error` was `unit.routeReason` — for a supplied unit the text `"supplied by the
  caller"`, which explains the route, not the failure — and `cancelled: true` was set for a unit that
  had never been started. It now reports `no route: <why>` with `notStarted: true`. Dating from the
  first release, this is what made a caller read its own rejected graph as the problem.

### Changed

- **The `units` parameter says that a unit's `prompt` should be short.** The run's `task` is added to
  every unit's prompt already, so repeating it inflates a hand-written JSON argument — and a real
  call in the same session was rejected by the host as `invalid arguments: "arguments" must be an
  object` because the payload had been written incorrectly at 5 kB. That rejection is the caller's,
  not the plugin's; this makes it less likely.

## [0.2.7] — 2026-09-14

### Fixed

- **Node 22 failed the suite with 7 tests cancelled; Node 24 passed by luck.** The budget timer is
  deliberately `unref`'d — a bound must not hold a host process open — and the test that exercises it
  relied on the event loop staying alive long enough for a 30 ms timer to fire. On Node 22 the loop
  drained first, so the child's result promise never settled and the runner cancelled the remaining
  tests in that file with `Promise resolution is still pending but the event loop has already
  resolved`. The test now supplies the liveness the host provides in production. Verified against a
  real Node 22.23.2, three runs, plus Node 24.
- **The host-dependent checks silently required this machine's install layout.** They located the
  host's packages at `<install>/node_modules/@deepseek-ai/…`, which is true of a version-manager
  install and false of a global one: npm **hoists** a globally installed CLI's dependencies to the
  top level. Against a published `npm install @deepseek-ai/dsh@0.1.5-rc.1`, **18 checks failed** —
  every one that exercises the real host contract, which is exactly the half that matters for a
  plugin others install. The helpers now reproduce Node's own resolution (nested first, top level
  as the fallback, the CLI always linked) and resolve host modules through the host's manifest
  instead of a path inside it. Three local copies of that logic are now one.

### Added

- **CI runs the suite against a real, published harness.** The bare-checkout job can only ever prove
  that the host-dependent checks *skip*; a second job installs `@deepseek-ai/dsh@0.1.5-rc.1` and runs
  the same 312 checks with **nothing skipped**. That is the guarantee a user cares about, and adding
  it is what exposed the layout assumptions above.

### Verified

- 312 checks, 0 skipped against a version-manager install, against a **freshly published npm install**,
  and on **Node 22 and 24**. With no harness at all: 296 pass, 16 skipped, 0 fail.

## [0.2.6] — 2026-09-14

### Fixed

- **The repository's own CI failed on every push, for a reason unrelated to the plugin.**
  `node scripts/check-compat.mjs` reported `RESULT: incompatible` and exited 1 when it could not
  find a DSH installation — which is the normal state of a fresh clone and of every CI runner, so
  the workflow added in 0.2.0 was red from its first run. A missing host is a condition of the
  machine, not a verdict about this build: the check now reports `not verified` and exits 0, still
  validating the parts that need no host (the declared range, the `dsh.engines.dsh` mirror, the peer
  declarations, `compatibility.json`). `--strict` keeps it fatal for a release gate, exiting 2 —
  "could not run" — rather than 1, which means "incompatible".

### Added

- **`DSH_TEST_HOST=none` models a bare checkout.** Every host-dependent check is supposed to skip
  when no harness is present, and that is the state CI runs in, but there was no way to produce it
  locally short of uninstalling DSH. The workflow now sets it, so the path is deterministic and a
  future check that forgets its skip guard fails in CI rather than on a user's machine. The three
  outcomes are pinned by a test that spawns the script: bare is a skip, bare with `--strict` is
  fatal, and a host present is compatible.

## [0.2.5] — 2026-09-14

### Fixed

- **The model pool could not follow a changed provider model list or subagent route policy.**
  Reported from a real deployment. Two defects produced the same symptom, and each hid the other.
  Discovery ran only when the pool was **empty**, so it effectively ran once per process: neither a
  provider's new model list nor the deployment's subagent route policy emits the host's
  adapter-topology event, so both were invisible until a restart. And while the `/state` route has
  supported `?force=1` — with its own passing tests — the panel's **Refresh** never sent it, so the
  one control that looked like a fix re-read the same cached snapshot. Now: the provider-id set is
  compared on every call (a synchronous registry read, so an adapter appearing or disappearing is
  caught even if the host's event is missed), a discovery older than five minutes is re-read lazily,
  and the panel's Refresh actually forces one. A stale re-read that fails keeps the pool that already
  exists — a provider being slow or offline must degrade routing, never break the call that tripped
  the timer.
- **A route allow/deny change did not re-narrow the pool.** The filter ran only inside a discovery,
  so after changing it the panel kept showing the previous sets while routing already used the new
  ones. The pool now keeps what the registry advertised, and a configuration write re-applies the
  filter to it — free, because re-filtering needs no provider call.

### Changed

- **The README's discovery row was false and now is not.** It claimed discovery happens "whenever the
  adapter topology changes", which was true only for the one case the host emits an event for, and
  silent about the pool having no other freshness trigger at all.

## [0.2.4] — 2026-09-14

### Changed

- **A multi-unit plan runs in parallel by default.** Units used to be chained automatically on the
  theory that a decomposition carries an implied order. For a genuine pipeline that is right; for a
  plan whose parts are independent it is not, and the independent case is the common one. A real
  eight-requirement research task became seven sequential agents, each doing its own retrieval and
  each waiting on all of its predecessors, and the run hit the caller's thirty-minute tool-call
  ceiling and returned **no results at all** — a timeout discards everything rather than what
  finished. `chain: true` restores the pipeline for a plan that really is a sequence.

### Added

- **A run bounds itself, so a long plan returns what finished.** `budgetMs` (default 25 minutes)
  aborts the run just before the caller's own tool-call ceiling, reports `budgetExhausted`, and
  returns every unit that completed with the rest marked unfinished. Previously the ceiling was the
  only limit and crossing it cost the entire run.
- **The run tool declares `units` and `chain`.** The engine had always accepted a caller-supplied
  graph and this plugin's own pipeline flag; the tool declared neither, so a caller that sent
  `units` had them silently dropped — the same declared-in-one-place, ignored-in-another shape as
  the top-level preferences fixed in 0.2.2, and it also made the new pipeline opt-in unreachable.
- **A caller-supplied graph overrides an inferred tier.** Supplying units is an explicit request to
  delegate, but a plan the plugin had merely inferred as `direct` discarded them without a word. An
  explicit `tier` still wins.

### Fixed

- **`run` did not detach its abort listener** — `dispatch` did, so the listener leak the earlier fix
  was written for survived on the path that matters most. A session-scoped signal accumulated one
  per orchestration.

## [0.2.3] — 2026-09-14

### Fixed

- **`foldedIntoAnalysis` and `unusedArguments` disagreed, one release after the fix that
  introduced them.** Verifying 0.2.2 against the reported call shape showed `unitModelPreference`
  listed in BOTH — folded and used, and simultaneously reported as unrecognised. A key that was
  folded is excluded from `unusedArguments` now, and the test asserts the two lists are mutually
  exclusive. My own output contradicting itself is precisely the class of defect this release pair
  set out to remove, so it gets a release rather than a quiet amend: v0.2.2 stays as tagged.

## [0.2.2] — 2026-09-14

### Fixed

- **A model preference placed at the top level was silently discarded.** Reported from a real
  research run whose caller had named a different model for every unit: all seven landed on the same
  one, and the result carried no warning. The schema nests `modelPreference` and
  `unitModelPreference` inside `analysis`, but the tool-parameter DSL accepts an extra root property
  without complaint, and no tool handler ever read the top-level copy — the same
  declared-then-ignored shape as `decisionCues` before it. Preferences are now folded into `analysis`
  from the top level and reported as `foldedIntoAnalysis`, so the value is used *and* the caller learns
  where it belongs; any other argument the tool does not recognise is reported as `unusedArguments`
  instead of vanishing.
- **`orchestrate_plan` ignored a forced `tier`.** The tool never declared the parameter and
  `engine.plan` never consulted one, so `{ tier: "multi-agent" }` was a second silently-ignored
  argument in the same call. It is declared, forwarded, and honoured exactly as `run` honours it.

## [0.2.1] — 2026-09-14

### Fixed

- **A reasoning level the destination route cannot express was sent anyway, failing the unit.**
  Reported from a real session: the plugin routed a unit to `commandcode/moonshotai/Kimi-K3` and the
  adapter rejected it with *"does not support reasoning effort \"medium\""*. `medium` is the common
  low/medium/high triad, and that route advertises `low`/`high`/`max` — the level came from the
  calling model's own vocabulary, because the parameter was undocumented and the schema told it
  nothing about which levels exist. The stored preference was validated against the route and the
  caller's request was not, so the caller's value went straight to the adapter and the unit returned
  no answer. All three sources — the stored preference, the caller's per-unit request, and a
  capability descriptor's declared level — are now checked with the same predicate; an
  unexpressible level is dropped (the route resolves its own default) and reported as
  `effortUnavailable` on the unit result and on a `dispatch` response. Reproduced against the live
  adapter before fixing, and the two `reasoningEffort` parameters now document that levels are
  route-specific and where to read them.

- **The two parameters that accept a level said nothing about it.** `orchestrate_run`'s
  per-requirement `reasoningEffort` was undocumented entirely, which is what let a calling model
  invent one. Both it and `orchestrate_dispatch`'s `reasoningEffort` now say the level must be
  spelled as the chosen route advertises it, point at `orchestrate_models` for the list, and state
  that an unavailable level is dropped and reported rather than fatal.

## [0.2.0] — 2026-09-14

### Removed

- **Dead code and dead keys the review found.** The model pool's subscription API
  (`EVIDENCE_SOURCES`, `onChange`, `setCalibrations` and the private listener set) had no caller
  anywhere, so its emit path iterated an empty set on every changed refresh — removing it also
  removed the comparison variable that existed only to feed it. `classifyTier` had a threshold
  branch that returned exactly what the next line returned unconditionally, so the threshold never
  decided anything. `rankModels` recomputed the source-confidence factor that `scoreCapability`
  already returned for the same profile, which is the one place that return value went unused.
  Eight locale keys nothing rendered are gone, along with three unused exports and a duplicate
  `store.snapshot()` per model and per poll. And the two copies of `findDshInstall` in the tests
  are one shared helper that now also builds a synthetic `node_modules`, so the three
  compatibility checks can resolve the CLI package and actually run.

### Added

- **The README is bilingual.** `README.zh.md` carries the same document in Chinese, with equal
  authority, and `README.i18n.yaml` records the git blob hash of each side as of the last
  confirmed-consistent state — the convention the harness's own packages use. A test enforces it
  three ways: both sides must carry a switcher, the structure must match (heading, fence and table
  counts), and the recorded hashes must match the files as they are, so editing one side and
  forgetting the other fails rather than ships. Code blocks, identifiers, route and model ids,
  locale keys and version strings stay verbatim on both sides by design.

### Fixed

- **A second review pass, this one adversarial and independent.** It found a silent data-loss bug
  the first pass introduced: `#composeUnits` pushes every bucket with `id: group`, and `#executeUnits`
  keys results BY ID — so a split cluster produced two units sharing one id, the second overwrote
  the first, and a specialist's answer was simply absent from `aggregated` while the run reported
  `completed: 2`. Unit ids carry an ordinal now, units list every capability they cover so
  `plan()` maps each requirement to its route, and a regression test asserts both answers survive.
  Also fixed: `firstDiscovery` was built and never handed to the routes, so the "first panel read
  waits for discovery" branch was dead while the README described it; a newer-schema state file was
  refused on read and then overwritten by the first ordinary write, because `save()` did not know
  about the refusal; `orchestrate_configure` advertised `decisionCues` in its schema and silently
  ignored it, the two configure surfaces having drifted apart; the panel reported a hand-set level
  as "ignored" on a route where the engine sends it; a `dispatch` child was never registered in
  flight, so teardown could not abort it and the capacity figures under-counted it; `childSignal`
  leaked one abort listener per run onto the session-scoped caller signal; and a delegation label
  lost its route entirely when the route was long enough to fill the label.

### Changed

- **One implementation of a preference patch, not two.** The panel route and
  `orchestrate_configure` both accept the same vocabulary, so they now both call
  `lib/preferences.js` — which is also what closes the `decisionCues` gap above, since that
  parameter can no longer be advertised by one surface and unimplemented by the other.

### Fixed

- **A review pass, fixing what it found.** `sync.cancel()` claimed to abort an in-flight sweep and
  only dropped the reference: the work kept running, kept **writing to the store after teardown**,
  and a later `start()` ran a second sweep alongside the first — the opposite of the one-at-a-time
  guarantee its own comment made. Each sweep now owns an `AbortController`, `cancel()` aborts it,
  an aborted sweep reports `cancelled` and writes nothing, and the slot is released only by the
  sweep that holds it. Four smaller ones: the research validator read `row.currency`, a field
  `RESEARCH_SCHEMA` never requests, so it could only ever fall back to USD; `web-research.js`
  re-exported `researchFor` purely because it imported it; the price scale was recomputed (and the
  whole persisted state cloned) once per ranking call, several times per plan, instead of once;
  and the Guided merge re-sorted the caller's own requirements by weight, changing which
  requirement becomes a cluster's primary — additions are appended now and the caller's order
  stands. Five locale keys nothing reads (`doc.unavailable`, `capacity.calibrations`,
  `board.statDelegatedSuffix`, `board.statRunning`, `pool.researchedAs`) are gone.

### Fixed

- **Guided capability areas were applied in Auto mode, and dropped whenever the calling model
  answered.** Two defects in the same mechanism, neither pinned by a test. `#localAnalysis` seeded
  the selected areas without checking the mode, so areas left selected while Auto was on kept
  shaping routing while the panel said they apply in Guided — and Auto means "read each task and
  decide by itself". The intake then returned the caller's analysis whole whenever it stated any
  requirement, so a caller that answered at all silently overrode the user's own session setting.
  The areas now apply in Guided mode only, and are **merged** with a caller's requirements rather
  than dropped: for a capability both name the caller wins, and an area the caller did not name is
  added, because nothing else was going to bring it up. The result reports `source: "model+guided"`.

### Added

- **Capability names are bilingual in the panel.** The taxonomy's labels stay English because a
  model reads them — they travel into child prompts and delegation labels — while the panel
  translates them through its own `capability.label.<id>` entries. 「能力领域」 and the assignment
  picker now read in Chinese while the agent still receives `Testing and verification`; a learned
  capability with no entry yet falls back to its taxonomy label.

### Changed

- **The cost unit is abbreviated and the tier column is gone.** `$/M tok` in the header, so the cell
  is just the two figures. The `Tier` column went because `deep` / `balanced` / `fast` is this
  plugin's own vocabulary rather than anything the host reports, and the columns beside it —
  context and cost — are the measured inputs it was summarising. The classification still drives
  the cost proxy; only the display changed.
- **A provider that reasons without listing levels can be given one by hand.** Such a route is used
  as-is by default, which is the honest answer since there is nothing to select. An operator who
  knows their provider accepts an effort can now set one: it is accepted, sent, and marked
  **manual** in the pool, because nothing can verify it — a rejected level fails that delegation
  with the adapter's own error. A route reporting no reasoning at all still cannot be given a
  level, and a route that lists levels keeps the strict rule that an id no longer on the list is a
  stale entry to be ignored rather than sent.

### Added

- **The model pool shows the public model and its published cost as columns.** The researched
  name, vendor, per-million-token prices and a bar relative to the dearest route in the same pool
  — because a price alone does not answer "is this expensive", and the only meaningful scale is
  the choice actually on offer. Rows with no research yet, and prices no source stated, stay
  blank rather than reading as zero; the card says plainly that these came from Sync and not from
  the host.

### Fixed

- **A provider that reasons without exposing a level was treated as unable to reason.** DSH
  reports reasoning in three states, and the plugin collapsed two of them: a model whose provider
  drives the depth itself (`reasoning` present, no selectable efforts) looked identical to a model
  with no reasoning at all, and a capability that requires reasoning **hard-rejected** it. The
  states are now distinct — `adjustable`, `automatic`, `none` — and a reasoning requirement with
  no named levels is satisfied by either of the first two. A requirement that NAMES levels still
  needs a selectable one, because there is nothing to select otherwise; that failure now says so
  instead of claiming no reasoning is exposed. An automatic-reasoning model also classifies as a
  deep tier on the same evidence an adjustable one does, which matters because the cost proxy
  reads that tier. Reported rather than left implicit: the pool's Reasoning column shows a
  selector only where a level exists, and says "automatic" where the model reasons but nothing is
  selectable.

### Added

- **Sync: public model facts and prices, researched on demand.** The host reports no pricing, so
  `preferCheaper` was shaping tie-breaks on a tier proxy that is identical across every route in a
  pool like this one — a switch that measured nothing. A **Sync** button in the model pool now
  resolves each route's public identity, its published per-million-token prices, and what public
  sources say it is good at, with the sources recorded. It is the one place this plugin touches the
  network and it is deliberately not automatic: nothing at activation, nothing on a poll, one
  sweep at a time, started only by a person. The plugin issues the searches through the harness's
  own web service and then makes one model call to reconcile them — the model judges the sources,
  the plugin decides what it may see, and everything is validated before it is stored. An
  identity the researcher could not confirm is stored as **unconfirmed** rather than given a
  plausible name, a price no source stated is absent rather than estimated, and each entry keeps
  its sources, its timestamp and the route that read it. Prices then shape tie-breaks within the
  same 0.08 ceiling as before, normalised against the most expensive route in the pool, and the
  pool still reports `metadata` evidence — nothing from the web is mixed into measured facts.
- **Capability assignments: a standing division of labour, set once and applied to every run.**
  Until now the only way to say "architecture to one model, implementation to another" was per
  task, through the calling model's own analysis — which is the gap between this plugin and the
  intent it was built for. An entry is keyed by a capability id or a whole group and holds an
  ordered list of model **identities**, so the table outlives the pool: a provider move or a
  respelled route is absorbed by identity matching, a version bump by an opt-in *follow the
  family* switch, and anything that stops resolving is reported rather than silently ignored. A
  pool route no entry mentions is reported as unassigned, so a new model is a decision the user
  gets to make. The resolution ladder is: the calling model's per-unit choice, then this table,
  then the calling model's task-level preference, then the measured ranking — the table outranks
  the task-level preference on purpose, so a chatty caller cannot quietly defeat a policy the
  user set, while the more specific per-unit statement still wins.
- **Same-cluster capabilities are split into separate units when their assignments differ.**
  Architecture and implementation share the `software` cluster; without the split they merge into
  one unit on one model and the table would do nothing. An entry that resolves to nothing does not
  shadow a group entry, so a stale specific row falls through instead of vetoing the general one.
- **The resolution is reported everywhere it matters**: on every plan and run, in
  `orchestrate_status`, and in the panel — what each entry points at right now, which targets
  match nothing, and which live routes no entry mentions.
- A **Capability assignments** panel section, offering capabilities and models from the live
  vocabulary and pool rather than a free-text field. Identity matching is exact-on-normalised by
  design — the prefix rule that would catch a truncated spelling is the same one that would route
  one model's work to its vision variant — so the way to be right here is to pick, not to type.

### Changed

- **The model-identity guard now checks code, not prose.** Its own name said "outside
  documentation" while it scanned raw text, so it would have failed this release for explaining
  itself with real model names. It now strips comments first and covers the two new logic modules.
  It also caught a real violation while being written: an *example model name inside a
  model-facing tool description*, which is not documentation to a model — it is an instruction.

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

[0.2.8]: https://github.com/Meaple-SFKY/dsh-model-orchestrator/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/Meaple-SFKY/dsh-model-orchestrator/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/Meaple-SFKY/dsh-model-orchestrator/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/Meaple-SFKY/dsh-model-orchestrator/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/Meaple-SFKY/dsh-model-orchestrator/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/Meaple-SFKY/dsh-model-orchestrator/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Meaple-SFKY/dsh-model-orchestrator/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Meaple-SFKY/dsh-model-orchestrator/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Meaple-SFKY/dsh-model-orchestrator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Meaple-SFKY/dsh-model-orchestrator/releases/tag/v0.1.0
