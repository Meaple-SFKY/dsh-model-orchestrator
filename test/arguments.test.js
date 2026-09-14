/**
 * Argument-placement tests.
 *
 * These are the rules that decide whether a calling model's intent survives the tool
 * boundary at all. They live in their own module precisely so they can be asserted
 * without a harness installed, because that is where they were wrong twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analysisFromArguments,
  argumentReport,
  FOLDED_ARGUMENTS,
  MISPLACED_ARGUMENTS,
} from '../lib/arguments.js';

const RUN_PARAMETERS = {
  task: undefined,
  analysis: undefined,
  units: undefined,
  chain: undefined,
  budgetMs: undefined,
  tier: undefined,
};

test('a top-level preference is folded into analysis and reported as folded', () => {
  const report = analysisFromArguments(
    {
      task: 'do it',
      unitModelPreference: [{ capability: 'software.review', routes: [{ route: 'p1/m' }] }],
      modelPreference: [{ route: 'p1/m2' }],
    },
    RUN_PARAMETERS,
  );
  assert.equal(report.analysis.unitModelPreference.length, 1);
  assert.equal(report.analysis.modelPreference.length, 1);
  assert.deepEqual(report.foldedIntoAnalysis, FOLDED_ARGUMENTS);
  // Folded is USED: reporting it as unused as well was the contradiction that made
  // the first version of this report untrustworthy.
  assert.deepEqual(report.unusedArguments, []);
});

test('a preference already inside analysis is left alone and not reported', () => {
  const report = analysisFromArguments(
    {
      task: 'do it',
      analysis: { unitModelPreference: [{ capability: 'x', routes: [] }] },
    },
    RUN_PARAMETERS,
  );
  assert.equal(report.foldedIntoAnalysis.length, 0);
  assert.deepEqual(report.unusedArguments, []);
  assert.equal(report.misplacedArguments.length, 0);
});

test('a route placed at the top level is reported WITH the path it belongs at', () => {
  // The reported complaint: the plugin did report the misplacement, but only as a bare
  // name, so the caller had no way to discover where the value belonged.
  const report = analysisFromArguments({ task: 'do it', route: 'p1/model' }, RUN_PARAMETERS);
  assert.deepEqual(report.unusedArguments, ['route']);
  assert.equal(report.misplacedArguments.length, 1);
  assert.equal(report.misplacedArguments[0].argument, 'route');
  assert.match(report.misplacedArguments[0].guidance, /units\[\]\.route/);
  assert.match(report.misplacedArguments[0].guidance, /analysis\.modelPreference/);
});

test('a misspelling is reported as unused without inventing guidance', () => {
  const report = analysisFromArguments(
    { task: 'do it', unitModelPreferences: [{ capability: 'x', routes: [] }] },
    RUN_PARAMETERS,
  );
  assert.deepEqual(report.unusedArguments, ['unitModelPreferences']);
  assert.equal(report.misplacedArguments.length, 1);
  assert.match(report.misplacedArguments[0].guidance, /unitModelPreference/);
});

test('an invented argument is reported and carries no guidance', () => {
  const report = analysisFromArguments({ task: 'do it', wibble: 1 }, RUN_PARAMETERS);
  assert.deepEqual(report.unusedArguments, ['wibble']);
  assert.equal(report.misplacedArguments.length, 0);
});

test('the report omits every empty field rather than emitting empty arrays', () => {
  const clean = argumentReport(analysisFromArguments({ task: 'do it' }, RUN_PARAMETERS));
  assert.deepEqual(clean, {});
});

test('every documented misplacement names a real parameter path', () => {
  for (const [key, guidance] of Object.entries(MISPLACED_ARGUMENTS)) {
    assert.ok(typeof guidance === 'string' && guidance.length > 20, `${key} needs usable guidance`);
    assert.ok(
      guidance.includes('`'),
      `${key} must name the parameter it belongs at, in backticks`,
    );
  }
});
