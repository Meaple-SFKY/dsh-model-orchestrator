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
import { createSyncRunner, groupByProvider } from '../lib/sync.js';
import { ResearchAnswerError, parseJsonAnswer } from '../lib/web-research.js';

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

test('cancelling a sweep aborts it, refuses to write, and frees the slot', async () => {
  // `cancel` used to only drop the reference: the work kept running, kept writing
  // after teardown, and a later start() ran a SECOND sweep beside the first.
  let writes = 0;
  let observed;
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  const runner = createSyncRunner({
    pool: { models: () => POOL },
    store: {
      snapshot: () => ({ research: {} }),
      update: () => {
        writes += 1;
      },
      writeError: undefined,
    },
    runResearch: async ({ signal }) => {
      observed = signal;
      await gate;
      return ANSWER;
    },
    now: () => 21,
  });

  const sweep = runner.start({});
  assert.equal(observed.aborted, false, 'the sweep starts unaborted');
  runner.cancel();
  assert.equal(observed.aborted, true, 'cancel must abort the work, not forget it');
  release();
  const status = await sweep;
  assert.equal(status.status, 'cancelled');
  assert.equal(writes, 0, 'an aborted sweep must not write');
  assert.equal(runner.status().status, 'cancelled');

  // The slot is free afterwards, so the next request is a real sweep again.
  const second = await runner.start({});
  assert.equal(second.status, 'done');
});

test('the same public model behind two providers is one entry, not two', () => {
  // Keying by the route's own id string stored it twice and let the copies drift.
  // The public identity is what the two routes genuinely share.
  const twoProviders = [
    { route: 'commandcode/gpt-5.6-sol', model: 'gpt-5.6-sol', name: 'GPT-5.6 Sol (CC)' },
    { route: 'otherai/gpt-5.6-sol', model: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' },
  ];
  const entries = normalizeResearch(
    {
      results: [
        { route: 'commandcode/gpt-5.6-sol', matched: true, publicName: 'GPT-5.6 Sol', inputPerMTok: 10 },
        { route: 'otherai/gpt-5.6-sol', matched: true, publicName: 'GPT-5.6 Sol', outputPerMTok: 30 },
      ],
    },
    { models: twoProviders, at: 1 },
  ).entries;

  const stored = mergeResearch({}, entries);
  assert.deepEqual(Object.keys(stored), ['gpt56sol'], 'one public identity, one entry');
  assert.equal(stored.gpt56sol.inputPerMTok, 10);
  assert.equal(stored.gpt56sol.outputPerMTok, 30, 'the second provider merges into the same record');

  // And it is still found from EITHER live route.
  for (const model of twoProviders) {
    assert.equal(researchFor(stored, model)?.publicName, 'GPT-5.6 Sol');
  }

  // An unconfirmed route keeps its own key: its note belongs to that route.
  const unconfirmed = normalizeResearch(
    { results: [{ route: 'commandcode/stealth/ox-alpha', matched: false, notes: 'nothing public' }] },
    { models: [{ route: 'commandcode/stealth/ox-alpha', model: 'stealth/ox-alpha', name: 'ox-alpha' }], at: 2 },
  ).entries;
  const withUnconfirmed = mergeResearch(stored, unconfirmed);
  assert.deepEqual(
    Object.keys(withUnconfirmed).sort(),
    ['gpt56sol', 'stealthoxalpha'],
    'an unconfirmed route keeps its own identity key, not the public one',
  );
});

// ---- per-provider isolation, diagnostics, and grouping ----------------------

const TWO_PROVIDERS = [
  { route: 'alpha/m1', provider: 'alpha', model: 'm1', name: 'M1' },
  { route: 'alpha/m2', provider: 'alpha', model: 'm2', name: 'M2' },
  { route: 'beta/m3', provider: 'beta', model: 'm3', name: 'M3' },
];

test('routes are grouped by provider, falling back to the route prefix', () => {
  const groups = groupByProvider([
    { route: 'alpha/m1', provider: 'alpha' },
    { route: 'alpha/m2', provider: 'alpha' },
    { route: 'beta/m3', provider: 'beta' },
    // No `provider` field: the vendor prefix is still its own group, so a pool row
    // without one cannot drag unrelated vendors into a single batch.
    { route: 'gamma/m4' },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.provider, group.models.length]),
    [['alpha', 2], ['beta', 1], ['gamma', 1]],
  );
});

test('one unreachable provider no longer costs every other provider its facts', async () => {
  // Reproduced from a real sync: a single call covered the whole pool, so one
  // provider that could not be reached discarded the facts of the other four and the
  // pass reported one error with no results at all.
  const updates = [];
  const runner = createSyncRunner({
    pool: { models: () => TWO_PROVIDERS },
    store: {
      snapshot: () => ({ research: {} }),
      update: (mutator) => {
        const state = { research: {} };
        mutator(state);
        updates.push(state.research);
      },
      writeError: undefined,
    },
    runResearch: async ({ provider }) => {
      if (provider === 'beta') throw new Error('provider beta is unreachable');
      return {
        results: [
          { route: 'alpha/m1', matched: true, publicName: 'M1' },
          { route: 'alpha/m2', matched: true, publicName: 'M2' },
        ],
      };
    },
    now: () => 3,
    providerConcurrency: 1,
  });

  const status = await runner.start({});
  assert.equal(status.status, 'partial', 'some answered and some did not');
  assert.equal(status.stored, 2, "the reachable provider's facts are stored");
  assert.match(status.error, /beta/);
  assert.deepEqual(status.failedProviders, ['beta']);
  assert.deepEqual(
    status.providers.map((entry) => [entry.provider, entry.status]),
    [['alpha', 'done'], ['beta', 'error']],
  );
  assert.equal(updates.length, 1, 'only the answering provider writes');
});

test('a failure to read the answer travels with what the researcher saw', async () => {
  const runner = createSyncRunner({
    pool: { models: () => [{ route: 'alpha/m1', provider: 'alpha', model: 'm1' }] },
    store: { snapshot: () => ({ research: {} }), update: () => {}, writeError: undefined },
    runResearch: async () => {
      throw new ResearchAnswerError('the research answer contained no JSON object: it was 12 character(s)', {
        length: 12,
        excerpt: 'I cannot do ',
      });
    },
    now: () => 1,
  });

  const status = await runner.start({});
  assert.equal(status.status, 'error');
  assert.equal(status.detail.excerpt, 'I cannot do ', 'the status carries the answer excerpt');
  assert.equal(status.providers[0].detail.length, 12, 'and so does the provider outcome');
});

test('an unreadable research answer says what it actually saw', () => {
  // The bare "no JSON object" message was the entire failure the user got.
  assert.throws(
    () => parseJsonAnswer('I am unable to browse the web.'),
    (error) => {
      assert.ok(error instanceof ResearchAnswerError);
      assert.match(error.message, /contained no JSON object/);
      assert.match(error.message, /30 character\(s\)/);
      assert.match(error.message, /I am unable to browse/);
      assert.equal(error.detail.objectFound, false);
      return true;
    },
  );

  assert.throws(
    () => parseJsonAnswer(''),
    (error) => {
      assert.match(error.message, /was empty/);
      assert.equal(error.detail.empty, true);
      return true;
    },
  );

  assert.throws(
    () => parseJsonAnswer('```json\n{ "results": [ }\n```'),
    (error) => {
      assert.match(error.message, /was not valid JSON/);
      assert.equal(error.detail.objectFound, true);
      assert.equal(error.detail.fenced, true);
      return true;
    },
  );

  // The two shapes that must keep working.
  assert.deepEqual(parseJsonAnswer('{"results":[]}'), { results: [] });
  assert.deepEqual(parseJsonAnswer('Here you go:\n```json\n{"results":[]}\n```\nDone.'), { results: [] });
});
