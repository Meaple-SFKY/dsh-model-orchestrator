/**
 * Reasoning-effort preference tests.
 *
 * A level is only meaningful against the route's own advertised ids, which only
 * the host knows. So a preference is validated twice: when it is set (against the
 * live pool) and when it is used (against the live profile). These tests pin both
 * halves of that, host-free.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { effortPatch, mergeEffortPatch } from '../lib/reasoning-effort.js';

/** A pool stub with the shape `effortPatch` reads. */
const pool = (facts) => ({
  get: (route) => (facts[route] === undefined ? undefined : { route, facts: facts[route] }),
});

test('an advertised level is accepted and an unadvertised one is rejected', () => {
  const live = pool({ 'p1/m1': { efforts: ['low', 'high', 'max'] } });

  const ok = effortPatch({ 'p1/m1': 'high' }, live);
  assert.deepEqual(ok.patch, [{ route: 'p1/m1', effort: 'high' }]);
  assert.deepEqual(ok.rejected, []);

  const bad = effortPatch({ 'p1/m1': 'xhigh' }, live);
  assert.deepEqual(bad.patch, [], 'an unadvertised level must not be stored');
  assert.match(bad.rejected[0], /"xhigh" is not one of low, high, max/);
});

test('a route outside the live pool is rejected rather than stored inert', () => {
  const live = pool({ 'p1/m1': { efforts: ['high'] } });
  const { patch, rejected } = effortPatch({ 'p9/ghost': 'high' }, live);
  assert.deepEqual(patch, []);
  assert.match(rejected[0], /not in the live model pool/);
});

test('a route that reports no reasoning at all cannot be given a level', () => {
  // Distinct from the manual-override case above: there is nothing for a level to
  // mean here, so it is refused at the boundary rather than sent and failed later.
  const live = pool({ 'p1/text-only': { reasoningMode: 'none' } });
  const { patch, rejected } = effortPatch({ 'p1/text-only': 'high' }, live);
  assert.deepEqual(patch, []);
  assert.match(rejected[0], /reports no reasoning, so it cannot be given a level/);
});

test('null and an empty string clear the preference', () => {
  const live = pool({ 'p1/m1': { efforts: ['high'] } });
  const cleared = effortPatch({ 'p1/m1': null, 'p1/m2': '' }, live);
  assert.deepEqual(cleared.patch, [
    { route: 'p1/m1', effort: undefined },
    { route: 'p1/m2', effort: undefined },
  ]);
  assert.deepEqual(cleared.rejected, [], 'clearing needs no live route to be valid');
});

test('a malformed patch is rejected whole rather than half-applied', () => {
  const live = pool({});
  for (const input of ['high', 42, ['high']]) {
    const { patch, rejected } = effortPatch(input, live);
    assert.deepEqual(patch, []);
    assert.match(rejected[0], /expected an object keyed by/);
  }
  assert.deepEqual(effortPatch(undefined, live), { patch: [], rejected: [] });
});

test('merging touches only the routes in the patch', () => {
  const current = { 'p1/a': 'low', 'p1/b': 'high' };
  const next = mergeEffortPatch(current, [
    { route: 'p1/b', effort: 'max' },
    { route: 'p1/c', effort: 'low' },
  ]);
  assert.deepEqual(next, { 'p1/a': 'low', 'p1/b': 'max', 'p1/c': 'low' });
  assert.deepEqual(current, { 'p1/a': 'low', 'p1/b': 'high' }, 'the input must not be mutated');

  const cleared = mergeEffortPatch(next, [{ route: 'p1/a', effort: undefined }]);
  assert.equal('p1/a' in cleared, false, 'a cleared route goes back to the model default');
  assert.deepEqual(mergeEffortPatch(undefined, [{ route: 'p1/a', effort: 'low' }]), { 'p1/a': 'low' });
});

test('a level may be set by hand for a provider that reasons without listing levels', () => {
  // There is nothing to select, so the route is used as-is by default. But an
  // operator who knows their provider accepts an effort can say so — accepted, and
  // MARKED, because nothing can check it and a wrong value fails at dispatch.
  const live = pool({ 'p1/auto': { reasoningMode: 'automatic' }, 'p1/none': { reasoningMode: 'none' } });

  const manual = effortPatch({ 'p1/auto': 'high' }, live);
  assert.deepEqual(manual.patch, [{ route: 'p1/auto', effort: 'high', unverified: true }]);
  assert.deepEqual(manual.rejected, []);

  const impossible = effortPatch({ 'p1/none': 'high' }, live);
  assert.deepEqual(impossible.patch, []);
  assert.match(impossible.rejected[0], /reports no reasoning, so it cannot be given a level/);

  // And a route that DOES list levels keeps the strict rule: an unlisted one is a
  // mistake, not a decision.
  const listed = pool({ 'p1/listed': { efforts: ['low', 'high'], reasoningMode: 'adjustable' } });
  const wrong = effortPatch({ 'p1/listed': 'max' }, listed);
  assert.deepEqual(wrong.patch, []);
  assert.match(wrong.rejected[0], /not one of low, high/);
});
