/**
 * Run-journal, sibling-question, and review-loop tests.
 *
 * These cover the two collaborations a run owns — a unit asking a finished sibling,
 * and a reviewer sending work back — plus the journal both are reported through. The
 * asserted contract is deliberately about BOUNDS: every loop here can spend real money,
 * so each one must be provably finite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Taxonomy } from '../lib/taxonomy.js';
import { ModelPool, buildProfile } from '../lib/discovery.js';
import { Orchestrator, readVerdict } from '../lib/engine.js';
import { OrchestratorStore } from '../lib/persistence.js';
import { createRunJournal } from '../lib/runs.js';

const CAPTAIN = { id: 'captain-session' };

function profileOf(provider, model, options = {}) {
  return buildProfile(
    {
      modalities: ['text'],
      contextWindow: options.contextWindow ?? 200000,
      defaultMaxTokens: options.defaultMaxTokens,
      efforts: options.efforts,
      name: options.name ?? model,
      description: options.description,
    },
    provider,
    model,
  );
}

/** A mock host whose child answers come from `answer(request, index)`. */
function makeEngine({ profiles, answer, preferences, units } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orch-runs-'));
  const store = new OrchestratorStore(directory);
  if (preferences !== undefined) store.update((state) => Object.assign(state.preferences, preferences));
  const pool = new ModelPool();
  pool.models = () => profiles ?? [];
  pool.providers = () => ['p1'];
  pool.get = (route) => (profiles ?? []).find((profile) => profile.route === route);
  pool.discoveredAt = () => Date.now();
  pool.problems = () => [];
  pool.lastError = () => undefined;
  pool.advertisedProviders = () => ['p1'];
  pool.setPreferences = () => {};
  pool.refresh = async () => ({ models: profiles ?? [], problems: [], discoveredAt: Date.now() });

  const calls = [];
  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({
      name: 'spawn',
      capabilities: { agentOptions: true, persona: true, outputSchema: false, depthLimit: false },
      inheritsParentContext: false,
    }),
    start: async (provider, request) => {
      calls.push({ provider, request });
      const text = answer === undefined ? `answer ${calls.length}` : answer(request, calls.length);
      return {
        id: `child-${calls.length}`,
        result: Promise.resolve({
          output: [{ type: 'text', text: typeof text === 'string' ? text : text.text }],
          stopReason: typeof text === 'string' ? 'completed' : (text.stopReason ?? 'completed'),
          ...(typeof text === 'string' || text.structured === undefined ? {} : { structured: text.structured }),
        }),
        dispose: async () => {},
      };
    },
  };
  const llm = {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => [],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    resolveCallConfig: async (config) => config,
  };
  const ctx = {
    get: (key) => (key === 'llm' ? llm : key === 'subagents' ? subagents : undefined),
  };
  const engine = new Orchestrator({ ctx, pool, taxonomy: new Taxonomy(), store, logger: undefined });
  return {
    engine,
    calls,
    store,
    units,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

// ---- the journal ------------------------------------------------------------

test('the journal reports only finished units as askable', () => {
  const journal = createRunJournal();
  journal.begin({ runId: 'r1', sessionId: 's1', task: 't', startedAt: 0, units: [{ id: 'a' }, { id: 'b' }] });
  journal.unitStarted('r1', { id: 'a' });
  assert.deepEqual(journal.askable('r1'), [], 'a running unit has no answer to ask about');

  journal.unitFinished('r1', { id: 'a' }, { id: 'a', ok: true, text: 'the answer', route: 'p1/m' });
  assert.deepEqual(
    journal.askable('r1').map((entry) => entry.id),
    ['a'],
  );
  journal.unitFinished('r1', { id: 'b' }, { id: 'b', ok: false, text: '', error: 'boom' });
  assert.deepEqual(
    journal.askable('r1').map((entry) => entry.id),
    ['a'],
    'a failed unit has nothing to answer from',
  );
});

test('the journal is bounded and reports the plugin-known edge kinds', () => {
  const journal = createRunJournal({ maxRuns: 2 });
  for (const id of ['r1', 'r2', 'r3']) {
    journal.begin({ runId: id, sessionId: 's', task: 't', startedAt: 0, units: [] });
  }
  assert.equal(journal.get('r1'), undefined, 'the oldest run is evicted');
  assert.equal(journal.get('r3') !== undefined, true);

  // `b` both depends on `a` and reviews it, so the journal must report a dependency
  // edge AND a review edge between the same pair.
  journal.begin({
    runId: 'r9',
    sessionId: 's',
    task: 't',
    startedAt: 0,
    units: [{ id: 'a' }, { id: 'b', dependsOn: ['a'], reviews: ['a'] }],
  });
  journal.unitFinished('r9', { id: 'a' }, { id: 'a', ok: true, text: 'a' });
  journal.recordQuestion('r9', { from: 'b', to: 'a', question: 'q', ok: true, answer: 'a2' });
  journal.recordReview('r9', { reviewer: 'a', round: 1, verdict: 'reject', objections: [{ unit: 'b', issue: 'x' }] });
  const kinds = new Set(journal.edges('r9').map((edge) => edge.kind));
  for (const kind of ['task', 'dependency', 'question', 'review', 'output']) {
    assert.ok(kinds.has(kind), `the board needs a ${kind} edge`);
  }
  assert.equal(journal.view('s').runs.length, 2, 'the view is bounded too');
});

// ---- sibling questions ------------------------------------------------------

test('a unit can ask a finished sibling and the answer comes from its own route', async () => {
  const profiles = [
    profileOf('p1', 'first', { description: 'coding implementation' }),
    profileOf('p1', 'second', { description: 'data analysis' }),
  ];
  const h = makeEngine({ profiles, answer: (request, index) => (index === 1 ? 'the first answer' : 'the follow-up') });
  try {
    const run = await h.engine.run({
      task: 'Do two things.',
      captain: CAPTAIN,
      units: [
        { id: 'a', capabilityId: 'software.implementation', prompt: 'first' },
        { id: 'b', capabilityId: 'data.analysis', prompt: 'second', dependsOn: ['a'] },
      ],
    });
    // The second unit was told the run id and who is askable.
    const secondPrompt = h.calls[1].request.prompt[0].text;
    assert.match(secondPrompt, new RegExp(`Run id: ${run.runId}`));
    assert.match(secondPrompt, /orchestrate_ask/);
    assert.match(secondPrompt, /- a \(/);

    const answer = await h.engine.ask({
      runId: run.runId,
      from: 'captain',
      to: 'a',
      question: 'what method did you use?',
      captain: CAPTAIN,
      signal: new AbortController().signal,
    });
    assert.equal(answer.ok, true);
    assert.equal(answer.answer, 'the follow-up');
    assert.equal(h.calls.length, 3, 'the question is one more delegation on the sibling route');
    assert.equal(h.calls[2].request.agentOptions.model, 'first');
  } finally {
    h.cleanup();
  }
});

test('an untracked run, an unknown unit, and an exhausted budget are each refused with the roster', async () => {
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation' })];
  const h = makeEngine({ profiles, answer: () => 'ok', preferences: { questions: { maxPerRun: 1, timeoutMs: 60_000 } } });
  try {
    const unknown = await h.engine.ask({ runId: 'nope', to: 'a', question: 'q', captain: CAPTAIN });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /not tracked/);
    assert.deepEqual(unknown.askable, []);

    const run = await h.engine.run({
      task: 'Implement the parser.',
      tier: 'specialist',
      captain: CAPTAIN,
    });

    const missingTarget = await h.engine.ask({
      runId: run.runId,
      to: 'ghost',
      question: 'q',
      captain: CAPTAIN,
    });
    assert.equal(missingTarget.ok, false);
    assert.match(missingTarget.error, /no unit "ghost"/);
    const onlyUnit = run.results[0].id;
    assert.deepEqual(
      missingTarget.askable.map((entry) => entry.id),
      [onlyUnit],
    );

    const first = await h.engine.ask({ runId: run.runId, to: onlyUnit, question: 'q', captain: CAPTAIN });
    assert.equal(first.ok, true);
    const second = await h.engine.ask({ runId: run.runId, to: onlyUnit, question: 'q2', captain: CAPTAIN });
    assert.equal(second.ok, false);
    assert.match(second.error, /budget exhausted/);
  } finally {
    h.cleanup();
  }
});

test('a unit that is still running refuses a question and names who can be asked', async () => {
  const profiles = [profileOf('p1', 'm1', { description: 'coding implementation' })];
  const h = makeEngine({ profiles, answer: () => 'ok' });
  try {
    h.engine.journal.begin({ runId: 'r-live', sessionId: 's', task: 't', startedAt: 0, units: [{ id: 'busy' }, { id: 'done' }] });
    h.engine.journal.unitStarted('r-live', { id: 'busy' });
    h.engine.journal.unitFinished('r-live', { id: 'done' }, { id: 'done', ok: true, text: 'finished' });

    const refused = await h.engine.ask({ runId: 'r-live', to: 'busy', question: 'q', captain: CAPTAIN });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /still running/);
    assert.deepEqual(
      refused.askable.map((entry) => entry.id),
      ['done'],
      'the refusal says who CAN answer',
    );
  } finally {
    h.cleanup();
  }
});

// ---- the review loop --------------------------------------------------------

test('a reviewer runs after what it reviews and receives the complete answers', async () => {
  const profiles = [
    profileOf('p1', 'impl', { description: 'coding implementation' }),
    profileOf('p1', 'critic', { description: 'software review' }),
  ];
  const upstream = `IMPL-${'z'.repeat(2500)}-END`;
  const h = makeEngine({
    profiles,
    answer: (request, index) => (index === 1 ? upstream : '{"verdict":"approve"}'),
  });
  try {
    await h.engine.run({
      task: 'Implement and review.',
      captain: CAPTAIN,
      units: [
        { id: 'impl', capabilityId: 'software.implementation', prompt: 'implement it' },
        { id: 'review', capabilityId: 'software.review', prompt: 'review it', reviews: ['impl'] },
      ],
    });
    assert.equal(h.calls[0].request.agentOptions.model, 'impl', 'the reviewed unit runs first');
    assert.equal(h.calls[1].request.agentOptions.model, 'critic');
    assert.ok(
      h.calls[1].request.prompt[0].text.includes('-END'),
      'the reviewer receives the COMPLETE answer, not a preview',
    );
  } finally {
    h.cleanup();
  }
});

test('a rejection sends the objection back, re-runs the unit, and the reviewer judges again', async () => {
  const profiles = [
    profileOf('p1', 'impl', { description: 'coding implementation' }),
    profileOf('p1', 'critic', { description: 'software review' }),
  ];
  let reviewRounds = 0;
  const h = makeEngine({
    profiles,
    answer: (request) => {
      if (request.agentOptions.model === 'critic') {
        reviewRounds += 1;
        return reviewRounds === 1
          ? '{"verdict":"reject","objections":[{"unit":"impl","issue":"no tests were mentioned"}]}'
          : '{"verdict":"approve"}';
      }
      return 'the implementation';
    },
  });
  try {
    const run = await h.engine.run({
      task: 'Implement and review.',
      captain: CAPTAIN,
      units: [
        { id: 'impl', capabilityId: 'software.implementation', prompt: 'implement it' },
        { id: 'review', capabilityId: 'software.review', prompt: 'review it', reviews: ['impl'] },
      ],
    });
    // 1: impl, 2: reviewer (reject), 3: impl re-run, 4: reviewer again (approve)
    assert.equal(h.calls.length, 4);
    assert.match(h.calls[2].request.prompt[0].text, /no tests were mentioned/, 'the objection is sent back');
    const impl = run.results.find((entry) => entry.id === 'impl');
    assert.equal(impl.reviewRound, 2);
    assert.equal(impl.ok, true);
    const reviews = run.reviews ?? [];
    assert.equal(reviews.length, 2);
    assert.equal(h.engine.journal.get(run.runId).reviews.length, 2);
  } finally {
    h.cleanup();
  }
});

test('an unreadable verdict is recorded as unknown and stops the loop', async () => {
  const profiles = [
    profileOf('p1', 'impl', { description: 'coding implementation' }),
    profileOf('p1', 'critic', { description: 'software review' }),
  ];
  const h = makeEngine({
    profiles,
    answer: (request) => (request.agentOptions.model === 'critic' ? 'I think it is probably fine.' : 'the implementation'),
  });
  try {
    const run = await h.engine.run({
      task: 'Implement and review.',
      captain: CAPTAIN,
      units: [
        { id: 'impl', capabilityId: 'software.implementation', prompt: 'implement it' },
        { id: 'review', capabilityId: 'software.review', prompt: 'review it', reviews: ['impl'] },
      ],
    });
    // Exactly two calls: the reviewer was never re-run, because an unreadable verdict
    // is not approval and nothing was sent back.
    assert.equal(h.calls.length, 2, 'the loop stopped');
    const recorded = h.engine.journal.get(run.runId).reviews;
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].verdict, 'unknown');
    assert.equal(recorded[0].readable, false);
  } finally {
    h.cleanup();
  }
});

test('the review rounds are capped', async () => {
  const profiles = [
    profileOf('p1', 'impl', { description: 'coding implementation' }),
    profileOf('p1', 'critic', { description: 'software review' }),
  ];
  let reviewRounds = 0;
  const h = makeEngine({
    profiles,
    preferences: { review: { maxRounds: 2 } },
    answer: (request) => {
      if (request.agentOptions.model === 'critic') {
        reviewRounds += 1;
        // Always rejects: only the round cap can stop this.
        return '{"verdict":"reject","objections":[{"unit":"impl","issue":"still wrong"}]}';
      }
      return 'the implementation';
    },
  });
  try {
    await h.engine.run({
      task: 'Implement and review.',
      captain: CAPTAIN,
      units: [
        { id: 'impl', capabilityId: 'software.implementation', prompt: 'implement it' },
        { id: 'review', capabilityId: 'software.review', prompt: 'review it', reviews: ['impl'] },
      ],
    });
    assert.equal(reviewRounds, 2, 'the reviewer ran at most maxRounds times');
    assert.equal(h.calls.length, 4);
  } finally {
    h.cleanup();
  }
});

test('a verdict is read from a structured result or from JSON in the text', () => {
  assert.deepEqual(readVerdict({ text: 'no json here' }), {
    readable: false,
    verdict: 'unknown',
    objections: [],
    raw: undefined,
  });
  assert.equal(readVerdict({ text: '{"verdict":"approved"}' }).verdict, 'approve');
  assert.equal(readVerdict({ text: '```json\n{"verdict":"reject","objections":[{"unit":"a","issue":"b"}]}\n```' }).verdict, 'reject');
  const structured = readVerdict({ structured: { verdict: 'reject', objections: [{ unit: 'a', issue: 'b' }] } });
  assert.equal(structured.readable, true);
  assert.deepEqual(structured.objections, [{ unit: 'a', issue: 'b' }]);
  // A recognized verdict word the plugin does not know is not approval.
  assert.equal(readVerdict({ text: '{"verdict":"maybe"}' }).verdict, 'unknown');
});

test('a sub-run started by a descendant session belongs to its ancestor board', () => {
  // A unit that orchestrates its own run is part of the same picture; filtering the
  // journal by the exact session id alone made that run invisible from the session the
  // user is actually looking at.
  const journal = createRunJournal();
  journal.begin({ runId: 'outer', sessionId: 'root', task: 'outer', startedAt: 0, units: [] });
  journal.begin({ runId: 'inner', sessionId: 'child-session', task: 'inner', startedAt: 0, units: [] });
  journal.begin({ runId: 'other', sessionId: 'unrelated', task: 'other', startedAt: 0, units: [] });

  assert.equal(journal.view('root').runs.length, 1, 'the root alone');
  assert.deepEqual(
    journal.view(['root', 'child-session']).runs.map((run) => run.runId),
    ['outer', 'inner'],
    'the root and its descendants',
  );
  assert.equal(journal.view(undefined).runs.length, 3, 'no filter means every run');
  assert.equal(journal.view([]).runs.length, 0);
});
