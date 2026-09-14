# dsh-model-orchestrator

English | [中文](README.zh.md)

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
| **Model discovery** | Reads the live LLM registry at activation, when the adapter topology changes, at most five minutes after the last read, and on demand — the panel's **Refresh pool**, `orchestrate_models { refresh: true }`, or `GET /state?force=1`. A provider's model listing can be a network round trip, so the periodic re-read is lazy: it happens when something next needs the pool, and a failure keeps the pool that already exists. The pool is never hardcoded and never persisted. |
| **Capability profiling** | Builds a profile per model from authoritative host facts (input modalities, context window, exposed reasoning efforts) plus the provider's own declared description. Nothing is invented. |
| **Task matching** | Turns a task into a requirement set, then scores every live model against it deterministically. A hard requirement that cannot be evidenced **rejects** a model instead of silently downgrading. |
| **Open capability system** | A capability is a generic descriptor, not a domain→model table. Unrecognized domains mint a **new** descriptor from the task's own vocabulary, which is persisted so the taxonomy genuinely grows. |
| **Two modes** | **Auto** infers what the task needs. **Guided** seeds matching with the capability areas you select for the session. |
| **Orchestration** | Simple work runs directly. Focused work goes to one specialist subagent. Complex multi-domain work is orchestrated across several, with every expert result returned to the calling agent. |
| **Captain** | The captain is a **role**, not a model binding: the task owner that understands, decomposes, dispatches, aggregates, verifies, and closes. Its route is chosen by the matcher from the live pool. |
| **UI** | A `Model Orchestrator` settings page, and an Orchestrator board beside `Chat` and `Trajectory` showing the session's delegations. Automation by default; everything is adjustable. |
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
dsh plugin --profile <name> add github:Meaple-SFKY/dsh-model-orchestrator
```

Or from a local checkout, **as a tarball**:

```sh
npm pack --pack-destination /tmp
dsh plugin --profile web add /tmp/dsh-model-orchestrator-0.3.0.tgz
```

Installing the directory itself (`add /path/to/dsh-model-orchestrator`) does **not** work, and
fails in a way that looks like a plugin bug rather than an install problem:
pnpm records a `link:` dependency, so the plugin's real path stays outside the profile and
Node's parent-walk never reaches the profile's `node_modules` — where the host packages it
imports (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, …) actually live. The load then
fails with `Cannot find package '@deepseek-ai/dsh-tools'`. A packed tarball is materialized
inside the profile, so resolution works. It also means the profile holds a **snapshot**: after
editing the checkout, pack and add again.

Once the package is on npm this shortens to the same thing:

```sh
dsh plugin --profile <name> add dsh-model-orchestrator
```

For the record, and so nobody plans around it: the package is **not** on npm yet, because npm now
requires either 2FA or a bypass-2FA granular token to publish and this account has 2FA disabled —
TOTP enrolment is no longer even possible. A GitHub source needs none of that, which is also how
roughly half of the plugins in the community registry are installed. See
[`docs/marketplace-submission.md`](docs/marketplace-submission.md).

The bundle patch mounts one row into the profile's host composition, registers the
`orchestrate_*` tools into the shared tool registry, contributes one routing-policy
section to the system prompt, and serves the control-panel routes. Restart the profile
after installing so the host picks up the new bundle.

**Check the host range first.** This release declares `engines.dsh = "0.1.5-rc.1"` and refuses
to activate against anything else, with the reason and a recovery line. Verify before installing,
or in CI, with:

```sh
node scripts/check-compat.mjs
```

In a checkout with no DSH to check against — a fresh clone, or any CI runner — it says so and
exits 0 rather than reporting an incompatibility it never established, and still validates the
parts that need no host: the declared range, the `dsh.engines.dsh` mirror, the peer
declarations and `compatibility.json`. Pass `--strict` when a missing harness should be fatal,
as it would be in a release gate.

**It publishes no service**, so it needs no `isolate` realm, and it only consumes host
capabilities (`llm`, `subagents`, `tools`, `systemPrompt`).

## Use

Nothing to configure. Ask for something and the agent routes it:

> *"Refactor the parser, then run the benchmarks, then write up what changed."*

You can also steer it explicitly:

- **`/model-orchestrator <task>`** — route one task through the orchestrator, whatever the
  agent would otherwise have decided. See below.
- **Settings → Model Orchestrator** — mode, capability areas, cost preference,
  parallelism, route allow/deny lists, live pool, routing preview, capability assignments.

### The `/model-orchestrator` command

Automatic routing is the default, but nothing *forces* the calling model to route rather
than spawn subagents itself — and a live session was observed delegating four heterogeneous
research units through the native `subagent` tool, leaving every child on the deployment's
single default model. The command is the explicit switch for exactly that case:

```
/model-orchestrator 分析这个季度的销售数据并写成一份给管理层看的总结报告，包含趋势图表和三条行动建议
/model-orchestrator status
```

A handler runs **without the command line reaching the model** (that is the host's command
contract), so the command delivers the task itself, as an ordinary user message, together
with the instruction to call `orchestrate_run` and to name per-unit routes when the units
differ in kind. The captain then owns the result as usual.

Honest limits: this makes the intent explicit and reliable to deliver, but the agent still
performs the routing — the command does not bypass the captain, and it does not make
orchestration automatic. Automatic remains the default; this is for when you want it
guaranteed. `recordInput: false` keeps the task from being logged twice, and the command is
only registered when the deployment mounts the `commands` service.

**It answers in your language.** The command's replies, its one-line summary and its input
hint all come from the same locale table the panel uses. The language comes from the durable
`locale` setting when you have set one — and, when you have not, from the panel telling the
host which language it is rendering. That second source is not a nicety: the harness resolves
a language as "explicit setting → browser detection → en" and never writes the browser-derived
value back, so without it the host cannot know the UI language at all in the default case, and
these strings stayed English inside a Chinese UI. The plugin never writes the setting, only
reads it, and an explicit choice always outranks the browser's.

The harness renders a *third-party* command's description and hint verbatim — it only
translates its own built-in commands — so the plugin re-registers the command when the
language changes; that re-registration is the only way its palette entry can follow you. The
settings page also states the command, its hint and its usage in the panel's own language, so
the copy is discoverable without opening the palette.

### Tools

| Tool | Purpose |
|---|---|
| `orchestrate_run` | Analyze, match, delegate every unit, and return all results. The main entry point. |
| `orchestrate_dispatch` | Delegate one self-contained unit to one model. Cheaper and more predictable. |
| `orchestrate_ask` | Ask a **completed** unit of the same run a follow-up question and get its answer, on the route that did the work. |
| `orchestrate_plan` | Show the routing decision **without** executing it. |
| `orchestrate_models` | The models that actually exist right now, with the evidence behind each profile. |
| `orchestrate_capabilities` | The capability vocabulary, including anything learned. |
| `orchestrate_configure` | Change preferences: mode, cost, parallelism, routes, reasoning levels, the capability assignment table, dependency handoff, and the sibling-question and review bounds. |
| `orchestrate_status` | Current mode, pool, mappings, the assignment table, the researched facts, which cue groups are still built-in, and the health report. |

Every tool that takes a caller's analysis says **where each field belongs**, and enforces it
rather than trusting it: a value placed at the top level is reported back in
`misplacedArguments` with the parameter path to use instead (a route belongs in
`units[].route` or `analysis.modelPreference[].route`), an unrecognised argument comes back in
`unusedArguments`, and a top-level `modelPreference`/`unitModelPreference` is folded into
`analysis` and named in `foldedIntoAnalysis`. A silently ignored route is not possible — but
the report has to be read, which is why the descriptions name it.

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

### Providers that do not expose reasoning levels

Not every provider offers a level to pick. DSH reports reasoning in three states and the pool
shows which one a route is in:

| State | What it means | What the pool shows |
|---|---|---|
| `adjustable` | The provider exposes levels (`low`, `high`, …) | A selector, whose options are the levels it reports |
| `automatic` | The model reasons and the provider drives the depth | **automatic** — no selector, because there is nothing to select |
| `none` | No reasoning is reported | A dash |

A route in the `automatic` state is used **as-is** by default: no level is sent, so the provider
does exactly what it would have done anyway. If you know your provider accepts a level it does not
list, you can set one anyway — `orchestrate_configure { reasoningEffort: { "<route>": "high" } }` —
and it is accepted, sent, and marked **manual** in the pool. Nothing can verify it, so a level the
provider rejects fails that delegation with the adapter's own error; that is the trade for not
silently ignoring what you asked for. A route that reports no reasoning at all cannot be given a
level, and a route that lists levels keeps the strict rule: an id that is no longer on its list is
a stale entry and is ignored.

A level is never sent to a route that cannot express it, whatever proposed it. The stored
preference, the calling model's own per-unit request, and a capability descriptor's declared level
are all checked against the destination route; a level it does not advertise is dropped — the route
then resolves its own default — and reported as `effortUnavailable` on that unit's result. It used
to be sent, on the theory that the caller's judgement outranks the plugin's, and the adapter then
rejected the route and the unit produced no answer at all.

The distinction matters in routing, not only in the panel. A capability that requires reasoning
accepts both `adjustable` and `automatic`; a requirement that names a level (for example "must
expose high") needs `adjustable`, since a level that cannot be selected cannot satisfy it. Setting
a level for a route that reports none is refused when you set it, and ignored if it goes stale —
sending an unsupported level would fail the child outright.

### Reasoning level per route

The pool's **Reasoning** column is a selector, not a label. Its options are the levels the
host actually reports for that route (`reasoning.efforts`), plus **default** — which means
"let the model resolve its own level", and shows which one that is whenever the host reports
it (`reasoning.defaultEffort`). The choice is stored per `provider/model` and applied as
`agentOptions.reasoningEffort` on every delegation the orchestrator makes to that route, so
the captain dispatches at the level you set.

The rules that keep it honest:

- A level the route does not advertise is **refused when you set it**, and **ignored if it
  goes stale** (an adapter change). Sending an unsupported level fails the child outright
  with `UNSUPPORTED_REASONING_EFFORT`, so a stale preference degrades to the model default
  instead — and the pool says so rather than showing it as if it applied.
- A route that advertises no levels gets no selector.
- A level the calling model states for a unit wins over the stored preference: the model
  reading the task is the better judge of that unit.
- Only the level is configurable. This plugin does not invent levels, and it still names no
  model anywhere in its selection logic.

The same preference is settable from a tool surface, for an agent asked to configure it:

```
orchestrate_configure { reasoningEffort: { "commandcode/xai/grok-4.6": "high" } }
```

### The model pool's columns

| Column | Where it comes from |
|---|---|
| **Route** | The deployment's own `provider/model` string |
| **Public model** | Sync. Blank until a sync, and explicitly *unconfirmed* when the researcher could not tie the route to a published model |
| **Cost ($/M tok)** | Sync: published list prices per million tokens, with a bar relative to the dearest route **in this pool** — a price alone does not answer "is this expensive" |
| **Context**, **Image** | Measured by the host |
| **Reasoning** | A selector where the provider lists levels, `automatic` where it reasons without listing any, a dash where none is reported |

The model **tier** column is gone: `deep` / `balanced` / `fast` is this plugin's own vocabulary, and
the columns beside it — context, cost — are the measured inputs it was summarising.

### Capability assignments — your standing division of labour

If you want a specific division of labour rather than per-task judgement — *vision to one
model, maths to another, architecture to the expensive one but implementation to the cheap
one* — set it once in **Settings → Model Orchestrator → Capability assignments**, or from a
tool:

```
orchestrate_configure { capabilityAssignments: {
  "multimodal.vision":       { models: ["gemini-3.8-flash"] },
  "reasoning.mathematics":   { models: ["Qwen 3.8 Max 0902"] },
  "software.architecture":   { models: ["gpt-5.6-sol"] },
  "software.implementation": { models: ["deepseek-v4.1-flash"] },
  "web.information":         { models: ["grok-4.6"] },
  "long.context":            { models: ["Kimi K3"] }
} }
```

An entry is keyed by a **capability id or a whole capability group**, and holds an **ordered
list of model identities**. Models are stored as identities, not routes, so the table
outlives the pool:

| The pool changes | What absorbs it |
|---|---|
| The model moves to another provider, or its route is respelled | Identity matching — the row above names `gemini-3.8-flash`, not a route |
| A new version ships (`5.6 → 5.7`) | The per-entry **follow the family** switch, off by default: a version bump is usually the same model, but not always |
| The model leaves the pool | The entry reports itself **unresolved**; routing falls through to the next entry, then the measured ranking |
| A model appears that no entry mentions | Reported as an **unassigned live route** — a decision you get to make, not one the table makes silently |

Two things this deliberately is not:

- **It is not a lock.** The table supplies the preference order; the matcher still reorders
  eligible candidates and still enforces hard requirements and the deployment's route policy.
  A table entry can never revive a route those excluded.
- **It is not a lock, but it IS the first priority.** A capability you have configured follows
  the table; the calling model's own preference is what has to give way, and the unit result
  says so (`decidedBy: "assignment"`, plus `overriddenCallerPreference` naming what was
  displaced). The full ladder is: this table → the calling model's per-unit choice → the
  calling model's task-level preference → the measured ranking. This reverses the earlier
  order on purpose — a decision you made once should not be quietly overruled by whoever
  happens to be calling.

  Both preferences live **inside `analysis`** — `modelPreference` for the task, `unitModelPreference`
  for one unit. A copy placed at the top level of the call is folded in and reported as
  `foldedIntoAnalysis`, because that mistake once sent a seven-unit plan to one model in silence; any
  *other* argument the tool does not recognise is reported as `unusedArguments`, and a *known*
  argument in the wrong place gets a `misplacedArguments` entry naming where it belongs.

  Caller-supplied `units` are routed by the same ladder, table included. They used to consult
  only the caller's own preference, so supplying a unit graph silently bypassed the division of
  labour you had configured.

Capabilities in one cluster are split into separate units when their assignments differ. That
is what makes "architecture to GPT, implementation to DeepSeek" real: both live in the
`software` cluster, and without the split they would merge into one unit on one model and the
table would silently do nothing.

The plugin still names no model anywhere in its selection logic — the table is yours. Identity
matching answers only *"is this still the same model"*; it never decides which model is better
at what.

### How the two panels relate

They sit next to each other and answer **different questions**, which is also why they cannot
disagree:

| Panel | Question | Controls |
|---|---|---|
| **Capability areas** (Guided) | *Which kinds of work are in scope for this session?* | The requirement set: it seeds a capability at weight 0.7, so a unit exists for it that the task text alone would not have produced |
| **Capability assignments** | *Who does each kind of work?* | The preference order for the route a unit is matched to, and whether two capabilities in one cluster split into separate units |

So the composition is: **areas decide what exists, assignments decide who does it.** They only
overlap when both name the same capability, and then there is nothing to resolve — the area makes
the requirement exist, the assignment routes it.

Two rules keep that true, both newly enforced and both previously broken:

- **Areas apply in Guided mode only.** They used to seed regardless of mode, so areas left
  selected while Auto was on silently kept shaping routing — while the panel said they apply in
  Guided. Auto means "read each task and decide by itself". Areas you keep selected are kept for
  when Guided comes back, not applied.
- **A caller's own requirements no longer discard them.** The intake returned the calling model's
  analysis whole whenever it stated any requirement, so a caller that answered at all silently
  overrode the user's own session setting. They are now merged: for a capability both name, the
  caller wins (it is the more specific statement about *this task*); an area the caller did not
  name is **added**, because nothing else was going to bring it up and the user asked for it. The
  result reports `source: "model+guided"`.

One consequence worth knowing: an assignment **only fires for a capability that becomes a
requirement**. It is a routing policy, not a trigger — assigning `web.information` does not make a
task involve the web. Capability areas *can* be that trigger, which is the one way the two panels
compose into something neither does alone.

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
3. At least one provider **route** with a usable id is registered — deliberately not a model listing, which can be a network round trip (see *Performance*).

If any check fails, the plugin registers **no** tool, prompt section, or route, logs a
precise reason naming the requirement and what was found, and throws so the row fails
loudly. It never degrades silently. Because the gate runs on every activation, upgrading
into an unsupported host is refused rather than run.

**Everything after the gate is isolated.** The gate is meant to be loud — an incompatible host
is a decision, not an accident. But every subsystem *registration* used to be unwrapped too,
and a failed composition entry is not a local failure: the harness's boot audit treats it as
fatal and disposes the whole context, so one bad tool schema took unrelated plugins down with
it. Each subsystem now registers inside a guard. A failure disables **that** subsystem,
records why, and leaves everything else working.

That is what the **health** line reports, on the settings page and on `orchestrate_status`:
each subsystem as `enabled`, `degraded` or `disabled` with the reason, plus the optional
services this deployment does not provide. A control panel that did not mount, or a Sync that
can never work because there is no search provider, is now a visible state instead of a log
line. Optional services are re-checked on every read, so one that mounts late is not reported
as permanently absent.

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

The **capability areas** belong to Guided mode, and the page says so: in Auto the panel is
collapsed with a one-line explanation of where it is, and choosing Guided reveals it with a
short slide-and-fade instead of swapping the layout instantly. The transition is ~340 ms,
`prefers-reduced-motion: reduce` switches it off entirely, and the copy names the modes the
same way the buttons do (`自动` / `引导`, never a mix of the translated label and the English
mode name).

**Orchestrator** is a Conversation view, a sibling of `Chat` and `Trajectory`. It is the
board for the session you are looking at: a **left-to-right dependency graph** of how the
task was delegated, from the task itself, through the captain, to every unit the orchestrator
dispatched — including the sub-agents a unit dispatched in turn — and on to the final output,
which is always the rightmost node.

- **Layout** — one column per dependency depth, so the direction of reading is the direction
  of the work. Edges are routed as curves whose control points stay inside the gap between
  columns, so a wire never crosses a node box, and edges that share a source or target are
  spread across lanes so they do not overlap each other.
- **Six edge kinds**, each drawn differently and all listed in the legend: **task** (the task
  to what it started), **dispatch** (who delegated to whom), **dependency** (the strongest
  line: this unit had to wait for that one), **question** (dotted — one unit asked a finished
  sibling something), **review** (its own colour, labelled with the round and the verdict),
  and **output** (a settled unit feeding the final answer). A wire touching something that is
  running flows.
- **Five node kinds**, all in the legend: the task, the captain, a routed unit, a session the
  harness started on its own (a **native delegation** — the orchestrator chose no model for
  it), and the final output.
- **Lifecycle, in full** — `waiting` (and it names who it is waiting for), `not started`,
  `running`, `completed`, `failed`, and `unknown`. Only a routed delegation shows a model:
  the route comes from the unit's own record, not from an inference about the label.
- **Honest about what it does not know.** The harness's listing reports whether a session
  *record* is resident, which is not the same as an agent running it. So the plugin's own
  journal outranks it — a unit the orchestrator finished reports `completed` even while the
  durable record still says `running` — and anything else that keeps claiming to run for more
  than half an hour becomes `unknown`, with the reason in its tooltip. It will not show
  "running" forever for a host that no longer runs the session.
- **Interaction** — drag a node and its wires follow it; hover a node or a wire and everything
  unrelated dims; every wire has a wide invisible hit area, so hovering it highlights the two
  nodes it connects and shows the kinds of both ends.
- **Detail per node** — capability, route and who decided it, review rounds, elapsed time,
  how many questions it asked and answered, the path of its written answer, a summary, and an
  error when it failed. Long values are truncated in the box with the full text in the
  tooltip, and labels wrap inside their box in both languages.
- **A top bar** with the run's numbers: delegated, running, completed, failed, questions and
  reviews, plus how long the run has taken. Below it, a grouped legend covering every node
  kind, every lifecycle status and every edge style — built from the same vocabulary the
  renderer draws, so it cannot drift.

The graph joins two sources. The **harness session tree** (`ctx.subagents.listDescendants`)
is the real topology — one node per durable session, one edge per reported parent — and the
plugin's **run journal** adds what the harness never knew: which capability a unit covered,
which route it ran on, what it produced and where that was written, who reviewed it, what was
asked of whom, and the dependency edges between units. Neither alone can draw this graph.

There is deliberately no ambient strip above the composer: the board is where delegated
work is inspected, and a strip would both duplicate it and crowd the composer.

Both the panel and the slash command follow the harness language setting: every user-facing
string lives in the plugin's `modelOrchestrator` locale namespace (`lib/locales.js`, mirrored
inside the self-contained client bundle), covering both shipped locales. Strings a **model**
reads — tool descriptions, parameter schemas, the routing prompt section, personas — are
deliberately English and do not follow the UI language.

The settings page also carries a **health** line: which subsystems are active, which are
degraded and why, which are disabled and why, and which optional services this deployment
does not provide. A panel that did not mount, or a Sync that can never work, is visible
there instead of being a log line nobody reads.

Capability names follow the same split: the taxonomy's labels are model-facing and stay English,
because they travel into child prompts and delegation labels, while the panel translates them
through its own `capability.label.<id>` entries — so 「能力领域」 reads in Chinese and the agent
still receives `Testing and verification`. A learned capability with no entry yet falls back to its
taxonomy label.

Terminology policy: generic and technical terms stay untranslated. `host` / `requires`
version labels, `provider`, `Route`, deployment ids such as `workflowEngine`, model and
route names, reasoning-effort ids, and version strings like `0.1.5-rc.1` are data or
shared identifiers, so they appear verbatim in every language. Only explanatory prose is
translated.

Both are served by the host over same-origin routes: `state`, `configure`, `plan`, `tree` (the board's delegation graph) and `sync` (the research sweep).
The browser half cannot enumerate models itself — the LLM listing surface is host-only —
so the panel reads the real pool from the host and never guesses.

## How a multi-unit plan runs

Units run **in parallel** by default. A plan whose parts are independent — the common case —
finishes in as many waves as its `maxParallel` setting requires, and no unit waits on another.

`chain: true` turns the plan into a **pipeline** instead: each unit receives its predecessors'
findings, which is what a genuine sequence ("research, then review, then summarise") needs. It
used to be automatic, and that was wrong for the opposite reason: an eight-requirement research
task became seven sequential agents, each doing its own retrieval and each waiting on all of its
predecessors. The run hit the caller's thirty-minute tool-call ceiling and returned a timeout
error with **no results at all**, because a timeout discards everything rather than what finished.
The asymmetry decides it — a parallel unit may lose some cross-unit context; a serial run that
times out loses all of it. A caller that supplies its own `units` keeps full control of the graph
either way, and its `dependsOn` is never rewritten. Each of those units may pin its own `route`,
or name none and be routed by the capability it names — and a route that is no longer in the live
pool degrades to capability routing with `routeRequested` saying which name was asked for, rather
than losing the unit to a stale one. Keep a supplied unit's `prompt` short: the run's `task` is
added to every unit's prompt, so repeating it only makes the argument large enough to be written
incorrectly.

**A run also bounds itself.** `budgetMs` (25 minutes by default) aborts the run before the caller's
own tool-call ceiling does, so a long plan returns the units that finished, marks the rest as
unfinished, and sets `budgetExhausted`. Without it, the ceiling is the only limit and it costs the
whole run. Pass a smaller `budgetMs` if your own tool-call limit is shorter than the default.

### What a unit receives from the units it depends on

A unit that declared a dependency receives that dependency's **complete answer**, plus its
structured result when there is one. This is what depending on something means — the preview
is exactly the part that loses the reasoning the dependent unit needs. Every other unit still
receives a bounded digest of recent completions, never a sibling's full text, because the
whole reason it is independent is that it does not need one.

Three settings change it: `handoff.strategy` (`full`, the default, or `summary`),
`handoff.maxChars` (500–200 000) and `handoff.includeStructured`.

### Every answer is written down

A run's result can easily be larger than the harness will carry inline, and when it is, the
harness replaces it with a bounded preview and a locator — which used to mean the calling
model was told the result "was stored somewhere" and could not read a single unit's answer.

So each unit's complete answer is written to a file before the result is bounded: a Markdown
document per unit inside a run directory, plus an `index.md` naming every unit, its route, its
outcome and its byte count. The result carries `results[].artifact.path` and the run-level
`artifacts.dir` / `artifacts.index`; an inline answer that was cut says how much was elided and
where the rest is (`textTruncated`, `elidedChars`). The directory is `.dsh-orchestrator/artifacts`
inside the calling session's working directory when one is known, and the plugin's own state
directory otherwise. Writing is best-effort: a read-only workspace degrades to "this run has no
artifacts", reported in `artifacts.problems`, and the run is unaffected.

### Asking a unit that already answered

`orchestrate_ask` sends a follow-up question to a **completed** unit of the same run and
returns its answer, on the route that did the work. Every unit is given its run id and the
list of units it may question in its own prompt, so the capability is discoverable rather than
theoretical.

A unit that is still **running** refuses outright — it has no answer yet, and queueing the
question would either deadlock the asker or duplicate the work — and the refusal names the
units that *can* answer. Questions are capped per run and per asking unit
(`questions.maxPerRun`, default 4) and by a timeout (`questions.timeoutMs`, default 4
minutes). The run result reports every question and answer.

### The review loop

A unit that declares `reviews: [ids]` is a **reviewer**. It is scheduled after the units it
reviews and receives their complete answers, and it is expected to answer with:

```json
{ "verdict": "approve", "objections": [{ "unit": "impl", "issue": "no tests were mentioned" }] }
```

A rejection sends each objected unit back with the objection attached — so it revises rather
than starting over — and then the reviewer judges again. The loop is bounded by
`review.maxRounds` (default 2). Two rules make it safe rather than merely finite: a verdict
that cannot be read is recorded as **`unknown`** and the loop **stops**, because an unreadable
answer is not approval; and a child that answered and then failed is never re-run on another
model, because that is a content problem and paying a second model would not fix it.

## Who decides which model

Selection is a division of labour, because neither side can do it alone.

**The plugin** knows the deployment: it discovers the live routes, applies the subagent
route policy, enforces hard requirements (a stated context floor, a required modality), and
reports measured facts — context window, modalities, output budget, reasoning tiers.

**The calling model** knows the models. Whether an opaque route id corresponds to a
vision-strong model or a maths-strong one is public knowledge the plugin does not have and
must not invent; a deployment's aliases also need not match any public model name.

So `orchestrate_run` and `orchestrate_plan` accept `analysis.modelPreference`: the calling
model names the routes it judges best, most preferred first, with its reasoning. For a plan
whose units need **different** models — a vision unit and a maths unit rarely want the same
route — `analysis.unitModelPreference` addresses them individually, by exact capability id or
by cluster, with the most specific target winning for the unit it names. Units that match
nothing keep the task-level preference. The rules:

| Rule | Why |
|---|---|
| A preference **reorders** eligible candidates | it is a judgement, not a constraint |
| A preference **cannot revive a rejected route** | your requirements stay authoritative |
| An **unrecognised name is reported back** | never silently dropped |
| A **malformed entry is discarded** | no half-built route can be invented |
| With **no preference, the measured ranking stands** | the plugin still works alone |

The same section states the full ladder, highest first, because a preference that appears to be
ignored is otherwise indistinguishable from a bug:

| Rung | Who set it |
|---|---|
| **Capability assignments** | The **user's** standing policy, set once in the panel — the **first** priority |
| `analysis.unitModelPreference` | The calling model, about **one unit** |
| `analysis.modelPreference` | The calling model, about the **task** |
| The measured ranking | The plugin, from host facts |

A capability the user has configured **always follows the table**. That is a deliberate
reversal of the earlier ladder, where a per-unit preference from the caller outranked it: a
table is a decision the user made once and expects to hold, and a chatty caller must not
quietly defeat it. The reversal is not silent — see the next paragraph — and the table is
consulted for **caller-supplied units too**, which it previously was not: supplying a unit
graph used to bypass the division of labour entirely.

**Who decided is in the result.** Every unit carries `decidedBy` — `assignment`,
`caller-unit`, `caller-task`, `caller-pin` or `measured` — and when the table displaced a
caller's preference the unit also carries `overriddenCallerPreference`, naming exactly what
was displaced. `routeReason` says the same thing in prose, so "why is this unit on that
model" is answerable from the run itself rather than by inference.

**An ordered table falls through.** A capability may name several models in priority order,
and a route that cannot answer falls through to the next candidate. Only when the child
produced *nothing*, though: a child that answered and then failed is a content problem, and
paying a second model for it would not fix it.

### Judgements belong to the model

Anything that is a **judgement about the task** is the calling model's to make. The plugin's
own cue lists are a **fallback** for when no model supplied an analysis — never an authority
that overrules one, and never the only wording that can be understood.

| The plugin | The model |
|---|---|
| Measures facts: context window, modalities, output budget, reasoning tiers | Reads the task and judges what it needs |
| Enforces the route policy and hard requirements | Names capabilities, in its own vocabulary |
| Falls back to cue lists when nothing was supplied | States complexity and model preferences |

Concretely:

- A model-supplied analysis is **used as given**. Its `complexity` is no longer reconciled
  against the local reading — that reconciliation demoted a model claiming `complex` to a
  locally observed `specialist`, and promoted a claim of `trivial`.
- The fallback vocabulary lives in `lib/decision-vocabulary.js` and is **replaceable** through
  `orchestrate_configure`'s `decisionCues`, so an operator is never stuck with the author's
  phrasing. `orchestrate_status` reports which groups are still built-in.
- The fallback lists are kept small and are documented as hints, so they cannot be mistaken
  for a definition of what a task is.

### What the plugin will not do

It will not merge two routes that share a model name. In the deployment measured here,
`deepseek-official/deepseek-flash` and `commandcode/deepseek/deepseek-v4.1-flash` name the
same public model but differ in output budget by 4x (256k against 64k), sit behind different
providers, and are billed differently. Collapsing them would discard real, measured
differences and break routing, which needs exact routes.

It also does not fetch public model data from the network **by itself**. The route ids in a
deployment are frequently not public models at all, and a plugin that guessed at their identity
from a name would be inventing capability rather than measuring it. What it offers instead is
Sync: an action **you** press, which researches the pool and shows you what it found, with the
sources, and keeps what it could not confirm explicitly unconfirmed.

## Model facts from the web (Sync)

The host reports no pricing at all, which made the cost preference a switch that did nothing:
every route in a pool like this one measures as the same tier, so the tie-break it shapes was
identical everywhere. **Sync**, in the model pool, closes that with public facts:

- **Which public model a route is.** A route id is the deployment's own string and often repeats
  the publisher (`commandcode` + id `deepseek/deepseek-v4.1-flash`, advertised name
  `DeepSeek V4.1 Flash (CC)`). Sync resolves that, or reports that it could not.
- **Published list prices**, per million input and output tokens.
- **What public sources say the model is good at**, and the URLs those claims came from.

Sync is the only action **the plugin itself** takes on the network — the one whose cost and content
it chooses. It is deliberately not automatic: nothing is fetched at activation or on a poll, and a
sweep runs only when the button is pressed. (The harness's own model discovery does talk to a
provider when it refreshes the pool; that is why the plugin keeps discovery off the boot path and
never re-runs it on a poll. See *Performance*.)
On a deployment with no `web` service, Sync reports that it cannot research and everything else is
unaffected — the service is optional, like the command registry. It searches the web once per route
through the harness's own web service, then one model call
reconciles the sources into facts — the model judges the sources, the plugin decides what it is
allowed to see, and nothing is stored that the validator cannot check.

**A sweep is grouped by provider, and one failure costs one provider.** It used to be a single
call over the whole pool, so one provider that could not be reached — or one reconciling answer
that came back as prose — discarded every other provider's facts and reported one error with no
results at all. Each provider is now researched on its own and its facts are written as soon as
they land, so the sweep reports itself as `done`, `partial` or `error` with a per-provider
outcome; a reconciling route that never answered is retried on the next candidate route first.

**A failure says what it saw.** `the research answer contained no JSON object` was the entire
diagnosis, from which nothing can be concluded: not whether the model answered prose, answered
nothing, or wrapped its JSON in a way the parser missed. The answer's length, its opening text,
whether a fenced block was present, the reconciling route and its chunk count now travel with
the failure as `sync.detail`, and the message itself names them.

| | |
|---|---|
| **Unconfirmed stays unconfirmed** | A route the researcher cannot tie to a published model is stored as unconfirmed, never given a plausible name |
| **No estimated prices** | A price is used only if a source stated it. Missing is missing; a free tier is not a list price |
| **Provenance is part of the record** | Every entry carries its sources, when it was read, and which route did the reading |
| **It never overrides a measurement** | Prices only shape tie-breaks, within the same 0.08 ceiling the tier proxy used, normalised against the most expensive route in *this* pool. Hard requirements still reject before any of it is consulted |
| **It stays visibly researched** | The pool shows it on each row, marked as researched; the profile's own evidence still reads `metadata`, so nothing from the web is silently mixed into measured facts |

`preferCheaper` uses researched prices where a route has them and the tier proxy where it does
not, so enabling research changes what cost is measured *from*, never how much it is allowed to
matter. Researched entries are keyed by model identity, so a provider move does not orphan them —
and an entry that stops resolving is exactly the drift the pool row shows.

## Layout

The board renders as a **centred, width-constrained column**, matching how the shipped
Chat and Trajectory views lay themselves out. This is not decoration: the conversation
shell renders the transcript's width handles *absolutely*, positioned off the content
column, so a view that paints full-bleed draws its content straight under those handles.
Measured in a live session: the board column spans x 498–1272 while the handles sit at
x 436 and x 1304 — clear of the content, which is where they belong.

The board takes the shell's own content width, so dragging the transcript width handle
resizes it too — the same behaviour the composer keeps on the Chat page. The width is a
CSS chain (the shell's variable, then an observed copy of it, then the shell's 920px
ceiling) inside a clamp with a floor, so an unresolved variable cannot collapse the view.

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
node --test "test/*.test.js"   # 408 checks, no host required
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
  persistence.js    atomic state: preferences, descriptors, calibrations, research
  preferences.js    the ONE preference-patch implementation both configure surfaces call
  tools.js          the orchestrate_* model-facing tools
  schemas.js        tool names and parameter specs (host-free, so they are testable)
  locales.js        zh/en dictionaries for the UI (mirrored into the client bundle)
  routes.js         host control routes for the browser panel
  commands.js       the /model-orchestrator human command (host-free, so it is testable)
  reasoning-effort.js  per-route reasoning level: validation and merge, shared by both configure surfaces
  model-research.js    public facts about models: prompt, validation, price lookup
  web-research.js      the two-stage sync: web searches, then one reconciling model call
  sync.js              one research sweep at a time, and its status
  model-identity.js    model identity and family keys: which live route a stored intent means
  assignments.js       the standing division of labour: normalise, resolve, report drift
  agent-tree.js     subagent relationship tree and lifecycle truth for the board (pure, testable)
  runs.js           the run journal: sibling questions, review rounds, and the board's edges
  artifacts.js      each unit's answer on disk, plus the run index, with degraded fallback
  arguments.js      how a tool call's arguments are read, and where a misplaced one belongs
  health.js         which subsystem is enabled, degraded or disabled, and why
  host-locale.js    the host half's view of the UI language (read-only, from `settings`)
  route-policy.js   narrows discovery to the routes the deployment offers
  prompt.js         the routing-policy system prompt section
  client.js         client bundle: settings page + the Orchestrator board
  home.js, util.js  harness-home and value helpers
```

See `DESIGN.md` for the verified host contracts this is built against, and `docs/` for the
full API references gathered from the installed DSH tree.

## License

MIT — see `LICENSE`.
