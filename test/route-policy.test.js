/**
 * Route-policy tests.
 *
 * Discovery reads the LLM registry, which advertises every model every adapter
 * has. A deployment with two providers mounted commonly sees the same underlying
 * model twice, and a provider may advertise more than the user enabled. These
 * tests pin the rules that narrow the pool to what the deployment actually offers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRoutePolicy,
  describePolicy,
  policyConstrains,
  readSubagentRoutePolicy,
} from '../lib/route-policy.js';

const model = (provider, id) => ({ route: `${provider}/${id}`, provider, model: id });

/** A context exposing a route policy or nothing at all. */
function ctxWith(current, { throws = false, absent = false } = {}) {
  return {
    get(name) {
      if (name !== 'subagentModelSelection') return undefined;
      if (absent) return undefined;
      return {
        current() {
          if (throws) throw new Error('settings unavailable');
          return current;
        },
      };
    },
  };
}

test('an enabled policy publishes its exact routes', () => {
  const policy = readSubagentRoutePolicy(
    ctxWith({
      enabled: true,
      allowedModels: [
        { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
        { provider: 'commandcode', model: 'gpt-5.6-sol' },
      ],
    }),
  );
  assert.deepEqual(policy, {
    present: true,
    enabled: true,
    routes: ['commandcode/deepseek/deepseek-v4.1-flash', 'commandcode/gpt-5.6-sol'],
  });
  assert.equal(policyConstrains(policy), true);
});

test('a disabled, empty, or absent policy does not constrain discovery', () => {
  const cases = [
    readSubagentRoutePolicy(ctxWith({ enabled: false, allowedModels: [{ provider: 'p', model: 'm' }] })),
    readSubagentRoutePolicy(ctxWith({ enabled: true, allowedModels: [] })),
    readSubagentRoutePolicy(ctxWith(undefined, { absent: true })),
  ];
  for (const policy of cases) {
    assert.equal(policyConstrains(policy), false, 'a policy with nothing to name must not filter');
  }
  // An absent service still reports honestly that it is absent.
  assert.equal(cases[2].present, false);
  assert.equal(cases[0].present, true);
});

test('a throwing service is reported, not propagated into discovery', () => {
  const policy = readSubagentRoutePolicy(ctxWith({}, { throws: true }));
  assert.equal(policy.present, true);
  assert.equal(policy.enabled, false);
  assert.deepEqual(policy.routes, []);
  assert.equal(policyConstrains(policy), false);
});

test('malformed route entries are dropped rather than becoming a match-anything route', () => {
  const policy = readSubagentRoutePolicy(
    ctxWith({
      enabled: true,
      allowedModels: [
        { provider: 'p1', model: 'm1' },
        { provider: '', model: 'm2' },
        { provider: 'p1' },
        { model: 'm3' },
        null,
        'nonsense',
        { provider: 'p1', model: 'm1' },
      ],
    }),
  );
  assert.deepEqual(policy.routes, ['p1/m1'], 'only complete, unique routes survive');
});

test('the policy filters the pool by exact route', () => {
  const pool = [
    model('deepseek-official', 'deepseek-flash'),
    model('commandcode', 'deepseek/deepseek-v4.1-flash'),
    model('commandcode', 'gpt-5.6-sol'),
  ];
  const result = applyRoutePolicy(pool, {
    policy: { present: true, enabled: true, routes: ['commandcode/deepseek/deepseek-v4.1-flash'] },
  });
  assert.deepEqual(
    result.models.map((entry) => entry.route),
    ['commandcode/deepseek/deepseek-v4.1-flash'],
  );
  assert.equal(result.constrained, true);
  assert.deepEqual(result.droppedByPolicy, ['deepseek-official/deepseek-flash', 'commandcode/gpt-5.6-sol']);
});

test('the same model id under two providers is NOT collapsed without a policy', () => {
  // Two providers may legitimately offer the same model id at different terms, so
  // deduplication by id would be wrong. Only an explicit policy narrows this.
  const pool = [model('provider-a', 'same-id'), model('provider-b', 'same-id')];
  const result = applyRoutePolicy(pool, { policy: { present: false, enabled: false, routes: [] } });
  assert.equal(result.models.length, 2, 'both routes are kept when nothing constrains them');
  assert.equal(result.constrained, false);
});

test("the user's own preferences narrow the pool on top of the policy", () => {
  const pool = [
    model('commandcode', 'a'),
    model('commandcode', 'b'),
    model('commandcode', 'c'),
  ];
  const policy = { present: true, enabled: true, routes: ['commandcode/a', 'commandcode/b', 'commandcode/c'] };

  const denied = applyRoutePolicy(pool, { policy, deniedRoutes: ['commandcode/b'] });
  assert.deepEqual(denied.models.map((entry) => entry.route), ['commandcode/a', 'commandcode/c']);
  assert.deepEqual(denied.droppedByPreference, ['commandcode/b']);

  const allowed = applyRoutePolicy(pool, { policy, allowedRoutes: ['commandcode/c'] });
  assert.deepEqual(allowed.models.map((entry) => entry.route), ['commandcode/c']);

  // Both together: a route must satisfy the policy AND the preferences.
  const both = applyRoutePolicy(pool, {
    policy: { present: true, enabled: true, routes: ['commandcode/a', 'commandcode/b'] },
    allowedRoutes: ['commandcode/b', 'commandcode/c'],
  });
  assert.deepEqual(both.models.map((entry) => entry.route), ['commandcode/b']);
});

test('a malformed pool is tolerated', () => {
  for (const input of [undefined, null, 'nope', 7, [null, {}, { route: '' }]]) {
    const result = applyRoutePolicy(input, { policy: { present: false, enabled: false, routes: [] } });
    assert.deepEqual(result.models, []);
  }
});

test('the report explains what constrained the pool, without inventing a source', () => {
  assert.equal(describePolicy({ present: false, enabled: false, routes: [] }).source, 'none');
  assert.equal(describePolicy({ present: true, enabled: false, routes: ['a/b'] }).source, 'none');
  assert.equal(describePolicy({ present: true, enabled: true, routes: [] }).source, 'none');

  const described = describePolicy({ present: true, enabled: true, routes: ['a/b', 'c/d'] });
  assert.equal(described.source, 'subagent');
  assert.equal(described.count, 2);
  assert.deepEqual(described.routes, ['a/b', 'c/d']);
});

test('no model name, provider, or vendor is hardcoded in the policy logic', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../lib/route-policy.js', import.meta.url), 'utf8'),
  );
  const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const forbidden of ['deepseek', 'gpt-', 'claude', 'gemini', 'commandcode']) {
    assert.ok(
      !code.toLowerCase().includes(forbidden),
      `route-policy.js must not hardcode "${forbidden}" in executable code`,
    );
  }
});
