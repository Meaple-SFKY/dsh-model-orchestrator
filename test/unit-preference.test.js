/**
 * Per-unit model preference, at the level where it is applied.
 *
 * A whole-task preference is often too coarse: one plan can hold a vision unit and
 * a maths unit, and the model that should read the diagram is not the model that
 * should do the derivation. These tests exercise the routing itself, so they drive
 * the engine rather than the ranker — the per-unit match happens during unit
 * composition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Taxonomy } from '../lib/taxonomy.js';
import { ModelPool, buildProfile } from '../lib/discovery.js';
import { Orchestrator } from '../lib/engine.js';

const route = (provider, id, { contextWindow, modalities = ['text'], description } = {}) =>
  buildProfile(
    {
      modalities,
      contextWindow,
      defaultMaxTokens: 64000,
      efforts: ['off', 'low', 'high', 'max'],
      name: id,
      description,
    },
    provider,
    id,
  );

/** The deployment's real distinguishing routes. */
const liveModels = () => [
  route('commandcode', 'gpt-5.6-sol', { contextWindow: 1050000, modalities: ['text', 'image'], description: 'GOAT · Image · 1.1M' }),
  route('commandcode', 'gemini-3.8-flash', { contextWindow: 1000000, modalities: ['text', 'image'], description: 'GOAT · Image · 1M' }),
  route('commandcode', 'xai/grok-4.6', { contextWindow: 500000, modalities: ['text', 'image'], description: 'GOAT · Image · 500K' }),
  route('deepseek-official', 'deepseek-v4-pro', { contextWindow: 1000000, description: 'Stronger agentic coding and difficult reasoning.' }),
];

/** A host whose subagents record the request they were started with. */
function harness(models = liveModels()) {
  const starts = [];
  const pool = new ModelPool();
  const define = (key, value) => Object.defineProperty(pool, key, { value, configurable: true });
  define('models', () => models);
  define('providers', () => [...new Set(models.map((entry) => entry.provider))]);
  define('refresh', async () => ({ models }));
  define('get', (value) => models.find((entry) => entry.route === value));
  define('discoveredAt', () => Date.now());
  define('problems', () => []);
  define('lastError', () => undefined);

  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({
      name: 'spawn',
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
    }),
    start: async (_provider, request) => {
      starts.push(request);
      return { id: `child-${starts.length}`, result: Promise.resolve({ text: 'ok' }), dispose: async () => {} };
    },
  };
  const ctx = {
    get(key) {
      if (key === 'subagents') return subagents;
      if (key === 'llm') {
        return {
          listProviders: () => [],
          listModels: async () => [],
          resolveModelInfo: async () => undefined,
          resolveCallConfig: async (config) => config,
        };
      }
      return undefined;
    },
  };
  const store = {
    snapshot: () => ({
      preferences: {
        preferCheaper: true,
        maxParallel: 4,
        maxAgentsPerRun: 12,
        allowMultiAgent: true,
        deniedRoutes: [],
        allowedRoutes: [],
        captainMode: 'main',
        decisionCues: {},
      },
      mode: 'auto',
      guided: { capabilities: [] },
      taxonomy: { custom: [] },
      profiles: {},
    }),
    update: () => {},
    path: '/tmp/unit-preference',
    writeError: undefined,
  };
  const engine = new Orchestrator({ ctx, pool, taxonomy: new Taxonomy(), store, logger: undefined });
  return { engine, starts };
}

const TWO_UNITS = [
  { capability: 'multimodal.screenshot', weight: 0.9 },
  { capability: 'software.implementation', weight: 0.9 },
];

const routed = (run) => Object.fromEntries(run.results.map((entry) => [entry.id, entry.route]));

test('one unit honours its preference while the other keeps the measured ranking', async () => {
  const { engine } = harness();
  const run = await engine.run({
    task: 'Read the attached image and implement the parser in the codebase.',
    captain: { id: 'captain' },
    analysis: {
      summary: 'vision then code',
      complexity: 'specialist',
      requirements: TWO_UNITS,
      unitModelPreference: [
        { capability: 'multimodal.screenshot', routes: ['commandcode/gpt-5.6-sol', 'commandcode/gemini-3.8-flash'] },
      ],
    },
  });

  const routes = routed(run);
  assert.equal(routes.multimodal, 'commandcode/gpt-5.6-sol', 'the vision unit takes its preference');
  assert.equal(routes.software, 'deepseek-official/deepseek-v4-pro', 'the other unit is untouched');
});

test('a cluster preference applies to the units inside that cluster', async () => {
  const { engine } = harness();
  const run = await engine.run({
    task: 'Read the attached image and implement the parser in the codebase.',
    captain: { id: 'captain' },
    analysis: {
      summary: 'vision then code',
      complexity: 'specialist',
      requirements: TWO_UNITS,
      unitModelPreference: [{ group: 'multimodal', routes: ['commandcode/xai/grok-4.6'] }],
    },
  });
  assert.equal(routed(run).multimodal, 'commandcode/xai/grok-4.6', 'the cluster name addresses its unit');
});

test('a per-unit preference cannot place an ineligible route, and falls through its own list', async () => {
  // The caller asks for a text-only model on the vision unit. The plugin refuses
  // that name and uses the caller's NEXT name, rather than dropping the unit.
  const { engine } = harness();
  const run = await engine.run({
    task: 'Read the attached screenshot and transcribe it.',
    captain: { id: 'captain' },
    analysis: {
      summary: 'vision',
      complexity: 'specialist',
      requirements: [{ capability: 'multimodal.screenshot', weight: 0.9 }],
      unitModelPreference: [
        { group: 'multimodal', routes: ['deepseek-official/deepseek-v4-pro', 'commandcode/xai/grok-4.6'] },
      ],
    },
  });

  const routes = routed(run);
  assert.notEqual(routes.multimodal, 'deepseek-official/deepseek-v4-pro', 'the ineligible name is refused');
  assert.equal(routes.multimodal, 'commandcode/xai/grok-4.6', 'the next eligible name is used');
});

test('an unmatched per-unit preference changes nothing', async () => {
  const { engine: plain } = harness();
  const base = await plain.run({
    task: 'Read the attached image and implement the parser in the codebase.',
    captain: { id: 'captain' },
    analysis: { summary: 'vision then code', complexity: 'specialist', requirements: TWO_UNITS },
  });

  const { engine: withUnmatched } = harness();
  const perturbed = await withUnmatched.run({
    task: 'Read the attached image and implement the parser in the codebase.',
    captain: { id: 'captain' },
    analysis: {
      summary: 'vision then code',
      complexity: 'specialist',
      requirements: TWO_UNITS,
      unitModelPreference: [{ capability: 'nothing.matches.this', routes: ['commandcode/xai/grok-4.6'] }],
    },
  });

  assert.deepEqual(routed(perturbed), routed(base), 'a preference that matches no unit must not perturb routing');
});

test('the most specific target wins for the unit it names', async () => {
  const { engine } = harness();
  const run = await engine.run({
    task: 'Read the attached image and implement the parser in the codebase.',
    captain: { id: 'captain' },
    analysis: {
      summary: 'vision then code',
      complexity: 'specialist',
      requirements: TWO_UNITS,
      // Cluster first, then the exact capability: the exact one must win.
      unitModelPreference: [
        { group: 'multimodal', routes: ['commandcode/xai/grok-4.6'] },
        { capability: 'multimodal.screenshot', routes: ['commandcode/gemini-3.8-flash'] },
      ],
    },
  });
  assert.equal(routed(run).multimodal, 'commandcode/gemini-3.8-flash', 'the specific target overrides the cluster');
});
