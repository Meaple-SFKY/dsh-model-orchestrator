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

test('ModelPool narrows its discovery to the deployment policy end to end', async () => {
  // The reported symptom: two providers advertise overlapping model families, so
  // the panel showed near-duplicates. Here the policy is what should decide.
  const { ModelPool } = await import('../lib/discovery.js');

  const advertised = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'];
  const ctx = {
    get(name) {
      if (name !== 'llm' && name !== 'subagentModelSelection') return undefined;
      if (name === 'subagentModelSelection') {
        return {
          current: () => ({
            enabled: true,
            allowedModels: [{ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }],
          }),
        };
      }
      return {
        listProviders: () => [
          { id: 'deepseek-official', name: 'Official' },
          { id: 'commandcode', name: 'Command Code' },
        ],
        listModels: async (provider) =>
          provider === 'deepseek-official'
            ? advertised.map((id) => ({ provider, id, name: id, inputModalities: ['text'] }))
            : [{ provider, id: 'deepseek/deepseek-v4.1-flash', name: 'V4.1', inputModalities: ['text'] }],
        resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
      };
    },
  };

  const pool = new ModelPool();
  const before = await pool.refresh(ctx, {});
  assert.equal(before.models.length, 4, 'the registry advertises four routes');

  // With the policy in force, only the selectable route survives.
  assert.deepEqual(pool.models().map((entry) => entry.route), [
    'commandcode/deepseek/deepseek-v4.1-flash',
  ]);
  const report = pool.filterReport();
  assert.equal(report.constrained, true);
  assert.equal(report.policy.source, 'subagent');
  assert.deepEqual(report.droppedByPolicy.sort(), [
    'deepseek-official/deepseek-flash',
    'deepseek-official/deepseek-v4-flash',
    'deepseek-official/deepseek-v4-pro',
  ]);
});

test('a deployment with no policy keeps every advertised route', async () => {
  const { ModelPool } = await import('../lib/discovery.js');
  const ctx = {
    get(name) {
      if (name !== 'llm') return undefined;
      return {
        listProviders: () => [{ id: 'p1', name: 'P1' }],
        listModels: async (provider) => [
          { provider, id: 'a', name: 'A', inputModalities: ['text'] },
          { provider, id: 'b', name: 'B', inputModalities: ['text'] },
        ],
        resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
      };
    },
  };
  const pool = new ModelPool();
  await pool.refresh(ctx, {});
  assert.equal(pool.models().length, 2, 'nothing may filter the pool without a policy');
  assert.equal(pool.filterReport().constrained, false);
});

test('a policy that matches nothing is reported as a problem, not an empty pool', async () => {
  const { ModelPool } = await import('../lib/discovery.js');
  const ctx = {
    get(name) {
      if (name === 'subagentModelSelection') {
        return { current: () => ({ enabled: true, allowedModels: [{ provider: 'other', model: 'x' }] }) };
      }
      if (name !== 'llm') return undefined;
      return {
        listProviders: () => [{ id: 'p1', name: 'P1' }],
        listModels: async (provider) => [{ provider, id: 'a', name: 'A', inputModalities: ['text'] }],
        resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
      };
    },
  };
  const pool = new ModelPool();
  await pool.refresh(ctx, {});
  assert.equal(pool.models().length, 0);
  assert.ok(
    pool.problems().some((line) => /policy matched none/.test(line)),
    'the mismatch must be explained rather than looking like an empty deployment',
  );
});
