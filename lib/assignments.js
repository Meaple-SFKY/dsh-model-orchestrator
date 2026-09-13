/**
 * Capability assignments: the user's standing division of labour.
 *
 * "Vision goes to Gemini, maths to Qwen, engineering to DeepSeek, architecture to
 * GPT" is a POLICY, not a per-task decision — and the version of this plugin that
 * could only express it per task, through the calling model's own analysis, was
 * the gap between the product and the intent it was built for.
 *
 * An entry is keyed by a capability id or a capability group, and holds an ordered
 * list of model targets. Targets are resolved against the live pool through
 * {@link module:dsh-model-orchestrator/model-identity} on every use, so the table
 * survives a model being renamed, moved behind another provider, or version-bumped
 * — which is the whole point of storing intent rather than routes.
 *
 * Two decisions are deliberate and load-bearing:
 *
 *  1. **The table is a default, not a lock.** It supplies the preference order the
 *     matcher reorders eligible candidates by. It cannot revive a route a hard
 *     requirement or the deployment's route policy excluded, and the calling model
 *     can still beat it for one unit with `analysis.unitModelPreference`, because
 *     that is the more specific statement about that unit.
 *  2. **Nothing is rejected for pointing at a model that is absent right now.**
 *     The pool churns, so "not in the pool today" is a normal state for a table
 *     meant to outlive the pool. Unresolved targets are REPORTED — at configure
 *     time, in `orchestrate_status`, and in the panel — never silently dropped and
 *     never allowed to fall back without saying so.
 *
 * @module dsh-model-orchestrator/assignments
 */
import { isRecord, str, uniqueStrings } from './util.js';
import { resolveAssignments as resolveTargets } from './model-identity.js';

/** Longest ordered target list one capability may carry. */
const MAX_TARGETS = 8;

/**
 * Validate and normalise a `{ key: { models, family } }` assignment map.
 *
 * A bare string or array is accepted as shorthand for the model list, because the
 * panel and a hand-written config both read better that way.
 *
 * @param input - the requested map.
 * @returns a normalised map, dropping entries with no usable target.
 */
export function normalizeAssignments(input) {
  const out = {};
  if (!isRecord(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    const name = str(key);
    if (name === undefined) continue;
    const raw = isRecord(value) ? value.models : value;
    const list = Array.isArray(raw) ? raw : [raw];
    const models = uniqueStrings(
      list.map((entry) => str(entry)).filter((entry) => entry !== undefined),
    ).slice(0, MAX_TARGETS);
    if (models.length === 0) continue;
    out[name] = {
      models,
      // Following a family is the user's judgement: a version bump is usually the
      // same model, but not always, so it is never assumed.
      family: isRecord(value) ? value.family === true : false,
    };
  }
  return out;
}

/**
 * Resolve every assignment against the live pool.
 *
 * @param assignments - the stored map.
 * @param models - live pool rows (`{ route, model, name }`).
 * @returns `{ entries, byKey, routes, unresolved, unassigned }`.
 */
export function resolveAssignments(assignments, models) {
  const normalized = normalizeAssignments(assignments);
  const entries = [];
  const byKey = new Map();
  const routes = [];
  const unresolved = [];

  for (const [key, entry] of Object.entries(normalized)) {
    const resolved = resolveTargets(entry.models, models, { family: entry.family });
    const record = {
      key,
      models: entry.models,
      family: entry.family,
      routes: resolved.routes,
      resolved: resolved.resolved,
      unresolved: resolved.unresolved,
    };
    entries.push(record);
    byKey.set(key, record);
    for (const route of resolved.routes) if (!routes.includes(route)) routes.push(route);
    for (const target of resolved.unresolved) unresolved.push({ key, target });
  }

  // Routes the live pool offers that no assignment mentions at all. Surfaced so a
  // model appearing in the pool is a decision the user gets to make, rather than
  // something the table silently ignores.
  const unassigned = [];
  for (const model of Array.isArray(models) ? models : []) {
    const route = str(model?.route);
    if (route !== undefined && !routes.includes(route)) unassigned.push(route);
  }

  return { entries, byKey, routes, unresolved, unassigned, count: entries.length };
}

/**
 * The preference order an assignment supplies for one unit.
 *
 * Most specific key wins: the exact capability, then its group. A key that
 * resolves to nothing does NOT shadow the more general one — an entry whose models
 * have all left the pool should let the group entry (or the measured ranking) take
 * over, and report itself unresolved separately.
 *
 * @param report - a {@link resolveAssignments} result.
 * @param target - `{ capability, group }` for the unit.
 * @returns an ordered route list, or `undefined` when no usable entry applies.
 */
export function preferenceFor(report, { capability, group }) {
  for (const key of [capability, group]) {
    const name = str(key);
    if (name === undefined) continue;
    const entry = report?.byKey?.get(name);
    if (entry !== undefined && entry.routes.length > 0) return entry.routes;
  }
  return undefined;
}

/**
 * A stable string identifying which preference a capability would use.
 *
 * Unit composition uses it to decide what may share a unit: two capabilities in
 * one cluster with the SAME preference are one delegation, but different
 * preferences must not be merged, or "architecture to GPT, implementation to
 * DeepSeek" would collapse back into a single unit on a single model — which is
 * exactly the case this feature exists for.
 *
 * @param report - a {@link resolveAssignments} result.
 * @param target - `{ capability, group }`.
 * @returns the signature; `''` when nothing applies.
 */
export function preferenceSignature(report, { capability, group }) {
  return (preferenceFor(report, { capability, group }) ?? []).join('|');
}

/**
 * Validate an assignment patch without rejecting absent models.
 *
 * Shape is strict — a capability id the taxonomy does not know, or a non-string
 * target, is a mistake worth refusing — while a target that simply is not in the
 * pool right now is accepted and reported, because that is a normal state for a
 * table meant to outlive the pool.
 *
 * @param input - the requested map.
 * @param options - `{ taxonomy, models }`.
 * @returns `{ patch, rejected, resolved, unresolved }`.
 */
export function assignmentPatch(input, { taxonomy, models } = {}) {
  const patch = {};
  const rejected = [];
  if (input === undefined) return { patch, rejected, resolved: [], unresolved: [] };
  if (!isRecord(input)) {
    return {
      patch,
      rejected: ['capabilityAssignments: expected an object keyed by capability'],
      resolved: [],
      unresolved: [],
    };
  }

  for (const [key, value] of Object.entries(input)) {
    const name = str(key);
    if (name === undefined) continue;
    // `null` clears the entry: the capability goes back to the measured ranking.
    if (value === null) {
      patch[name] = null;
      continue;
    }
    const known =
      typeof taxonomy?.has === 'function' && taxonomy.has(name);
    const isGroup =
      typeof taxonomy?.list === 'function' &&
      taxonomy.list().some((descriptor) => descriptor.group === name);
    if (!known && !isGroup) {
      rejected.push(`capabilityAssignments.${name}: unknown capability or group`);
      continue;
    }
    const normalized = normalizeAssignments({ [name]: value });
    if (normalized[name] === undefined) {
      rejected.push(`capabilityAssignments.${name}: expected a model target or a list of them`);
      continue;
    }
    patch[name] = normalized[name];
  }

  const preview = resolveAssignments(
    Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null)),
    models,
  );
  return {
    patch,
    rejected,
    resolved: preview.entries.flatMap((entry) =>
      entry.resolved.map((match) => ({ key: entry.key, target: match.target, kind: match.kind, routes: match.routes })),
    ),
    unresolved: preview.unresolved,
  };
}

/**
 * Merge a validated patch into a stored map.
 *
 * Merged, not replaced: the panel edits one capability at a time, and replacing
 * the map would drop every other entry.
 *
 * @param current - the stored map.
 * @param patch - entries from {@link assignmentPatch}.
 * @returns the next map.
 */
export function mergeAssignmentPatch(current, patch) {
  const next = { ...(isRecord(current) ? current : {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}
