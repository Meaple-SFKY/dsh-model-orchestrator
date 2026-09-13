/**
 * Decision vocabulary: the cues the plugin may use when NO model supplied an
 * analysis.
 *
 * ## Why this module exists
 *
 * Judging a task — is it deep work or routine, is it one step or a pipeline, does
 * it carry material the model must read — is a decision. Embedding that decision
 * as a phrase list inside the plugin is the wrong shape: the list only recognizes
 * the wording its author happened to think of, it cannot generalize to a paraphrase
 * or a language it was not written for, and it silently outranks the judgement of
 * the model that is actually reading the task.
 *
 * So the plugin treats its own lists as a FALLBACK and nothing more:
 *
 * - When a calling model supplies an analysis, that analysis is used as given. The
 *   lists here are never consulted, and the model's complexity judgement is
 *   authoritative rather than a floor to be raised.
 * - When nothing is supplied, these defaults let the plugin still route, because a
 *   plugin that refuses to act without a model would be useless in the one case it
 *   exists to serve.
 * - Any list can be replaced at runtime through `orchestrate_configure`, so an
 *   operator is never stuck with the author's vocabulary.
 *
 * Every default list is deliberately small and obviously a hint rather than a
 * definition, to keep it from looking like an authority it is not.
 *
 * @module dsh-model-orchestrator/decision-vocabulary
 */
import { str, uniqueStrings } from './util.js';

/**
 * The built-in fallback cues, used only when no model analysis is supplied.
 *
 * @returns a fresh, mutable copy so a caller can replace any list.
 */
export function defaultCues() {
  return {
    multiStep: [
      'then', 'after that', 'and also', 'finally', 'first', 'second', 'third',
      'step', 'pipeline', 'end to end', 'end-to-end',
    ],
    trivial: [
      'rename', 'typo', 'one line', 'single line', 'what is', 'define', 'list the',
    ],
    parallel: [
      'in parallel', 'concurrently', 'at the same time', 'compare', 'across',
      'each of', 'respectively',
    ],
    deep: [
      'prove', 'proof', 'theorem', 'derive', 'root cause', 'debug', 'verify',
      'audit', 'review', 'assess', 'evaluate', 'critique', 'design', 'architect',
      'trade-off', 'optimize', 'analyze', 'diagnose', 'investigate', 'formal',
    ],
    routine: [
      'rename', 'format', 'typo', 'lint', 'boilerplate', 'extract', 'convert',
      'translate', 'summarize', 'count',
    ],
    image: [
      'image', 'screenshot', 'picture', 'photo', 'diagram', 'figure', 'attached',
      'visual', 'render',
    ],
  };
}

/** The cue lists a caller may replace, in a fixed order for reporting. */
export const CUE_GROUPS = Object.freeze([
  'multiStep',
  'trivial',
  'parallel',
  'deep',
  'routine',
  'image',
]);

/**
 * Merge caller-supplied cues over the defaults.
 *
 * @param overrides - a partial cue map. A non-array or empty value is ignored, so
 *   a caller cannot accidentally disable a whole dimension by passing nothing.
 * @returns `{ cues, replaced }` where `replaced` names the groups the caller owns.
 */
export function resolveCues(overrides) {
  const cues = defaultCues();
  const replaced = [];
  if (overrides === null || typeof overrides !== 'object') return { cues, replaced };
  for (const group of CUE_GROUPS) {
    const supplied = overrides[group];
    if (!Array.isArray(supplied)) continue;
    const cleaned = uniqueStrings(supplied.map((entry) => str(entry)?.toLowerCase()));
    if (cleaned.length === 0) continue;
    cues[group] = cleaned;
    replaced.push(group);
  }
  return { cues, replaced };
}

/**
 * Read a cue map from stored preferences.
 *
 * @param preferences - the plugin's preference object.
 * @returns a resolved cue map plus which groups the operator replaced.
 */
export function cuesFromPreferences(preferences) {
  const stored = preferences?.decisionCues;
  return resolveCues(stored);
}

/**
 * Describe the current cue configuration for a model or an operator.
 *
 * @param preferences - the plugin's preference object.
 * @returns a plain, JSON-safe report.
 */
export function describeCues(preferences) {
  const { cues, replaced } = cuesFromPreferences(preferences);
  return {
    source: replaced.length > 0 ? 'operator' : 'built-in-fallback',
    replacedGroups: replaced,
    groups: CUE_GROUPS.map((group) => ({ group, count: cues[group].length })),
  };
}
