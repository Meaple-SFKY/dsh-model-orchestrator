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
import { poolFingerprint } from './discovery.js';
import { CUE_GROUPS, describeCues, resolveCues } from './decision-vocabulary.js';
import { buildAgentTree, flattenAgentTree } from './agent-tree.js';
import { effortPatch, mergeEffortPatch } from './reasoning-effort.js';
import { assignmentPatch, mergeAssignmentPatch, resolveAssignments } from './assignments.js';
import { researchFor } from './model-research.js';

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
  // Declared domains come only from a model's own description.
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
      // What the deployment policy and the user's preferences excluded, so the
      // panel can explain a smaller pool instead of looking broken.
      filter: typeof pool.filterReport === 'function' ? pool.filterReport() : undefined,
      models: pool.models().map((model) => {
        const efforts = Array.isArray(model.facts?.efforts) ? model.facts.efforts : [];
        const researched = researchFor(state.research, model);
        const stored = state.preferences.reasoningEffort?.[model.route];
        // Reported as effective only while the route still advertises it: a stale
        // preference is ignored at dispatch, so showing it as applied would lie.
        // `effortIgnored` marks that case so the panel can report it instead of
        // hiding it.
        const effective = stored !== undefined && efforts.includes(stored) ? stored : undefined;
        return {
          route: model.route,
          provider: model.provider,
          model: model.model,
          name: model.name,
          description: model.description,
          tier: model.derived?.tier ?? 'unknown',
          supportsImage: model.derived?.supportsImage,
          contextWindow: model.facts?.contextWindow,
          defaultMaxTokens: model.facts?.defaultMaxTokens,
          // The levels this route advertises, and the one the harness applies with
          // no preference. Both come from the host, so the selector offers exactly
          // what the route supports rather than a list this plugin guessed.
          reasoningEfforts: model.facts?.efforts,
          defaultEffort: model.facts?.defaultEffort,
          ...(effective === undefined ? {} : { reasoningEffort: effective }),
          ...(stored !== undefined && effective === undefined ? { effortIgnored: stored } : {}),
          hasReasoning: model.derived?.hasReasoning === true,
          // `adjustable` | `automatic` | `none`. The panel needs the difference:
          // a provider that reasons without exposing a level gets no selector, and
          // saying "no reasoning" of it would be wrong.
          reasoningMode: model.facts?.reasoningMode ?? (model.derived?.hasReasoning === true ? 'adjustable' : 'none'),
          // Public facts from the last sync, with their provenance. Absent until a
          // sync has run, which is exactly what the panel needs to know to offer it.
          ...(researched === undefined ? {} : { researched }),
        };
      }),
    },
    // Which decision cues are the built-in fallback and which an operator
    // replaced. Reported so the vocabulary is visible rather than implicit.
    decisionCues: describeCues(store.snapshot().preferences),
    capabilities: taxonomy.list().map((entry) => ({
      id: entry.id,
      label: entry.label,
      group: entry.group,
      origin: entry.origin,
      summary: entry.summary,
    })),
    calibrations: state.profiles,
    // The last sync's outcome, so the panel can show a running sweep, report what
    // it could not confirm, and never imply the numbers are live when they are not.
    sync: deps.sync?.status?.() ?? { status: 'unavailable' },
    // The standing division of labour, resolved against the live pool: what each
    // entry currently points at, what it cannot resolve, and which live routes no
    // entry mentions. The panel renders exactly this, so a table that has stopped
    // matching anything is visible instead of felt.
    assignments: (() => {
      const report = resolveAssignments(
        state.preferences.capabilityAssignments,
        pool.models(),
      );
      return {
        count: report.count,
        entries: report.entries.map((entry) => ({
          key: entry.key,
          models: entry.models,
          family: entry.family,
          routes: entry.routes,
          resolved: entry.resolved.map((match) => ({ target: match.target, kind: match.kind, route: match.routes[0] })),
          unresolved: entry.unresolved,
        })),
        unresolved: report.unresolved,
        unassigned: report.unassigned,
      };
    })(),
    // Capability ids and groups an assignment may be keyed by, so the panel offers
    // what actually exists rather than a free-text field.
    assignmentKeys: [
      ...taxonomy.list().map((entry) => ({ key: entry.id, kind: 'capability', group: entry.group, label: entry.label })),
      ...[...new Set(taxonomy.list().map((entry) => entry.group))].map((group) => ({
        key: group,
        kind: 'group',
        group,
        label: group,
      })),
    ],
    // No run or task list is exposed: DSH owns task lists, step status, and
    // progress. The panel shows only configuration and routing capacity.
    inFlight: engine.inFlightCount,
    storage: { path: store.path, lastError: store.writeError },
  };
}

/**
 * Apply a validated preference patch. Shared with the configure tool's rules.
 *
 * @param store - the durable preference store.
 * @param body - the requested patch.
 * @param pool - the live model pool, when the caller has one. Required to validate
 *   a reasoning-effort preference, which only means something against the route's
 *   own advertised levels.
 * @param taxonomy - the live capability vocabulary, used to refuse an assignment
 *   keyed by a capability that cannot exist.
 * @returns `{ applied, rejected }`.
 */
function applyConfiguration(store, body, pool, taxonomy) {
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
  if (body.decisionCues !== undefined) {
    if (body.decisionCues === null || typeof body.decisionCues !== 'object' || Array.isArray(body.decisionCues)) {
      rejected.push('decisionCues: expected an object keyed by cue group');
    } else {
      for (const [group, value] of Object.entries(body.decisionCues)) {
        if (!CUE_GROUPS.includes(group)) {
          rejected.push(`decisionCues.${group}: unknown group (known: ${CUE_GROUPS.join(', ')})`);
        } else if (!Array.isArray(value)) {
          rejected.push(`decisionCues.${group}: expected an array of strings`);
        }
      }
    }
  }

  // A reasoning-effort preference is only meaningful against the live route: an
  // unknown `provider/model`, or a level the route does not advertise, is either a
  // typo or a stale entry, and storing it would leave an inert preference that
  // looks applied. It is rejected here instead.
  const effort = effortPatch(body.reasoningEffort, pool);
  rejected.push(...effort.rejected);

  // Assignments are NOT rejected for naming a model that is absent right now: the
  // pool churns, and a table meant to outlive the pool must be able to hold an
  // intent whose model is temporarily gone. Shape is strict, absence is reported.
  const assignment = assignmentPatch(body.capabilityAssignments, {
    taxonomy,
    models: pool.models(),
  });
  rejected.push(...assignment.rejected);

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
    if (body.decisionCues !== null && typeof body.decisionCues === 'object' && !Array.isArray(body.decisionCues)) {
      // Only known groups, and only non-empty arrays: an empty list would silently
      // disable a whole dimension of the fallback instead of replacing it.
      const accepted = resolveCues(body.decisionCues);
      const next = { ...(preferences.decisionCues ?? {}) };
      for (const group of accepted.replaced) next[group] = [...accepted.cues[group]];
      preferences.decisionCues = next;
      if (accepted.replaced.length > 0) applied.push('decisionCues');
    }
    if (effort.patch.length > 0) {
      preferences.reasoningEffort = mergeEffortPatch(preferences.reasoningEffort, effort.patch);
      applied.push('reasoningEffort');
    }
    if (Object.keys(assignment.patch).length > 0) {
      preferences.capabilityAssignments = mergeAssignmentPatch(
        preferences.capabilityAssignments,
        assignment.patch,
      );
      applied.push('capabilityAssignments');
    }
  });

  return {
    applied: [...new Set(applied)],
    rejected,
    // What the patch resolved to right now, so a target that names nothing gets
    // reported at the moment it is written rather than months later.
    ...(assignment.resolved.length === 0 ? {} : { assignmentsResolved: assignment.resolved }),
    ...(assignment.unresolved.length === 0 ? {} : { assignmentsUnresolved: assignment.unresolved }),
  };
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

  /**
   * Wait for the web server, then mount.
   *
   * `ctx.inject` is used UNCONDITIONALLY rather than probing the service first.
   * Two reasons, both learned the hard way:
   *
   *  1. A plugin context is a Cordis proxy: reading a name it does not inject
   *     THROWS (`cannot get property "webServer" without inject`) instead of
   *     returning `undefined`. A "check first, inject as fallback" shape is
   *     therefore not safe here, and neither is `a ?? ctx.get(...)`, because `??`
   *     evaluates its right-hand side whenever the left is nullish — including a
   *     throw.
   *  2. `inject` fires immediately when the service already exists, so it covers
   *     the late-mount case too and needs no fast path at all.
   *
   * Inside the callback the injected context exposes `webServer` directly, which
   * is why the router receives the service as an explicit argument rather than
   * reaching for it.
   */
  const injected = ctx.inject(['webServer'], (webCtx) => {
    dispose = installRoutesOn(webCtx, webCtx.webServer, deps) ?? (() => {});
    deps.logger?.info?.(`${deps.host.name}: control panel routes mounted.`);
    return undefined;
  });

  return () => {
    try {
      injected?.();
    } catch {
      // Injection teardown is owned by the Fiber.
    }
    dispose();
  };
}

/**
 * Mount the routes on one resolved web server.
 *
 * @param ctx - the injected context that owns the effects.
 * @param server - the resolved web server service.
 * @param deps - the orchestrator dependencies.
 * @returns a disposer for every route mounted here.
 */
function installRoutesOn(ctx, server, deps) {
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
    // `connection` is an OPTIONAL overlay that not every deployment provides, and
    // a context read of a name the composing plugin does not inject can throw
    // rather than return undefined — so the lookup is guarded.
    let connection
    try {
      connection = ctx.get('connection');
    } catch {
      connection = undefined;
    }
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
    // Serving state must be CHEAP: the panel polls it. A provider's model listing
    // can be a network round trip, so re-discovering on every poll made the panel
    // slow and hammered the provider. The pool is kept current by the adapter
    // topology event and refreshed on demand (`?force=1`, or the panel's Refresh).
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.get('force') === '1') {
      try {
        await deps.engine.refresh({});
      } catch (error) {
        deps.logger?.warn?.(`${deps.host.name}: forced refresh failed: ${String(error)}`);
      }
    } else if (deps.pool.models().length === 0 && deps.firstDiscovery !== undefined) {
      // First paint: wait only if the pool has never been read, so an empty panel
      // is never shown, and never longer than the discovery itself.
      try {
        await deps.firstDiscovery;
      } catch {
        // Reported through the pool's problems.
      }
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
    const result = applyConfiguration(deps.store, body, deps.pool, deps.taxonomy);
    sendJson(res, 200, { ok: true, ...result, state: stateDocument(deps) });
  });

  /**
   * Start one research sweep, or report the one already running.
   *
   * Deliberately fire-and-return. A sweep does several web searches and a model
   * call — minutes, not milliseconds — and a POST that blocked for minutes would be
   * a worse lie than a button that says "working". The panel polls `/state` for the
   * status; the plugin keeps one in-flight record, no history, and nothing about
   * the user's own work.
   */
  register(`${ROUTE_PREFIX}/sync`, async (req, res) => {
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
    const runner = deps.sync;
    if (runner === undefined || typeof runner.start !== 'function') {
      sendJson(res, 200, { ok: false, status: { status: 'unavailable' } });
      return;
    }
    // Not awaited: the sweep continues in the background and reports through
    // `/state`. The runner turns its own failure into an error status, so this can
    // never become an unhandled rejection.
    void runner.start({ force: body?.force === true });
    sendJson(res, 200, { ok: true, status: runner.status() });
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
    // Planning reads the pool it already has; previewing a route must not trigger
    // a provider round trip.
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
