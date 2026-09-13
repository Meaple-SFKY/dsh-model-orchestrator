# dsh-model-orchestrator

**A generic Model Orchestrator for the DeepSeek Harness.** It discovers the models the
running harness actually has, works out what each one is evidenced to be good at, and
routes each unit of work to the best available one — so you never have to decide which
task goes to which model.

It names **no model, provider, or vendor** anywhere in its selection logic, and it is not
specific to any business domain.

---

## What it does

| Concern | How it is handled |
|---|---|
| **Model discovery** | Reads the live LLM registry on every activation and whenever the adapter topology changes. The pool is never hardcoded and never persisted. |
| **Capability profiling** | Builds a profile per model from authoritative host facts (input modalities, context window, exposed reasoning efforts) plus the provider's own declared description. Nothing is invented. |
| **Task matching** | Turns a task into a requirement set, then scores every live model against it deterministically. A hard requirement that cannot be evidenced **rejects** a model instead of silently downgrading. |
| **Open capability system** | A capability is a generic descriptor, not a domain→model table. Unrecognized domains mint a **new** descriptor from the task's own vocabulary, which is persisted so the taxonomy genuinely grows. |
| **Two modes** | **Auto** infers what the task needs. **Guided** seeds matching with the capability areas you select for the session. |
| **Orchestration** | Simple work runs directly. Focused work goes to one specialist subagent. Complex multi-domain work is orchestrated across several, with every expert result returned to the calling agent. |
| **Captain** | The captain is a **role**, not a model binding: the task owner that understands, decomposes, dispatches, aggregates, verifies, and closes. Its route is chosen by the matcher from the live pool. |
| **UI** | A `Model Orchestrator` settings page plus a compact per-session routing strip. Automation by default; everything is adjustable. |
| **Persistence** | Preferences, learned capability descriptors, and per-route calibrations. **Never the model pool.** |
| **Compatibility** | Refuses to activate against an unsupported host, with a precise reason. No silent degradation. |

## It is a scheduler, not a task manager

The orchestrator is invoked **inside** normal task execution. It does not replace, mirror,
or compete with DSH's native task handling:

| Concern | Owner |
|---|---|
| Task list, plan, steps, step status | **DSH** — the orchestrator registers no task tool |
| Progress and progress display | **DSH** — the orchestrator renders no progress surface and emits no event |
| Session transcript | **DSH** — the orchestrator appends no custom session event |
| Subagent visibility | **DSH** — delegated children are ordinary DSH subagents in the normal views |
| Record of what was done | **DSH** session log — the orchestrator keeps no run history |
| Which model runs a unit of work | **Orchestrator** |
| Whether a task needs one specialist or several | **Orchestrator** |

So: `todo_write`, plan mode, step tracking, and progress rendering all keep working
exactly as they do without this plugin. An expert's answer comes back as the tool result
of the `orchestrate_*` call, and the agent writes the final answer as usual.

The only live bookkeeping the plugin keeps is a set of abort controllers for delegations
currently in flight, so a plugin reload aborts children instead of orphaning them. It is
not queryable and is never surfaced as task state.

## Why it routes through subagents

The harness exposes exactly one supported seam for choosing a model: `agentOptions` on a
**child** agent (`ctx.subagents.start`). An agent's own route is fixed when it is created,
and there is no per-turn retargeting hook for a running session.

So the orchestrator works with that seam rather than against it:

1. Your session's agent stays the user-facing surface and the **captain**.
2. The plugin picks a route per **unit of work** and spawns a child on it.
3. The expert's result returns to the captain as the tool result.
4. The **captain writes the final answer** — the orchestrator never talks to the user.

## Install

```sh
dsh plugin --profile <name> add dsh-model-orchestrator
```

Or from a local checkout:

```sh
dsh plugin --profile web add /path/to/dsh-model-orchestrator
```

The bundle patch mounts one row into the profile's host composition, registers the
`orchestrate_*` tools into the shared tool registry, contributes one routing-policy
section to the system prompt, and serves the control-panel routes. Restart the profile
after installing so the host picks up the new bundle.

**It publishes no service**, so it needs no `isolate` realm, and it only consumes host
capabilities (`llm`, `subagents`, `tools`, `systemPrompt`).

## Use

Nothing to configure. Ask for something and the agent routes it:

> *"Refactor the parser, then run the benchmarks, then write up what changed."*

You can also steer it explicitly:

- **Settings → Model Orchestrator** — mode, capability areas, cost preference,
  parallelism, route allow/deny lists, live pool, routing preview, recent runs.
- **The routing strip above the composer** — the current mode and live pool at a glance.

### Tools

| Tool | Purpose |
|---|---|
| `orchestrate_run` | Analyze, match, delegate every unit, and return all results. The main entry point. |
| `orchestrate_dispatch` | Delegate one self-contained unit to one model. Cheaper and more predictable. |
| `orchestrate_plan` | Show the routing decision **without** executing it. |
| `orchestrate_models` | The models that actually exist right now, with the evidence behind each profile. |
| `orchestrate_capabilities` | The capability vocabulary, including anything learned. |
| `orchestrate_configure` | Change preferences. |
| `orchestrate_status` | Current mode, pool, mappings, and run history. |

## Which models are in the pool

Discovery reads the LLM registry, which lists every model every registered adapter
advertises. That is **not** the same as the set a deployment intends you to use: a profile
with two providers mounted commonly advertises the same underlying model twice, and a
provider may advertise more than the user enabled.

So the pool is narrowed by two layers, in order:

1. **The deployment's subagent route policy** — `subagentModelSelection.current()`, the
   same exact routes the Settings page shows for subagent model selection. Since every
   model this plugin runs is a subagent route, this is the authoritative answer.
2. **Your own route preferences** — `orchestrate_configure`'s `allowedRoutes` /
   `deniedRoutes`, applied on top.

Rules that keep this safe:

- The policy constrains the pool **only** when the service exists, is enabled, and names at
  least one route. An absent, disabled, or empty policy means the deployment expressed no
  preference, and discovery stands — filtering to nothing would silently disable routing.
- Routes are matched **exactly** as `provider/model`. Two providers exposing the same model
  id are different models and are both kept unless a policy excludes one; ids are never
  deduplicated, because that would discard a legitimate route.
- When the policy would leave nothing routable, that is reported as a problem rather than
  shown as an empty pool.

The panel says which layer narrowed the pool, so a smaller list reads as a decision rather
than a fault:

```
Showing the 7 route(s) this deployment offers for subagents;
4 advertised route(s) are not selectable.
```

## How matching works

```
score(model, task) = geometric_mean( satisfaction(requirementᵢ, model) ^ weightᵢ ) × confidence
                     − cost_shaping
```

- **Conjunctive, not averaged.** A model that cannot do a required thing is not rescued by
  being excellent at something adjacent, so per-requirement satisfaction is multiplied
  rather than averaged.
- **Hard requirements reject.** Modality, context floor, and reasoning availability are
  checked *before* scoring. An unknown modality is treated as *unknown*, never as capable.
- **Capability level is measured, not inferred from prose.** Depth requirements such as
  `depth.difficult` resolve against facts the host measures (exposed reasoning efforts,
  context window). That is what makes routing work for a domain no model has ever
  described itself as covering.
- **Cost shaping never overrides a requirement.** It only breaks ties.

### Evidence layers

Each profile records where its evidence came from:

| Source | Meaning |
|---|---|
| `metadata` | Authoritative host facts: modalities, context window, output cap, reasoning efforts. |
| `declared` | The provider's own model name and description. Soft evidence. |
| `calibrated` | The model's answer to the orchestrator's own self-probe. |

The matcher weights a measured fact above an inferred one, and reports the evidence for
every candidate so a decision can be audited.

## Compatibility and versioning

The host range is declared in **both** sites the ecosystem reads:

```json
{
  "engines": { "dsh": "0.1.5-rc.1" },
  "dsh": { "engines": { "dsh": "0.1.5-rc.1" } }
}
```

`engines.dsh` is authoritative; `dsh.engines.dsh` mirrors it for marketplace discovery.
`peerDependencies` declare the `@deepseek-ai/*` packages actually imported and are checked
independently.

**On every activation, before registering anything**, the plugin proves three things:

1. The declared range admits the running DSH version (resolved from the installed tree and
   evaluated with the host's own `semver`).
2. Every required Service **and method** is present by name.
3. At least one provider answers a model listing.

If any check fails, the plugin registers **no** tool, prompt section, or route, logs a
precise reason naming the requirement and what was found, and throws so the row fails
loudly. It never degrades silently. Because the gate runs on every activation, upgrading
into an unsupported host is refused rather than run.

Run the standalone check any time:

```sh
node scripts/check-compat.mjs
```

## Requirements

- **DSH** `0.1.5-rc.1` (exact pin; see `compatibility.json`)
- **Node.js** `^22.19.0 || >=24`
- A host composition with `llm`, `subagents`, `tools`, and `systemPrompt` mounted — the
  shipped `web` and `headless` profiles have all four.
- At least one registered LLM provider that lists models.

The client panel additionally requires a web server; without one the tools work normally
and only the panel is unavailable.

## Operating it

### Disabling and removing

There is **no universal enable/disable button** in the harness settings: the Plugins
settings page configures plugins, it does not stop them. Turning a plugin off is done
through the **loader row**, which is the official mechanism and needs no code change from
the plugin.

**Disable** by adding one row to the profile's user patch layer:

```sh
dsh plugin --profile <name> add dsh-model-orchestrator   # if not installed yet

cat >> "$DSH_HOME/profiles/<name>/cordis.patch.yml" <<'YAML'
- id: model-orchestrator
  disabled: true
YAML
```

Because a profile's `patchReload` is `live`, the change is hot-applied within about a
second — no restart — and the loader re-applies the file on every boot, so the choice
survives restarts. `disabled: false` force-enables the row again, overriding a lower
layer that disabled it.

While disabled the loader never calls the plugin's `apply`, so **no tool, prompt section,
or control route is registered**. Re-enabling registers all of them again from live state;
the plugin holds no task state that could go stale, and its teardown aborts any delegation
still in flight.

**Remove** entirely:

```sh
dsh plugin --profile <name> remove dsh-model-orchestrator
```

Removing it withdraws every tool, the prompt section, and the control routes on the next
start; nothing else in the profile is affected. Because the plugin registers no service
and holds no task state, removal cannot strand a session.

> The community marketplace plugin only manages what it installed itself, so a plugin
> added with `dsh plugin add` is not listed there for toggling. Use the patch row above.

### When the host is unsupported

A build whose `engines.dsh` does not admit the running DSH **refuses to activate**. The
composition row fails loudly with the requirement, the version found, and a recovery line:

```
dsh-model-orchestrator 0.0.1: incompatible host — the plugin is disabled
  1. DSH 0.1.5-rc.1 does not satisfy the declared range "0.9.9-rc.1" (>= 0.9.9-rc.1)
  Required host range: dsh 0.9.9-rc.1  (running: 0.1.5-rc.1)
  Recovery: remove the plugin from this profile with `dsh plugin --profile <name> remove dsh-model-orchestrator`, or install a build whose "engines.dsh" admits this host.
```

That is deliberate: it registers nothing and never silently degrades. Check a build before
installing, or in CI, with:

```sh
node scripts/check-compat.mjs
```

### Upgrading

The gate runs on **every** activation, not just installation, so upgrading into an
incompatible host is refused rather than run. Preferences, learned capability
descriptors, and calibrations live in `$DSH_HOME/orchestrator/state.json` and survive an
upgrade; calibrations for routes that left the pool are pruned automatically.

### Interface

**Settings → Model Orchestrator** is the full page: mode, capability areas, the live pool
with the basis behind each assessment, preferences, and a routing preview.

**Orchestrator** is a Conversation view, a sibling of `Chat` and `Trajectory`:

![The Orchestrator board showing two delegations on different models](docs/board-two-models.png)
 It is the
board for the session you are looking at, and it has three parts:

- **Delegation graph** — every subagent the orchestrator started for this task, indented
  under the agent that started it, with its mode (`one-shot` / `continuable`) and live
  activity. Topology is read from the harness's own durable session tree
  (`ctx.subagents.listDescendants`), refreshed every few seconds, so it shows the
  delegations that actually exist rather than a mirrored copy.
- **Stats** — how many delegations there are, how many are running, and how many branches.
- **Routing capacity** — the current mode, live pool size, in-flight delegations, and the
  capability count.

There is deliberately no ambient strip above the composer: the board is where delegated
work is inspected, and a strip would both duplicate it and crowd the composer.

Both follow the harness language setting: every user-facing string lives in the plugin's
`modelOrchestrator` locale namespace (`lib/locales.js`, mirrored inside the self-contained
client bundle), covering both shipped locales. Strings a **model** reads — tool
descriptions, parameter schemas, the routing prompt section, personas — are deliberately
English and do not follow the UI language.

Terminology policy: generic and technical terms stay untranslated. `host` / `requires`
version labels, `provider`, `Route`, deployment ids such as `workflowEngine`, model and
route names, reasoning-effort ids, and version strings like `0.1.5-rc.1` are data or
shared identifiers, so they appear verbatim in every language. Only explanatory prose is
translated.

Both are served by the host over three same-origin routes (`state`, `configure`, `plan`).
The browser half cannot enumerate models itself — the LLM listing surface is host-only —
so the panel reads the real pool from the host and never guesses.

## Layout

The board renders as a **centred, width-constrained column**, matching how the shipped
Chat and Trajectory views lay themselves out. This is not decoration: the conversation
shell renders the transcript's width handles *absolutely*, positioned off the content
column, so a view that paints full-bleed draws its content straight under those handles.
Measured in a live session: the board column spans x 498–1272 while the handles sit at
x 436 and x 1304 — clear of the content, which is where they belong.

The constraint is `width: min(920px, 64%, 100%)` with `margin-inline: auto`; 64% mirrors
the shell's adaptive content width and 920px is its ceiling.

## Performance

The plugin must not make the harness feel slower. Two rules enforce that, both
regressions found by timing a real profile boot:

1. **Activation performs no network I/O.** The compatibility gate originally probed every
   provider with `listModels()` to prove the pool was usable. A provider's model listing can
   be a live HTTP request — the bundled third-party provider refetches its catalog on every
   call with a 10s timeout and only a failure fallback to disk — so the gate turned every
   boot into a multi-second wait. The gate now checks only that a provider **route** is
   registered; whether a provider answers is a runtime condition reported as a pool problem.
   Measured effect: profile boot went from **6.7s back to 3.9s**, matching the
   no-plugin baseline within 3ms.
2. **Polling never re-reads providers.** The panel polls `/state`, and discovery was
   originally re-run on every read. `/state` now serves the pool it has; re-discovery happens
   only on an explicit `?force=1` (the panel's Refresh button) or when the harness reports an
   adapter change. `/plan` no longer discovers either — previewing a route must not hit a
   provider.

Discovery still starts immediately at activation; it is simply not awaited, so nothing about
the pool blocks the boot. The first panel read waits for that in-flight discovery rather than
painting an empty pool.

## Interruption and restart

The plugin holds no durable task state, so an interruption cannot leave it wedged.

**If you cancel a session mid-orchestration** the tool's signal aborts, which reaches the
child; the child's result rejects, and that is recorded as a **failed unit** on the run —
never a hang, never an unhandled rejection, and never a silent gap. Every spawned child is
disposed exactly once on every path.

**If the process is killed** (`kill -9`, a crash, a power cut), nothing in memory mattered:

| On restart | Behaviour |
|---|---|
| Preferences, mode, Guided areas | Restored from `$DSH_HOME/orchestrator/state.json` |
| Learned capability descriptors | Restored, and usable again |
| Per-route calibrations | Restored; entries whose model left the pool are pruned |
| Model pool | **Rediscovered** from the live registry — never restored, so it cannot be stale |
| Route registration | Re-mounted on activation |
| A truncated or corrupt state file | Falls back to defaults with a reported reason, and the next write repairs it |
| A state file from a NEWER plugin version | Refused without overwriting, so a downgrade cannot corrupt it |

Writes are atomic (temp file, then rename), so a kill during a write leaves either the old
file or the new one — there is no partial state to recover from. `test/lifecycle.test.js`
pins all of the above.

### Known native caveat

One observation from testing, reported for completeness rather than as a plugin defect: in
one run a `kill -9` of the `dsh --profile headless` process left a surviving `dsh` child
(adopted by init, still holding a network socket). I could **not** reproduce it in two later
controlled attempts — one without any subagent, one with an orchestrator-spawned subagent —
and in-process subagents cannot outlive their parent, so that child was not a delegated
agent. If you ever see a stray `dsh` after killing a session, check for it with:

```sh
pgrep -fa 'dsh --profile'
```

## Development

```sh
node --test "test/*.test.js"   # 164 tests, no host required
node scripts/check-compat.mjs  # host compatibility report
```

The suite runs without a live harness. Where a real host contract matters — the
`defineTool` schema compiler and lossless-JSON output validator, the client module loader,
version resolution — the tests resolve the **installed** host package and exercise the real
thing, materializing the plugin beside a symlink to the host's `node_modules`.

Two of those checks exist because a live boot found defects a shape test could not: a
missing `output.render` on every tool, and an `undefined` property that the host's
lossless-JSON validator rejects (which `JSON.stringify` silently hides). Both are now
pinned, along with a guard that the plugin never grows a task or progress surface.

## Layout

```
lib/
  index.js          plugin entry: gate, wiring, pool, tools, prompt, routes
  compatibility.js  activation gate and host version resolution
  taxonomy.js       open, domain-agnostic capability descriptors
  discovery.js      live pool discovery and capability profiling
  matching.js       task analysis, scoring, and route selection
  engine.js         orchestration tiers, delegation, aggregation
  persistence.js    atomic state: preferences, descriptors, calibrations
  tools.js          the orchestrate_* model-facing tools
  schemas.js        tool names and parameter specs (host-free, so they are testable)
  locales.js        zh/en dictionaries for the UI (mirrored into the client bundle)
  routes.js         host control routes for the browser panel
  agent-tree.js     subagent relationship tree for the board (pure, testable)
  route-policy.js   narrows discovery to the routes the deployment offers
  prompt.js         the routing-policy system prompt section
  client.js         client bundle: settings page + session strip
  home.js, util.js  harness-home and value helpers
```

See `DESIGN.md` for the verified host contracts this is built against, and `docs/` for the
full API references gathered from the installed DSH tree.

## License

MIT — see `LICENSE`.
