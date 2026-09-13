/**
 * Preference patches: one implementation, two surfaces.
 *
 * The panel's control route and the model-facing `orchestrate_configure` tool accept
 * the same vocabulary, so they must not each decide what it means. They were
 * separate copies and they drifted — the tool advertised `decisionCues` in its
 * schema and silently ignored it, and its validation was weaker than the route's
 * in several places, while a comment claimed the rules were shared.
 *
 * Host-free: it touches only the store, the live pool and the taxonomy, so it is
 * testable without a harness.
 *
 * @module dsh-model-orchestrator/preferences
 */
import { str, uint } from './util.js';
import { CUE_GROUPS, resolveCues } from './decision-vocabulary.js';
import { effortPatch, mergeEffortPatch } from './reasoning-effort.js';
import { assignmentPatch, mergeAssignmentPatch } from './assignments.js';

/**
 * Apply a validated preference patch.
 *
 * THE ONE implementation: the control route and `orchestrate_configure` both call
 * this. They used to be separate, and they drifted — the tool advertised
 * `decisionCues` in its schema and silently ignored it, while its validation was
 * weaker than the route's, which is what "shared with the configure tool's rules"
 * claimed and did not mean.
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
export function applyPreferencePatch(store, body, pool, taxonomy) {
  const applied = [];
  const rejected = [];

  // Reported rather than refused: an unknown id may be a capability this taxonomy
  // has not learned yet, so the caller is told instead of being blocked.
  const unknownCapabilities = Array.isArray(body.guidedCapabilities)
    ? body.guidedCapabilities.filter((id) => !taxonomy?.has?.(id))
    : [];

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

  // Nothing valid to apply: report rather than silently ignoring the request — and
  // do not write, because a patch that changes nothing must not touch the file.
  if (applied.length === 0) {
    const valid = Object.keys(body).filter(
      (key) => !rejected.some((entry) => entry.startsWith(`${key}:`)),
    );
    if (rejected.length > 0 && valid.length === 0) {
      return { applied, rejected, ...(unknownCapabilities.length === 0 ? {} : { unknownCapabilities }) };
    }
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
    ...(unknownCapabilities.length === 0 ? {} : { unknownCapabilities }),
  };
}
