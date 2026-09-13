/**
 * Route policy: which of the live models this deployment actually offers.
 *
 * ## Why this exists
 *
 * Discovery reads the LLM **registry**, which lists every model every registered
 * adapter advertises. That is not the same as the set a deployment intends you to
 * use: a profile with two providers mounted commonly advertises the same
 * underlying model twice (for example `deepseek-official/deepseek-flash` and
 * `commandcode/deepseek/deepseek-v4.1-flash`), and a provider may advertise far
 * more models than the user has enabled for plan or cost reasons.
 *
 * The harness already publishes the authoritative answer for delegation:
 * `subagentModelSelection.current()` returns the exact routes the user has made
 * selectable for subagents. Since every model this plugin runs is a subagent route,
 * aligning the pool with that policy is both more accurate and what the user
 * expects to see.
 *
 * ## Rules
 *
 * - The policy is applied ONLY when the service exists, is enabled, and carries at
 *   least one route. An absent, disabled, or empty policy means the deployment has
 *   not expressed a preference, and discovery stands — filtering to nothing would
 *   silently disable routing.
 * - The plugin's own `allowedRoutes` / `deniedRoutes` preferences still apply on
 *   top, so a user can narrow further without editing the subagent setting.
 * - The union is computed per exact `provider/model` route; route strings are never
 *   fuzzy-matched, because two providers may legitimately expose the same model id.
 *
 * @module dsh-model-orchestrator/route-policy
 */
import { str, uniqueStrings } from './util.js';

/**
 * Read the deployment's selectable subagent routes.
 *
 * @param ctx - the plugin context.
 * @returns `{ present, enabled, routes }` where `routes` are exact
 *   `provider/model` strings. A missing service or a throwing one reports
 *   `present: false` rather than failing discovery.
 */
export function readSubagentRoutePolicy(ctx) {
  let service;
  try {
    // A plugin context throws for a name it does not inject, so the lookup is
    // guarded even though this service is optional by design.
    service = ctx.get('subagentModelSelection');
  } catch {
    service = undefined;
  }
  if (service === undefined || typeof service.current !== 'function') {
    return { present: false, enabled: false, routes: [] };
  }

  let settings;
  try {
    settings = service.current();
  } catch {
    return { present: true, enabled: false, routes: [] };
  }
  if (settings === null || typeof settings !== 'object') {
    return { present: true, enabled: false, routes: [] };
  }

  const enabled = settings.enabled === true;
  const allowed = Array.isArray(settings.allowedModels) ? settings.allowedModels : [];
  const routes = uniqueStrings(
    allowed.map((entry) => {
      const provider = str(entry?.provider);
      const model = str(entry?.model);
      return provider === undefined || model === undefined ? undefined : `${provider}/${model}`;
    }),
  );
  return { present: true, enabled, routes };
}

/**
 * Whether a route policy should constrain discovery.
 *
 * @param policy - a result from {@link readSubagentRoutePolicy}.
 * @returns true when the policy names at least one route and is enabled.
 */
export function policyConstrains(policy) {
  return policy !== undefined && policy.enabled === true && policy.routes.length > 0;
}

/**
 * Filter a discovered pool by the deployment policy and the user's preferences.
 *
 * @param models - discovered profiles.
 * @param options - `{ policy, allowedRoutes, deniedRoutes }`.
 * @returns `{ models, droppedByPolicy, droppedByPreference, constrained }`.
 */
export function applyRoutePolicy(models, options = {}) {
  const list = Array.isArray(models) ? models : [];
  const policy = options.policy;
  const constrained = policyConstrains(policy);
  const policyRoutes = constrained ? new Set(policy.routes) : undefined;
  const allowed = new Set(uniqueStrings(options.allowedRoutes ?? []));
  const denied = new Set(uniqueStrings(options.deniedRoutes ?? []));

  const kept = [];
  const droppedByPolicy = [];
  const droppedByPreference = [];

  for (const model of list) {
    const route = str(model?.route);
    if (route === undefined) continue;
    if (policyRoutes !== undefined && !policyRoutes.has(route)) {
      droppedByPolicy.push(route);
      continue;
    }
    if (denied.has(route) || (allowed.size > 0 && !allowed.has(route))) {
      droppedByPreference.push(route);
      continue;
    }
    kept.push(model);
  }

  return { models: kept, droppedByPolicy, droppedByPreference, constrained };
}

/**
 * A short, displayable description of what constrained the pool.
 *
 * @param policy - a result from {@link readSubagentRoutePolicy}.
 * @returns a plain object the panel can render without re-deriving the rules.
 */
export function describePolicy(policy) {
  if (policy === undefined || policy.present !== true) {
    return { source: 'none', detail: 'no subagent route policy is published' };
  }
  if (policy.enabled !== true) {
    return { source: 'none', detail: 'the subagent route policy is disabled' };
  }
  if (policy.routes.length === 0) {
    return { source: 'none', detail: 'the subagent route policy lists no routes' };
  }
  return { source: 'subagent', count: policy.routes.length, routes: policy.routes };
}
