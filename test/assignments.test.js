/**
 * Capability-assignment tests.
 *
 * The table is the user's standing division of labour, and the pool it resolves
 * against churns underneath it. These tests pin both halves: that a resolved entry
 * supplies the preference order, and that everything which stops resolving is
 * reported rather than dropped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Taxonomy } from '../lib/taxonomy.js';
import {
  assignmentPatch,
  mergeAssignmentPatch,
  normalizeAssignments,
  preferenceFor,
  preferenceSignature,
  resolveAssignments,
} from '../lib/assignments.js';

const POOL = [
  { route: 'commandcode/google/gemini-3.8-flash', model: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash (CC)' },
  { route: 'commandcode/Qwen/Qwen3.8-Max-0902', model: 'Qwen/Qwen3.8-Max-0902', name: 'Qwen 3.8 Max 0902 (CC)' },
  { route: 'commandcode/deepseek/deepseek-v4.1-flash', model: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (CC)' },
  { route: 'commandcode/gpt-5.6-sol', model: 'gpt-5.6-sol', name: 'GPT-5.6 Sol (CC)' },
];

test('shorthand and full entries normalise to the same shape', () => {
  const normalized = normalizeAssignments({
    'multimodal.vision': 'gemini-3.8-flash',
    'reasoning.mathematics': ['Qwen 3.8 Max 0902'],
    'software.architecture': { models: ['gpt-5.6-sol'], family: true },
    'software.implementation': { models: [] },
    '': 'nonsense',
  });
  assert.deepEqual(normalized, {
    'multimodal.vision': { models: ['gemini-3.8-flash'], family: false },
    'reasoning.mathematics': { models: ['Qwen 3.8 Max 0902'], family: false },
    'software.architecture': { models: ['gpt-5.6-sol'], family: true },
  });
  assert.deepEqual(normalizeAssignments(undefined), {});
  assert.deepEqual(normalizeAssignments({ a: [42, 7] }), {}, 'non-strings are not targets');
});

test('an entry resolves through identity, not through a stored route', () => {
  const report = resolveAssignments(
    { 'multimodal.vision': 'gemini-3.8-flash', 'reasoning.mathematics': 'Qwen 3.8 Max 0902' },
    POOL,
  );
  assert.equal(report.count, 2);
  assert.deepEqual(preferenceFor(report, { capability: 'multimodal.vision' }), [
    'commandcode/google/gemini-3.8-flash',
  ]);
  assert.deepEqual(preferenceFor(report, { capability: 'reasoning.mathematics' }), [
    'commandcode/Qwen/Qwen3.8-Max-0902',
  ]);
  assert.deepEqual(report.unresolved, []);
  // Every pool route no entry mentions.
  assert.deepEqual(report.unassigned, [
    'commandcode/deepseek/deepseek-v4.1-flash',
    'commandcode/gpt-5.6-sol',
  ]);
});

test('the live pool moving under the table does not break it', () => {
  // Same model, new provider, new id spelling, bumped version — the three things
  // that happen to a pool. Only the last needs the family rung.
  const moved = [{ route: 'otherai/gemini-3.8-flash', model: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }];
  const byIdentity = resolveAssignments({ 'multimodal.vision': 'gemini-3.8-flash' }, moved);
  assert.deepEqual(preferenceFor(byIdentity, { capability: 'multimodal.vision' }), [
    'otherai/gemini-3.8-flash',
  ]);

  const bumped = [{ route: 'commandcode/gemini-3.9-flash', model: 'gemini-3.9-flash', name: 'Gemini 3.9 Flash' }];
  const notFollowed = resolveAssignments({ 'multimodal.vision': 'gemini-3.8-flash' }, bumped);
  assert.deepEqual(preferenceFor(notFollowed, { capability: 'multimodal.vision' }), undefined);
  assert.deepEqual(notFollowed.unresolved, [{ key: 'multimodal.vision', target: 'gemini-3.8-flash' }]);

  const followed = resolveAssignments({ 'multimodal.vision': { models: ['gemini-3.8-flash'], family: true } }, bumped);
  assert.deepEqual(preferenceFor(followed, { capability: 'multimodal.vision' }), [
    'commandcode/gemini-3.9-flash',
  ]);
});

test('a group entry applies where a capability entry does not', () => {
  const report = resolveAssignments(
    { software: 'deepseek-v4.1-flash', 'software.architecture': 'gpt-5.6-sol' },
    POOL,
  );
  assert.deepEqual(preferenceFor(report, { capability: 'software.architecture', group: 'software' }), [
    'commandcode/gpt-5.6-sol',
  ]);
  assert.deepEqual(preferenceFor(report, { capability: 'software.implementation', group: 'software' }), [
    'commandcode/deepseek/deepseek-v4.1-flash',
  ]);
});

test('an entry that resolves to nothing does not shadow the group entry', () => {
  // A stale specific entry must fall through, not veto: the group entry is the
  // user's less specific but still valid intent.
  const report = resolveAssignments(
    { software: 'deepseek-v4.1-flash', 'software.architecture': 'claude-opus-9' },
    POOL,
  );
  assert.deepEqual(preferenceFor(report, { capability: 'software.architecture', group: 'software' }), [
    'commandcode/deepseek/deepseek-v4.1-flash',
  ]);
  assert.deepEqual(report.unresolved, [{ key: 'software.architecture', target: 'claude-opus-9' }]);
});

test('the signature separates capabilities that must not share a unit', () => {
  // The split rule: same cluster, different preference -> different unit. Without
  // it, "architecture to GPT, implementation to DeepSeek" merges back into one
  // delegation on one model.
  const report = resolveAssignments(
    { 'software.architecture': 'gpt-5.6-sol', 'software.implementation': 'deepseek-v4.1-flash' },
    POOL,
  );
  const architecture = preferenceSignature(report, {
    capability: 'software.architecture',
    group: 'software',
  });
  const implementation = preferenceSignature(report, {
    capability: 'software.implementation',
    group: 'software',
  });
  assert.notEqual(architecture, implementation);

  const same = resolveAssignments({ software: 'deepseek-v4.1-flash' }, POOL);
  assert.equal(
    preferenceSignature(same, { capability: 'software.architecture', group: 'software' }),
    preferenceSignature(same, { capability: 'software.implementation', group: 'software' }),
    'one group entry keeps the cluster together',
  );
  assert.equal(
    preferenceSignature(resolveAssignments({}, POOL), { capability: 'anything', group: 'g' }),
    '',
    'no entry means no signature, so unassigned capabilities stay merged',
  );
});

test('a patch validates shape strictly and absence leniently', () => {
  const taxonomy = new Taxonomy();
  const { patch, rejected, resolved, unresolved } = assignmentPatch(
    {
      'multimodal.vision': 'gemini-3.8-flash',        // resolves
      software: ['deepseek-v4.1-flash'],              // group key, resolves
      'software.review': 'claude-opus-9',             // absent from the pool: legal
      'not.a.capability': 'gemini-3.8-flash',         // unknown key: refused
      'multimodal.screenshot': 42,                    // malformed: refused
    },
    { taxonomy, models: POOL },
  );

  assert.deepEqual(Object.keys(patch).sort(), ['multimodal.vision', 'software', 'software.review']);
  assert.deepEqual(rejected, [
    'capabilityAssignments.not.a.capability: unknown capability or group',
    'capabilityAssignments.multimodal.screenshot: expected a model target or a list of them',
  ]);
  assert.equal(resolved.length, 2, 'what resolved now is reported');
  assert.deepEqual(unresolved, [{ key: 'software.review', target: 'claude-opus-9' }]);
});

test('null clears one entry and merging leaves the others alone', () => {
  const taxonomy = new Taxonomy();
  const clear = assignmentPatch({ 'multimodal.vision': null }, { taxonomy, models: POOL });
  assert.deepEqual(clear.patch, { 'multimodal.vision': null });

  const current = { 'multimodal.vision': { models: ['gemini-3.8-flash'], family: false }, software: { models: ['x'], family: true } };
  const merged = mergeAssignmentPatch(current, clear.patch);
  assert.deepEqual(Object.keys(merged), ['software']);
  const appended = mergeAssignmentPatch(current, { 'multimodal.vision': { models: ['grok-4.6'], family: true } });
  assert.deepEqual(appended['multimodal.vision'], { models: ['grok-4.6'], family: true });
  assert.deepEqual(current['multimodal.vision'].models, ['gemini-3.8-flash'], 'the input must not be mutated');
});

test('an absent patch is a no-op rather than an error', () => {
  const { patch, rejected } = assignmentPatch(undefined, { taxonomy: new Taxonomy(), models: POOL });
  assert.deepEqual(patch, {});
  assert.deepEqual(rejected, []);
});
