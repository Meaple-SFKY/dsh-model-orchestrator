/**
 * Reasoning-effort preferences, keyed by `provider/model`.
 *
 * A level is only meaningful against the route's own advertised ids: DSH reports
 * them per model (`reasoning.efforts`) and rejects anything else at call time with
 * `UNSUPPORTED_REASONING_EFFORT`. So a preference is validated against the LIVE
 * pool when it is set, and re-checked when it is used — an adapter change must
 * degrade a stale preference, not fail a delegation.
 *
 * Validation lives here, host-free, because two surfaces accept the same patch:
 * the panel's control route and `orchestrate_configure`.
 *
 * @module dsh-model-orchestrator/reasoning-effort
 */
import { isRecord, str } from './util.js';

/**
 * Validate a `{ "<provider>/<model>": "<effort>" | null }` patch.
 *
 * `null` (or an empty string) clears the preference, so the route goes back to the
 * level the model resolves for itself.
 *
 * @param input - the requested patch.
 * @param pool - the live pool; `get(route)` must return a profile.
 * @returns `{ patch, rejected }`, where each patch entry is `{ route, effort }`
 *   and `effort` is `undefined` for a clear.
 */
export function effortPatch(input, pool) {
  const patch = [];
  const rejected = [];
  if (input === undefined) return { patch, rejected };
  if (!isRecord(input)) {
    return { patch, rejected: ['reasoningEffort: expected an object keyed by "provider/model"'] };
  }

  for (const [route, value] of Object.entries(input)) {
    if (value === null || value === '') {
      patch.push({ route, effort: undefined });
      continue;
    }
    const effort = str(value);
    if (effort === undefined) {
      rejected.push(`reasoningEffort.${route}: expected an effort id or null`);
      continue;
    }
    const profile = typeof pool?.get === 'function' ? pool.get(route) : undefined;
    if (profile === undefined) {
      rejected.push(`reasoningEffort.${route}: not in the live model pool`);
      continue;
    }
    const efforts = Array.isArray(profile.facts?.efforts) ? profile.facts.efforts : [];
    if (efforts.length === 0) {
      rejected.push(`reasoningEffort.${route}: the route advertises no reasoning efforts`);
      continue;
    }
    if (!efforts.includes(effort)) {
      rejected.push(`reasoningEffort.${route}: "${effort}" is not one of ${efforts.join(', ')}`);
      continue;
    }
    patch.push({ route, effort });
  }

  return { patch, rejected };
}

/**
 * Merge a validated patch into a preference map.
 *
 * Merged rather than replaced: the panel's selector sends only the route it
 * changed, and replacing the map would drop every other choice.
 *
 * @param current - the stored map.
 * @param patch - entries from {@link effortPatch}.
 * @returns the next map.
 */
export function mergeEffortPatch(current, patch) {
  const next = { ...(isRecord(current) ? current : {}) };
  for (const { route, effort } of patch) {
    if (effort === undefined) delete next[route];
    else next[route] = effort;
  }
  return next;
}
