/**
 * Control-route tests.
 *
 * The browser panel depends on these routes, so their mounting, their security
 * fence, and their request validation are all observable contracts. The module is
 * deliberately free of host imports so it can be exercised directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROUTE_PREFIX, installControlRoutesDeferred } from '../lib/routes.js';
import { exchange, fakeContext, fakeServer } from './helpers/fake-context.js';
import { OrchestratorStore } from '../lib/persistence.js';
import { ModelPool } from '../lib/discovery.js';
import { Taxonomy } from '../lib/taxonomy.js';

/** Minimal engine/pool/taxonomy/store bundle the routes read. */
function deps() {
  const directory = mkdtempSync(join(tmpdir(), 'orch-routes-'));
  const store = new OrchestratorStore(directory);
  const pool = new ModelPool();
  Object.defineProperty(pool, 'models', { value: () => [], configurable: true });
  Object.defineProperty(pool, 'providers', { value: () => [], configurable: true });
  Object.defineProperty(pool, 'discoveredAt', { value: () => Date.now(), configurable: true });
  Object.defineProperty(pool, 'problems', { value: () => [], configurable: true });
  Object.defineProperty(pool, 'refresh', { value: async () => ({ models: [] }), configurable: true });
  return {
    engine: {
      refresh: async () => ({ models: [] }),
      plan: async () => ({ tier: 'direct', units: [] }),
      inFlightCount: 0,
    },
    pool,
    taxonomy: new Taxonomy(),
    store,
    logger: undefined,
    host: { name: 'dsh-model-orchestrator', version: '0.1.0', range: '0.1.5-rc.1', runningVersion: '0.1.5-rc.1', optionalMissing: [] },
    subagents: undefined,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('the routes mount on the fast path when a web server already exists', () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    const dispose = installControlRoutesDeferred(ctx, d);
    assert.deepEqual(
      [...server.routes.keys()].sort(),
      [
        `${ROUTE_PREFIX}/configure`,
        `${ROUTE_PREFIX}/plan`,
        `${ROUTE_PREFIX}/state`,
        `${ROUTE_PREFIX}/sync`,
        `${ROUTE_PREFIX}/tree`,
      ],
    );
    dispose();
    assert.equal(server.disposed.length, 5, 'every route must have a disposer');
  } finally {
    d.cleanup();
  }
});

test('the routes wait for the web server when it is not mounted yet', () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx, injections } = fakeContext(server, { injectable: false });
    // No web server yet: the fast path must not be taken.
    const isolated = {
      get: (name) => (name === 'webServer' ? undefined : ctx.get(name)),
      inject: ctx.inject,
    };
    const dispose = installControlRoutesDeferred(isolated, d);
    assert.deepEqual(server.routes.size, 0, 'nothing may mount before the service exists');
    assert.deepEqual(injections, [['webServer']], 'the installer must wait on webServer');
    dispose();
  } finally {
    d.cleanup();
  }
});

test('a profile with no web server mounts nothing and does not throw', () => {
  const d = deps();
  try {
    const ctx = { get: () => undefined, inject: () => () => {} };
    const dispose = installControlRoutesDeferred(ctx, d);
    assert.equal(typeof dispose, 'function');
    dispose();
  } finally {
    d.cleanup();
  }
});

test('every route is fenced to same-origin loopback requests', async () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);

    // A foreign Host is refused.
    for (const name of ['state', 'configure', 'plan']) {
      const route = server.routes.get(`${ROUTE_PREFIX}/${name}`);
      const foreign = exchange({ method: name === 'state' ? 'GET' : 'POST', headers: { host: 'evil.example' } });
      await route.handler(foreign.req, foreign.res);
      assert.equal(foreign.captured.status, 403, `${name} must refuse a foreign Host`);
    }

    // A cross-origin page is refused even over loopback.
    const crossOrigin = exchange({ headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' } });
    await server.routes.get(`${ROUTE_PREFIX}/state`).handler(crossOrigin.req, crossOrigin.res);
    assert.equal(crossOrigin.captured.status, 403);

    // A loopback host with no Origin is admitted.
    const ok = exchange();
    await server.routes.get(`${ROUTE_PREFIX}/state`).handler(ok.req, ok.res);
    assert.equal(ok.captured.status, 200);
    assert.equal(ok.captured.body.ok, true);

    // A missing Host fails closed.
    const noHost = exchange({ headers: {} });
    await server.routes.get(`${ROUTE_PREFIX}/state`).handler(noHost.req, noHost.res);
    assert.equal(noHost.captured.status, 403);
  } finally {
    d.cleanup();
  }
});

test('the harness connection overlay is preferred when present', async () => {
  const d = deps();
  try {
    const server = fakeServer();
    const gate = { requestRejection: () => 401 };
    // `connection` is an optional overlay, so it arrives as a service rather than
    // through the plugin's own inject list.
    const { ctx } = fakeContext(server, { services: { connection: gate } });
    installControlRoutesDeferred(ctx, d);
    // A request that would pass the loopback fence is still rejected by the gate.
    const rejected = exchange();
    await server.routes.get(`${ROUTE_PREFIX}/state`).handler(rejected.req, rejected.res);
    assert.equal(rejected.captured.status, 401);
  } finally {
    d.cleanup();
  }
});

test('the state route rejects a non-GET method', async () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const bad = exchange({ method: 'POST' });
    await server.routes.get(`${ROUTE_PREFIX}/state`).handler(bad.req, bad.res);
    assert.equal(bad.captured.status, 405);
    assert.match(bad.captured.headers.allow, /GET/);
  } finally {
    d.cleanup();
  }
});

test('the configure route applies a valid patch and reports unknown capabilities', async () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/configure`);

    const applied = exchange({
      method: 'POST',
      body: { mode: 'guided', maxParallel: 2, preferCheaper: false, captainMode: 'spawned' },
    });
    await route.handler(applied.req, applied.res);
    assert.equal(applied.captured.status, 200);
    assert.deepEqual(applied.captured.body.applied.sort(), ['captainMode', 'maxParallel', 'mode', 'preferCheaper']);

    const state = d.store.snapshot();
    assert.equal(state.mode, 'guided');
    assert.equal(state.preferences.maxParallel, 2);
    assert.equal(state.preferences.preferCheaper, false);
    assert.equal(state.preferences.captainMode, 'spawned');
  } finally {
    d.cleanup();
  }
});

test('the configure route rejects malformed values instead of coercing them', async () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/configure`);

    const rejected = exchange({
      method: 'POST',
      body: { mode: 'nonsense', preferCheaper: 'yes', maxParallel: 'many', deniedRoutes: 7 },
    });
    await route.handler(rejected.req, rejected.res);
    assert.equal(rejected.captured.status, 200);
    assert.ok(rejected.captured.body.rejected.length >= 3, 'each bad field must be reported');
    // Nothing invalid was applied.
    const state = d.store.snapshot();
    assert.equal(state.mode, 'auto');
  } finally {
    d.cleanup();
  }
});

test('the configure route rejects an oversized body', async () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/configure`);

    const huge = exchange({ method: 'POST' });
    huge.req.on = (event, handler) => {
      if (event === 'data') handler(Buffer.alloc(70 * 1024));
      if (event === 'end') handler();
      return huge.req;
    };
    await route.handler(huge.req, huge.res);
    assert.equal(huge.captured.status, 400);
    assert.match(String(huge.captured.body.error), /too large/);
  } finally {
    d.cleanup();
  }
});

test('the plan route requires a task and is read-only', async () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/plan`);

    const missing = exchange({ method: 'POST', body: {} });
    await route.handler(missing.req, missing.res);
    assert.equal(missing.captured.status, 400);

    const planned = exchange({ method: 'POST', body: { task: 'anything' } });
    await route.handler(planned.req, planned.res);
    assert.equal(planned.captured.status, 200);
    assert.equal(planned.captured.body.ok, true);

    const wrongMethod = exchange({ method: 'GET' });
    await route.handler(wrongMethod.req, wrongMethod.res);
    assert.equal(wrongMethod.captured.status, 405);
  } finally {
    d.cleanup();
  }
});

test('the state document exposes routing capacity but no task state', async () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const ok = exchange();
    await server.routes.get(`${ROUTE_PREFIX}/state`).handler(ok.req, ok.res);
    const body = ok.captured.body;
    assert.equal(body.ok, true);
    assert.ok(body.pool && typeof body.pool.size === 'number');
    assert.ok(Array.isArray(body.capabilities));
    assert.equal(body.inFlight, 0);
    // DSH owns task lists, step status, and progress: nothing here may mirror them.
    for (const forbidden of ['runs', 'tasks', 'steps', 'progress', 'todo', 'plan', 'liveRuns']) {
      assert.ok(!(forbidden in body), `the state document must not expose "${forbidden}"`);
    }
  } finally {
    d.cleanup();
  }
});

test('the state document carries no rating and no cost field', async () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const ok = exchange();
    await server.routes.get(`${ROUTE_PREFIX}/state`).handler(ok.req, ok.res);
    assert.ok(Array.isArray(ok.captured.body.pool.models));
    // Neither a score nor a price is reported: the rating was removed as
    // misleading, and the host exposes no price to compute a cost from.
    const serialized = JSON.stringify(ok.captured.body).toLowerCase();
    for (const forbidden of ['rating', 'stars', 'costindex', 'costlow', 'costmed', '"cost"']) {
      assert.ok(!serialized.includes(forbidden), `the state document must not expose ${forbidden}`);
    }
  } finally {
    d.cleanup();
  }
});

test('the tree route is installed and refuses a missing session', async () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/tree`);
    assert.ok(route, 'the board needs a tree route');

    const missing = exchange({ method: 'GET' });
    missing.req.url = `${ROUTE_PREFIX}/tree`;
    await route.handler(missing.req, missing.res);
    assert.equal(missing.captured.status, 400);
    assert.match(String(missing.captured.body.error), /session is required/);

    const wrongMethod = exchange({ method: 'POST' });
    wrongMethod.req.url = `${ROUTE_PREFIX}/tree?session=root`;
    await route.handler(wrongMethod.req, wrongMethod.res);
    assert.equal(wrongMethod.captured.status, 405);
  } finally {
    d.cleanup();
  }
});

test('the tree route reports an empty graph when no registry is mounted', async () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/tree`);
    const req = exchange({ method: 'GET' });
    req.req.url = `${ROUTE_PREFIX}/tree?session=root`;
    await route.handler(req.req, req.res);
    // A capability absence, not a crash: the panel must be able to say so.
    assert.equal(req.captured.status, 503);
    assert.match(String(req.captured.body.error), /subagent registry is unavailable/);
  } finally {
    d.cleanup();
  }
});

test('the tree route returns the topology the registry reports', async () => {
  const d = deps();
  try {
    const subagents = {
      listDescendants: async (root) => [
        { kind: 'child', id: 'kid', parentId: root, depth: 1, mode: 'one-shot', activity: 'running', hasChildren: false, label: 'research' },
      ],
    };
    const server = fakeServer();
    const { ctx } = fakeContext(server, { services: { subagents } });
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/tree`);
    const req = exchange({ method: 'GET' });
    req.req.url = `${ROUTE_PREFIX}/tree?session=root`;
    await route.handler(req.req, req.res);
    assert.equal(req.captured.status, 200);
    assert.equal(req.captured.body.ok, true);
    assert.equal(req.captured.body.counts.total, 1);
    assert.equal(req.captured.body.rows[0].label, 'research');
    assert.equal(req.captured.body.rows[0].activity, 'running');
  } finally {
    d.cleanup();
  }
});

test('a failing listing is reported as unavailable, not as an empty graph', async () => {
  const d = deps();
  try {
    const subagents = {
      listDescendants: async () => {
        throw new Error('no projection registry is mounted');
      },
    };
    const server = fakeServer();
    const { ctx } = fakeContext(server, { services: { subagents } });
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/tree`);
    const req = exchange({ method: 'GET' });
    req.req.url = `${ROUTE_PREFIX}/tree?session=root`;
    await route.handler(req.req, req.res);
    assert.equal(req.captured.status, 200);
    assert.equal(req.captured.body.ok, false);
    assert.match(req.captured.body.error, /projection registry/);
  } finally {
    d.cleanup();
  }
});

test('the installer never probes a service property on its own context', () => {
  // Regression, found by booting the plugin inside a real deployment: the plugin
  // context throws on a non-injected name, so a "probe then fall back" shape
  // crashes at activation. A strict context reproduces that contract, and the
  // installer must satisfy it without reading `webServer` off its own context.
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx, injections } = fakeContext(server, { strict: true });
    const dispose = installControlRoutesDeferred(ctx, d);
    assert.deepEqual(injections, [['webServer']], 'the web server is always acquired by injection');
    assert.equal(server.routes.size, 4 + 1, 'all five routes mount');
    dispose();
  } finally {
    d.cleanup();
  }
});

test('a deployment without a web server does not crash a strict context', () => {
  const d = deps();
  try {
    // No server: the inject callback still runs (the harness supplies the
    // context), and the installer must simply mount nothing.
    const ctx = {
      inject: () => () => {},
      effect: (factory) => factory(),
    };
    const dispose = installControlRoutesDeferred(ctx, d);
    assert.equal(typeof dispose, 'function');
    dispose();
  } finally {
    d.cleanup();
  }
});

test('a plain state read does NOT re-discover the pool', async () => {
  // The panel polls this route. A provider's model listing can be a network round
  // trip (the bundled third-party provider refetches its catalog over HTTP on
  // every call), so re-discovering on every poll made the panel slow and hammered
  // the provider. Polls must be cheap.
  const d = deps();
  try {
    let refreshes = 0;
    d.engine.refresh = async () => {
      refreshes += 1;
      return { models: [] };
    };
    // A populated pool means no first-paint wait either.
    Object.defineProperty(d.pool, 'models', { value: () => [{ route: 'p1/m1' }], configurable: true });

    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/state`);

    for (let index = 0; index < 5; index += 1) {
      const ok = exchange({ url: `${ROUTE_PREFIX}/state` });
      await route.handler(ok.req, ok.res);
      assert.equal(ok.captured.status, 200);
    }
    assert.equal(refreshes, 0, 'five polls must not trigger a single discovery');
  } finally {
    d.cleanup();
  }
});

test('an explicit force=1 re-discovers the pool', async () => {
  const d = deps();
  try {
    let refreshes = 0;
    d.engine.refresh = async () => {
      refreshes += 1;
      return { models: [] };
    };
    Object.defineProperty(d.pool, 'models', { value: () => [{ route: 'p1/m1' }], configurable: true });
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);

    const ok = exchange({ url: `${ROUTE_PREFIX}/state?force=1` });
    await server.routes.get(`${ROUTE_PREFIX}/state`).handler(ok.req, ok.res);
    assert.equal(refreshes, 1, 'the panel Refresh button must actually refresh');
  } finally {
    d.cleanup();
  }
});

test('the first read waits for the initial discovery, then never again', async () => {
  const d = deps();
  try {
    let settle;
    const firstDiscovery = new Promise((resolve) => {
      settle = resolve;
    });
    let models = [];
    Object.defineProperty(d.pool, 'models', { value: () => models, configurable: true });
    d.engine.refresh = async () => ({ models: [] });
    d.firstDiscovery = firstDiscovery;

    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/state`);

    // The first request blocks on the in-flight discovery: better to wait than to
    // paint an empty pool that looks like a broken deployment.
    const first = exchange({ url: `${ROUTE_PREFIX}/state` });
    let firstSettled = false;
    const pending = route.handler(first.req, first.res).then(() => {
      firstSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(firstSettled, false, 'the first read waits for discovery');

    settle();
    await pending;
    assert.equal(firstSettled, true);
    assert.equal(first.captured.status, 200);

    // Once the pool is populated, later reads answer immediately.
    models = [{ route: 'p1/m1' }];
    const second = exchange({ url: `${ROUTE_PREFIX}/state` });
    await route.handler(second.req, second.res);
    assert.equal(second.captured.status, 200);
  } finally {
    d.cleanup();
  }
});

test('a plain state read does NOT re-discover the pool', async () => {
  // The panel polls this route. A provider's model listing can be a real network
  // round trip (the bundled third-party provider refetches its catalog over HTTP
  // on every call, with a 10s timeout), so re-discovering on every poll made the
  // panel slow and hammered the provider. Polls must be cheap.
  const d = deps();
  try {
    let refreshes = 0;
    d.engine = { ...d.engine, refresh: async () => { refreshes += 1; return { models: [] }; } };
    Object.defineProperty(d.pool, 'models', { value: () => [{ route: 'p1/m1' }], configurable: true });

    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/state`);

    for (let index = 0; index < 5; index += 1) {
      const ok = exchange({ url: `${ROUTE_PREFIX}/state` });
      await route.handler(ok.req, ok.res);
      assert.equal(ok.captured.status, 200);
    }
    assert.equal(refreshes, 0, 'five polls must not trigger a single discovery');
  } finally {
    d.cleanup();
  }
});

test('an explicit force=1 re-discovers the pool', async () => {
  const d = deps();
  try {
    let refreshes = 0;
    d.engine = { ...d.engine, refresh: async () => { refreshes += 1; return { models: [] }; } };
    Object.defineProperty(d.pool, 'models', { value: () => [{ route: 'p1/m1' }], configurable: true });
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);

    const ok = exchange({ url: `${ROUTE_PREFIX}/state?force=1` });
    await server.routes.get(`${ROUTE_PREFIX}/state`).handler(ok.req, ok.res);
    assert.equal(refreshes, 1, 'the panel Refresh button must actually refresh');
  } finally {
    d.cleanup();
  }
});

test('the first read waits for the in-flight discovery, then never blocks', async () => {
  const d = deps();
  try {
    let settle;
    const firstDiscovery = new Promise((resolve) => { settle = resolve; });
    let models = [];
    Object.defineProperty(d.pool, 'models', { value: () => models, configurable: true });
    d.engine = { ...d.engine, refresh: async () => ({ models: [] }) };
    d.firstDiscovery = firstDiscovery;

    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/state`);

    // The first request waits rather than painting an empty pool, which a reader
    // would misread as a broken deployment.
    const first = exchange({ url: `${ROUTE_PREFIX}/state` });
    let settled = false;
    const pending = route.handler(first.req, first.res).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, 'the first read waits for discovery');

    settle();
    await pending;
    assert.equal(first.captured.status, 200);

    // Once the pool is populated, later reads answer without waiting.
    models = [{ route: 'p1/m1' }];
    const second = exchange({ url: `${ROUTE_PREFIX}/state` });
    await route.handler(second.req, second.res);
    assert.equal(second.captured.status, 200);
  } finally {
    d.cleanup();
  }
});

test('the plan preview does not trigger a provider round trip', async () => {
  const d = deps();
  try {
    let refreshes = 0;
    d.engine = {
      ...d.engine,
      refresh: async () => { refreshes += 1; return { models: [] }; },
      plan: async () => ({ tier: 'direct', units: [] }),
    };
    Object.defineProperty(d.pool, 'models', { value: () => [{ route: 'p1/m1' }], configurable: true });
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);

    const ok = exchange({ method: 'POST', body: { task: 'anything' }, url: `${ROUTE_PREFIX}/plan` });
    await server.routes.get(`${ROUTE_PREFIX}/plan`).handler(ok.req, ok.res);
    assert.equal(ok.captured.status, 200);
    assert.equal(refreshes, 0, 'previewing a route must not hit the providers');
  } finally {
    d.cleanup();
  }
});

test('the panel can set a per-route reasoning level, and an invalid one is refused', async () => {
  const d = deps();
  try {
    const profile = {
      route: 'p1/m1',
      provider: 'p1',
      model: 'm1',
      name: 'M1',
      facts: { efforts: ['low', 'high'], defaultEffort: 'low' },
      derived: { tier: 'deep', hasReasoning: true },
    };
    Object.defineProperty(d.pool, 'models', { value: () => [profile], configurable: true });
    Object.defineProperty(d.pool, 'get', {
      value: (route) => (route === 'p1/m1' ? profile : undefined),
      configurable: true,
    });
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/configure`);

    // A level the route does not advertise must not be stored: it would look
    // applied while the engine silently ignores it at dispatch.
    const bad = exchange({ method: 'POST', body: { reasoningEffort: { 'p1/m1': 'xhigh' } } });
    await route.handler(bad.req, bad.res);
    assert.match(bad.captured.body.rejected.join(' '), /"xhigh" is not one of low, high/);
    assert.equal(d.store.snapshot().preferences.reasoningEffort['p1/m1'], undefined);

    const good = exchange({ method: 'POST', body: { reasoningEffort: { 'p1/m1': 'high' } } });
    await route.handler(good.req, good.res);
    assert.deepEqual(good.captured.body.applied, ['reasoningEffort']);
    assert.equal(d.store.snapshot().preferences.reasoningEffort['p1/m1'], 'high');
    // The panel learns the options and the current choice from the pool document.
    const model = good.captured.body.state.pool.models[0];
    assert.equal(model.reasoningEffort, 'high');
    assert.equal(model.defaultEffort, 'low');
    assert.deepEqual(model.reasoningEfforts, ['low', 'high']);

    const cleared = exchange({ method: 'POST', body: { reasoningEffort: { 'p1/m1': null } } });
    await route.handler(cleared.req, cleared.res);
    assert.equal(
      d.store.snapshot().preferences.reasoningEffort['p1/m1'],
      undefined,
      'clearing returns the route to the model default',
    );
  } finally {
    d.cleanup();
  }
});

test('the panel can set a capability assignment, and the state reports how it resolves', async () => {
  const d = deps();
  try {
    Object.defineProperty(d.pool, 'models', {
      value: () => [
        {
          route: 'p1/gemini-3.8-flash',
          provider: 'p1',
          model: 'gemini-3.8-flash',
          name: 'Gemini 3.8 Flash',
          facts: { efforts: [] },
          derived: { tier: 'deep' },
        },
      ],
      configurable: true,
    });
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/configure`);

    // A model that is not in the pool right now is legal (the pool churns) but is
    // reported at the moment it is written.
    const written = exchange({
      method: 'POST',
      body: {
        capabilityAssignments: {
          'multimodal.vision': 'gemini-3.8-flash',
          'reasoning.mathematics': 'claude-opus-9',
          'not.a.capability': 'gemini-3.8-flash',
        },
      },
    });
    await route.handler(written.req, written.res);
    assert.deepEqual(written.captured.body.applied, ['capabilityAssignments']);
    assert.match(written.captured.body.rejected.join(' '), /not\.a\.capability: unknown capability or group/);
    assert.deepEqual(written.captured.body.assignmentsUnresolved, [
      { key: 'reasoning.mathematics', target: 'claude-opus-9' },
    ]);
    assert.equal(written.captured.body.assignmentsResolved.length, 1);

    const stored = d.store.snapshot().preferences.capabilityAssignments;
    assert.deepEqual(Object.keys(stored).sort(), ['multimodal.vision', 'reasoning.mathematics']);
    assert.equal('not.a.capability' in stored, false, 'a refused key must not be stored');

    // The state document the panel renders carries the resolution and the pool.
    const assignments = written.captured.body.state.assignments;
    assert.equal(assignments.count, 2);
    assert.deepEqual(assignments.entries[0].routes, ['p1/gemini-3.8-flash']);
    assert.deepEqual(assignments.unresolved, [{ key: 'reasoning.mathematics', target: 'claude-opus-9' }]);
    assert.ok(Array.isArray(written.captured.body.state.assignmentKeys));
    assert.ok(
      written.captured.body.state.assignmentKeys.some((entry) => entry.key === 'multimodal.vision'),
      'the panel needs the vocabulary it may assign',
    );

    // And clearing one entry leaves the other alone.
    const cleared = exchange({ method: 'POST', body: { capabilityAssignments: { 'multimodal.vision': null } } });
    await route.handler(cleared.req, cleared.res);
    assert.deepEqual(Object.keys(d.store.snapshot().preferences.capabilityAssignments), [
      'reasoning.mathematics',
    ]);
  } finally {
    d.cleanup();
  }
});

test('the sync route starts a sweep and returns without waiting for it', async () => {
  const d = deps();
  try {
    let started = 0;
    let finish;
    const gate = new Promise((done) => {
      finish = done;
    });
    d.sync = {
      start: (options) => {
        started += 1;
        assert.equal(options.force, false);
        return gate;
      },
      status: () => ({ status: started === 0 ? 'idle' : 'running', total: 2 }),
    };
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/sync`);

    const refused = exchange({ method: 'GET' });
    await route.handler(refused.req, refused.res);
    assert.equal(refused.captured.status, 405, 'sync is a POST');

    const accepted = exchange({ method: 'POST', body: { force: false } });
    await route.handler(accepted.req, accepted.res);
    assert.equal(accepted.captured.status, 200);
    assert.equal(accepted.captured.body.ok, true);
    assert.equal(started, 1, 'the sweep is started exactly once');
    // It must NOT wait: the sweep takes minutes, and a blocked POST would be a
    // worse lie than a button that reports progress.
    assert.equal(accepted.captured.body.status.status, 'running');
    finish();
  } finally {
    d.cleanup();
  }
});

test('a deployment with no sync runner reports it instead of failing', async () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const route = server.routes.get(`${ROUTE_PREFIX}/sync`);
    const answer = exchange({ method: 'POST', body: {} });
    await route.handler(answer.req, answer.res);
    assert.equal(answer.captured.status, 200);
    assert.equal(answer.captured.body.ok, false);
    assert.equal(answer.captured.body.status.status, 'unavailable');
  } finally {
    d.cleanup();
  }
});

test('the pool state carries the researched facts, the cost basis and the reasoning mode', async () => {
  const d = deps();
  try {
    Object.defineProperty(d.pool, 'models', {
      value: () => [
        {
          route: 'p1/dear',
          provider: 'p1',
          model: 'dear',
          name: 'Dear (CC)',
          facts: { efforts: ['low', 'high'], reasoningMode: 'adjustable' },
          derived: { tier: 'deep', hasReasoning: true },
        },
        {
          route: 'p1/auto',
          provider: 'p1',
          model: 'auto',
          name: 'Auto (CC)',
          // A provider that reasons without exposing a level to pick.
          facts: { reasoningMode: 'automatic' },
          derived: { tier: 'deep', hasReasoning: false },
        },
      ],
      configurable: true,
    });
    d.store.update((state) => {
      state.research = {
        dear: { route: 'p1/dear', matched: true, publicName: 'Dear 1.0', vendor: 'Acme', inputPerMTok: 3, outputPerMTok: 9, identityKeys: ['dear'] },
        auto: { route: 'p1/auto', matched: false, notes: 'no public listing', identityKeys: ['auto'] },
      };
    });
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const answer = exchange({ method: 'GET' });
    await server.routes.get(`${ROUTE_PREFIX}/state`).handler(answer.req, answer.res);

    const [dear, auto] = answer.captured.body.pool.models;
    assert.deepEqual(dear.researched.publicName, 'Dear 1.0');
    assert.equal(dear.researched.matched, true);
    assert.equal(dear.researched.inputPerMTok, 3);
    assert.equal(dear.reasoningMode, 'adjustable', 'the panel needs this to choose a selector');

    // Unconfirmed stays unconfirmed and carries its note, so the cell can say so.
    assert.equal(auto.researched.matched, false);
    assert.equal(auto.researched.publicName, undefined);
    assert.equal(auto.researched.notes, 'no public listing');
    assert.equal(auto.reasoningMode, 'automatic', 'not "none": it reasons, without a level');
  } finally {
    d.cleanup();
  }
});

test('a sync runner that throws while starting is reported, not absorbed by the server', async () => {
  const d = deps();
  try {
    d.sync = {
      start: () => {
        throw new Error('the pool is not ready');
      },
      status: () => ({ status: 'idle' }),
    };
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const answer = exchange({ method: 'POST', body: {} });
    await server.routes.get(`${ROUTE_PREFIX}/sync`).handler(answer.req, answer.res);
    assert.equal(answer.captured.status, 200);
    assert.equal(answer.captured.body.ok, false);
    assert.match(answer.captured.body.status.error, /pool is not ready/);
  } finally {
    d.cleanup();
  }
});

test('a hand-set level on an automatic route is reported as applied, not ignored', async () => {
  // The panel called it "ignored" while the engine sent it — a contradiction
  // between what the user was told and what the child did.
  const d = deps();
  try {
    Object.defineProperty(d.pool, 'models', {
      value: () => [
        {
          route: 'p1/auto',
          provider: 'p1',
          model: 'auto',
          name: 'Auto (CC)',
          facts: { reasoningMode: 'automatic' },
          derived: { hasReasoning: false },
        },
      ],
      configurable: true,
    });
    d.store.update((state) => {
      state.preferences.reasoningEffort = { 'p1/auto': 'high' };
    });
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const answer = exchange({ method: 'GET' });
    await server.routes.get(`${ROUTE_PREFIX}/state`).handler(answer.req, answer.res);
    const model = answer.captured.body.pool.models[0];
    assert.equal(model.reasoningEffort, 'high', 'it is applied, and the panel must say so');
    assert.equal(model.effortIgnored, undefined, 'it must not also be reported as ignored');
    assert.equal(model.reasoningMode, 'automatic', 'so the client renders the manual form');
  } finally {
    d.cleanup();
  }
});
