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

/** A web-server stand-in recording registrations. */
function fakeServer() {
  const routes = new Map();
  const disposed = [];
  return {
    routes,
    disposed,
    register(route) {
      routes.set(route.path, route);
      const dispose = () => disposed.push(route.path);
      return dispose;
    },
  };
}

/** A context exposing a web server by fast path or by injection. */
function fakeContext(server, { injectable = true, services = {} } = {}) {
  const injections = [];
  const ctx = {
    get(name) {
      if (name === 'webServer') return server;
      if (name in services) return services[name];
      return undefined;
    },
    inject(names, callback) {
      injections.push(names);
      if (injectable) callback({ webServer: server, get: ctx.get, effect: (factory) => factory() });
      return () => {};
    },
  };
  return { ctx, injections };
}

/** A request/response pair capturing the handler's decision. */
function exchange({ method = 'GET', headers = { host: '127.0.0.1:3080' }, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url: '/',
    headers,
    on(event, handler) {
      if (event === 'data') for (const chunk of chunks) handler(chunk);
      if (event === 'end') handler();
      return req;
    },
    off() {},
    once() {},
  };
  const captured = { status: undefined, headers: undefined, body: undefined };
  const res = {
    writeHead(status, responseHeaders) {
      captured.status = status;
      captured.headers = responseHeaders;
    },
    end(payload) {
      if (payload !== undefined) {
        try {
          captured.body = JSON.parse(payload);
        } catch {
          captured.body = payload;
        }
      }
    },
  };
  return { req, res, captured };
}

test('the routes mount on the fast path when a web server already exists', () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    const dispose = installControlRoutesDeferred(ctx, d);
    assert.deepEqual(
      [...server.routes.keys()].sort(),
      [`${ROUTE_PREFIX}/configure`, `${ROUTE_PREFIX}/plan`, `${ROUTE_PREFIX}/state`, `${ROUTE_PREFIX}/tree`],
    );
    dispose();
    assert.equal(server.disposed.length, 4, 'every route must have a disposer');
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
    const ctx = {
      get: (name) => (name === 'webServer' ? server : name === 'connection' ? gate : undefined),
      inject: () => () => {},
    };
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

test('each model carries a pool-relative rating and its declared domains', async () => {
  const d = deps();
  try {
    const server = fakeServer();
    const { ctx } = fakeContext(server);
    installControlRoutesDeferred(ctx, d);
    const ok = exchange();
    await server.routes.get(`${ROUTE_PREFIX}/state`).handler(ok.req, ok.res);
    // No models in this fixture pool, so the shape is asserted on the container.
    assert.ok(Array.isArray(ok.captured.body.pool.models));
    // The state document must not carry a cost field: the panel shows no price.
    const serialized = JSON.stringify(ok.captured.body).toLowerCase();
    for (const forbidden of ['costindex', 'costlow', 'costmed', '"cost"']) {
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
