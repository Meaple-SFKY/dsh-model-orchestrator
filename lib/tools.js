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
import { ANALYSIS_PARAMETER, TOOL_NAMES, toolNameList, toolParameterSpecs } from './schemas.js';

export { TOOL_NAMES, toolNameList, toolParameterSpecs };

/**
 * Register every orchestrator tool.
 *
 * @param ctx - the plugin context (needs `tools`).
 * @param deps - `{ engine, pool, taxonomy, store, calibrate, logger }`.
 * @returns the registered tool names.
 */
export function registerOrchestratorTools(ctx, deps) {
  const { engine, pool, taxonomy, store } = deps;
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
        'Build an orchestration plan for a task WITHOUT executing it: which routing tier applies, which capabilities are needed, which live model was matched to each unit, and why. Always cheap. Use it when you want to show the user the routing decision before committing to it, or when you want to see the match quality.',
      parameters: {
        task: { type: 'string', required: true, description: 'The task to plan.' },
        analysis: ANALYSIS_PARAMETER,
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        if (str(args?.task) === undefined) return { ok: false, error: 'task is required' };
        if (pool.models().length === 0) await engine.refresh({ signal: exec.signal });
        return toJsonSafe({ ok: true, ...(await engine.plan({ task: args.task, analysis: args.analysis })) });
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
        'Use this for any task that is non-trivial, needs a specific strength, or spans more than one kind of expertise. Simple tasks should be executed directly instead.',
      parameters: {
        task: { type: 'string', required: true, description: 'The complete task, with all the context a specialist would need.' },
        analysis: ANALYSIS_PARAMETER,
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
        const run = await engine.run({
          task: args.task,
          analysis: args.analysis,
          tier: str(args?.tier),
          captain,
          signal: exec.signal,
        });
        return toJsonSafe({ ok: true, ...run });
      },
    }),
  );

  add(
    defineTool({
      name: TOOL_NAMES.dispatch,
      description:
        'Delegate ONE self-contained unit of work to ONE model and return its answer. Use this when you already know exactly how to split the task and only need routing: give a capability id to let the orchestrator choose the route, or an explicit provider+model to force one. Cheaper and more predictable than orchestrate_run.',
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
          calibrations: Object.keys(state.profiles).length,
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
      },
      output: jsonOutput(),
      execute: async (args) => {
        const changes = {};
        if (args?.mode !== undefined) changes.mode = args.mode;
        if (args?.guidedCapabilities !== undefined) changes.guidedCapabilities = args.guidedCapabilities;
        for (const key of [
          'preferCheaper',
          'maxParallel',
          'maxAgentsPerRun',
          'allowMultiAgent',
          'deniedRoutes',
          'allowedRoutes',
          'calibrationEnabled',
          'captainMode',
        ]) {
          if (args?.[key] !== undefined) changes[key] = args[key];
        }

        const unknown = [];
        if (Array.isArray(changes.guidedCapabilities)) {
          for (const id of changes.guidedCapabilities) {
            if (!taxonomy.has(id)) unknown.push(id);
          }
        }

        if (Object.keys(changes).length > 0) {
          store.update((state) => {
            if (changes.mode !== undefined) state.mode = changes.mode;
            if (Array.isArray(changes.guidedCapabilities)) {
              state.guided.capabilities = changes.guidedCapabilities;
            }
            const preferences = state.preferences;
            if (changes.preferCheaper !== undefined) preferences.preferCheaper = changes.preferCheaper === true;
            if (changes.allowMultiAgent !== undefined) preferences.allowMultiAgent = changes.allowMultiAgent === true;
            if (changes.calibrationEnabled !== undefined) preferences.calibrationEnabled = changes.calibrationEnabled === true;
            if (changes.captainMode !== undefined) preferences.captainMode = changes.captainMode;
            const maxParallel = uint(changes.maxParallel);
            if (maxParallel !== undefined) preferences.maxParallel = clamp(maxParallel, 1, 16);
            const maxAgentsPerRun = uint(changes.maxAgentsPerRun);
            if (maxAgentsPerRun !== undefined) preferences.maxAgentsPerRun = clamp(maxAgentsPerRun, 1, 64);
            if (Array.isArray(changes.deniedRoutes)) preferences.deniedRoutes = changes.deniedRoutes;
            if (Array.isArray(changes.allowedRoutes)) preferences.allowedRoutes = changes.allowedRoutes;
          });
        }

        const state = store.snapshot();
        return toJsonSafe({
          ok: true,
          applied: Object.keys(changes),
          ...(unknown.length === 0 ? {} : { unknownCapabilities: unknown }),
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

/** Whether a route string is well-formed, used by validation paths. */
export function isRoute(value) {
  if (typeof value !== 'string') return false;
  const slash = value.indexOf('/');
  return slash > 0 && slash < value.length - 1;
}

/** A defensive check that a JSON output value is plain data. */
export function isPlainResult(value) {
  return value === null || isRecord(value) || Array.isArray(value) || typeof value !== 'object';
}

export { routeKey };
