/**
 * Model-facing tool schemas: names and parameter specifications.
 *
 * Declared here, in a module that imports nothing, for two reasons:
 *
 *  1. `tools.js` must import the host's `defineTool`, so it cannot be loaded
 *     outside an installed host. Keeping the schemas separate lets them be
 *     validated against the host's schema compiler on any machine.
 *  2. A parameter DSL violation then fails in a test rather than at boot.
 *
 * ## Parameter DSL rules this file obeys
 *
 * The harness compiles these specs strictly (`defineTool`). The rules are not
 * optional and are easy to get wrong:
 *
 *   - an **object** node requires `additionalProperties: boolean` explicitly;
 *   - an **array** node accepts only `type` and `items` — no
 *     `additionalProperties`, no `required`;
 *   - `required` is a per-property annotation on the property map, not a node
 *     field, and only in a parameter map (never inside `items`);
 *   - scalar nodes accept `type`, `enum`, `const`, and the shared annotations.
 *
 * @module dsh-model-orchestrator/schemas
 */

/** Tool name constants, shared with the prompt section so they cannot drift. */
export const TOOL_NAMES = Object.freeze({
  capabilities: 'orchestrate_capabilities',
  plan: 'orchestrate_plan',
  run: 'orchestrate_run',
  dispatch: 'orchestrate_dispatch',
  models: 'orchestrate_models',
  status: 'orchestrate_status',
  configure: 'orchestrate_configure',
  // Answered from what THIS process's run already produced, so it is only meaningful
  // to a unit inside a run — the run id is handed to each unit in its prompt.
  ask: 'orchestrate_ask',
});

/**
 * The shared `analysis` parameter: the calling model's own decomposition of a
 * task. Omit it and the orchestrator analyzes the task locally from vocabulary.
 */
export const ANALYSIS_PARAMETER = Object.freeze({
  type: 'object',
  additionalProperties: true,
  description:
    'Your own analysis of the task. Omit it to let the orchestrator analyze the task locally from vocabulary.',
  properties: {
    summary: { type: 'string', description: 'One-line statement of the real objective.' },
    complexity: {
      type: 'string',
      enum: ['trivial', 'simple', 'specialist', 'complex'],
      description: 'How much the task needs: nothing, one specialist, or several.',
    },
    domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Free-form area names, including areas the taxonomy does not know yet.',
    },
    modelPreference: {
      type: 'array',
      description:
        'Models YOU judge best for this task, INSIDE `analysis`, most preferred first. This is where your own knowledge of public models belongs: the deployment route ids are often opaque (a provider alias), so cite the models you know. Entries whose route is not in the live pool are reported back, never silently dropped, and the rest are ordered ahead of the plugin\'s own measured ranking.',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          provider: { type: 'string', description: 'Provider route, exactly as reported by orchestrate_models.' },
          model: { type: 'string', description: 'Model id, exactly as reported by orchestrate_models.' },
          route: { type: 'string', description: 'Shorthand for "provider/model"; alternative to the two fields above.' },
          reason: {
            type: 'string',
            description: 'Why this model suits the task. Cite the public model it corresponds to when the id is an alias.',
          },
        },
      },
    },
    chain: {
      type: 'boolean',
      description:
        'Chain the derived units into a pipeline, so each unit receives its predecessors\' findings. Off by default: an independent multi-part task runs faster in parallel and cannot lose everything to a time limit.',
    },
    unitModelPreference: {
      type: 'array',
      description:
        'Per-unit model preferences, INSIDE `analysis` (a top-level copy is folded in and reported, but this is where it belongs), for a plan whose units need DIFFERENT models - the vision unit and the maths unit of one plan rarely want the same route. Each entry names the unit it applies to, most specifically first: a capability id ("multimodal.screenshot"), a cluster ("multimodal"), or a unit id. Units that match nothing keep modelPreference or the measured ranking. As with modelPreference, an entry reorders eligible routes and cannot revive one the requirements excluded.',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          capability: { type: 'string', description: 'Capability id this preference applies to.' },
          group: { type: 'string', description: 'Capability cluster this preference applies to, e.g. "multimodal".' },
          routes: {
            type: 'array',
            description: 'Routes for this unit, most preferred first.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                provider: { type: 'string', description: 'Provider route.' },
                model: { type: 'string', description: 'Model id.' },
                route: { type: 'string', description: 'Shorthand for "provider/model".' },
                reason: { type: 'string', description: 'Why this model suits this unit.' },
              },
            },
          },
        },
      },
    },
    requirements: {
      type: 'array',
      description:
        'What the task needs. Each entry names a capability id (existing or invented) and how strongly it matters.',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          capability: { type: 'string', description: 'Capability id, e.g. "reasoning.mathematics".' },
          weight: { type: 'number', description: 'Relative importance, 0..1.' },
          reasoningEffort: {
            type: 'string',
            description:
              'Reasoning level for this unit, spelled as the chosen route advertises it (see orchestrate_models, which lists reasoningEfforts per route). Levels are route-specific: asking for one a route does not offer is dropped and reported as effortUnavailable rather than failing the unit.',
          },
          required: { type: 'boolean', description: 'Hard requirement; a model without it is rejected.' },
          minContextWindow: { type: 'integer', description: 'Minimum context window in tokens.' },
          minOutputTokens: { type: 'integer', description: 'Minimum output token cap.' },
          needsImageInput: { type: 'boolean', description: 'The unit must read images.' },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Vocabulary that describes the capability, used when minting a new one.',
          },
          label: { type: 'string', description: 'Human-readable name when minting a new capability.' },
          group: { type: 'string', description: 'Broad family when minting a new capability.' },
          reason: { type: 'string', description: 'Why this capability is needed.' },
        },
      },
    },
  },
});

/**
 * The caller-supplied unit graph, shared verbatim with the live `orchestrate_run`
 * registration in `lib/tools.js`.
 *
 * `provider`+`model` and `capabilityLabel` were read by the engine but declared
 * nowhere, so a caller could not discover them; they are part of the contract here
 * because they are part of the behavior.
 */
export const UNITS_PARAMETER = Object.freeze({
  type: 'array',
  description:
    'A caller-supplied unit graph, which replaces the one the orchestrator would build. Each entry is { id, capabilityId?, capabilityLabel?, prompt, route?, provider?, model?, dependsOn? }. A `route`, or an explicit `provider` together with `model`, pins that unit and is reported back when the live pool does not have it. Omit them and the unit is routed by the capability it names, subject to the standing capability assignment. A unit that lists `dependsOn` receives those units\' complete answers.',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: {
      id: { type: 'string', description: 'Unit id, referenced by dependsOn.' },
      capabilityId: { type: 'string', description: 'Capability this unit covers.' },
      capabilityLabel: { type: 'string', description: 'Human label for the unit.' },
      prompt: { type: 'string', description: 'What this unit must do.' },
      route: { type: 'string', description: 'Exact "provider/model" to pin this unit to.' },
      provider: { type: 'string', description: 'Provider to pin. Requires `model`.' },
      model: { type: 'string', description: 'Model to pin. Requires `provider`.' },
      dependsOn: {
        type: 'array',
        items: { type: 'string' },
        description: 'Unit ids that must finish first.',
      },
      reviews: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Unit ids this unit REVIEWS. It starts after them, receives their complete answers, and is expected to answer with { "verdict": "approve" | "reject", "objections": [{ "unit", "issue" }] }. A rejection sends each objected unit back for another attempt (bounded by the `review` setting).',
      },
    },
  },
});

/**
 * Every parameter specification this plugin registers, keyed by tool name.
 *
 * @returns a fresh map of tool name to parameter spec.
 */
export function toolParameterSpecs() {
  return {
    [TOOL_NAMES.capabilities]: {
      group: { type: 'string', description: 'Only return capabilities in this group.' },
    },
    [TOOL_NAMES.models]: {
      refresh: { type: 'boolean', description: 'Force a fresh discovery instead of using the cached pool.' },
      capability: {
        type: 'string',
        description: 'Rank the live pool against this capability id and show the resulting order.',
      },
    },
    [TOOL_NAMES.plan]: {
      task: { type: 'string', required: true, description: 'The task to plan.' },
      analysis: ANALYSIS_PARAMETER,
      tier: {
        type: 'string',
        enum: ['direct', 'specialist', 'multi-agent'],
        description: 'Force a routing tier instead of letting the orchestrator infer one.',
      },
    },
    [TOOL_NAMES.run]: {
      task: {
        type: 'string',
        required: true,
        description: 'The complete task, with all the context a specialist would need.',
      },
      analysis: ANALYSIS_PARAMETER,
      units: UNITS_PARAMETER,
      budgetMs: {
        type: 'integer',
        description:
          'How long the whole run may take before it aborts itself and returns the units that finished. Set it below your own tool-call time limit.',
      },
      chain: {
        type: 'boolean',
        description:
          "Chain the derived units into a pipeline so each receives its predecessors' findings. Off by default.",
      },
      tier: {
        type: 'string',
        enum: ['direct', 'specialist', 'multi-agent'],
        description: 'Force a routing tier instead of letting the orchestrator infer one.',
      },
    },
    [TOOL_NAMES.dispatch]: {
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
      reasoningEffort: {
        type: 'string',
        description:
          'Reasoning level for the child model, spelled as that route advertises it (see orchestrate_models). A level the route does not offer is dropped and reported as effortUnavailable rather than failing the delegation.',
      },
      maxTokens: { type: 'integer', description: 'Output token cap for the child model.' },
    },
    [TOOL_NAMES.ask]: {
      runId: {
        type: 'string',
        // Deliberately NOT `required`: a caller that omits it gets an answer that says
        // what is missing and lists nothing, which reads better than a schema refusal
        // from the tool layer, and keeps the parameter probe-able.
        description:
          'The run this question belongs to. Every unit is given it in its own prompt, as "Run id: …". Omitting it is reported back rather than refused.',
      },
      to: {
        type: 'string',
        description:
          'The id of the completed sibling unit to ask. OMIT IT to be told which units of the run can be asked right now.',
      },
      question: { type: 'string', description: 'The question, self-contained.' },
      from: { type: 'string', description: 'The asking unit id, so the run can report who asked.' },
    },
    [TOOL_NAMES.status]: {},
    [TOOL_NAMES.configure]: {
      mode: {
        type: 'string',
        enum: ['auto', 'guided'],
        description: 'auto routes automatically; guided seeds the session with your selected capabilities.',
      },
      guidedCapabilities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Capability ids selected in Guided mode. Replaces the current selection.',
      },
      preferCheaper: { type: 'boolean', description: 'Prefer lower-cost routes when fit is comparable.' },
      maxParallel: { type: 'integer', description: 'Maximum concurrent specialist subagents (1-16).' },
      maxAgentsPerRun: { type: 'integer', description: 'Maximum specialists per orchestration run (1-64).' },
      allowMultiAgent: { type: 'boolean', description: 'Allow multi-agent plans for complex tasks.' },
      deniedRoutes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Routes never to use, as "provider/model".',
      },
      allowedRoutes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict routing to these routes. Empty means any.',
      },
      calibrationEnabled: {
        type: 'boolean',
        description: 'Whether learned per-model calibration is kept in sync with the live pool.',
      },
      captainMode: {
        type: 'string',
        enum: ['main', 'spawned'],
        description: 'main keeps the calling agent as captain; spawned lets a plan run its own captain child.',
      },
      reasoningEffort: {
        type: 'object',
        additionalProperties: true,
        description:
          'Reasoning level per route, keyed by "provider/model" exactly as orchestrate_models reports it. Each value must be a level that route advertises; null clears the preference.',
      },
      capabilityAssignments: {
        type: 'object',
        additionalProperties: true,
        description:
          "The user's standing division of labour, keyed by capability id or capability group: an ordered list of model identities, most preferred first, optionally with `family: true`. null clears the entry.",
      },
      handoff: {
        type: 'object',
        additionalProperties: true,
        description:
          "What a unit that declared a dependency receives from the units it depends on: `strategy` 'full' (default) or 'summary', `maxChars` (500-200000), and `includeStructured` (default true).",
      },
      questions: {
        type: 'object',
        additionalProperties: true,
        description:
          'Bounds on sibling questions (orchestrate_ask): `maxPerRun` (0-32, default 4) per asking unit, and `timeoutMs` (1000-1800000, default 240000) for one question.',
      },
      review: {
        type: 'object',
        additionalProperties: true,
        description:
          'Bounds on the review loop: `maxRounds` (0-5, default 2). A reviewer re-runs a rejected unit with the objection and then judges again, at most this many times.',
      },
      decisionCues: {
        type: 'object',
        additionalProperties: true,
        description:
          'Replace the FALLBACK cue lists used only when no calling model supplied an analysis. Keys are cue groups, each value a string array. An empty list is ignored, so a dimension cannot be disabled by omission. A model-supplied analysis is always used as given and never consults these lists.',
        properties: {
          multiStep: { type: 'array', items: { type: 'string' }, description: 'Wording indicating work with several ordered parts.' },
          trivial: { type: 'array', items: { type: 'string' }, description: 'Wording indicating a one-line change.' },
          parallel: { type: 'array', items: { type: 'string' }, description: 'Wording indicating several independent parts.' },
          deep: { type: 'array', items: { type: 'string' }, description: 'Wording indicating difficult, multi-step work.' },
          routine: { type: 'array', items: { type: 'string' }, description: 'Wording indicating mechanical, fully specified work.' },
          image: { type: 'array', items: { type: 'string' }, description: 'Wording indicating visual material to read.' },
        },
      },
    },
  };
}

/** The tool names as a comma-separated list, for prompts and diagnostics. */
export function toolNameList() {
  return Object.values(TOOL_NAMES).join(', ');
}
