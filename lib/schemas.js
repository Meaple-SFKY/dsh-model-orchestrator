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
        'Models YOU judge best for this task, most preferred first. This is where your own knowledge of public models belongs: the deployment route ids are often opaque (a provider alias), so cite the models you know. Entries whose route is not in the live pool are reported back, never silently dropped, and the rest are ordered ahead of the plugin\'s own measured ranking.',
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
    unitModelPreference: {
      type: 'array',
      description:
        'Per-unit model preferences, for a plan whose units need DIFFERENT models - the vision unit and the maths unit of one plan rarely want the same route. Each entry names the unit it applies to, most specifically first: a capability id ("multimodal.screenshot"), a cluster ("multimodal"), or a unit id. Units that match nothing keep modelPreference or the measured ranking. As with modelPreference, an entry reorders eligible routes and cannot revive one the requirements excluded.',
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
    },
    [TOOL_NAMES.run]: {
      task: {
        type: 'string',
        required: true,
        description: 'The complete task, with all the context a specialist would need.',
      },
      analysis: ANALYSIS_PARAMETER,
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
      reasoningEffort: { type: 'string', description: 'Reasoning effort id for the child model.' },
      maxTokens: { type: 'integer', description: 'Output token cap for the child model.' },
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
