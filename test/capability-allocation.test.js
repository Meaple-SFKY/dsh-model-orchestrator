/**
 * Capability allocation tests.
 *
 * The reported problem: with a pool of eleven live routes the matcher picked the
 * same model for every task, and its scores were identical across models — a 2.1x
 * difference in context window changed nothing. These tests pin the three defects
 * that caused it and the behaviour that replaced them.
 *
 * The pool below is the deployment's real shape, reduced to the routes that
 * distinguish: providers publish a short capability tag, and the only axes that
 * actually differ are window size and modality.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Taxonomy } from '../lib/taxonomy.js';
import { analysisFromModel, analysisFromText, rankModels, scoreCapability } from '../lib/matching.js';
import { buildProfile } from '../lib/discovery.js';

/** A route with the metadata the host actually exposes. */
function route(provider, id, { description, contextWindow, defaultMaxTokens = 64000, modalities = ['text'] } = {}) {
  return buildProfile(
    {
      modalities,
      contextWindow,
      defaultMaxTokens,
      efforts: ['off', 'low', 'high', 'max'],
      name: id,
      description,
    },
    provider,
    id,
  );
}

/** The deployment's real routes, which is where the defect was observed. */
function livePool() {
  const models = [
    route('deepseek-official', 'deepseek-v4-flash', {
      description: 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
      contextWindow: 1000000,
      defaultMaxTokens: 256000,
    }),
    route('deepseek-official', 'deepseek-v4-pro', {
      description:
        'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
      contextWindow: 1000000,
      defaultMaxTokens: 256000,
    }),
    route('commandcode', 'deepseek/deepseek-v4.1-flash', {
      description: 'Go · Half · Image · 1M',
      contextWindow: 1000000,
      modalities: ['text', 'image'],
    }),
    route('commandcode', 'google/gemini-3.8-flash', {
      description: 'GOAT · Image · 1M',
      contextWindow: 1000000,
      modalities: ['text', 'image'],
    }),
    route('commandcode', 'gpt-5.6-sol', {
      description: 'GOAT · Image · 1.1M',
      contextWindow: 1050000,
      modalities: ['text', 'image'],
    }),
    route('commandcode', 'xai/grok-4.6', {
      description: 'GOAT · Image · 500K',
      contextWindow: 500000,
      modalities: ['text', 'image'],
    }),
  ];
  return {
    models: () => models,
    providers: () => [...new Set(models.map((entry) => entry.provider))],
    discoveredAt: () => Date.now(),
    problems: () => [],
    lastError: () => undefined,
    get: (value) => models.find((entry) => entry.route === value),
    model: (id) => models.find((entry) => entry.model === id),
  };
}

const shortName = (candidate) => candidate.model;

test('a size stated in the task excludes routes that cannot hold it', () => {
  const taxonomy = new Taxonomy();
  const pool = livePool();
  const analysis = analysisFromText(taxonomy, 'Analyze this 900,000 token corpus and summarize.');

  const capacity = analysis.requirements.find((req) => req.minContextWindow !== undefined);
  assert.ok(capacity, 'the stated size must become a requirement');
  assert.equal(capacity.minContextWindow, 900000);

  const result = rankModels(pool, taxonomy, analysis, {});
  const rejected = result.rejected.map((entry) => entry.route);
  assert.ok(
    rejected.includes('commandcode/xai/grok-4.6'),
    'a 500K window cannot satisfy a 900K requirement and must be rejected',
  );
  assert.equal(
    shortName(result.candidates[0]),
    'gpt-5.6-sol',
    'the widest window in the pool wins when the requirement is between the two',
  );
});

test('the magnitude forms people actually write are read', () => {
  const taxonomy = new Taxonomy();
  const cases = [
    ['Analyze this 900,000 token corpus.', 900000],
    ['Summarize 128k tokens of notes.', 128000],
    ['Handle 1.05m token context.', 1050000],
    ['处理这 90 万 token 的材料', 900000],
  ];
  for (const [task, expected] of cases) {
    const analysis = analysisFromText(taxonomy, task);
    const floor = analysis.requirements.find((req) => req.minContextWindow !== undefined);
    assert.ok(floor, `a size in "${task}" must become a requirement`);
    assert.equal(floor.minContextWindow, expected, task);
  }
});

test('a small item count is not read as a context size', () => {
  const taxonomy = new Taxonomy();
  // "12 items" is a count of things to do, not a size of material to hold.
  const analysis = analysisFromText(taxonomy, 'Summarize these 12 items in one line each.');
  assert.equal(
    analysis.requirements.find((req) => req.minContextWindow !== undefined),
    undefined,
    'a bare small number must not become a context floor',
  );
});

test('a task that needs to read an image excludes text-only routes', () => {
  const taxonomy = new Taxonomy();
  const pool = livePool();
  const analysis = analysisFromText(taxonomy, 'Read the attached image and transcribe the table.');

  const visual = analysis.requirements.filter((req) => req.needsImageInput === true);
  assert.equal(visual.length, 1, 'the visual need must be stated exactly once');

  const result = rankModels(pool, taxonomy, analysis, {});
  const rejected = result.rejected.map((entry) => entry.route);
  assert.deepEqual(
    rejected.sort(),
    ['deepseek-official/deepseek-v4-flash', 'deepseek-official/deepseek-v4-pro'],
    'text-only routes must be rejected, and the image-capable ones kept',
  );
  for (const candidate of result.candidates) {
    assert.equal(candidate.supportsImage, true, `${candidate.model} must be able to read the image`);
  }
});

test('capacity separates routes that both satisfy the floor', () => {
  const taxonomy = new Taxonomy();
  const pool = livePool();
  const descriptor = taxonomy.get('capacity.very_long');
  assert.notEqual(descriptor, undefined, 'the capacity capability must be seeded');
  const signal = descriptor.signals.find((sig) => sig.type === 'contextAtLeast');
  assert.notEqual(signal, undefined, 'it must declare a context floor signal');

  // The capability under test carries that one signal, with its floor raised so
  // both routes below clear it and only their headroom differs.
  const requirement = { signals: [{ ...signal, min: 100000 }] };
  const scoringPool = { maxContextWindow: 1050000 };
  const wide = scoreCapability(requirement, pool.model('gpt-5.6-sol'), scoringPool);
  const narrow = scoreCapability(requirement, pool.model('xai/grok-4.6'), scoringPool);

  assert.ok(wide.score > narrow.score, `a wider window must score higher (${wide.score} vs ${narrow.score})`);
  assert.ok(narrow.score > 0, 'a route that satisfies the floor must not score zero');
  assert.ok(wide.score <= 1 && narrow.score <= 1);
});

test('a route with no evidence at all scores a floor, not a veto', () => {
  const taxonomy = new Taxonomy();
  // Regression: making "no evidence" a hard zero disqualified every model whose
  // provider states no description. Making it a large neutral score did the
  // opposite and let silence outrank evidence. It must be a small floor, and it
  // must apply only to a route with NO signal of any kind.
  const silent = buildProfile(
    {
      modalities: ['text'],
      contextWindow: 200000,
      defaultMaxTokens: 64000,
      efforts: undefined,
      name: 'silent',
      description: undefined,
    },
    'p2',
    'silent',
  );
  const stated = route('p1', 'stated', {
    description: 'difficult reasoning, multi-step analysis',
    contextWindow: 200000,
  });

  const descriptor = taxonomy.get('reasoning.general');
  assert.notEqual(descriptor, undefined);
  const scoringPool = { maxContextWindow: 200000 };
  const silentScored = scoreCapability(descriptor, silent, scoringPool);
  const statedScored = scoreCapability(descriptor, stated, scoringPool);

  assert.equal(silentScored.score, 0.02, 'a route with no signal of any kind scores the floor');
  assert.ok(statedScored.score > silentScored.score, 'evidence must outrank silence');
  assert.ok(silentScored.score > 0, 'silence must not veto an otherwise eligible route');
  assert.ok(
    silentScored.matched.some((line) => /no stated evidence/.test(line)),
    'the reason must say the ranking fell back to measured capability',
  );
});

test('a measured, non-textual capability is not mistaken for silence', () => {
  const taxonomy = new Taxonomy();
  // A provider that states no prose may still declare reasoning tiers, and that is
  // REAL evidence the host exposes. It must be scored on its merits.
  const declaredTiers = route('p2', 'tiered', { description: undefined, contextWindow: 200000 });
  const descriptor = taxonomy.get('depth.difficult');
  const scored = scoreCapability(descriptor, declaredTiers, { maxContextWindow: 200000 });
  assert.ok(scored.score > 0.5, `declared reasoning tiers are evidence (got ${scored.score})`);
});

test('no model, provider, or vendor name is hardcoded in the scoring path', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../lib/matching.js', import.meta.url), 'utf8')
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  for (const forbidden of ['deepseek', 'gpt-', 'claude', 'gemini', 'commandcode', 'kimi', 'grok', 'qwen', 'goat']) {
    assert.ok(
      !source.toLowerCase().includes(forbidden),
      `matching.js must not hardcode "${forbidden}" in executable code`,
    );
  }
});

test("the caller's model knowledge orders candidates without overriding constraints", () => {
  // The division of labour: the CALLING model knows the public models behind
  // opaque deployment aliases, so it may state a preference. The plugin keeps the
  // deployment's constraints authoritative, so a preference can only reorder
  // candidates the plugin has already judged eligible.
  const taxonomy = new Taxonomy();
  const pool = livePool();

  // A preference for the narrowest route, on a task with no hard requirements.
  const plain = analysisFromText(taxonomy, 'Diagnose the root cause of the failure.');
  const preferred = rankModels(
    pool,
    taxonomy,
    {
      ...plain,
      modelPreference: [
        { route: 'commandcode/xai/grok-4.6', reason: 'the caller judges it best here' },
        { route: 'commandcode/does-not-exist' },
      ],
    },
    {},
  );

  assert.equal(shortName(preferred.candidates[0]), 'xai/grok-4.6', 'the preference is honoured');
  assert.equal(preferred.candidates[0].preferred, true, 'and marked as the caller choice');
  assert.equal(preferred.candidates[0].preferenceReason, 'the caller judges it best here');
  assert.deepEqual(
    preferred.unresolvedPreferences,
    ['commandcode/does-not-exist'],
    'an unknown alias is reported, never silently dropped',
  );
  // Every candidate is still present; a preference reorders, it does not filter.
  assert.equal(preferred.candidates.length, pool.models().length);
});

test('a model preference cannot revive a route the requirements rejected', () => {
  const taxonomy = new Taxonomy();
  const pool = livePool();
  // 500K cannot hold a 900K corpus, however much the caller likes that model.
  const analysis = analysisFromText(taxonomy, 'Analyze this 900,000 token corpus and summarize.');
  const result = rankModels(
    pool,
    taxonomy,
    { ...analysis, modelPreference: [{ route: 'commandcode/xai/grok-4.6', reason: 'preferred anyway' }] },
    {},
  );

  assert.ok(
    !result.candidates.some((candidate) => candidate.route === 'commandcode/xai/grok-4.6'),
    'the capacity constraint is authoritative',
  );
  assert.ok(
    result.rejected.some((entry) => entry.route === 'commandcode/xai/grok-4.6'),
    'and the route is still reported as rejected',
  );
});

test('a malformed preference is dropped, not turned into a route', () => {
  const taxonomy = new Taxonomy();
  const analysis = analysisFromModel(taxonomy, {
    summary: 'anything',
    modelPreference: [
      { provider: 'p1', model: 'm1', reason: 'ok' },
      { route: 'p2/m2' },
      { provider: 'p3' },
      { model: 'm4' },
      null,
      'nonsense',
      { provider: 'p1', model: 'm1' },
    ],
  });
  assert.deepEqual(
    analysis.modelPreference.map((entry) => entry.route),
    ['p1/m1', 'p2/m2', 'p1/m1'],
    'only complete provider/model pairs and full routes survive',
  );
});

test('no preference leaves the measured ranking untouched', () => {
  const taxonomy = new Taxonomy();
  const pool = livePool();
  const analysis = analysisFromText(taxonomy, 'Diagnose the root cause of the failure.');
  const plain = rankModels(pool, taxonomy, analysis, {});
  const empty = rankModels(pool, taxonomy, { ...analysis, modelPreference: [] }, {});

  assert.deepEqual(empty.preferred, []);
  assert.deepEqual(
    empty.candidates.map((candidate) => candidate.route),
    plain.candidates.map((candidate) => candidate.route),
    'an absent preference must not perturb the order',
  );
  assert.ok(
    empty.candidates.every((candidate) => candidate.preferred === undefined),
    'and must not mark anything as preferred',
  );
});
