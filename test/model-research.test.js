/**
 * Model-research and sync tests.
 *
 * Two things matter here and are pinned separately. The researched facts must be
 * honest — an unconfirmed identity stays unconfirmed, an unusable price is
 * discarded rather than repaired, and everything carries its provenance. And cost
 * shaping must actually change, because an entire pool of one tier made
 * `preferCheaper` a switch that did nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Taxonomy } from '../lib/taxonomy.js';
import { ModelPool, buildProfile } from '../lib/discovery.js';
import { rankModels } from '../lib/matching.js';
import {
  mergeResearch,
  normalizeResearch,
  normalizeResearchMap,
  priceOf,
  priceRatios,
  researchFor,
  researchPrompt,
} from '../lib/model-research.js';
import { createSyncRunner } from '../lib/sync.js';

const POOL = [
  { route: 'commandcode/gpt-5.6-sol', model: 'gpt-5.6-sol', name: 'GPT-5.6 Sol (CC)' },
  { route: 'commandcode/google/gemini-3.8-flash', model: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash (CC)' },
];

const ANSWER = {
  results: [
    {
      route: 'commandcode/gpt-5.6-sol',
      matched: true,
      publicName: 'GPT-5.6 Sol',
      vendor: 'OpenAI',
      inputPerMTok: 10,
      outputPerMTok: 30,
      strengths: ['reasoning', 'architecture'],
      sources: ['https://example.test/pricing'],
    },
    { route: 'commandcode/google/gemini-3.8-flash', matched: false, notes: 'no public listing found' },
  ],
};

test('a researched answer becomes facts, with provenance, keyed by identity', () => {
  const { entries, problems } = normalizeResearch(ANSWER, { models: POOL, at: 1234, agentModel: 'p/x' });
  assert.deepEqual(problems, []);
  const sol = entries['commandcode/gpt-5.6-sol'];
  assert.equal(sol.matched, true);
  assert.equal(sol.publicName, 'GPT-5.6 Sol');
  assert.equal(sol.inputPerMTok, 10);
  assert.equal(sol.at, 1234);
  assert.equal(sol.agentModel, 'p/x');
  assert.ok(sol.identityKeys.includes('gpt56sol'));

  const stored = mergeResearch({}, entries);
  assert.ok('gpt56sol' in stored, 'the entry is keyed by identity, not by route');
  // And it is found again from the live row, even after the route is respelled.
  assert.equal(
    researchFor(stored, { route: 'otherai/gpt-5.6-sol', model: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' })
      ?.publicName,
    'GPT-5.6 Sol',
  );
});

test('an unconfirmed identity is stored as unconfirmed, not dropped', () => {
  const { entries } = normalizeResearch(ANSWER, { models: POOL, at: 1 });
  const gemini = entries['commandcode/google/gemini-3.8-flash'];
  assert.equal(gemini.matched, false);
  assert.equal(gemini.publicName, undefined, 'no name may be invented for an unconfirmed route');
  assert.equal(gemini.notes, 'no public listing found');
});

test('unusable answers are dropped, never repaired', () => {
  const { entries, problems } = normalizeResearch(
    {
      results: [
        { route: 'commandcode/gpt-5.6-sol', matched: true, inputPerMTok: -3, outputPerMTok: 'free' },
        { route: 'some/other-route', matched: true, publicName: 'Invented' },
        'not an object',
      ],
    },
    { models: POOL, at: 1 },
  );
  // The price fields are unusable, so they are absent — but the route itself was
  // asked about, so its row survives with no price rather than a made-up one.
  assert.equal(entries['commandcode/gpt-5.6-sol'].inputPerMTok, undefined);
  assert.equal(entries['commandcode/gpt-5.6-sol'].outputPerMTok, undefined);
  assert.equal(entries['some/other-route'], undefined, 'a route nobody asked about is refused');
  // Three problems: the unusable price on a row that was kept, a route nobody
  // asked about, and a row that was not an object.
  assert.equal(problems.length, 3);
});

test('the prompt demands an honest false and forbids estimated prices', () => {
  const prompt = researchPrompt(POOL);
  assert.match(prompt, /Answer false when you could not confirm it/);
  assert.match(prompt, /never estimate/);
  assert.ok(prompt.includes('commandcode/gpt-5.6-sol'), 'every route must be listed');
});

test('a stored map survives a hand-edited file', () => {
  const map = normalizeResearchMap({
    a: { route: 'r', matched: 'yes', inputPerMTok: -1, strengths: ['x', 5], at: 'soon' },
    b: 'nonsense',
  });
  assert.deepEqual(map.a, { route: 'r', matched: false, strengths: ['x'] });
  assert.equal(map.b, undefined);
});

test('priceOf averages the two sides, and priceRatios normalises within the pool', () => {
  assert.equal(priceOf({ inputPerMTok: 10, outputPerMTok: 30 }), 20);
  assert.equal(priceOf({ inputPerMTok: 4 }), 4);
  assert.equal(priceOf({}), undefined);

  const research = mergeResearch(
    {},
    normalizeResearch(
      {
        results: [
          { route: POOL[0].route, matched: true, inputPerMTok: 30, outputPerMTok: 30 },
          { route: POOL[1].route, matched: true, inputPerMTok: 3, outputPerMTok: 3 },
        ],
      },
      { models: POOL, at: 1 },
    ).entries,
  );
  const ratios = priceRatios(POOL, research);
  assert.equal(ratios.get('commandcode/gpt-5.6-sol'), 1);
  assert.equal(ratios.get('commandcode/google/gemini-3.8-flash'), 0.1);
});

test('a researched price makes preferCheaper change the ranking', () => {
  // The defect this closes: with every route measuring as one tier, the tier proxy
  // was identical everywhere and the preference did nothing.
  const build = (provider, id, description) =>
    buildProfile(
      { modalities: ['text'], contextWindow: 200000, defaultMaxTokens: 64000, name: id, description },
      provider,
      id,
    );
  const cheap = build('p', 'cheap', 'coding implementation');
  const dear = build('p', 'dear', 'coding implementation');
  const pool = new ModelPool();
  for (const [key, value] of Object.entries({
    models: () => [dear, cheap],
    providers: () => ['p'],
    discoveredAt: () => 1,
    problems: () => [],
    lastError: () => undefined,
  })) {
    Object.defineProperty(pool, key, { value, configurable: true });
  }
  const analysis = {
    summary: 'implement',
    complexity: 'specialist',
    requirements: [{ capability: 'software.implementation', weight: 1 }],
  };
  const preferences = { preferCheaper: true };
  const taxonomy = new Taxonomy();

  const withoutPrices = rankModels(pool, taxonomy, analysis, { preferences });
  assert.equal(
    withoutPrices.candidates.length,
    2,
    'both routes stay eligible; the tie is between equal tiers',
  );

  const research = mergeResearch(
    {},
    normalizeResearch(
      {
        results: [
          { route: 'p/dear', matched: true, inputPerMTok: 30, outputPerMTok: 30 },
          { route: 'p/cheap', matched: true, inputPerMTok: 1, outputPerMTok: 1 },
        ],
      },
      { models: [{ route: 'p/dear', model: 'dear', name: 'dear' }, { route: 'p/cheap', model: 'cheap', name: 'cheap' }], at: 1 },
    ).entries,
  );
  const ratios = priceRatios([{ route: 'p/dear' }, { route: 'p/cheap' }], research);
  const withPrices = rankModels(pool, taxonomy, analysis, { preferences, priceRatios: ratios });
  assert.equal(withPrices.candidates[0].route, 'p/cheap', 'the cheaper route must win the tie');
  assert.ok(
    withPrices.candidates[0].costPenalty < withPrices.candidates[1].costPenalty,
    'the penalty must be graded by research, not by a shared tier',
  );

  // And with the preference off, the price must not matter at all.
  const off = rankModels(pool, taxonomy, analysis, {
    preferences: { preferCheaper: false },
    priceRatios: ratios,
  });
  assert.equal(off.candidates.every((candidate) => candidate.costPenalty === 0), true);
});

test('a sync pass stores what it researched and reports what it could not confirm', async () => {
  const updates = [];
  const store = {
    snapshot: () => ({ research: {}, preferences: {} }),
    update: (mutator) => {
      const state = { research: {}, preferences: {} };
      mutator(state);
      updates.push(state.research);
    },
    writeError: undefined,
  };
  const pool = { models: () => POOL };
  const runner = createSyncRunner({
    pool,
    store,
    runResearch: async () => ANSWER,
    now: () => 5,
  });

  const status = await runner.start({});
  assert.equal(status.status, 'done');
  assert.equal(status.requested, 2);
  assert.equal(status.stored, 2);
  assert.equal(status.unmatched, 1, 'the unconfirmed route is counted, not hidden');
  assert.equal(updates.length, 1);
  assert.ok('gpt56sol' in updates[0]);
});

test('a sync pass with nothing outstanding does no work and says so', async () => {
  let calls = 0;
  const existing = { gpt56sol: { route: POOL[0].route, matched: true, identityKeys: ['gpt56sol'] },
    gemini38flash: { route: POOL[1].route, matched: false, identityKeys: ['gemini38flash'] } };
  const runner = createSyncRunner({
    pool: { models: () => POOL },
    store: { snapshot: () => ({ research: existing }), update: () => {}, writeError: undefined },
    runResearch: async () => {
      calls += 1;
      return ANSWER;
    },
    now: () => 7,
  });
  const status = await runner.start({});
  assert.equal(status.status, 'idle');
  assert.match(status.reason, /already has researched facts/);
  assert.equal(calls, 0, 'no model call may be made when there is nothing to learn');
});

test('a failed sweep becomes a status rather than a thrown error', async () => {
  const runner = createSyncRunner({
    pool: { models: () => POOL },
    store: { snapshot: () => ({ research: {} }), update: () => {}, writeError: undefined },
    runResearch: async () => {
      throw new Error('no search provider');
    },
    now: () => 9,
  });
  const status = await runner.start({});
  assert.equal(status.status, 'error');
  assert.match(status.error, /no search provider/);
  assert.equal(runner.status().status, 'error');
});

test('one sweep at a time: a second request joins the first', async () => {
  let resolve;
  const gate = new Promise((done) => {
    resolve = done;
  });
  let calls = 0;
  const runner = createSyncRunner({
    pool: { models: () => POOL },
    store: { snapshot: () => ({ research: {} }), update: () => {}, writeError: undefined },
    runResearch: async () => {
      calls += 1;
      await gate;
      return ANSWER;
    },
    now: () => 11,
  });
  const first = runner.start({});
  const second = runner.start({});
  assert.equal(first, second, 'the second caller joins the in-flight sweep');
  resolve();
  await first;
  assert.equal(calls, 1, 'only one sweep may run');
});
