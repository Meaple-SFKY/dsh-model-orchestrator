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

    const explicit = await engine.dispatch({
      task: 'Force this route.',
      provider: 'p1',
      model: 'builder',
      captain: CAPTAIN,
    });
    assert.equal(explicit.ok, true);
    assert.equal(host.calls[1].request.agentOptions.model, 'builder');

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
      ['guided', 'mode', 'preferences', 'profiles', 'schemaVersion', 'taxonomy', 'updatedAt'],
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
