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

test('chain: true turns a multi-unit plan into a pipeline that shares findings', async () => {
  // A pipeline must still be available — it is just no longer the default. A task
  // explicitly described as a sequence routes to several specialists, and with
  // `chain: true` the review and the summary see the research output.
  const profiles = [profileOf('p1', 'general', { description: 'careful analysis', efforts: ['high'] })];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const run = await engine.run({
      task: 'Research the topic, then review the findings, then summarize the result.',
      captain: CAPTAIN,
      chain: true,
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

test('a hand-set level is sent for a provider that reasons without listing levels', async () => {
  // The route advertises nothing to select, so by default it is used as-is. An
  // operator who says "this provider does accept high" is obeyed — the alternative
  // is silently ignoring what they asked for.
  const profile = buildProfile(
    {
      modalities: ['text'],
      contextWindow: 200000,
      defaultMaxTokens: 64000,
      name: 'auto',
      description: 'coding implementation',
    },
    'p1',
    'auto',
  );
  // The pool row itself reports the state; the profile facts carry it too.
  profile.facts.reasoningMode = 'automatic';
  const { engine, host, cleanup } = makeEngine({
    profiles: [profile],
    preferences: { reasoningEffort: { 'p1/auto': 'high' } },
  });
  try {
    await engine.run({ task: 'Implement the parser.', captain: CAPTAIN });
    assert.equal(host.calls[0].request.agentOptions.reasoningEffort, 'high');
  } finally {
    cleanup();
  }
});

test('a stale level on a route that DOES list levels is still ignored', async () => {
  // The strict rule survives where it belongs: a route that advertises a list and
  // no longer offers the stored id is reporting a stale entry, not a decision.
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation', efforts: ['low', 'high'] })];
  const { engine, host, cleanup } = makeEngine({
    profiles,
    preferences: { reasoningEffort: { 'p1/m1': 'max' } },
  });
  try {
    await engine.run({ task: 'Implement the parser.', captain: CAPTAIN });
    assert.equal(host.calls[0].request.agentOptions.reasoningEffort, undefined);
  } finally {
    cleanup();
  }
});

test('Guided areas apply only in Guided mode', async () => {
  // They were seeded regardless of mode, while the panel said "capability areas
  // apply in Guided mode". Auto means "read each task and decide by itself", so
  // areas left selected while Auto is on are kept for when Guided comes back —
  // not applied.
  const profiles = [
    profileOf('p1', 'm1', { description: 'coding implementation' }),
    profileOf('p1', 'm2', { description: 'image understanding' }),
  ];
  const { engine, store, cleanup } = makeEngine({ profiles });
  try {
    store.update((state) => {
      state.guided.capabilities = ['multimodal.vision'];
    });

    const auto = await engine.plan({ task: 'Implement the parser.' });
    assert.equal(
      auto.units.some((unit) => unit.capabilityId.startsWith('multimodal')),
      false,
      'Auto must not seed the areas',
    );

    store.update((state) => {
      state.mode = 'guided';
    });
    const guided = await engine.plan({ task: 'Implement the parser.' });
    assert.equal(
      guided.units.some((unit) => unit.capabilityId.startsWith('multimodal')),
      true,
      'Guided must seed them',
    );
    assert.equal(guided.analysis.source, 'guided');
  } finally {
    cleanup();
  }
});

test("a caller's own requirements no longer drop the user's Guided areas", async () => {
  // Returning the caller's analysis whole meant a caller that stated ANY
  // requirements silently overrode the user's session setting.
  const profiles = [
    profileOf('p1', 'coder', { description: 'coding implementation' }),
    profileOf('p1', 'vision', { description: 'image understanding', modalities: ['text', 'image'] }),
  ];
  const { engine, store, cleanup } = makeEngine({ profiles });
  try {
    store.update((state) => {
      state.mode = 'guided';
      state.guided.capabilities = ['multimodal.vision'];
    });
    const plan = await engine.plan({
      task: 'Implement the parser.',
      analysis: {
        summary: 'implement',
        complexity: 'specialist',
        requirements: [{ capability: 'software.implementation', weight: 0.9 }],
      },
    });
    const capabilities = plan.units.map((unit) => unit.capabilityId);
    assert.ok(capabilities.includes('software.implementation'), "the caller's requirement stands");
    assert.ok(capabilities.includes('multimodal.vision'), 'the user area is added, not dropped');
    assert.equal(plan.analysis.source, 'model+guided', 'and the source says so');
  } finally {
    cleanup();
  }
});

test('the caller still wins for a capability both sides name', async () => {
  const profiles = [profileOf('p1', 'coder', { description: 'coding implementation' })];
  const { engine, store, cleanup } = makeEngine({ profiles });
  try {
    store.update((state) => {
      state.mode = 'guided';
      state.guided.capabilities = ['software.implementation'];
    });
    const plan = await engine.plan({
      task: 'Implement the parser.',
      analysis: {
        summary: 'implement',
        complexity: 'specialist',
        requirements: [
          { capability: 'software.implementation', weight: 0.9, reason: 'the caller said so' },
        ],
      },
    });
    assert.equal(plan.units.length, 1, 'naming the same capability must not duplicate the unit');
    const requirement = plan.analysis.requirements.find(
      (entry) => entry.capability === 'software.implementation',
    );
    assert.equal(requirement.weight, 0.9, "the caller's weight wins");
    assert.equal(requirement.reason, 'the caller said so');
  } finally {
    cleanup();
  }
});

test("the caller's requirement order survives the Guided merge", async () => {
  // A cluster's primary requirement is the first one composition meets, and the
  // caller's order is a deliberate sequence — so merging must append additions
  // rather than re-sort the caller's own list.
  const profiles = [
    profileOf('p1', 'coder', { description: 'coding implementation' }),
    profileOf('p1', 'vision', { description: 'image understanding', modalities: ['text', 'image'] }),
    profileOf('p1', 'analyst', { description: 'data analysis statistics' }),
  ];
  const { engine, store, cleanup } = makeEngine({ profiles });
  try {
    store.update((state) => {
      state.mode = 'guided';
      state.guided.capabilities = ['data.analysis'];
    });
    const plan = await engine.plan({
      task: 'Implement the parser.',
      analysis: {
        summary: 'implement',
        complexity: 'specialist',
        requirements: [
          { capability: 'multimodal.vision', weight: 0.9 },
          { capability: 'software.implementation', weight: 0.6 },
        ],
      },
    });
    assert.deepEqual(
      plan.analysis.requirements.map((entry) => entry.capability),
      ['multimodal.vision', 'software.implementation', 'data.analysis'],
      'the caller order first, the added area last',
    );
  } finally {
    cleanup();
  }
});

test('a split cluster returns every answer, not the last one twice', async () => {
  // Regression, and a silent one: units were pushed with `id: group`, so a split
  // cluster produced two units sharing one id. `#executeUnits` keys results by id,
  // so the second overwrote the first — the run reported completed: 2 while one
  // specialist's answer was simply absent from `aggregated`.
  const profiles = [
    profileOf('p1', 'alpha', { description: 'system design and architecture tradeoffs' }),
    profileOf('p1', 'beta', { description: 'coding implementation' }),
  ];
  const { engine, host, cleanup } = makeEngine({
    profiles,
    preferences: {
      capabilityAssignments: {
        'software.architecture': { models: ['alpha'], family: false },
        'software.implementation': { models: ['beta'], family: false },
      },
    },
    answer: undefined,
  });
  try {
    const run = await engine.run({
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
    assert.equal(run.results.length, 2, 'both specialists must be reported');
    assert.equal(new Set(run.results.map((entry) => entry.id)).size, 2, 'unit ids must be unique');
    assert.deepEqual(
      run.results.map((entry) => entry.route).sort(),
      ['p1/alpha', 'p1/beta'],
      'each unit keeps its own route',
    );
    assert.equal(run.counts.completed, 2);
    assert.equal(host.calls.length, 2);
  } finally {
    cleanup();
  }
});

test('a dispatch registers its child, so teardown can abort it', async () => {
  // It never did: `abortAll` could not reach a dispatch child, and `/state`
  // under-reported in-flight delegations.
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation' })];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const original = host.subagents.start;
    let release;
    const gate = new Promise((done) => {
      release = done;
    });
    host.subagents.start = async (name, request) => {
      const run = await original(name, request);
      await gate;
      return run;
    };
    const pending = engine.dispatch({
      task: 'Implement the parser.',
      provider: 'p1',
      model: 'm1',
      captain: CAPTAIN,
    });
    await new Promise((done) => setTimeout(done, 5));
    assert.equal(engine.inFlightCount, 1, 'the dispatch must be counted as in flight');
    assert.equal(engine.abortAll('test teardown'), 1, 'and teardown must be able to abort it');
    release();
    await pending;
  } finally {
    cleanup();
  }
});

test('a level the route cannot express is dropped and said, not fatal', async () => {
  // Reproduced from a real failure: the calling model asked for "medium" (the
  // common low/medium/high triad) for a unit routed to a model that advertises
  // low/high/max. The level used to be sent unvalidated, the preflight rejected the
  // route at the adapter, and the unit returned no answer at all.
  const profiles = [
    profileOf('p1', 'kimi', { description: 'coding implementation', efforts: ['low', 'high', 'max'] }),
  ];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const run = await engine.run({
      task: 'Implement the parser.',
      captain: CAPTAIN,
      analysis: {
        summary: 'implement',
        complexity: 'specialist',
        requirements: [{ capability: 'software.implementation', weight: 0.9, reasoningEffort: 'medium' }],
      },
    });
    assert.equal(run.results.length, 1);
    const [entry] = run.results;
    assert.equal(entry.ok, true, 'the unit must still produce an answer');
    assert.equal(entry.error, undefined);
    assert.equal(entry.reasoningEffort, undefined, 'no unsupported level is sent');
    assert.equal(entry.effortUnavailable, 'medium', 'and the drop is reported, not swallowed');

    // The child was actually started without a reasoning level.
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].request.agentOptions.reasoningEffort, undefined);
  } finally {
    cleanup();
  }
});

test('a level the route does advertise is still sent', async () => {
  const profiles = [
    profileOf('p1', 'kimi', { description: 'coding implementation', efforts: ['low', 'high', 'max'] }),
  ];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const run = await engine.run({
      task: 'Implement the parser.',
      captain: CAPTAIN,
      analysis: {
        summary: 'implement',
        complexity: 'specialist',
        requirements: [{ capability: 'software.implementation', weight: 0.9, reasoningEffort: 'high' }],
      },
    });
    assert.equal(run.results[0].reasoningEffort, 'high');
    assert.equal(run.results[0].effortUnavailable, undefined);
    assert.equal(host.calls[0].request.agentOptions.reasoningEffort, 'high');
  } finally {
    cleanup();
  }
});

test('dispatch drops an unsupported level too, and reports it', async () => {
  const profiles = [
    profileOf('p1', 'kimi', { description: 'coding implementation', efforts: ['low', 'high', 'max'] }),
  ];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const answer = await engine.dispatch({
      task: 'Implement the parser.',
      capability: 'software.implementation',
      captain: CAPTAIN,
      reasoningEffort: 'medium',
    });
    assert.equal(answer.ok, true);
    assert.equal(answer.reasoningEffort, undefined);
    assert.equal(answer.effortUnavailable, 'medium');
    assert.equal(host.calls[0].request.agentOptions.reasoningEffort, undefined);
  } finally {
    cleanup();
  }
});

test('units run in parallel by default, with no implied order', async () => {
  // The default used to be a serial chain for every multi-unit plan. A research task
  // with several independent parts then ran as several sequential agents, hit the
  // caller's tool ceiling, and returned nothing at all — a timeout discards
  // everything rather than what finished.
  const profiles = [profileOf('p1', 'general', { description: 'careful analysis', efforts: ['high'] })];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const run = await engine.run({
      task: 'Research the topic, then review the findings, then summarize the result.',
      captain: CAPTAIN,
    });
    assert.ok(run.results.length > 1, `expected several units, got ${run.results.length}`);
    assert.deepEqual(
      run.results.map((entry) => entry.dependsOn ?? []),
      run.results.map(() => []),
      'no unit may depend on another unless the caller asked for a pipeline',
    );
    // Nothing receives "shared findings", because nothing ran after anything.
    const withContext = host.calls.filter((call) =>
      call.request.prompt.some((block) => /Shared findings so far/.test(block.text ?? '')),
    );
    assert.equal(withContext.length, 0, 'independent units must not be fed each other\'s output');
  } finally {
    cleanup();
  }
});

test('a caller-supplied graph is never rewritten into a chain', async () => {
  const profiles = [profileOf('p1', 'general', { description: 'careful analysis', efforts: ['high'] })];
  const { engine, cleanup } = makeEngine({ profiles });
  try {
    const run = await engine.run({
      task: 'Two independent questions.',
      captain: CAPTAIN,
      chain: true,
      units: [
        { id: 'one', capabilityId: 'general', prompt: 'First.', route: 'p1/general' },
        { id: 'two', capabilityId: 'general', prompt: 'Second.', route: 'p1/general' },
      ],
    });
    assert.deepEqual(run.results.map((entry) => entry.dependsOn ?? []), [[], []], 'the caller\'s graph stands');
  } finally {
    cleanup();
  }
});

test('a run that exhausts its budget returns the parts that finished', async () => {
  // The alternative was the real failure: the caller's tool call hit its 30-minute
  // ceiling and returned a timeout error with NO results, losing everything the run
  // had already produced.
  const profiles = [profileOf('p1', 'general', { description: 'careful analysis', efforts: ['high'] })];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    // A host that settles a child's result when its signal aborts, which is what a
    // real one does and what makes the abort actually unblock the run.
    host.subagents.start = async (name, request) => ({
      id: 'child',
      localAgent: undefined,
      result: new Promise((_, reject) => {
        const stop = () => reject(new Error('aborted by the run budget'));
        if (request.signal?.aborted === true) stop();
        else request.signal?.addEventListener('abort', stop, { once: true });
      }),
      dispose: async () => {},
    });

    // The budget timer is deliberately `unref`'d in the engine — a bound must not hold a
    // host process open — so this test has to supply the event-loop liveness the host
    // provides in production. Without it the loop drains before the 30 ms timer fires,
    // the child's promise never settles, and the runner reports
    // "Promise resolution is still pending but the event loop has already resolved".
    // Node 22 exposed that; Node 24 happened to keep the loop alive long enough, which
    // is exactly the kind of luck a test must not depend on.
    const keepAlive = setTimeout(() => {}, 250);
    let run;
    try {
      run = await engine.run({
        task: 'Research the topic, then review the findings, then summarize the result.',
        captain: CAPTAIN,
        budgetMs: 30,
      });
    } finally {
      clearTimeout(keepAlive);
    }

    assert.equal(run.budgetExhausted, true, 'the caller must be told it holds partial results');
    assert.equal(run.budgetMs, 30);
    assert.ok(run.counts.total > 0, 'the plan is still reported, unit by unit');
    assert.equal(run.counts.completed, 0);
    assert.ok(
      run.results.every((entry) => entry.ok === false && typeof entry.error === 'string'),
      'units that could not finish are reported as failed rather than omitted',
    );
    assert.ok(run.aggregated.length >= 0, 'and the document is still well-formed');
  } finally {
    cleanup();
  }
});

test('an ordinary run reports its budget and does not claim to have hit it', async () => {
  const profiles = [profileOf('p1', 'general', { description: 'careful analysis', efforts: ['high'] })];
  const { engine, cleanup } = makeEngine({ profiles });
  try {
    const run = await engine.run({ task: 'Implement the parser.', captain: CAPTAIN });
    assert.equal(typeof run.budgetMs, 'number');
    assert.equal(run.budgetExhausted, undefined);
  } finally {
    cleanup();
  }
});

/** A pool stub that records refreshes, for the freshness policy tests. */
function stubPool(options = {}) {
  const state = {
    models: options.models ?? [],
    seenAt: options.discoveredAt ?? Date.now(),
    providers: options.providers ?? [],
    refreshes: 0,
    refilters: 0,
    prefs: undefined,
  };
  return {
    state,
    models: () => state.models,
    providers: () => state.providers,
    problems: () => [],
    filtered: () => ({}),
    filterReport: () => ({}),
    fingerprint: () => 'stub',
    advertisedProviders: () => state.providers,
    discoveredAt: () => state.seenAt,
    lastError: () => undefined,
    get: (route) => state.models.find((model) => model.route === route),
    setPreferences(preferences) {
      state.prefs = preferences;
    },
    refilter() {
      state.refilters += 1;
      return state.models.length;
    },
    async refresh() {
      state.refreshes += 1;
      state.seenAt = Date.now();
      if (options.failWith !== undefined) throw options.failWith;
      state.models = options.afterRefresh ?? state.models;
      return { models: state.models, problems: [], discoveredAt: state.seenAt };
    },
  };
}

function engineWithPool(pool, llm) {
  const directory = mkdtempSync(join(tmpdir(), 'orch-fresh-'));
  const store = new OrchestratorStore(directory);
  const engine = new Orchestrator({
    ctx: { get: (key) => (key === 'llm' ? llm : undefined) },
    pool,
    taxonomy: new Taxonomy(),
    store,
    logger: undefined,
  });
  return { engine, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('a pool older than its window is re-read before the next call uses it', async () => {
  // Discovery used to run only when the pool was EMPTY, so a deployment that changed
  // its provider's model list saw nothing until the process restarted.
  const pool = stubPool({
    models: [profileOf('p1', 'm1', { description: 'coding implementation' })],
    discoveredAt: Date.now() - 6 * 60 * 1000,
    providers: ['p1'],
  });
  const { engine, cleanup } = engineWithPool(pool, { listProviders: () => [{ id: 'p1' }] });
  try {
    await engine.plan({ task: 'Implement the parser.', captain: CAPTAIN });
    assert.equal(pool.state.refreshes, 1, 'a stale pool must be re-discovered');
  } finally {
    cleanup();
  }
});

test('a fresh pool is not re-read, so an ordinary call asks the provider nothing', async () => {
  const pool = stubPool({
    models: [profileOf('p1', 'm1', { description: 'coding implementation' })],
    discoveredAt: Date.now(),
    providers: ['p1'],
  });
  const { engine, cleanup } = engineWithPool(pool, { listProviders: () => [{ id: 'p1' }] });
  try {
    await engine.plan({ task: 'Implement the parser.', captain: CAPTAIN });
    await engine.plan({ task: 'Implement the parser.', captain: CAPTAIN });
    assert.equal(pool.state.refreshes, 0, 'the listing must not run per call');
  } finally {
    cleanup();
  }
});

test('an adapter appearing or disappearing re-reads the pool immediately', async () => {
  // The host emits a topology event for this, but the check is a synchronous registry
  // read: cheap enough to run always, and it survives a missed event.
  const pool = stubPool({
    models: [profileOf('p1', 'm1', { description: 'coding implementation' })],
    discoveredAt: Date.now(),
    providers: ['p1'],
  });
  const { engine, cleanup } = engineWithPool(pool, {
    listProviders: () => [{ id: 'p1' }, { id: 'p2' }],
  });
  try {
    await engine.plan({ task: 'Implement the parser.', captain: CAPTAIN });
    assert.equal(pool.state.refreshes, 1, 'a changed provider set must be re-discovered');
  } finally {
    cleanup();
  }
});

test('a failed refresh of a stale pool keeps the pool and does not fail the call', async () => {
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation' })];
  const pool = stubPool({
    models: profiles,
    discoveredAt: Date.now() - 6 * 60 * 1000,
    providers: ['p1'],
    failWith: new Error('provider is offline'),
  });
  const { engine, cleanup } = engineWithPool(pool, { listProviders: () => [{ id: 'p1' }] });
  try {
    const answer = await engine.plan({ task: 'Implement the parser.', captain: CAPTAIN });
    assert.equal(pool.state.refreshes, 1, 'it did try');
    assert.equal(answer.pool.size, 1, 'and the previous pool is still served');
  } finally {
    cleanup();
  }
});

test('refilterPool re-narrows the pool without re-discovering it', async () => {
  const pool = stubPool({ models: [], providers: ['p1'] });
  const { engine, cleanup } = engineWithPool(pool, { listProviders: () => [{ id: 'p1' }] });
  try {
    const size = engine.refilterPool();
    assert.equal(pool.state.refilters, 1, 'the filter was re-applied');
    assert.equal(pool.state.refreshes, 0, 'and nothing was asked of the provider');
    assert.equal(pool.state.prefs !== undefined, true, 'the new preferences were handed over first');
    assert.equal(typeof size, 'number');
  } finally {
    cleanup();
  }
});

test('a caller-supplied unit that names only a route runs on that route', async () => {
  // Reproduced from a real session: the caller supplied four units, each naming a route
  // through `route` and no `provider`/`model`. `route` was copied onto the unit and never
  // resolved into the pair a dispatch needs, so every unit hit the dispatch guard with no
  // provider and came back as `error: "supplied by the caller"` and `cancelled: true`.
  const profiles = [
    profileOf('p1', 'm1', { description: 'coding implementation' }),
    profileOf('p1', 'm2', { description: 'coding implementation' }),
  ];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const run = await engine.run({
      task: 'Two pinned units.',
      captain: CAPTAIN,
      units: [{ id: 'u1', capabilityId: 'software.implementation', prompt: 'Do it.', route: 'p1/m2' }],
    });
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].ok, true, `expected success, got ${run.results[0].error}`);
    assert.equal(run.results[0].route, 'p1/m2');
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].request.agentOptions.model, 'm2', 'the named route must be dispatched');
  } finally {
    cleanup();
  }
});

test('a supplied unit with no route is routed by the capability it names', async () => {
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation' })];
  const { engine, host, cleanup } = makeEngine({ profiles });
  try {
    const run = await engine.run({
      task: 'One unpinned unit.',
      captain: CAPTAIN,
      units: [{ id: 'u1', capabilityId: 'software.implementation', prompt: 'Do it.' }],
    });
    assert.equal(run.results[0].ok, true, `expected success, got ${run.results[0].error}`);
    assert.equal(run.results[0].route, 'p1/m1', 'the orchestrator decides when no route is named');
    assert.equal(host.calls.length, 1);
  } finally {
    cleanup();
  }
});

test('a supplied route that is not in the live pool degrades to capability routing', async () => {
  // The pool changes under a session — a deployment editing its provider's models is how
  // this was reported — so a stale name must not cost the whole unit.
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation' })];
  const { engine, cleanup } = makeEngine({ profiles });
  try {
    const run = await engine.run({
      task: 'One stale pin.',
      captain: CAPTAIN,
      units: [
        { id: 'u1', capabilityId: 'software.implementation', prompt: 'Do it.', route: 'p1/gone' },
      ],
    });
    assert.equal(run.results[0].ok, true, `expected success, got ${run.results[0].error}`);
    assert.equal(run.results[0].route, 'p1/m1');
    assert.equal(run.results[0].routeRequested, 'p1/gone', 'and the name it asked for is reported');
    assert.match(run.results[0].routeReason, /not in the live pool/);
  } finally {
    cleanup();
  }
});

test('an unroutable supplied unit says why, and does not claim it was cancelled', async () => {
  // The old refusal returned `error: unit.routeReason` — for a supplied unit that is the
  // text "supplied by the caller", which is a reason for the ROUTE, not a failure — and
  // set `cancelled: true` for a unit that had never been started.
  const { engine, host, cleanup } = makeEngine({ profiles: [] });
  try {
    const run = await engine.run({
      task: 'No model could serve this.',
      captain: CAPTAIN,
      units: [{ id: 'u1', capabilityId: 'software.implementation', prompt: 'Do it.' }],
    });
    const [entry] = run.results;
    assert.equal(entry.ok, false);
    assert.match(entry.error, /^no route:/, `got: ${entry.error}`);
    assert.match(entry.error, /pool is empty|no model could serve/);
    assert.equal(entry.notStarted, true, 'nothing was cancelled; it was never started');
    assert.equal(entry.cancelled, undefined, 'claiming a cancellation invents an abort');
    assert.equal(host.calls.length, 0, 'and no child was spawned');
  } finally {
    cleanup();
  }
});
