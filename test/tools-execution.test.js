/**
 * Tool execution tests.
 *
 * These run the plugin's REAL tool definitions through the host's REAL
 * `defineTool` compiler, execute each tool, and validate every canonical result
 * with the host's own lossless-JSON check. That combination is what the live
 * boot enforces, and it caught two defects a definition-shape test could not:
 * a missing `output.render`, and an `undefined` property in a result.
 *
 * The plugin is materialized into a scratch directory whose `node_modules` is a
 * symlink to the host's, so the plugin's bare host imports resolve exactly as
 * they do when it is installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Locate the installed DSH tree, matching the plugin-shape test's search. */
function findDshInstall() {
  const override = process.env.DSH_TEST_HOST;
  if (typeof override === 'string' && override !== '') return override;
  const candidates = [];
  let directory = ROOT;
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(directory, 'node_modules', '@deepseek-ai', 'dsh'));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const executable = process.execPath;
  if (typeof executable === 'string' && executable !== '') {
    const bin = dirname(executable);
    candidates.push(join(bin, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
    candidates.push(join(bin, 'node_modules', '@deepseek-ai', 'dsh'));
  }
  for (const home of [process.env.DSH_HOME, join(homedir(), '.dsh')]) {
    if (typeof home !== 'string' || home === '') continue;
    try {
      for (const entry of readdirSync(join(home, 'profiles'))) {
        candidates.push(join(home, 'profiles', entry, 'node_modules', '@deepseek-ai', 'dsh'));
      }
    } catch {
      // No profiles directory.
    }
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

/**
 * Materialize the plugin so its host imports resolve, then import a module.
 *
 * @param install - the DSH package directory.
 * @param name - the module under `lib/` to import.
 * @returns `{ module, cleanup }`.
 */
async function materialize(install, name) {
  const scratch = mkdtempSync(join(tmpdir(), 'orch-exec-'));
  const lib = join(scratch, 'lib');
  mkdirSync(lib, { recursive: true });
  for (const entry of readdirSync(join(ROOT, 'lib'))) {
    if (entry.endsWith('.js')) copyFileSync(join(ROOT, 'lib', entry), join(lib, entry));
  }
  const hostModules = join(install, 'node_modules');
  if (!existsSync(join(hostModules, '@deepseek-ai', 'dsh-tools'))) {
    throw new Error(`the DSH install at ${install} has no host packages to link against`);
  }
  // The copied modules use ESM syntax, and a scratch directory has no manifest
  // of its own. Declaring the type explicitly keeps the test from depending on
  // whatever the nearest ancestor package.json happens to say.
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({ name: 'orch-exec-scratch', private: true, type: 'module' }),
  );
  symlinkSync(hostModules, join(scratch, 'node_modules'), 'dir');
  return {
    module: await import(pathToFileURL(join(lib, name)).href),
    scratch,
    cleanup: () => rmSync(scratch, { recursive: true, force: true }),
  };
}

/** A live engine wired to stub host services, plus the validator. */
async function harness(install) {
  const materialized = await materialize(install, 'tools.js');
  const host = await import(
    pathToFileURL(join(install, 'node_modules', '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js')).href
  );
  const { ModelPool } = await import(pathToFileURL(join(materialized.scratch, 'lib', 'discovery.js')).href);
  const { Taxonomy } = await import(pathToFileURL(join(materialized.scratch, 'lib', 'taxonomy.js')).href);
  const { OrchestratorStore } = await import(
    pathToFileURL(join(materialized.scratch, 'lib', 'persistence.js')).href
  );
  const { Orchestrator } = await import(pathToFileURL(join(materialized.scratch, 'lib', 'engine.js')).href);

  const state = mkdtempSync(join(tmpdir(), 'orch-store-'));
  const registered = [];
  const spawned = [];
  let writeFails = false;

  const llm = {
    listProviders: () => [{ id: 'p1', name: 'Provider one' }],
    listModels: async () => [
      { provider: 'p1', id: 'm-fast', name: 'Fast', inputModalities: ['text'] },
      { provider: 'p1', id: 'm-deep', name: 'Deep', inputModalities: ['text'] },
    ],
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      inputModalities: model === 'm-deep' ? ['text', 'image'] : ['text'],
      context: { contextWindow: model === 'm-deep' ? 200000 : 8000 },
      ...(model === 'm-deep' ? { reasoning: { efforts: [{ id: 'high', name: 'High' }] } } : {}),
    }),
    resolveCallConfig: async (config) => {
      if (writeFails) throw new Error('UNSUPPORTED_REASONING_EFFORT');
      return config;
    },
  };
  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({
      name: 'spawn',
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
    }),
    start: async (provider, request) => {
      spawned.push(request);
      const run = {
        id: `child-${spawned.length}`,
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: `result for ${request.agentOptions.model}` }],
          stopReason: 'completed',
        }),
        dispose: async () => {},
      };
      return run;
    },
  };
  const ctx = {
    get: (key) => {
      if (key === 'llm') return llm;
      if (key === 'subagents') return subagents;
      return undefined;
    },
    tools: {
      register: (definition) => {
        registered.push(definition);
        return () => {};
      },
    },
  };

  const store = new OrchestratorStore(state);
  const pool = new ModelPool();
  const taxonomy = new Taxonomy();
  const engine = new Orchestrator({ ctx, pool, taxonomy, store, logger: undefined });
  materialized.module.registerOrchestratorTools(ctx, { engine, pool, taxonomy, store });

  return {
    isJsonValue: host.isJsonValue,
    registered,
    spawned,
    store,
    engine,
    pool,
    setWriteFails: (value) => {
      writeFails = value;
    },
    cleanup: () => {
      materialized.cleanup();
      rmSync(state, { recursive: true, force: true });
    },
  };
}

/** A tool execution context good enough for these tools. */
function execution() {
  return {
    callId: 'call-1',
    name: 'probe',
    arguments: {},
    agent: { id: 'captain-session' },
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  };
}

const install = findDshInstall();

test('every tool compiles, executes, and returns lossless JSON', async (t) => {
  if (install === undefined) return t.skip('no DSH installation is present');
  const h = await harness(install);
  try {
    assert.equal(h.registered.length, 7, 'every declared tool must register');
    for (const definition of h.registered) {
      // A missing `output.render` only surfaces at call time, so assert it here.
      assert.equal(
        typeof definition.output?.render,
        'function',
        `${definition.name} must declare a render projection`,
      );
      const value = await definition.execute({ task: 'Implement the parser in src/parse.js.' }, execution());
      assert.ok(
        h.isJsonValue(value),
        `${definition.name} returned a value the host's lossless-JSON check rejects`,
      );
      const blocks = definition.output.render({}, value);
      assert.ok(Array.isArray(blocks) && blocks.length > 0, `${definition.name} rendered no content`);
      assert.equal(blocks[0].type, 'text');
      assert.ok(blocks[0].text.length > 0);
    }
  } finally {
    h.cleanup();
  }
});

test('the pool tool discovers the live models and reports their evidence', async (t) => {
  if (install === undefined) return t.skip('no DSH installation is present');
  const h = await harness(install);
  try {
    const tool = h.registered.find((entry) => entry.name === 'orchestrate_models');
    const value = await tool.execute({ refresh: true }, execution());
    assert.equal(value.ok, true);
    assert.equal(value.pool.size, 2);
    assert.deepEqual(value.pool.providers, ['p1']);
    const routes = value.models.map((model) => model.route).sort();
    assert.deepEqual(routes, ['p1/m-deep', 'p1/m-fast']);
    const deep = value.models.find((model) => model.route === 'p1/m-deep');
    assert.equal(deep.supportsImage, true);
    assert.equal(deep.contextWindow, 200000);
    assert.deepEqual(deep.reasoningEfforts, ['high']);
    assert.ok(deep.evidence.includes('metadata'));
  } finally {
    h.cleanup();
  }
});

test('a run delegates to the live pool and returns each result to the captain', async (t) => {
  if (install === undefined) return t.skip('no DSH installation is present');
  const h = await harness(install);
  try {
    const tool = h.registered.find((entry) => entry.name === 'orchestrate_run');
    const value = await tool.execute(
      { task: 'Diagnose the root cause of the intermittent failure in the parser.' },
      execution(),
    );
    assert.equal(value.ok, true);
    assert.ok(h.spawned.length >= 1, 'the run must delegate at least one unit');
    // The child must be attributed to the calling agent.
    assert.equal(h.spawned[0].parent.id, 'captain-session');
    // The depth requirement must have selected the reasoning-capable route.
    assert.equal(h.spawned[0].agentOptions.provider, 'p1');
    assert.equal(h.spawned[0].agentOptions.model, 'm-deep');
    assert.ok(Array.isArray(value.results) && value.results.length >= 1);
    assert.ok(typeof value.aggregated === 'string' && value.aggregated.length > 0);
    // Nothing queryable survives the call.
    assert.equal(h.engine.inFlightCount, 0);
  } finally {
    h.cleanup();
  }
});

test('a trivial task is answered without delegating', async (t) => {
  if (install === undefined) return t.skip('no DSH installation is present');
  const h = await harness(install);
  try {
    const tool = h.registered.find((entry) => entry.name === 'orchestrate_run');
    const value = await tool.execute(
      { task: 'what is a monad', analysis: { summary: 'definition', complexity: 'trivial', requirements: [] } },
      execution(),
    );
    assert.equal(value.tier, 'direct');
    assert.equal(h.spawned.length, 0, 'a direct task must not spawn a child');
  } finally {
    h.cleanup();
  }
});

test('the run tool reports a precise error when no calling agent exists', async (t) => {
  if (install === undefined) return t.skip('no DSH installation is present');
  const h = await harness(install);
  try {
    const tool = h.registered.find((entry) => entry.name === 'orchestrate_run');
    const value = await tool.execute({ task: 'Implement the feature.' }, { ...execution(), agent: undefined });
    assert.equal(value.ok, false);
    assert.match(value.error, /no calling agent is available/);
    assert.equal(h.spawned.length, 0);
  } finally {
    h.cleanup();
  }
});

test('a rejected child route surfaces the adapter error', async (t) => {
  if (install === undefined) return t.skip('no DSH installation is present');
  const h = await harness(install);
  try {
    h.setWriteFails(true);
    const tool = h.registered.find((entry) => entry.name === 'orchestrate_dispatch');
    await assert.rejects(
      () => tool.execute({ task: 'Review this diff.', capability: 'software.review' }, execution()),
      /rejected by the live LLM adapter/,
    );
  } finally {
    h.cleanup();
  }
});

test('configuration round-trips and is validated', async (t) => {
  if (install === undefined) return t.skip('no DSH installation is present');
  const h = await harness(install);
  try {
    const tool = h.registered.find((entry) => entry.name === 'orchestrate_configure');
    const applied = await tool.execute(
      {
        mode: 'guided',
        guidedCapabilities: ['software.implementation', 'not.a.real.capability'],
        maxParallel: 3,
      },
      execution(),
    );
    assert.equal(applied.ok, true);
    assert.ok(applied.applied.includes('mode'));
    assert.ok(applied.applied.includes('maxParallel'));
    assert.deepEqual(applied.unknownCapabilities, ['not.a.real.capability']);
    assert.equal(applied.state.mode, 'guided');
    assert.equal(applied.state.preferences.maxParallel, 3);

    // The change must be durable.
    const reloaded = h.store.snapshot();
    assert.equal(reloaded.mode, 'guided');
    assert.equal(reloaded.preferences.maxParallel, 3);
  } finally {
    h.cleanup();
  }
});

test('an unknown capability produces an actionable dispatch error', async (t) => {
  if (install === undefined) return t.skip('no DSH installation is present');
  const h = await harness(install);
  try {
    const tool = h.registered.find((entry) => entry.name === 'orchestrate_dispatch');
    const value = await tool.execute({ task: 'x', capability: 'no.such.thing' }, execution());
    assert.equal(value.ok, false);
    assert.match(value.error, /unknown capability/);
    assert.ok(Array.isArray(value.availableCapabilities));
    assert.ok(h.spawned.length === 0);
  } finally {
    h.cleanup();
  }
});
