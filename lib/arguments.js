/**
 * Reading a tool call's arguments into the shape the engine expects.
 *
 * Kept out of `tools.js` on purpose: that module imports the host's `defineTool` at
 * load time, so a rule about argument placement could only be exercised on a machine
 * with a harness installed. These are plain functions, and the placement rules are
 * exactly the part that costs a real run when it is wrong.
 *
 * Two failure modes are handled, both of which did cost one.
 *
 * FIRST: a preference placed at the TOP LEVEL. The schema nests `modelPreference` and
 * `unitModelPreference` inside `analysis`, but the tool-parameter DSL accepts an extra
 * root property without complaint, so a calling model that treated them as siblings of
 * `task` had them silently discarded. A run whose caller had named a different model
 * for every unit instead routed all seven to the same one, and the result carried no
 * warning at all. The intent is unmistakable, so the value is folded in — and reported
 * as folded, so the caller learns where it belongs.
 *
 * SECOND: anything else unrecognised, including a ROUTE placed at the top level. That
 * case used to be reported as a bare argument name, which told the caller something was
 * wrong without telling them where the value belonged. Every known misplacement now
 * comes back with the location to use instead.
 *
 * @module dsh-model-orchestrator/arguments
 */
import { isRecord } from './util.js';

/** Argument keys that are folded into `analysis` rather than rejected. */
export const FOLDED_ARGUMENTS = Object.freeze(['modelPreference', 'unitModelPreference']);

/**
 * Where a mis-placed argument actually belongs.
 *
 * The whole point of the report is that a caller can fix the call without guessing, so
 * each entry names the exact parameter path.
 */
export const MISPLACED_ARGUMENTS = Object.freeze({
  route: 'a route belongs in `units[].route` (to pin one supplied unit) or in `analysis.modelPreference[].route` (as a task-level preference)',
  provider: 'a provider belongs in `units[].provider` together with `units[].model`, or in `analysis.modelPreference[]` as `{ provider, model }`',
  model: 'a model belongs in `units[].model` together with `units[].provider`, or in `analysis.modelPreference[]` as `{ provider, model }`',
  capability: 'a capability belongs in `units[].capabilityId`, in `analysis.requirements[].capability`, or as `orchestrate_dispatch`\'s own `capability` parameter',
  capabilityId: 'a per-unit capability belongs in `units[].capabilityId`, or in `analysis.requirements[].capability` for a derived plan',
  routes: 'route lists belong inside `analysis.modelPreference[].routes` (per unit) or `analysis.modelPreference` itself (task-level)',
  requirements: 'requirements belong inside `analysis.requirements`, not beside it',
  unitModelPreferences: 'the parameter is `analysis.unitModelPreference` — singular, and INSIDE `analysis`',
  modelPreferences: 'the parameter is `analysis.modelPreference` — singular, and INSIDE `analysis`',
  summary: 'the summary belongs inside `analysis.summary`',
  complexity: 'the complexity belongs inside `analysis.complexity`',
  domains: 'the domains belong inside `analysis.domains`',
  dependsOn: 'a dependency list belongs on the unit: `units[].dependsOn`',
  prompt: 'a unit prompt belongs inside `units[]`, which is this tool\'s own `units` parameter',
});

/**
 * Split a tool call's arguments into the analysis the engine uses and the report the
 * caller gets back.
 *
 * @param args - the raw tool arguments.
 * @param parameters - the tool's declared parameter map.
 * @returns `{ analysis, unusedArguments, foldedIntoAnalysis, misplacedArguments }`.
 */
export function analysisFromArguments(args, parameters) {
  const declared = new Set(Object.keys(parameters ?? {}));
  const analysis = isRecord(args?.analysis) ? { ...args.analysis } : {};
  const foldedIntoAnalysis = [];
  for (const key of FOLDED_ARGUMENTS) {
    if (analysis[key] === undefined && Array.isArray(args?.[key])) {
      analysis[key] = args[key];
      foldedIntoAnalysis.push(key);
    }
  }
  // A folded key is USED, so it must not also be reported as unused: the first
  // version listed it in both, which is the kind of contradiction this whole change
  // exists to remove.
  const unusedArguments = Object.keys(isRecord(args) ? args : {}).filter(
    (key) => !declared.has(key) && args[key] !== undefined && !foldedIntoAnalysis.includes(key),
  );
  const misplacedArguments = unusedArguments
    .filter((key) => MISPLACED_ARGUMENTS[key] !== undefined)
    .map((key) => ({ argument: key, guidance: MISPLACED_ARGUMENTS[key] }));
  return { analysis, unusedArguments, foldedIntoAnalysis, misplacedArguments };
}

/**
 * The report both analysis-taking tools return, and omit when empty.
 *
 * @param report - a {@link analysisFromArguments} result.
 * @returns the fields to merge into the tool output.
 */
export function argumentReport({ unusedArguments, foldedIntoAnalysis, misplacedArguments }) {
  const misplaced = Array.isArray(misplacedArguments) ? misplacedArguments : [];
  return {
    ...(unusedArguments.length === 0 ? {} : { unusedArguments }),
    // Named separately because it is the actionable half: an unused argument says
    // "this did nothing", a misplaced one says where it should have gone.
    ...(misplaced.length === 0 ? {} : { misplacedArguments: misplaced }),
    ...(foldedIntoAnalysis.length === 0 ? {} : { foldedIntoAnalysis }),
  };
}
