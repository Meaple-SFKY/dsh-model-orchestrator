# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
