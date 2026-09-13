/**
 * Model-identity tests.
 *
 * The pool churns; an assignment must not. These tests use the real rows this
 * deployment advertises, because the interesting cases are the ones the actual
 * ids create — a vendor path segment the declared name does not repeat, and a
 * version number that moves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateFamilies,
  candidateKeys,
  familyKey,
  identityKey,
  resolveAssignment,
  resolveAssignments,
} from '../lib/model-identity.js';

/** The live pool of the deployment this was built against. */
const POOL = [
  { route: 'commandcode/deepseek/deepseek-v4.1-flash', model: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (CC)' },
  { route: 'commandcode/google/gemini-3.8-flash', model: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash (CC)' },
  { route: 'commandcode/gpt-5.6-sol', model: 'gpt-5.6-sol', name: 'GPT-5.6 Sol (CC)' },
  { route: 'commandcode/moonshotai/Kimi-K3', model: 'moonshotai/Kimi-K3', name: 'Kimi K3 (CC)' },
  { route: 'commandcode/Qwen/Qwen3.8-Max-0902', model: 'Qwen/Qwen3.8-Max-0902', name: 'Qwen 3.8 Max 0902 (CC)' },
  { route: 'commandcode/xai/grok-4.6', model: 'xai/grok-4.6', name: 'Grok 4.6 (CC)' },
  { route: 'commandcode/z-ai/glm-5.3-flash', model: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash (CC)' },
];

test('the same model collapses to one key however it is spelled', () => {
  const spellings = ['gpt5.6sol', 'GPT 5.6 Sol', 'gpt-5.6-sol', 'GPT-5.6 Sol (CC)', 'gpt_5_6_SOL'];
  const keys = new Set(spellings.map(identityKey));
  assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(', ')}`);
  assert.equal([...keys][0], 'gpt56sol');

  // A provider-qualified route is NOT the same key: an identity is
  // provider-agnostic on purpose, and the bridge between the two spellings is
  // `candidateKeys`, which is what resolution actually uses.
  assert.equal(identityKey('commandcode/gpt-5.6-sol'), 'commandcodegpt56sol');
  assert.ok(
    candidateKeys(POOL[2]).includes(identityKey('commandcode/gpt-5.6-sol')),
    'the route spelling must still be one of the route keys',
  );
});

test('a route answers to keys from its id AND its declared name', () => {
  // The live ids repeat a vendor segment their names do not, so keying only the
  // whole id fails to connect `deepseek/deepseek-v4.1-flash` (key
  // `deepseekdeepseekv41flash`) with `DeepSeek V4.1 Flash (CC)`
  // (`deepseekv41flash`). Both spellings must find the route.
  for (const model of POOL) {
    const keys = candidateKeys(model);
    assert.ok(
      keys.includes(identityKey(model.name)),
      `${model.route}: the declared name must be a candidate key (got ${keys.join(', ')})`,
    );
    for (const spelling of [model.model, model.route, model.name]) {
      assert.ok(
        keys.includes(identityKey(spelling)),
        `${model.route}: ${JSON.stringify(spelling)} must be a candidate key`,
      );
    }
  }
});

test('an assignment written as a bare model name finds the live route', () => {
  // What a person types when filling in the table.
  const cases = [
    ['deepseek-v4.1-flash', 'commandcode/deepseek/deepseek-v4.1-flash'],
    ['Gemini 3.8 Flash', 'commandcode/google/gemini-3.8-flash'],
    ['grok-4.6', 'commandcode/xai/grok-4.6'],
    ['Kimi K3', 'commandcode/moonshotai/Kimi-K3'],
    ['Qwen 3.8 Max 0902', 'commandcode/Qwen/Qwen3.8-Max-0902'],
    ['GLM-5.3 Flash', 'commandcode/z-ai/glm-5.3-flash'],
  ];
  for (const [spelling, route] of cases) {
    const match = resolveAssignment(spelling, POOL);
    assert.ok(match !== undefined, `${spelling} must resolve`);
    assert.deepEqual(match.routes, [route], `${spelling} must resolve to ${route}`);
    assert.equal(match.kind, 'identity', `${spelling} must resolve by identity`);
  }
});

test('a truncated spelling is reported unresolved rather than guessed at', () => {
  // `Qwen3.8-Max` is what a person writes for `Qwen/Qwen3.8-Max-0902`, and the
  // trailing date is exactly the part they drop. Matching it would need fuzzy or
  // prefix rules, which is how `gpt-5.6-sol` starts matching
  // `gpt-5.6-sol-vision` — a wrong model routed to silently, which is worse than
  // a target that reports itself unresolved. This is the argument for the panel
  // offering a picker over the live pool instead of a free-text box.
  assert.equal(resolveAssignment('Qwen3.8-Max', POOL), undefined);
  assert.deepEqual(resolveAssignments(['Qwen3.8-Max'], POOL).unresolved, ['Qwen3.8-Max']);
});

test('an exact route wins over an identity, and both are reported', () => {
  const exact = resolveAssignment('commandcode/gpt-5.6-sol', POOL);
  assert.equal(exact.kind, 'route');

  const byName = resolveAssignment('GPT-5.6 Sol', POOL);
  assert.equal(byName.kind, 'identity');
  assert.deepEqual(byName.routes, ['commandcode/gpt-5.6-sol']);
});

test('one identity behind two providers keeps both routes', () => {
  const two = [
    ...POOL,
    { route: 'otherai/gpt-5.6-sol', model: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' },
  ];
  const match = resolveAssignment('gpt-5.6-sol', two);
  assert.equal(match.kind, 'identity');
  assert.deepEqual(match.routes, ['commandcode/gpt-5.6-sol', 'otherai/gpt-5.6-sol']);
});

test('the family rung follows a version bump, but only when asked for', () => {
  assert.equal(familyKey('gpt-5.6-sol'), familyKey('gpt-5.7-sol'));
  assert.equal(familyKey('gpt-5.6-sol'), 'gptsol');
  assert.notEqual(familyKey('gpt-5.6-sol'), familyKey('gpt-4o'));

  const bumped = [
    { route: 'commandcode/gpt-5.7-sol', model: 'gpt-5.7-sol', name: 'GPT-5.7 Sol (CC)' },
  ];
  assert.equal(
    resolveAssignment('gpt-5.6-sol', bumped),
    undefined,
    'a different version is not an identity match',
  );
  const followed = resolveAssignment('gpt-5.6-sol', bumped, { family: true });
  assert.equal(followed.kind, 'family');
  assert.deepEqual(followed.routes, ['commandcode/gpt-5.7-sol']);
});

test('a family that is not in the pool stays unresolved rather than guessing', () => {
  const only = [{ route: 'commandcode/gpt-5.7-sol', model: 'gpt-5.7-sol', name: 'GPT-5.7 Sol' }];
  assert.equal(resolveAssignment('claude-opus-9', only, { family: true }), undefined);
  assert.equal(resolveAssignment('', only), undefined);
  assert.equal(resolveAssignment('   ', only), undefined);
});

test('candidate families are derived from every candidate key', () => {
  const gemini = POOL[1];
  assert.ok(candidateFamilies(gemini).includes('geminiflash'));
});

test('an ordered assignment list becomes an ordered preference and a report', () => {
  const result = resolveAssignments(
    [
      'GPT-5.6 Sol',            // architecture, say
      'deepseek-v4.1-flash',    // engineering
      'grok-4.6',               // web
      'claude-opus-9',          // not in this pool
      'deepseek-v4.1-flash',    // repeated: must not duplicate the route
    ],
    POOL,
  );
  assert.deepEqual(result.routes, [
    'commandcode/gpt-5.6-sol',
    'commandcode/deepseek/deepseek-v4.1-flash',
    'commandcode/xai/grok-4.6',
  ]);
  assert.deepEqual(result.unresolved, ['claude-opus-9'], 'a missing model must be reported');
  assert.deepEqual(result.resolved.map((entry) => entry.target), [
    'GPT-5.6 Sol',
    'deepseek-v4.1-flash',
    'grok-4.6',
    'deepseek-v4.1-flash',
  ]);
});
