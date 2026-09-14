/**
 * Model-facing orchestrator tools.
 *
 * These are the only surface through which an agent reaches the orchestrator.
 * They are deliberately thin: every decision lives in `engine.js`, `matching.js`
 * and `discovery.js`, so the same logic serves the tools, the control panel, and
 * tests.
 *
 * @module dsh-model-orchestrator/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { clamp, isRecord, jsonOutput, routeKey, str, toJsonSafe, uint } from './util.js';
import { poolFingerprint } from './discovery.js';
import { SEED_IDS } from './taxonomy.js';
import { effortPatch, mergeEffortPatch } from './reasoning-effort.js';
import { resolveAssignments } from './assignments.js';
import { applyPreferencePatch } from './preferences.js';
import { describeCues } from './decision-vocabulary.js';
import { ANALYSIS_PARAMETER, TOOL_NAMES, UNITS_PARAMETER, toolNameList, toolParameterSpecs } from './schemas.js';
import { analysisFromArguments, argumentReport } from './arguments.js';

export { TOOL_NAMES, toolNameList, toolParameterSpecs };

/**
 * Register every orchestrator tool.
 *
 * @param ctx - the plugin context (needs `tools`).
 * @param deps - `{ engine, pool, taxonomy, store, calibrate, logger }`.
 * @returns the registered tool names.
 */
export function registerOrchestratorTools(ctx, deps) {
  const { engine, pool, taxonomy, store, health, locale } = deps;
  const registered = [];

  const add = (definition) => {
    const dispose = ctx.tools.register(definition);
    registered.push(definition.name);
    return dispose;
  };

  // ---- capability catalog --------------------------------------------------

  add(
    defineTool({
      name: TOOL_NAMES.capabilities,
      description:
        'List the orchestrator capability taxonomy and the current orchestration mode. Use this to discover which capability ids can be requested, or to see what was added for a new domain. Capability ids are generic (e.g. "software.implementation", "data.analysis", "multimodal.vision") and are never tied to a specific model.',
      parameters: {
        group: { type: 'string', description: 'Only return capabilities in this group.' },
      },
      output: jsonOutput(),
      execute: async (args) => {
        const group = str(args?.group);
        const capabilities = taxonomy
          .list()
          .filter((entry) => group === undefined || entry.group === group)
          .map((entry) => ({
            id: entry.id,
            label: entry.label,
            group: entry.group,
            origin: entry.origin,
            ...(entry.summary === undefined ? {} : { summary: entry.summary }),
          }));
        const groups = [...new Set(taxonomy.list().map((entry) => entry.group))].sort();
        const state = store.snapshot();
        return toJsonSafe({
          mode: state.mode,
          guidedCapabilities: state.guided.capabilities,
          capabilityCount: capabilities.length,
          groups,
          capabilities,
        });
      },
    }),
  );

  // ---- model pool ----------------------------------------------------------

  add(
    defineTool({
      name: TOOL_NAMES.models,
      description:
        'List the models actually available right now, with the capability evidence the orchestrator observed for each. This reads the live pool on every call: it is never a fixed list. Use it to see why a route was or was not chosen.',
      parameters: {
        refresh: {
          type: 'boolean',
          description: 'Force a fresh discovery instead of using the cached pool.',
        },
        capability: {
          type: 'string',
          description: 'Rank the pool against this capability id and show the resulting order.',
        },
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        if (args?.refresh === true) await engine.refresh({ signal: exec.signal });
        const capability = str(args?.capability);
        let ranking;
        if (capability !== undefined) {
          const descriptor = taxonomy.get(capability);
          if (descriptor === undefined) {
            return { ok: false, error: `unknown capability "${capability}"`, known: SEED_IDS.slice(0, 20) };
          }
          const { rankModels } = await import('./matching.js');
          const ranked = rankModels(
            pool,
            taxonomy,
            { summary: capability, complexity: 'specialist', requirements: [{ capability, weight: 1 }], source: 'auto' },
            { preferences: engine.preferences },
          );
          ranking = { selected: capability, candidates: ranked.candidates.slice(0, 10), rejected: ranked.rejected.slice(0, 10) };
        }

        // One clone, not one per model: `store.snapshot()` is a deep clone of the
        // persisted state (calibrations and researched facts included) and the map
        // below runs once per route.
        const preferences = store.snapshot().preferences;

        return toJsonSafe({
          ok: true,
          pool: {
            size: pool.models().length,
            providers: pool.providers(),
            fingerprint: poolFingerprint(pool),
            discoveredAt: pool.discoveredAt(),
            problems: pool.problems(),
            filter: typeof pool.filterReport === 'function' ? pool.filterReport() : undefined,
          },
          models: pool.models().map((model) => ({
            route: model.route,
            provider: model.provider,
            model: model.model,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            confidence: model.confidence,
            evidence: model.evidence,
            tier: model.derived?.tier ?? 'unknown',
            supportsImage: model.derived?.supportsImage,
            contextWindow: model.facts?.contextWindow,
            defaultMaxTokens: model.facts?.defaultMaxTokens,
            reasoningEfforts: model.facts?.efforts,
            reasoningMode:
              model.facts?.reasoningMode ?? (model.derived?.hasReasoning === true ? 'adjustable' : 'none'),
            // The level the harness applies with no preference, and the level
            // configured for this route in the model pool. Reported so a caller can
            // see which reasoning level its work will actually run at.
            ...(model.facts?.defaultEffort === undefined ? {} : { defaultEffort: model.facts.defaultEffort }),
            ...(preferences.reasoningEffort?.[model.route] === undefined
              ? {}
              : { reasoningEffort: preferences.reasoningEffort[model.route] }),
          })),
          ...(ranking === undefined ? {} : { ranking }),
        });
      },
    }),
  );

  // ---- planning ------------------------------------------------------------


  add(
    defineTool({
      name: TOOL_NAMES.plan,
      description:
        'Build an orchestration plan for a task WITHOUT executing it: which routing tier applies, which capabilities are needed, which live model was matched to each unit, and why — including `decidedBy`, which names whether the user\'s standing capability assignment, your own preference, or the measured ranking decided each route. Always cheap. Use it when you want to show the user the routing decision before committing to it, or when you want to see the match quality. Routing inputs belong INSIDE `analysis`; anything placed at the top level is reported back in `misplacedArguments`/`unusedArguments` rather than silently ignored.',
      parameters: {
        task: { type: 'string', required: true, description: 'The task to plan.' },
        analysis: ANALYSIS_PARAMETER,
        // `engine.plan` has always accepted a forced tier; the tool simply never passed
        // one, so `orchestrate_plan { tier }` was another silently ignored argument.
        tier: {
          type: 'string',
          enum: ['direct', 'specialist', 'multi-agent'],
          description: 'Force a routing tier instead of letting the orchestrator infer one.',
        },
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        if (str(args?.task) === undefined) return { ok: false, error: 'task is required' };
        if (pool.models().length === 0) await engine.refresh({ signal: exec.signal });
        const { analysis, ...report } = analysisFromArguments(args, {
          task: undefined,
          analysis: undefined,
          tier: undefined,
        });
        return toJsonSafe({
          ok: true,
          ...argumentReport(report),
          ...(await engine.plan({ task: args.task, analysis, tier: str(args?.tier) })),
        });
      },
    }),
  );

  // ---- execution -----------------------------------------------------------

  add(
    defineTool({
      name: TOOL_NAMES.run,
      description:
        'Execute a task through the orchestrator: it matches capabilities to the live models, delegates each unit to a specialist subagent on the matched route, and returns every specialist result to you. You remain the owner of the final answer and must synthesize the results yourself. ' +
        'ROUTING IS YOURS TO INFORM. The plugin measures what the harness exposes (context window, modalities, output budget, reasoning tiers) and enforces your deployment\'s route policy, but it has no knowledge of how public models differ at what they do. You do. So when you know a model is the right one for a unit - a vision-strong model for reading a diagram, a maths-strong model for a derivation, a cheap high-scoring coder for bulk implementation - say so in analysis.modelPreference, naming routes exactly as orchestrate_models reports them. Your preference reorders the eligible candidates; it can never revive a route your requirements excluded, and any name the pool does not recognise is reported back to you instead of being dropped. Read the live pool with orchestrate_models first when the route ids are unfamiliar. ' +
        'WHERE EVERY FIELD BELONGS. All routing inputs live INSIDE `analysis` (`modelPreference`, ' +
        '`unitModelPreference`, `requirements`, `domains`, `complexity`, `summary`, `chain`) or are declared ' +
        'parameters of this tool (`task`, `units`, `chain`, `tier`, `budgetMs`). A model route is written as ' +
        '`analysis.modelPreference[].route`; a per-unit route as `units[].route` or `units[].provider` + ' +
        '`units[].model`. A value placed at the top level instead is REPORTED BACK to you: read ' +
        '`misplacedArguments` (each entry names the argument AND the parameter path it belongs at), ' +
        '`unusedArguments` (anything else unrecognised) and `foldedIntoAnalysis` (a top-level ' +
        '`modelPreference`/`unitModelPreference`, which is folded in because the intent is unmistakable). ' +
        'A silently ignored route is therefore not possible — but do read those fields rather than assuming ' +
        'the value took effect. ' +
        'WHERE YOUR PREFERENCE SITS. A standing capability assignment the user has configured for a route ' +
        'outranks your task-level modelPreference, so a preference that appears to be ignored is usually ' +
        'the user\'s own policy winning. Your per-unit unitModelPreference still beats it, which is the ' +
        'way to override the table for one unit. ' +
        'LONG RUNS STAY READABLE. Every unit\'s complete answer is written to a file and the result carries its ' +
        'path in `results[].artifact.path` (plus the run-level `artifacts.dir` and `artifacts.index`). The inline ' +
        '`results[].text` is bounded by the plugin on purpose; when it is cut, `textTruncated` and `elidedChars` ' +
        'say so and the file holds the rest, so read the file rather than asking for the run again. If artifact ' +
        'writing failed, `artifacts.count` is 0 and `artifacts.problems` says why — the run is unaffected. ' +
        'Use this for any task that is non-trivial, needs a specific strength, or spans more than one kind of expertise. ' +
        'Prefer it over spawning subagents yourself whenever the units differ in kind or their model should differ: a child spawned without an explicit route inherits the deployment\'s single default child model, so heterogeneous work would all run on one model. ' +
        'Simple tasks should be executed directly instead.',
      parameters: {
        task: { type: 'string', required: true, description: 'The complete task, with all the context a specialist would need.' },
        analysis: ANALYSIS_PARAMETER,
        // `engine.run` has always accepted a caller-supplied graph and a chain flag;
        // the tool declared neither, so `units` was another argument a caller could
        // send and have silently dropped — which also made the pipeline opt-in
        // unreachable from here.
        // Declared in `schemas.js` and reused here so the runtime contract and the
        // DSL-validated mirror cannot drift apart again.
        units: UNITS_PARAMETER,
        budgetMs: {
          type: 'integer',
          description:
            'How long the whole run may take before it aborts itself and returns the units that finished. Set it below your own tool-call time limit: without it, a run that hits that limit returns a timeout error and no results at all, and everything it had already produced is lost.',
        },
        chain: {
          type: 'boolean',
          description:
            'Chain the derived units into a pipeline: each unit receives its predecessors\' findings. Off by default, because an independent multi-part task runs faster and cannot lose everything to a time limit. Only set it when the parts genuinely depend on each other\'s output.',
        },
        tier: {
          type: 'string',
          enum: ['direct', 'specialist', 'multi-agent'],
          description: 'Force a routing tier instead of letting the orchestrator infer one.',
        },
      },
      timeoutMs: 1_800_000,
      output: jsonOutput(),
      execute: async (args, exec) => {
        const task = str(args?.task);
        if (task === undefined) return { ok: false, error: 'task is required' };
        const captain = exec.agent;
        if (captain === undefined) {
          return {
            ok: false,
            error:
              'no calling agent is available; the orchestrator delegates from a live agent session',
          };
        }
        if (pool.models().length === 0) await engine.refresh({ signal: exec.signal });
        const { analysis, ...report } = analysisFromArguments(args, {
          task: undefined,
          analysis: undefined,
          tier: undefined,
          units: undefined,
          chain: undefined,
          budgetMs: undefined,
        });
        const run = await engine.run({
          task: args.task,
          analysis,
          tier: str(args?.tier),
          ...(Array.isArray(args?.units) && args.units.length > 0 ? { units: args.units } : {}),
          ...(args?.chain === true ? { chain: true } : {}),
          ...(uint(args?.budgetMs) === undefined ? {} : { budgetMs: uint(args.budgetMs) }),
          captain,
          signal: exec.signal,
        });
        return toJsonSafe({ ok: true, ...argumentReport(report), ...run });
      },
    }),
  );

  add(
    defineTool({
      name: TOOL_NAMES.dispatch,
      description:
        'Delegate ONE self-contained unit of work to ONE model and return its answer. Use this when you already know exactly how to split the task and only need routing: give a capability id to let the orchestrator choose the route, or an explicit provider+model to force one. Cheaper and more predictable than orchestrate_run. Prefer it over a native subagent call whenever that unit must run on a chosen model.',
      parameters: {
        task: { type: 'string', required: true, description: 'The unit of work, self-contained.' },
        capability: {
          type: 'string',
          description: 'Capability id to route by, e.g. "software.review". Omit when forcing a route.',
        },
        provider: { type: 'string', description: 'Force this provider route (requires model).' },
        model: { type: 'string', description: 'Force this model (requires provider).' },
        prompt: { type: 'string', description: 'Override the prompt sent to the specialist.' },
        label: { type: 'string', description: 'Short label for the delegated unit.' },
        persona: { type: 'string', description: 'Override the specialist persona.' },
        outputContract: { type: 'string', description: 'What the specialist should return.' },
        executionPrompt: { type: 'string', description: 'Extra execution guidance for the specialist.' },
        reasoningEffort: { type: 'string', description: 'Reasoning effort id for the child model.' },
        maxTokens: { type: 'integer', description: 'Output token cap for the child model.' },
      },
      timeoutMs: 1_800_000,
      output: jsonOutput(),
      execute: async (args, exec) => {
        const task = str(args?.task);
        if (task === undefined) return { ok: false, error: 'task is required' };
        const provider = str(args?.provider);
        const model = str(args?.model);
        if ((provider === undefined) !== (model === undefined)) {
          return { ok: false, error: 'provider and model must be supplied together' };
        }
        const captain = exec.agent;
        if (captain === undefined) {
          return { ok: false, error: 'no calling agent is available for delegation' };
        }
        if (pool.models().length === 0) await engine.refresh({ signal: exec.signal });
        const run = await engine.dispatch({
          task,
          capability: str(args?.capability),
          provider,
          model,
          prompt: str(args?.prompt),
          label: str(args?.label),
          persona: str(args?.persona),
          outputContract: str(args?.outputContract),
          executionPrompt: str(args?.executionPrompt),
          reasoningEffort: str(args?.reasoningEffort),
          maxTokens: uint(args?.maxTokens),
          captain,
          signal: exec.signal,
        });
        // `dispatch` reports its own outcome; return it unchanged either way.
        return run;
      },
    }),
  );

  // ---- sibling questions ---------------------------------------------------

  add(
    defineTool({
      name: TOOL_NAMES.ask,
      description:
        'Ask a COMPLETED sibling unit of the same orchestration run a follow-up question, and get its answer back. Use it when another unit of your run already did work you need a detail from, instead of re-deriving it. You are given the run id and the units available to you in your own prompt. A unit that is still RUNNING cannot be asked — it has no answer yet — and the refusal tells you which units can be. Questions are capped per run and by a timeout (see the `questions` setting of orchestrate_configure). Omit `to` to be told who is askable right now.',
      parameters: toolParameterSpecs()[TOOL_NAMES.ask],
      timeoutMs: 600_000,
      output: jsonOutput(),
      execute: async (args, exec) => {
        const captain = exec.agent;
        if (captain === undefined) {
          return { ok: false, error: 'no calling agent is available, so the sibling cannot be reached' };
        }
        return toJsonSafe(
          await engine.ask({
            runId: str(args?.runId),
            from: str(args?.from),
            to: str(args?.to),
            question: str(args?.question),
            captain,
            signal: exec.signal,
          }),
        );
      },
    }),
  );

  // ---- status --------------------------------------------------------------

  add(
    defineTool({
      name: TOOL_NAMES.status,
      description:
        'Report ROUTING status only: the mode, the live model pool and its change fingerprint, the capability taxonomy, calibrations, and any pool problem. This is not a task list — task lists, step status, and progress are DSH-native and are not owned or mirrored by the orchestrator. Use it to verify that the model pool changed, not to check on work in progress.',
      parameters: {},
      output: jsonOutput(),
      execute: async (_args, exec) => {
        await engine.refresh({ signal: exec.signal });
        const state = store.snapshot();
        return toJsonSafe({
          ok: true,
          mode: state.mode,
          guidedCapabilities: state.guided.capabilities,
          preferences: state.preferences,
          pool: {
            size: pool.models().length,
            providers: pool.providers(),
            fingerprint: poolFingerprint(pool),
            discoveredAt: pool.discoveredAt(),
            problems: pool.problems(),
          },
          capabilities: taxonomy.list().length,
          customCapabilities: taxonomy.customDescriptors().length,
          // Enabled / degraded / disabled subsystems and the optional dependencies
          // this deployment does not provide. The status tool reported no health at
          // all, so a missing surface could only be discovered from the log.
          ...(health?.snapshot === undefined ? {} : { health: health.snapshot() }),
          // The language the HOST half is using, and which source decided it. The
          // harness renders a third-party command's copy verbatim, so "why is my slash
          // command still English?" has exactly one answer — the host never learned the
          // UI language — and this is where that answer is readable.
          ...(locale?.language === undefined
            ? {}
            : {
                locale: {
                  language: locale.language,
                  source: locale.source,
                  explicit: locale.explicit === true,
                },
              }),
          // Which cue groups are the built-in fallback and which an operator
          // replaced. The README promised this from the status tool and only the
          // panel did it.
          decisionCues: describeCues(state.preferences),
          calibrations: Object.keys(state.profiles).length,
          // The standing table as it stands right now against the live pool: what
          // resolves, what does not, and which live routes it does not mention. A
          // table that has stopped matching anything must be visible from here, not
          // inferred from routing that quietly got worse.
          assignments: (() => {
            const report = resolveAssignments(state.preferences.capabilityAssignments, pool.models());
            return {
              count: report.count,
              entries: report.entries.map((entry) => ({
                key: entry.key,
                models: entry.models,
                family: entry.family,
                routes: entry.routes,
                ...(entry.unresolved.length === 0 ? {} : { unresolved: entry.unresolved }),
              })),
              unresolved: report.unresolved,
              unassigned: report.unassigned,
            };
          })(),
          // Routing capacity only. Task and progress reporting belong to DSH.
          inFlight: engine.inFlightCount,
          storage: {
            path: store.path,
            // Absent rather than `undefined`: the host's lossless-JSON check
            // rejects an explicitly-undefined property outright.
            ...(store.writeError === undefined ? {} : { lastError: store.writeError }),
          },
        });
      },
    }),
  );

  // ---- configuration -------------------------------------------------------

  add(
    defineTool({
      name: TOOL_NAMES.configure,
      description:
        'Read or change the user\'s orchestration preferences: Auto or Guided mode, the capabilities selected in Guided mode, cost preference, parallelism limits, denied/allowed routes, and the subagent child provider. Changes persist across restarts. This never changes the model pool, which is always rediscovered live.',
      parameters: {
        mode: { type: 'string', enum: ['auto', 'guided'], description: 'auto routes automatically; guided seeds the session with your selected capabilities.' },
        guidedCapabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Capability ids selected in Guided mode. Replaces the current selection.',
        },
        preferCheaper: { type: 'boolean', description: 'Prefer lower-cost routes when fit is comparable.' },
        maxParallel: { type: 'integer', description: 'Maximum concurrent specialist subagents (1-16).' },
        maxAgentsPerRun: { type: 'integer', description: 'Maximum specialists per orchestration run (1-64).' },
        allowMultiAgent: { type: 'boolean', description: 'Allow multi-agent plans for complex tasks.' },
        deniedRoutes: { type: 'array', items: { type: 'string' }, description: 'Routes never to use, as "provider/model".' },
        allowedRoutes: { type: 'array', items: { type: 'string' }, description: 'Restrict routing to these routes. Empty means any.' },
        calibrationEnabled: { type: 'boolean', description: 'Whether learned per-model calibration is kept in sync with the live pool.' },
        captainMode: { type: 'string', enum: ['main', 'spawned'], description: 'main keeps the calling agent as captain; spawned lets a plan run its own captain child.' },
        reasoningEffort: {
          type: 'object',
          additionalProperties: true,
          description:
            'Reasoning level per route, keyed by "provider/model" exactly as orchestrate_models reports it. Each value must be one of the levels that route advertises; null clears the preference. A route-level setting applies to every delegation on that route.',
        },
        questions: {
          type: 'object',
          additionalProperties: true,
          description:
            'Bounds on sibling questions: `maxPerRun` (0-32, default 4) is how many questions ONE unit may ask of its completed siblings of the same run, and `timeoutMs` (1000-1800000, default 240000) is how long one question may take before it is cancelled. A unit that is still running refuses a question outright, and the refusal names the units that can be asked.',
        },
        review: {
          type: 'object',
          additionalProperties: true,
          description:
            'Bounds on the review loop: `maxRounds` (0-5, default 2). A unit that declares `reviews: [ids]` judges those units after they answer; a rejection with objections re-runs the objected units with the objection attached and then judges again. A verdict that cannot be read is recorded as "unknown" and stops the loop.',
        },
        handoff: {
          type: 'object',
          additionalProperties: true,
          description:
            'What a unit that DECLARED a dependency receives from the units it depends on. `strategy` is "full" (the default: the dependency\'s complete answer, plus its structured result when there is one) or "summary" (only its bounded preview). `maxChars` caps how much of that answer may enter the dependent unit\'s prompt, between 500 and 200000; `includeStructured` (default true) decides whether a structured result travels with the text. Units that declare no dependency always receive only a bounded digest, never a sibling\'s full text.',
        },
        capabilityAssignments: {
          type: 'object',
          additionalProperties: true,
          description:
            'The user\'s standing division of labour, keyed by capability id or capability group: which model serves which kind of work. Values are an ordered list of model identities, most preferred first — a model id or name as the pool reports it, not necessarily a provider-qualified route — optionally with `family: true` to also follow a version bump. null clears the entry. Identities are resolved against the live pool on every run, so a rename, a provider move and a version bump are all absorbed; a target that resolves to nothing is reported rather than silently ignored. Read the pool and the vocabulary with orchestrate_models and orchestrate_capabilities first, and use the exact ids they report.',
        },
      },
      output: jsonOutput(),
      execute: async (args) => {
        // Cleaned of `undefined`, so an omitted parameter is genuinely absent
        // rather than present-and-empty.
        const patch = Object.fromEntries(
          Object.entries(args ?? {}).filter(([, value]) => value !== undefined),
        );
        // The SAME implementation the panel's control route uses: these two
        // surfaces accept one vocabulary, and keeping two copies of what it means
        // is how `decisionCues` came to be advertised here and ignored.
        const result = applyPreferencePatch(store, patch, pool, taxonomy);
        const state = store.snapshot();
        return toJsonSafe({
          ok: true,
          applied: result.applied,
          ...(result.unknownCapabilities === undefined
            ? {}
            : { unknownCapabilities: result.unknownCapabilities }),
          ...(result.rejected === undefined || result.rejected.length === 0
            ? {}
            : { rejected: result.rejected }),
          ...(result.assignmentsResolved === undefined
            ? {}
            : { assignmentsResolved: result.assignmentsResolved }),
          ...(result.assignmentsUnresolved === undefined
            ? {}
            : { assignmentsUnresolved: result.assignmentsUnresolved }),
          state: {
            mode: state.mode,
            guidedCapabilities: state.guided.capabilities,
            preferences: state.preferences,
          },
        });
      },
    }),
  );

  return registered;
}
