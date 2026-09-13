/**
 * Decision-authority tests.
 *
 * The principle under test: anything that is a JUDGEMENT about the task belongs to
 * the model reading it, and the plugin's own cue lists are a fallback for when no
 * model supplied one — never an authority that overrules one, and never the only
 * wording that can be understood.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Taxonomy } from '../lib/taxonomy.js';
import { analysisFromModel, analysisFromText, inferComplexity, scoreCapability } from '../lib/matching.js';
import { CUE_GROUPS, defaultCues, describeCues, resolveCues } from '../lib/decision-vocabulary.js';

const taxonomy = () => new Taxonomy();

test("a model's complexity judgement is used as given, never adjusted", async (t) => {
  if (taxonomy() === undefined) return t.skip();
  // Regression: the plugin previously took the MAXIMUM of the claimed and locally
  // observed level, so a model claiming "complex" against a locally observed
  // "specialist" was silently DEMOTED and a model claiming "trivial" was promoted.
  const cases = [
    ['trivial', 'prove the theorem and derive the bound'],
    ['simple', 'prove the theorem and derive the bound'],
    ['specialist', 'rename this variable'],
    ['complex', 'rename this variable'],
  ];
  for (const [claimed, summary] of cases) {
    const analysis = analysisFromModel(taxonomy(), { summary, complexity: claimed });
    assert.equal(analysis.complexity, claimed, `"${claimed}" must survive a contrary local reading`);
  }
});

test('an unrecognized complexity claim falls back to the local reading', () => {
  const analysis = analysisFromModel(taxonomy(), { summary: 'prove the theorem', complexity: 'enormous' });
  assert.ok(['trivial', 'simple', 'specialist', 'complex'].includes(analysis.complexity));
  assert.notEqual(analysis.complexity, 'enormous');
});

test('a model analysis is never reconciled against the cue lists', () => {
  // A task worded with no cue at all still takes the model's judgement; the lists
  // exist for the case where there is no judgement to take.
  const cues = defaultCues();
  const barren = 'qwertyuiop asdfghjkl';
  assert.equal(cues.deep.some((cue) => barren.includes(cue)), false, 'the fixture must contain no cue');

  assert.equal(inferComplexity([], barren), 'simple', 'with no model input the local reading applies');
  assert.equal(
    analysisFromModel(taxonomy(), { summary: barren, complexity: 'complex' }).complexity,
    'complex',
    'with a model input the local reading is not consulted',
  );
});

test('caller-supplied cues replace the built-in fallback outright', () => {
  const supplied = { deep: ['prove by induction'], image: ['扫描件'] };
  const { cues, replaced } = resolveCues(supplied);
  assert.deepEqual(replaced.sort(), ['deep', 'image']);
  assert.deepEqual(cues.deep, ['prove by induction'], 'the list is replaced, not appended to');
  // Untouched groups keep their defaults, so replacing one dimension does not
  // disable the rest.
  assert.deepEqual(cues.routine, defaultCues().routine);
});

test('an empty or malformed cue list cannot disable a dimension', () => {
  const { cues, replaced } = resolveCues({ deep: [], routine: 'not an array', image: [null, '', '  '] });
  assert.deepEqual(replaced, [], 'nothing usable was supplied');
  assert.deepEqual(cues.deep, defaultCues().deep, 'an empty list leaves the fallback in place');
  assert.deepEqual(cues.image, defaultCues().image, 'a list with no usable entry leaves it in place too');
});

test('a task text cue can be understood in wording the author never wrote', () => {
  // The point of making the vocabulary replaceable: judging the task is the
  // model's job, so a model that supplies its own wording is understood, while the
  // built-in list alone would have missed it.
  const t = taxonomy();
  const task = '请对这个论题做出形式化论证并给出界';

  const withBuiltins = analysisFromText(t, task);
  const withSupplied = analysisFromText(t, task, { cues: { deep: ['形式化论证'] } });

  assert.equal(withBuiltins.complexity, 'simple', 'the built-in English list cannot see this wording');
  // The supplied cue is a deep-work cue, which raises the reading; `multiStep` is
  // what would lift it to the top level, so the floor here is "specialist".
  assert.equal(withSupplied.complexity, 'specialist', 'the supplied wording is understood');
});

test('the cue report says whether the vocabulary is built-in or operator-owned', () => {
  assert.equal(describeCues({}).source, 'built-in-fallback');
  assert.deepEqual(describeCues({}).replacedGroups, []);

  const owned = describeCues({ decisionCues: { deep: ['a'], routine: ['b'] } });
  assert.equal(owned.source, 'operator');
  assert.deepEqual(owned.replacedGroups, ['deep', 'routine']);
  // Every group is reported with its size, so the vocabulary is visible rather
  // than implicit.
  assert.deepEqual(
    owned.groups.map((entry) => entry.group),
    [...CUE_GROUPS],
  );
});

test('the fallback lists stay small enough to read as hints, not definitions', () => {
  const cues = defaultCues();
  for (const group of CUE_GROUPS) {
    assert.ok(cues[group].length >= 1, `${group} must have at least one hint`);
    assert.ok(cues[group].length <= 32, `${group} has grown into a dictionary (${cues[group].length} entries)`);
    for (const entry of cues[group]) {
      assert.equal(entry, entry.toLowerCase(), `${group} entries are matched lower-cased`);
      assert.ok(entry.trim().length > 0);
    }
  }
});

test('the cue lists are described as a fallback wherever they are documented', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../lib/decision-vocabulary.js', import.meta.url), 'utf8');
  assert.match(source, /FALLBACK/, 'the module must say so in its own documentation');
  assert.match(source, /as given/, 'and must state that a model analysis is used as given');
});

test('reasoning has three states, and only two of them are capability', () => {
  // A provider may reason WITHOUT exposing a level to pick: the model thinks and the
  // provider drives the depth. Collapsing that into "no reasoning" hard-rejected such
  // a model from every capability that requires reasoning, which is the opposite of
  // what a model that reasons automatically should get.
  const build = (facts) => {
    const profile = { route: 'p/m', facts, derived: { hasReasoning: false } };
    return profile;
  };
  const reasoningSignal = { type: 'reasoning', efforts: [], required: true };
  const descriptor = { id: 'x', signals: [reasoningSignal] };

  const adjustable = scoreCapability(descriptor, build({ efforts: ['low', 'high'], reasoningMode: 'adjustable' }), {});
  assert.equal(adjustable.score, 1, 'an adjustable level satisfies a reasoning requirement');

  const automatic = scoreCapability(descriptor, build({ reasoningMode: 'automatic' }), {});
  assert.equal(automatic.score, 1, 'automatic reasoning satisfies a reasoning requirement');
  assert.match(automatic.matched.join(' '), /reasons automatically/);
  assert.deepEqual(automatic.hardFailures, []);

  const none = scoreCapability(descriptor, build({ reasoningMode: 'none' }), {});
  assert.equal(none.hardFailures.length, 1, 'a model that cannot reason is still refused');
  assert.match(none.hardFailures[0], /no reasoning is reported/);
});

test('a requirement that NAMES levels still needs a selectable one', () => {
  // "must expose high" cannot be satisfied by a provider that will not let anyone
  // pick a level — there is nothing to select.
  const descriptor = { id: 'x', signals: [{ type: 'reasoning', efforts: ['high'], required: true }] };
  const automatic = scoreCapability(
    descriptor,
    { route: 'p/m', facts: { reasoningMode: 'automatic' }, derived: { hasReasoning: false } },
    {},
  );
  assert.equal(automatic.hardFailures.length, 1);
  assert.match(automatic.hardFailures[0], /requested reasoning levels \[high\] is selectable/);

  const hasHigh = scoreCapability(
    descriptor,
    { route: 'p/m', facts: { efforts: ['high'], reasoningMode: 'adjustable' }, derived: { hasReasoning: true } },
    {},
  );
  assert.equal(hasHigh.score, 1);
  assert.deepEqual(hasHigh.hardFailures, []);
});
