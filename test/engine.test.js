/**
 * Engine tests: tier selection, delegation to the matched route, result return
 * to the captain, disposal, and failure handling.
 *
 * These run against a mock host rather than a live one, so they assert the
 * orchestrator's own contract: what it decides and what it sends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Taxonomy } from '../lib/taxonomy.js';
import { ModelPool, buildProfile } from '../lib/discovery.js';
import { Orchestrator, planTier } from '../lib/engine.js';
import { OrchestratorStore } from '../lib/persistence.js';

/** Build a fake pool from literal profiles. */
function makePool(profiles) {
  const pool = new ModelPool();
  Object.defineProperty(pool, 'models', { value: () => profiles, configurable: true });
  Object.defineProperty(pool, 'providers', {
    value: () => [...new Set(profiles.map((entry) => entry.provider))],
    configurable: true,
  });
  Object.defineProperty(pool, 'discoveredAt', { value: () => Date.now(), configurable: true });
  Object.defineProperty(pool, 'problems', { value: () => [], configurable: true });
  Object.defineProperty(pool, 'lastError', { value: () => undefined, configurable: true });
  Object.defineProperty(pool, 'refresh', { value: async () => ({ models: profiles }), configurable: true });
  Object.defineProperty(pool, 'get', {
    value: (route) => profiles.find((entry) => entry.route === route),
    configurable: true,
  });
  return pool;
}

function profileOf(provider, model, options = {}) {
  return buildProfile(
    {
      modalities: options.modalities ?? ['text'],
      contextWindow: options.contextWindow ?? 200000,
      defaultMaxTokens: options.defaultMaxTokens,
      efforts: options.efforts,
      defaultEffort: undefined,
      name: options.name ?? model,
      description: options.description,
    },
    provider,
    model,
  );
}

/**
 * A mock host: records every child request and answers with a canned result.
 */
function makeHost({ profiles, answer } = {}) {
  const calls = [];
  const disposed = [];
  const subagents = {
    list: () => ['spawn'],
    getProvider: (name) =>
      name === 'spawn'
        ? {
            name: 'spawn',
            capabilities: {
              agentOptions: true,
              outputSchema: true,
              depthLimit: true,
              toolFilter: true,
              persona: true,
            },
            inheritsParentContext: false,
          }
        : undefined,
    start: async (provider, request) => {
      calls.push({ provider, request });
      const text =
        typeof answer === 'function' ? answer(request) : (answer ?? `answered by ${request.agentOptions.model}`);
      const run = {
        id: `child-${calls.length}`,
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text }],
          stopReason: 'completed',
        }),
        dispose: async () => {
          disposed.push(run.id);
        },
      };
      return run;
    },
  };
  const llm = {
    listProviders: () => [{ id: 'p1', name: 'Provider one' }],
    listModels: async () => [],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    resolveCallConfig: async (config) => config,
  };
  const ctx = {
    get(key) {
      if (key === 'llm') return llm;
      if (key === 'subagents') return subagents;
      return undefined;
    },
  };
  return { ctx, calls, disposed, subagents };
}

function makeEngine({ profiles, answer, preferences } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orch-engine-'));
  const store = new OrchestratorStore(directory);
  if (preferences !== undefined) {
    store.update((state) => Object.assign(state.preferences, preferences));
  }
  const taxonomy = new Taxonomy();
  const pool = makePool(profiles ?? []);
  const host = makeHost({ profiles, answer });
  const engine = new Orchestrator({
    ctx: host.ctx,
    pool,
    taxonomy,
    store,
    logger: undefined,
  });
  return { engine, host, store, taxonomy, pool, directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

const CAPTAIN = { id: 'captain-session' };

test('a trivial task is executed directly with no child spawned', async () => {
  const profiles = [profileOf('p1', 'm1', { efforts: ['high'] })];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const run = await engine.run({
      task: 'what is a monad',
      analysis: { summary: 'definition', complexity: 'trivial', requirements: [] },
      captain: CAPTAIN,
    });
    assert.equal(run.tier, 'direct');
    assert.equal(host.calls.length, 0, 'no child may be spawned for a direct task');
    assert.equal(run.counts.total, 0);
    assert.match(run.guidance, /executes this task itself/i);
  } finally {
    cleanup();
  }
});

test('a specialist task spawns exactly one child on the matched route', async () => {
  const profiles = [
    profileOf('p1', 'cheap', { description: 'routine' }),
    profileOf('p1', 'capable', { description: 'careful multi-step work', efforts: ['high'] }),
  ];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const run = await engine.run({
      task: 'Diagnose the root cause of the intermittent failure.',
      captain: CAPTAIN,
    });
    assert.equal(run.tier, 'specialist');
    assert.equal(host.calls.length, 1, 'a specialist task must spawn exactly one child');
    assert.equal(host.calls[0].request.agentOptions.provider, 'p1');
    assert.equal(
      host.calls[0].request.agentOptions.model,
      'capable',
      'the depth requirement must route to the reasoning-capable model',
    );
    assert.equal(run.counts.completed, 1);
    assert.equal(run.routes.length, 1);
  } finally {
    cleanup();
  }
});

test('the child receives the original task and a specialist persona', async () => {
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation' })];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    await engine.run({ task: 'Implement the parser in src/parse.js', captain: CAPTAIN });
    const request = host.calls[0].request;
    const text = request.prompt.map((block) => block.text).join('\n');
    assert.match(text, /Implement the parser in src\/parse\.js/, 'the child must see the real task');
    assert.ok(typeof request.persona === 'string' && request.persona.length > 0, 'a persona must be applied');
    assert.match(request.persona, /specialist subagent/i);
    assert.equal(request.parent, CAPTAIN, 'the calling agent must be the parent');
    assert.ok(request.signal instanceof AbortSignal, 'a cancellation signal must be supplied');
    // The board reads a delegation's route back out of its label, because the
    // host's descendant listing reports a child's mode and label and no model.
    // So the label must end with the route this engine chose.
    assert.match(
      request.label,
      / via p1\/m1$/,
      'the child label must carry the route the orchestrator selected',
    );
  } finally {
    cleanup();
  }
});

test('every spawned child is disposed, even when it fails', async () => {
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation' })];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    // Make the child fail at the seam.
    const original = host.subagents.start;
    host.subagents.start = async () => {
      throw new Error('provider exploded');
    };
    const run = await engine.run({ task: 'Implement the feature.', captain: CAPTAIN });
    assert.equal(run.counts.failed, 1);
    assert.match(run.results[0].error, /provider exploded/);
    host.subagents.start = original;
    assert.equal(host.disposed.length, 0, 'a start that never published has nothing to dispose');
  } finally {
    cleanup();
  }
});

test('a multi-domain task orchestrates several children and returns all results', async () => {
  const profiles = [profileOf('p1', 'general', { description: 'careful analysis', efforts: ['high'] })];
  const { engine, host, cleanup } = makeEngine({
    profiles,
    answer: (request) => `finding from ${request.label}`,
  });
  try {
    const run = await engine.run({
      task: 'Research the literature, then run the statistical analysis, then review the report.',
      captain: CAPTAIN,
    });
    assert.equal(run.tier, 'multi-agent');
    assert.ok(host.calls.length >= 2, `expected several children, got ${host.calls.length}`);
    assert.equal(run.counts.completed, host.calls.length);
    assert.equal(run.results.length, host.calls.length);
    // Every result must reach the captain, and the aggregation must quote them.
    for (const result of run.results) {
      assert.ok(typeof result.preview === 'string' && result.preview.length > 0);
      assert.ok(run.aggregated.includes(result.preview));
    }
    assert.match(run.guidance, /captain owns the final answer/i);
    assert.equal(host.disposed.length, host.calls.length, 'every child must be disposed');
  } finally {
    cleanup();
  }
});

test('the per-run agent limit drops work explicitly instead of silently', async () => {
  const profiles = [profileOf('p1', 'general', { description: 'careful analysis', efforts: ['high'] })];
  const { engine, host, cleanup } = makeEngine({
    profiles,
    preferences: { maxAgentsPerRun: 1 },
  });
  try {
    const run = await engine.run({
      task: 'Research the literature, then run the statistical analysis, then review the report.',
      captain: CAPTAIN,
    });
    assert.equal(host.calls.length, 1);
    assert.ok(run.counts.dropped >= 1, 'dropped work must be counted');
    assert.ok(run.dropped.length >= 1, 'dropped work must be reported with a reason');
    assert.match(run.dropped[0].reason, /agent limit/i);
  } finally {
    cleanup();
  }
});

test('an unrouted capability is reported as a failure, not executed blind', async () => {
  // A pool with no model at all: nothing can serve the capability.
  const { engine, host, cleanup } = makeEngine({ profiles: [] });
  try {
    const run = await engine.run({ task: 'Implement the feature in the codebase.', captain: CAPTAIN });
    assert.equal(host.calls.length, 0, 'nothing may be spawned with an empty pool');
    assert.ok(run.results.length >= 1);
    assert.equal(run.results[0].ok, false);
    assert.match(run.results[0].error ?? '', /pool is empty|no model/i);
  } finally {
    cleanup();
  }
});

test('dispatch routes by capability and honours an explicit route', async () => {
  const profiles = [
    profileOf('p1', 'reviewer', { description: 'code review audit critique' }),
    profileOf('p1', 'builder', { description: 'coding implementation' }),
  ];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const byCapability = await engine.dispatch({
      task: 'Review this diff for correctness.',
      capability: 'software.review',
      captain: CAPTAIN,
    });
    assert.equal(byCapability.ok, true);
    assert.equal(host.calls[0].request.agentOptions.model, 'reviewer');
    assert.match(
      host.calls[0].request.label,
      / via p1\/reviewer$/,
      'a dispatch must record its route in the label, exactly as a run does',
    );

    const explicit = await engine.dispatch({
      task: 'Force this route.',
      provider: 'p1',
      model: 'builder',
      captain: CAPTAIN,
    });
    assert.equal(explicit.ok, true);
    assert.equal(host.calls[1].request.agentOptions.model, 'builder');
    assert.match(
      host.calls[1].request.label,
      / via p1\/builder$/,
      'an explicit-route dispatch must record its route in the label too',
    );

    const unknown = await engine.dispatch({
      task: 'x',
      capability: 'does.not.exist',
      captain: CAPTAIN,
    });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /unknown capability/);
  } finally {
    cleanup();
  }
});

test('a route outside the live pool is refused at dispatch', async () => {
  const profiles = [profileOf('p1', 'real', {})];
  const { engine, cleanup } = makeEngine({ profiles });
  try {
    const result = await engine.dispatch({
      task: 'x',
      provider: 'p1',
      model: 'imaginary',
      captain: CAPTAIN,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /not in the live model pool/);
  } finally {
    cleanup();
  }
});

test('a rejected route surfaces the adapter error rather than failing obscurely', async () => {
  const profiles = [profileOf('p1', 'm1', { description: 'coding', efforts: ['low'] })];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const llm = host.ctx.get('llm');
    llm.resolveCallConfig = async () => {
      throw new Error('UNSUPPORTED_REASONING_EFFORT');
    };
    await assert.rejects(
      () => engine.dispatch({ task: 'x', provider: 'p1', model: 'm1', captain: CAPTAIN }),
      /rejected by the live LLM adapter.*UNSUPPORTED_REASONING_EFFORT/s,
    );
  } finally {
    cleanup();
  }
});

test('plan reports routing without spawning anything', async () => {
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation' })];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const plan = await engine.plan({ task: 'Implement the parser.' });
    assert.equal(host.calls.length, 0, 'planning must never spawn a child');
    assert.ok(['direct', 'specialist', 'multi-agent'].includes(plan.tier));
    assert.ok(plan.pool.size >= 1);
    assert.ok(Array.isArray(plan.units));
  } finally {
    cleanup();
  }
});

test('planTier escalates to multi-agent only when several groups are involved', () => {
  assert.equal(planTier({ complexity: 'trivial', requirements: [] }, {}), 'direct');
  assert.equal(
    planTier({ complexity: 'specialist', requirements: [{ capability: 'a.b' }] }, {}),
    'specialist',
  );
  assert.equal(
    planTier(
      { complexity: 'complex', requirements: [{ capability: 'a.b' }, { capability: 'c.d' }] },
      { allowMultiAgent: true },
    ),
    'multi-agent',
  );
  assert.equal(
    planTier(
      { complexity: 'complex', requirements: [{ capability: 'a.b' }, { capability: 'c.d' }] },
      { allowMultiAgent: false },
    ),
    'specialist',
    'disabling multi-agent must not prevent the task from running',
  );
});

test('the orchestrator persists no task or run state of its own', async () => {
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation' })];
  const harness = makeEngine({ profiles });
  try {
    await harness.engine.run({ task: 'Implement the feature.', captain: CAPTAIN });
    const state = harness.store.snapshot();
    // DSH's session log owns the record of what happened; a second store here
    // would be a conflicting progress surface.
    assert.ok(!('runs' in state), 'no run history may be persisted');
    assert.ok(!('tasks' in state), 'no task list may be persisted');
    assert.ok(!('steps' in state), 'no step status may be persisted');
    assert.ok(!('profiles' in state) || Object.keys(state.profiles).length === 0);
    assert.ok(!('pool' in state) && !('models' in state), 'the model pool must never persist');
    // Only preferences, learned descriptors, and calibrations remain.
    assert.deepEqual(
      Object.keys(state).sort(),
      ['guided', 'mode', 'preferences', 'profiles', 'research', 'schemaVersion', 'taxonomy', 'updatedAt'],
    );
  } finally {
    harness.cleanup();
  }
});

test('a run result is returned to the caller and is not registered anywhere', async () => {
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation' })];
  const harness = makeEngine({ profiles });
  try {
    const run = await harness.engine.run({ task: 'Implement the feature.', captain: CAPTAIN });
    // The result is owned by the tool call that produced it.
    assert.ok(typeof run.runId === 'string' && run.runId.length > 0);
    assert.ok(Array.isArray(run.results));
    // Nothing queryable is retained afterwards.
    assert.equal(harness.engine.inFlightCount, 0, 'nothing may remain in flight after settling');
    assert.ok(!('liveRuns' in harness.engine), 'no live-run listing may be exposed');
  } finally {
    harness.cleanup();
  }
});

test('teardown aborts in-flight delegation instead of orphaning it', async () => {
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation' })];
  const harness = makeEngine({ profiles });
  try {
    // Make the child hang so the run is still in flight when teardown runs.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    harness.host.subagents.start = async (provider, request) => {
      harness.host.calls.push({ provider, request });
      const run = {
        id: 'child-hanging',
        localAgent: undefined,
        result: gate.then(() => ({ output: [{ type: 'text', text: 'late' }], stopReason: 'completed' })),
        dispose: async () => {},
      };
      return run;
    };

    const running = harness.engine.run({ task: 'Implement the feature.', captain: CAPTAIN });
    // Wait until the delegation is registered as in flight.
    for (let attempt = 0; attempt < 50 && harness.engine.inFlightCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(harness.engine.inFlightCount, 1, 'the delegation must be tracked while running');

    const aborted = harness.engine.abortAll('test teardown');
    assert.equal(aborted, 1);
    assert.equal(harness.engine.inFlightCount, 0);

    release();
    await running;
  } finally {
    harness.cleanup();
  }
});

test('a multi-unit plan chains its stages so each sees the previous findings', async () => {
  // Regression: a task explicitly described as a sequence was routed to several
  // specialists that all ran in parallel with `dependsOn: []`, so the review and
  // the summary never saw the research output. A pipeline must serialise.
  const profiles = [profileOf('p1', 'general', { description: 'careful analysis', efforts: ['high'] })];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const run = await engine.run({
      task: 'Research the topic, then review the findings, then summarize the result.',
      captain: CAPTAIN,
    });
    // Every unit after the first must declare a dependency.
    const chained = run.results.filter((entry) => (entry.dependsOn ?? []).length > 0);
    assert.ok(run.results.length > 1, `expected several units, got ${run.results.length}`);
    assert.equal(
      chained.length,
      run.results.length - 1,
      'every stage after the first must depend on its predecessor',
    );
    // And the later stages must actually receive the earlier preview as context.
    const withContext = host.calls.filter((call) =>
      call.request.prompt.some((block) => /Shared findings so far/.test(block.text ?? '')),
    );
    assert.ok(withContext.length > 0, 'a dependent stage must receive the prior findings');
  } finally {
    cleanup();
  }
});

test('a configured reasoning effort reaches the child on the routed model', async () => {
  // The pool's selector is a per-route preference; it has to arrive as the child's
  // `agentOptions.reasoningEffort`, or choosing it in the panel would do nothing.
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation', efforts: ['low', 'high'] })];
  const { engine, host, cleanup } = makeEngine({
    profiles,
    preferences: { reasoningEffort: { 'p1/m1': 'high' } },
  });
  try {
    await engine.run({ task: 'Implement the parser.', captain: CAPTAIN });
    assert.equal(host.calls[0].request.agentOptions.reasoningEffort, 'high');
  } finally {
    cleanup();
  }
});

test('a configured effort the route no longer advertises is ignored, not sent', async () => {
  // A stale preference must degrade. Sending it would fail the child outright with
  // UNSUPPORTED_REASONING_EFFORT, which is worse than running at the model default.
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation', efforts: ['low', 'high'] })];
  const { engine, host, cleanup } = makeEngine({
    profiles,
    preferences: { reasoningEffort: { 'p1/m1': 'xhigh' } },
  });
  try {
    await engine.run({ task: 'Implement the parser.', captain: CAPTAIN });
    assert.equal(host.calls[0].request.agentOptions.reasoningEffort, undefined);
  } finally {
    cleanup();
  }
});

test("a caller's own effort for a unit beats the configured one", async () => {
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation', efforts: ['low', 'high'] })];
  const { engine, host, cleanup } = makeEngine({
    profiles,
    preferences: { reasoningEffort: { 'p1/m1': 'low' } },
  });
  try {
    await engine.run({
      task: 'Implement the parser.',
      captain: CAPTAIN,
      analysis: {
        summary: 'implement',
        complexity: 'specialist',
        requirements: [{ capability: 'software.implementation', weight: 1, reasoningEffort: 'high' }],
      },
    });
    assert.equal(
      host.calls[0].request.agentOptions.reasoningEffort,
      'high',
      'the model reading the task decides the level',
    );
  } finally {
    cleanup();
  }
});

test('a configured effort applies to dispatch too, and is reported', async () => {
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation', efforts: ['low', 'high'] })];
  const { engine, host, cleanup } = makeEngine({
    profiles,
    preferences: { reasoningEffort: { 'p1/m1': 'high' } },
  });
  try {
    const result = await engine.dispatch({
      task: 'Implement the parser.',
      provider: 'p1',
      model: 'm1',
      captain: CAPTAIN,
    });
    assert.equal(result.ok, true);
    assert.equal(host.calls[0].request.agentOptions.reasoningEffort, 'high');
  } finally {
    cleanup();
  }
});

test('a standing assignment splits one cluster so architecture and implementation differ', async () => {
  // The intent this feature exists for: "architecture to the expensive model,
  // implementation to the cheap one". Both capabilities live in the `software`
  // cluster, so without the split they merge into ONE unit on ONE model and the
  // table silently does nothing.
  const profiles = [
    profileOf('p1', 'arch', { description: 'system design and architecture tradeoffs' }),
    profileOf('p1', 'coder', { description: 'coding implementation' }),
  ];
  const { engine, host, cleanup } = makeEngine({
    profiles,
    preferences: {
      capabilityAssignments: {
        'software.architecture': { models: ['arch'], family: false },
        'software.implementation': { models: ['coder'], family: false },
      },
    },
  });
  try {
    const plan = await engine.plan({
      task: 'Implement the parser.',
      analysis: {
        summary: 'design then implement',
        complexity: 'specialist',
        requirements: [
          { capability: 'software.architecture', weight: 0.9 },
          { capability: 'software.implementation', weight: 0.9 },
        ],
      },
    });
    assert.equal(plan.units.length, 2, 'the two capabilities must not share a unit');
    const byCapability = Object.fromEntries(plan.units.map((unit) => [unit.capabilityId, unit.route]));
    assert.equal(byCapability['software.architecture'], 'p1/arch');
    assert.equal(byCapability['software.implementation'], 'p1/coder');
    assert.equal(plan.assignments.count, 2);
    assert.deepEqual(plan.assignments.unresolved, []);
    // And the reason says the table decided, not the ranking.
    assert.match(
      plan.units.find((unit) => unit.capabilityId === 'software.architecture').routeReason,
      /^assigned: software\.architecture/,
    );

    await engine.run({
      task: 'Implement the parser.',
      captain: CAPTAIN,
      analysis: {
        summary: 'design then implement',
        complexity: 'specialist',
        requirements: [
          { capability: 'software.architecture', weight: 0.9 },
          { capability: 'software.implementation', weight: 0.9 },
        ],
      },
    });
    const routed = Object.fromEntries(host.calls.map((call) => [call.request.agentOptions.model, true]));
    assert.deepEqual(Object.keys(routed).sort(), ['arch', 'coder']);
  } finally {
    cleanup();
  }
});

test('one group entry keeps its cluster together', async () => {
  const profiles = [
    profileOf('p1', 'arch', { description: 'system design and architecture tradeoffs' }),
    profileOf('p1', 'coder', { description: 'coding implementation' }),
  ];
  const { engine, cleanup } = makeEngine({
    profiles,
    preferences: { capabilityAssignments: { software: { models: ['coder'], family: false } } },
  });
  try {
    const plan = await engine.plan({
      task: 'Implement the parser.',
      analysis: {
        summary: 'design then implement',
        complexity: 'specialist',
        requirements: [
          { capability: 'software.architecture', weight: 0.9 },
          { capability: 'software.implementation', weight: 0.9 },
        ],
      },
    });
    assert.equal(plan.units.length, 1, 'a group entry is one preference, so one unit');
    assert.equal(plan.units[0].route, 'p1/coder');
  } finally {
    cleanup();
  }
});

test('an assignment through a different spelling survives a provider move', async () => {
  const profiles = [
    profileOf('p2', 'gemini-3.8-flash', { description: 'image understanding', modalities: ['text', 'image'] }),
  ];
  const { engine, cleanup } = makeEngine({
    profiles,
    preferences: {
      // Written as a bare name, resolved against a route that did not exist when
      // it was written.
      capabilityAssignments: { 'multimodal.vision': { models: ['Gemini 3.8 Flash'], family: false } },
    },
  });
  try {
    const plan = await engine.plan({
      task: 'Read the attached screenshot and describe its layout.',
      analysis: {
        summary: 'read a screenshot',
        complexity: 'specialist',
        requirements: [{ capability: 'multimodal.vision', weight: 1 }],
      },
    });
    assert.equal(plan.units[0].route, 'p2/gemini-3.8-flash');
    assert.deepEqual(plan.assignments.unresolved, []);
  } finally {
    cleanup();
  }
});

test('an assignment naming a model that is gone is reported, not silently ignored', async () => {
  const profiles = [profileOf('p1', 'coder', { description: 'coding implementation' })];
  const { engine, cleanup } = makeEngine({
    profiles,
    preferences: {
      capabilityAssignments: { 'software.implementation': { models: ['claude-opus-9'], family: false } },
    },
  });
  try {
    const plan = await engine.plan({ task: 'Implement the parser.' });
    assert.deepEqual(plan.assignments.unresolved, [
      { key: 'software.implementation', target: 'claude-opus-9' },
    ]);
    // It still routes — through the measured ranking — and reports that the table
    // had nothing to say.
    assert.ok(plan.units.length >= 1);
    assert.doesNotMatch(plan.units[0].routeReason ?? '', /^assigned: /);
  } finally {
    cleanup();
  }
});

test("the calling model's own per-unit preference still beats the table", async () => {
  const profiles = [
    profileOf('p1', 'table-pick', { description: 'coding implementation' }),
    profileOf('p1', 'caller-pick', { description: 'coding implementation' }),
  ];
  const { engine, cleanup } = makeEngine({
    profiles,
    preferences: { capabilityAssignments: { 'software.implementation': { models: ['table-pick'], family: false } } },
  });
  try {
    const plan = await engine.plan({
      task: 'Implement the parser.',
      analysis: {
        summary: 'implement',
        complexity: 'specialist',
        requirements: [{ capability: 'software.implementation', weight: 1 }],
        unitModelPreference: [{ capability: 'software.implementation', routes: ['p1/caller-pick'] }],
      },
    });
    assert.equal(plan.units[0].route, 'p1/caller-pick');
  } finally {
    cleanup();
  }
});
