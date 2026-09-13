/**
 * Lifecycle tests: interruption, cancellation, and process-fault recovery.
 *
 * The question these answer is operational: if a user cancels a session, or the
 * process is killed outright and restarted, does the plugin stay coherent? Three
 * properties matter and each is pinned here:
 *
 *  1. A cancelled delegation becomes a recorded FAILURE — never a hang, never an
 *     unhandled rejection, and never a silent gap in the results.
 *  2. Every spawned child is disposed exactly once, on every path.
 *  3. Nothing durable depends on in-memory state, so a cold restart resumes from
 *     the state file alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Taxonomy } from '../lib/taxonomy.js';
import { ModelPool, buildProfile } from '../lib/discovery.js';
import { Orchestrator } from '../lib/engine.js';
import { OrchestratorStore, defaultState } from '../lib/persistence.js';

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

/** A host whose child runs are scripted per test. */
function harness({ profiles, start }) {
  const directory = mkdtempSync(join(tmpdir(), 'orch-life-'));
  const spawns = [];
  const disposed = [];
  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({
      name: 'spawn',
      capabilities: {
        agentOptions: true,
        outputSchema: true,
        depthLimit: true,
        toolFilter: true,
        persona: true,
      },
      inheritsParentContext: false,
    }),
    start: async (provider, request) => {
      spawns.push(request);
      return start({ request, spawns, disposed });
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
  const store = new OrchestratorStore(directory);
  const engine = new Orchestrator({
    ctx,
    pool: makePool(profiles),
    taxonomy: new Taxonomy(),
    store,
    logger: undefined,
  });
  return {
    engine,
    store,
    directory,
    spawns,
    disposed,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const CAPTAIN = { id: 'captain-session' };

test('a cancelled delegation is recorded as a failure and still disposed', async () => {
  const controller = new AbortController();
  const h = harness({
    profiles: [profileOf('p1', 'm1', { description: 'coding implementation' })],
    start: ({ request }) => ({
      id: 'child-aborted',
      localAgent: undefined,
      result: new Promise((_resolve, reject) => {
        // Reject only once the caller cancels, mirroring a real abort.
        request.signal.addEventListener('abort', () => reject(new Error('aborted by the caller')));
      }),
      dispose: async () => h.disposed.push('child-aborted'),
    }),
  });
  try {
    const running = h.engine.run({
      task: 'Implement the feature in the codebase.',
      captain: CAPTAIN,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort('session cancelled');

    const run = await running;
    assert.equal(run.counts.failed, 1, 'the aborted unit is a failure, not a silent gap');
    assert.match(String(run.results[0].error ?? ''), /aborted/);
    assert.deepEqual(h.disposed, ['child-aborted'], 'a cancelled child is still disposed');
    assert.equal(h.engine.inFlightCount, 0, 'nothing may remain in flight');
  } finally {
    h.cleanup();
  }
});

test('an infrastructure rejection is contained, recorded, and disposed', async () => {
  const h = harness({
    profiles: [profileOf('p1', 'm1', { description: 'coding implementation' })],
    start: () => ({
      id: 'child-fault',
      localAgent: undefined,
      result: Promise.reject(new Error('transport exploded')),
      dispose: async () => h.disposed.push('child-fault'),
    }),
  });
  try {
    // If the rejection escaped as an unhandled rejection this would fail the run
    // (or the test process), so awaiting a normal run IS the assertion.
    const run = await h.engine.run({ task: 'Implement the feature.', captain: CAPTAIN });
    assert.equal(run.counts.failed, 1);
    assert.match(String(run.results[0].error), /transport exploded/);
    assert.deepEqual(h.disposed, ['child-fault'], 'disposal still runs on a rejection');
    assert.equal(h.engine.inFlightCount, 0);
  } finally {
    h.cleanup();
  }
});

test('abortAll cancels in-flight work and is safe to call twice', async () => {
  const h = harness({
    profiles: [profileOf('p1', 'm1', { description: 'coding implementation' })],
    start: ({ request }) => ({
      id: 'child-hanging',
      localAgent: undefined,
      result: new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('cancelled at teardown')));
      }),
      dispose: async () => h.disposed.push('child-hanging'),
    }),
  });
  try {
    const running = h.engine.run({ task: 'Implement the feature.', captain: CAPTAIN });
    // Wait until the delegation is registered as in flight.
    for (let attempt = 0; attempt < 100 && h.engine.inFlightCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(h.engine.inFlightCount, 1);

    // Teardown path: the plugin unloads mid-run.
    assert.equal(h.engine.abortAll('test teardown'), 1);
    assert.equal(h.engine.abortAll('test teardown again'), 0, 'a second call is a no-op');

    const run = await running;
    assert.equal(run.counts.failed, 1);
    assert.equal(h.engine.inFlightCount, 0);
  } finally {
    h.cleanup();
  }
});

test('a cold restart resumes purely from the state file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orch-cold-'));
  try {
    // ---- first process: adopt preferences and learn a descriptor -------------
    const first = new OrchestratorStore(directory);
    first.update((state) => {
      state.mode = 'guided';
      state.guided.capabilities = ['software.implementation', 'data.analysis'];
      state.preferences.maxParallel = 6;
      state.preferences.deniedRoutes = ['p1/expensive'];
    });
    const learned = new Taxonomy();
    const descriptor = learned.register({
      id: 'maritime.contract-review',
      label: 'Contract review',
      group: 'maritime',
      signals: [{ type: 'keywords', keywords: ['clause'], weight: 1 }],
      origin: 'synthesized',
    });
    first.update((state) => {
      state.taxonomy.custom = learned.customDescriptors();
      state.profiles['p1/m1'] = { strengths: ['careful'], keywords: ['reasoning'], at: 1 };
    });
    assert.ok(descriptor.id.length > 0);

    // ---- the process is killed here; the next one reads only the file --------
    const second = new OrchestratorStore(directory);
    const state = second.snapshot();
    assert.equal(state.mode, 'guided');
    assert.deepEqual(state.guided.capabilities, ['software.implementation', 'data.analysis']);
    assert.equal(state.preferences.maxParallel, 6);
    assert.deepEqual(state.preferences.deniedRoutes, ['p1/expensive']);
    assert.equal(state.taxonomy.custom.length, 1);

    // The learned descriptor is restored into a fresh taxonomy and usable.
    const restored = new Taxonomy();
    assert.equal(restored.restore(state.taxonomy.custom), 1);
    assert.ok(restored.has('maritime.contract-review'));

    // The model pool is NOT restored: it is rediscovered from the live registry.
    assert.ok(!('models' in state) && !('pool' in state));
    assert.deepEqual(state.profiles['p1/m1'].strengths, ['careful'], 'calibrations survive');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a state file truncated by a hard kill is tolerated on restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orch-trunc-'));
  try {
    const store = new OrchestratorStore(directory);
    store.update((state) => {
      state.mode = 'guided';
    });
    // Simulate a file damaged by an interrupted external write.
    const path = store.path;
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.slice(0, Math.floor(text.length / 2)));

    // A restart must not throw; it falls back to defaults and reports why.
    const recovered = new OrchestratorStore(directory);
    assert.match(String(recovered.writeError), /could not read/);
    assert.equal(recovered.snapshot().mode, 'auto', 'defaults are usable');
    // And the deployment keeps working: a write repairs the file.
    recovered.update((state) => {
      state.mode = 'guided';
    });
    const reread = new OrchestratorStore(directory);
    assert.equal(reread.snapshot().mode, 'guided');
    assert.equal(reread.writeError, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an atomic write leaves no temp file, so a kill cannot wedge later reads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orch-atomic-'));
  try {
    const { readdirSync } = await import('node:fs');
    const store = new OrchestratorStore(directory);
    // Many writes: a temp file that were left behind would eventually be packed
    // alongside the state file, and a later process could read a partial one.
    for (let index = 1; index <= 16; index += 1) {
      store.update((state) => {
        state.preferences.maxParallel = index;
      });
    }
    const leftovers = readdirSync(directory).filter((name) => name.includes('.tmp'));
    assert.deepEqual(leftovers, [], 'a temp file left behind would confuse a later read');
    assert.ok(existsSync(store.path));
    // The last write wins, intact.
    assert.equal(new OrchestratorStore(directory).snapshot().preferences.maxParallel, 16);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a newer on-disk schema is refused rather than half-applied after a downgrade', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orch-schema-'));
  try {
    const base = defaultState();
    writeFileSync(
      join(directory, 'state.json'),
      JSON.stringify({ ...base, schemaVersion: base.schemaVersion + 3, mode: 'guided' }),
    );
    const store = new OrchestratorStore(directory);
    // Defaults in memory, and the newer file left untouched for the newer build.
    assert.equal(store.snapshot().mode, 'auto');
    assert.match(String(store.writeError), /newer than supported/);
    assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).schemaVersion, base.schemaVersion + 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
