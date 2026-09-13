/**
 * Host control routes for the browser panel.
 *
 * The Client half of this plugin cannot enumerate models for itself: the LLM
 * listing surface (`listModels`, `resolveModelInfo`) is host-only, and only
 * `listProviders` crosses the Remote boundary. So the panel reads orchestrator
 * state over these routes, which run in the host where the real pool lives.
 *
 * Every route is fenced. The harness's own authentication overlay is consulted
 * when the deployment provides one; when it does not, a same-origin loopback
 * fence applies instead, and it fails closed on a missing or foreign Host. The
 * handlers are read-mostly: `state` and `plan` are read-only, and `configure`
 * only writes the user's own routing preferences.
 *
 * @module dsh-model-orchestrator/routes
 */
import { isRecord, str, uint } from './util.js';
import { declaredDomains, poolFingerprint, ratePool } from './discovery.js';
import { buildAgentTree, flattenAgentTree } from './agent-tree.js';

/** Route prefix. Must stay in sync with the client bundle. */
export const ROUTE_PREFIX = '/plugins/dsh-model-orchestrator';

/** Reject an oversized body before buffering it. */
const MAX_BODY_BYTES = 64 * 1024;

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Drain and parse a JSON request body with a hard size bound. */
async function readJsonBody(req) {
  const raw = await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    req.on('data', (chunk) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > MAX_BODY_BYTES) finish(new Error('request body is too large'));
      else chunks.push(part);
    });
    req.on('end', () => finish());
    req.on('aborted', () => finish(new Error('request aborted')));
    req.on('error', (error) => finish(error));
  });
  if (raw.trim() === '') return {};
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('body must be a JSON object');
  return parsed;
}

/** The full state document the panel renders. */
function stateDocument(deps) {
  const { engine, pool, taxonomy, store, host } = deps;
  const state = store.snapshot();
  // Ratings are relative to the pool (see `ratePool`), and declared domains come
  // only from a model's own description; both are computed per snapshot.
  const ratings = ratePool(pool.models());
  return {
    ok: true,
    plugin: { name: host.name, version: host.version },
    compatibility: {
      declaredRange: host.range,
      runningVersion: host.runningVersion,
      optionalMissing: host.optionalMissing,
    },
    mode: state.mode,
    guidedCapabilities: state.guided.capabilities,
    preferences: state.preferences,
    pool: {
      size: pool.models().length,
      providers: pool.providers(),
      fingerprint: poolFingerprint(pool),
      discoveredAt: pool.discoveredAt(),
      problems: pool.problems(),
      models: pool.models().map((model) => ({
        route: model.route,
        provider: model.provider,
        model: model.model,
        name: model.name,
        description: model.description,
        confidence: model.confidence,
        evidence: model.evidence,
        tier: model.derived?.tier ?? 'unknown',
        supportsImage: model.derived?.supportsImage,
        contextWindow: model.facts?.contextWindow,
        defaultMaxTokens: model.facts?.defaultMaxTokens,
        reasoningEfforts: model.facts?.efforts,
        hasReasoning: model.derived?.hasReasoning === true,
        strengths: model.derived?.strengths,
        domains: declaredDomains(model, taxonomy),
        // Union of declared text and calibrated claims, for the "declared
        // strengths" column: the only domain evidence the host can offer.
        declared: model.derived?.strengths ?? [],
        rating: ratings[model.route],
      })),
    },
    capabilities: taxonomy.list().map((entry) => ({
      id: entry.id,
      label: entry.label,
      group: entry.group,
      origin: entry.origin,
      summary: entry.summary,
    })),
    calibrations: state.profiles,
    // No run or task list is exposed: DSH owns task lists, step status, and
    // progress. The panel shows only configuration and routing capacity.
    inFlight: engine.inFlightCount,
    storage: { path: store.path, lastError: store.writeError },
  };
}

/** Apply a validated preference patch. Shared with the configure tool's rules. */
function applyConfiguration(store, body) {
  const applied = [];
  const rejected = [];

  const mode = str(body.mode);
  if (body.mode !== undefined) {
    if (mode === 'auto' || mode === 'guided') applied.push('mode');
    else rejected.push(`mode: expected "auto" or "guided", got ${JSON.stringify(body.mode)}`);
  }
  if (body.guidedCapabilities !== undefined && !Array.isArray(body.guidedCapabilities)) {
    rejected.push('guidedCapabilities: expected an array of capability ids');
  }
  const booleanKeys = [
    'preferCheaper',
    'allowMultiAgent',
    'calibrationEnabled',
  ];
  for (const key of booleanKeys) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') {
      rejected.push(`${key}: expected a boolean`);
    }
  }
  for (const key of ['deniedRoutes', 'allowedRoutes']) {
    if (body[key] !== undefined && !Array.isArray(body[key])) {
      rejected.push(`${key}: expected an array of "provider/model" strings`);
    }
  }
  const captainMode = str(body.captainMode);
  if (body.captainMode !== undefined && captainMode !== 'main' && captainMode !== 'spawned') {
    rejected.push('captainMode: expected "main" or "spawned"');
  }

  if (rejected.length > 0 && applied.length === 0 && Object.keys(body).length > 0) {
    // Nothing valid to apply: report rather than silently ignoring the request.
    const valid = Object.keys(body).filter((key) => !rejected.some((entry) => entry.startsWith(`${key}:`)));
    if (valid.length === 0) return { applied, rejected };
  }

  store.update((state) => {
    if (mode === 'auto' || mode === 'guided') {
      state.mode = mode;
      applied.push('mode');
    }
    if (Array.isArray(body.guidedCapabilities)) {
      state.guided.capabilities = body.guidedCapabilities.map(String);
      applied.push('guidedCapabilities');
    }
    const preferences = state.preferences;
    if (typeof body.preferCheaper === 'boolean') {
      preferences.preferCheaper = body.preferCheaper;
      applied.push('preferCheaper');
    }
    if (typeof body.allowMultiAgent === 'boolean') {
      preferences.allowMultiAgent = body.allowMultiAgent;
      applied.push('allowMultiAgent');
    }
    if (typeof body.calibrationEnabled === 'boolean') {
      preferences.calibrationEnabled = body.calibrationEnabled;
      applied.push('calibrationEnabled');
    }
    if (captainMode === 'main' || captainMode === 'spawned') {
      preferences.captainMode = captainMode;
      applied.push('captainMode');
    }
    const maxParallel = uint(body.maxParallel);
    if (maxParallel !== undefined) {
      preferences.maxParallel = Math.min(16, Math.max(1, maxParallel));
      applied.push('maxParallel');
    }
    const maxAgentsPerRun = uint(body.maxAgentsPerRun);
    if (maxAgentsPerRun !== undefined) {
      preferences.maxAgentsPerRun = Math.min(64, Math.max(1, maxAgentsPerRun));
      applied.push('maxAgentsPerRun');
    }
    if (Array.isArray(body.deniedRoutes)) {
      preferences.deniedRoutes = body.deniedRoutes.map(String);
      applied.push('deniedRoutes');
    }
    if (Array.isArray(body.allowedRoutes)) {
      preferences.allowedRoutes = body.allowedRoutes.map(String);
      applied.push('allowedRoutes');
    }
  });

  return { applied: [...new Set(applied)], rejected };
}

/**
 * Install the control routes, waiting for the web server if necessary.
 *
 * This mirrors the harness's own `dsh-client-modules` carrier exactly, because
 * the web server is provided by a sibling row of the SAME composition and may be
 * registered *after* this plugin activates:
 *
 * ```js
 * if (ctx.get('webServer') === undefined) ctx.inject(['webServer'], register)
 * else register(ctx)
 * ```
 *
 * The fast path covers a plugin reload or a late mount; the injected path waits
 * for the service to appear. Inside the callback the injected context exposes
 * `webCtx.webServer` and `webCtx.effect`, and every route is registered as an
 * effect of that context so it unwinds with the Fiber.
 *
 * A profile with no web server (a headless run) never mounts the routes; the
 * tools work regardless, and nothing throws.
 *
 * @param ctx - the plugin context.
 * @param deps - `{ engine, pool, taxonomy, store, logger, host }`.
 * @returns a disposer that uninstalls every route this plugin owns.
 */
export function installControlRoutesDeferred(ctx, deps) {
  let dispose = () => {};
  let injected;

  const register = (webCtx) => {
    dispose = installRoutesOn(webCtx, deps) ?? (() => {});
    deps.logger?.info?.(`${deps.host.name}: control panel routes mounted.`);
  };

  if (ctx.get('webServer') === undefined) {
    injected = ctx.inject(['webServer'], (webCtx) => {
      register(webCtx);
      // The routes are already held in `dispose`; the injected context's own
      // effects unwind on unload, so no further disposer is returned here.
      return undefined;
    });
  } else {
    register(ctx);
  }

  return () => {
    try {
      injected?.();
    } catch {
      // Injection teardown is owned by the Fiber.
    }
    dispose();
  };
}

function installRoutesOn(ctx, deps) {
  // `ctx` here is the injected context, so the service is a direct property.
  const server = ctx.webServer ?? ctx.get('webServer');
  if (server === undefined || typeof server.register !== 'function') {
    deps.logger?.info?.(
      `${deps.host.name}: no web server is mounted, so the control panel routes were not registered (the tools work regardless).`,
    );
    return () => {};
  }

  const disposers = [];

  /**
   * Fence every handler.
   *
   * The harness's own authentication overlay, when the deployment provides one,
   * is consulted first. When it does not — this deployment's service catalogue
   * has no `connection` service at all — the route is NOT left open: a same-origin
   * fence rejects any request whose `Host`/`Origin` is not the loopback address
   * this plugin's own page is served from. The web server binds to loopback, so
   * that admits the harness page and rejects a cross-origin page or a rebinding
   * host, and it fails closed on a missing or malformed header.
   */
  const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
  const guard = (handler) => async (req, res) => {
    const connection = ctx.get('connection');
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) {
        sendJson(res, rejection, {
          error: rejection === 401 ? 'unauthorized' : 'forbidden',
        });
        return;
      }
      await handler(req, res);
      return;
    }

    const host = req.headers?.host;
    if (typeof host !== 'string' || !LOOPBACK.test(host.trim())) {
      sendJson(res, 403, { error: 'this route is restricted to same-origin loopback requests' });
      return;
    }
    const origin = req.headers?.origin;
    if (origin !== undefined) {
      let originHost;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = undefined;
      }
      if (originHost === undefined || !LOOPBACK.test(originHost)) {
        sendJson(res, 403, { error: 'cross-origin request rejected' });
        return;
      }
    }
    await handler(req, res);
  };

  const register = (path, handler) => {
    disposers.push(server.register({ kind: 'exact', path, handler: guard(handler) }));
  };

  register(`${ROUTE_PREFIX}/state`, async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    try {
      // Refresh on read so the panel always shows the live pool rather than a
      // snapshot taken at page load.
      await deps.engine.refresh({});
    } catch (error) {
      deps.logger?.warn?.(`${deps.host.name}: refresh before serving state failed: ${String(error)}`);
    }
    sendJson(res, 200, stateDocument(deps));
  });

  register(`${ROUTE_PREFIX}/configure`, async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message ?? error) });
      return;
    }
    const result = applyConfiguration(deps.store, body);
    sendJson(res, 200, { ok: true, ...result, state: stateDocument(deps) });
  });

  register(`${ROUTE_PREFIX}/tree`, async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = str(url.searchParams.get('session'));
    if (sessionId === undefined) {
      sendJson(res, 400, { error: 'session is required' });
      return;
    }

    const subagents = ctx.get('subagents');
    if (subagents === undefined || typeof subagents.listDescendants !== 'function') {
      sendJson(res, 503, {
        error: 'the subagent registry is unavailable, so the delegation graph cannot be read',
      });
      return;
    }

    let entries;
    try {
      // The harness enumerates the DURABLE session tree; nothing here is cached,
      // so the panel always shows the topology that actually exists.
      entries = await subagents.listDescendants(sessionId);
    } catch (error) {
      // A deployment without a projection registry cannot classify children.
      // That is a capability absence, reported as such rather than as an empty
      // graph, which would misrepresent "unknown" as "nothing delegated".
      sendJson(res, 200, {
        ok: false,
        root: sessionId,
        nodes: [],
        rows: [],
        diagnostics: [],
        truncated: false,
        counts: { total: 0, running: 0, continuable: 0, roots: 0 },
        error: String(error?.message ?? error),
      });
      return;
    }

    const tree = buildAgentTree(sessionId, entries);
    sendJson(res, 200, { ok: true, ...tree, rows: flattenAgentTree(tree.nodes) });
  });

  register(`${ROUTE_PREFIX}/plan`, async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message ?? error) });
      return;
    }
    const task = str(body.task);
    if (task === undefined) {
      sendJson(res, 400, { error: 'task is required' });
      return;
    }
    await deps.engine.refresh({});
    // Planning is read-only and never spawns a child, so exposing it to the
    // panel is safe: it only shows what routing WOULD happen.
    sendJson(res, 200, { ok: true, ...(await deps.engine.plan({ task })) });
  });

  deps.logger?.info?.(
    `${deps.host.name}: control panel routes mounted under ${ROUTE_PREFIX}.`,
  );

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // Route teardown is best effort; the server owns its own lifecycle.
      }
    }
  };
}
