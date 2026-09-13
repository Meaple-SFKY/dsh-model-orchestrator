/**
 * Value-projection tests.
 *
 * The host validates a tool's canonical output with a strict lossless-JSON
 * check that rejects an explicitly-`undefined` property. `JSON.stringify` hides
 * that difference, so these assertions inspect the projected structure directly
 * rather than its serialization — which is exactly how the defect escaped a
 * round-trip check during development.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toJsonSafe, uint, tokenize, routeKey, compactRoute, truncate, contentToText, uniqueStrings, delegationLabel, DELEGATION_LABEL_MARKER } from '../lib/util.js';

test('an explicitly-undefined property is dropped, not carried', () => {
  const projected = toJsonSafe({ ok: true, storage: { path: '/tmp/x', lastError: undefined } });
  assert.equal(
    Object.prototype.hasOwnProperty.call(projected.storage, 'lastError'),
    false,
    'a property present as `undefined` must be absent after projection',
  );
  assert.deepEqual(projected, { ok: true, storage: { path: '/tmp/x' } });
});

test('undefined and functions become null inside arrays', () => {
  const projected = toJsonSafe([1, undefined, () => {}, 'x']);
  assert.deepEqual(projected, [1, null, null, 'x']);
});

test('non-finite numbers are normalized to null', () => {
  assert.deepEqual(toJsonSafe({ a: NaN, b: Infinity, c: -Infinity, d: 1.5 }), {
    a: null,
    b: null,
    c: null,
    d: 1.5,
  });
});

test('nested structures are projected recursively', () => {
  const projected = toJsonSafe({
    runs: [{ id: 'a', note: undefined }],
    meta: { deep: { value: undefined, keep: 1 } },
  });
  assert.deepEqual(projected, { runs: [{ id: 'a' }], meta: { deep: { keep: 1 } } });
});

test('a cycle is broken rather than hanging', () => {
  const value = { name: 'root' };
  value.self = value;
  const projected = toJsonSafe(value);
  assert.equal(projected.name, 'root');
  assert.equal(Object.prototype.hasOwnProperty.call(projected, 'self'), false);
});

test('a date is projected to its ISO string', () => {
  const projected = toJsonSafe({ at: new Date('2026-01-02T03:04:05.000Z') });
  assert.equal(projected.at, '2026-01-02T03:04:05.000Z');
});

test('plain data passes through unchanged', () => {
  const value = { a: 1, b: 'two', c: true, d: null, e: [1, 2], f: { g: 'h' } };
  assert.deepEqual(toJsonSafe(value), value);
});

test('uint accepts zero and rejects negatives', () => {
  assert.equal(uint(0), 0, 'zero is a valid non-negative integer');
  assert.equal(uint(5), 5);
  assert.equal(uint(-1), undefined);
  assert.equal(uint(1.5), undefined);
  assert.equal(uint('5'), undefined);
});

test('tokenize handles latin words, digits, and CJK runs', () => {
  assert.deepEqual(tokenize('Implement the Parser'), ['implement', 'the', 'parser']);
  assert.deepEqual(tokenize('a b'), [], 'single characters are not useful tokens');
  const cjk = tokenize('数据分析');
  assert.ok(cjk.includes('数') && cjk.includes('据'), `expected CJK runes, got ${cjk.join(',')}`);
});

test('routeKey and compactRoute handle the provider/model split', () => {
  assert.equal(routeKey('p1', 'm1'), 'p1/m1');
  assert.equal(routeKey('p1', ''), undefined);
  assert.equal(routeKey(undefined, 'm1'), undefined);
  assert.equal(compactRoute('provider/model'), 'model');
  assert.equal(compactRoute('vendor/group/model'), 'group/model');
  assert.equal(compactRoute('bare'), 'bare');
});

test('uniqueStrings preserves first-seen order', () => {
  assert.deepEqual(uniqueStrings(['b', 'a', 'b', '', undefined, 'a', 'c']), ['b', 'a', 'c']);
});

test('truncate and contentToText behave at the boundaries', () => {
  assert.equal(truncate('abcdef', 10), 'abcdef');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'b' }, { type: 'text', text: 'c' }]), 'a\nc');
  assert.equal(contentToText(undefined), '');
});

test('a delegation label always carries its route, even when the name is long', () => {
  // The label is the ONLY durable record of a child's route: the host's
  // descendant listing reports `mode` and `label` and nothing about the model.
  // So the route has to survive the tail truncation the spawn path applies.
  const label = delegationLabel('Data visualization', 'commandcode/gpt-5.6-sol');
  assert.equal(label, `Data visualization${DELEGATION_LABEL_MARKER}commandcode/gpt-5.6-sol`);
  assert.ok(label.endsWith(`${DELEGATION_LABEL_MARKER}commandcode/gpt-5.6-sol`));

  const long = delegationLabel('x'.repeat(400), 'p1/m1');
  assert.ok(long.endsWith(`${DELEGATION_LABEL_MARKER}p1/m1`), 'the route must not be truncated away');
  assert.ok(long.length <= 120, `the label must fit the spawn limit, got ${long.length}`);

  // A name that is absent must still yield a parseable label, and must not
  // repeat the route as both name and route.
  const unnamed = delegationLabel(undefined, 'p1/m1');
  assert.equal(unnamed, `m1${DELEGATION_LABEL_MARKER}p1/m1`);

  // The parse the client board performs must recover exactly what was written.
  const marker = label.lastIndexOf(DELEGATION_LABEL_MARKER);
  assert.equal(label.slice(0, marker), 'Data visualization');
  assert.equal(label.slice(marker + DELEGATION_LABEL_MARKER.length), 'commandcode/gpt-5.6-sol');
});

test('a delegation label keeps its route even when the route is very long', () => {
  // The route used to be appended unbounded, so a route near the limit left no room
  // for the name, the composed label exceeded the limit, and the spawn path's own
  // truncation cut the tail — destroying the one fact the label exists to carry.
  const route = `provider/${'x'.repeat(200)}`;
  const label = delegationLabel('Data visualization', route);
  assert.ok(label.length <= 120, `label must fit the limit, got ${label.length}`);
  assert.ok(label.includes(DELEGATION_LABEL_MARKER), 'the marker must survive');
  const suffix = label.slice(label.lastIndexOf(DELEGATION_LABEL_MARKER) + DELEGATION_LABEL_MARKER.length);
  // The route is bounded with a reserve for the marker and a readable name, so what
  // follows the marker is the truncated route — and it is still the ROUTE, which is
  // the point: a prefix of the real route beats a label that lost it entirely.
  assert.equal(suffix, truncate(route, 100), 'the route is what follows the marker, bounded');
  assert.ok(suffix.length > 8, 'and enough of it to identify the route');
});
