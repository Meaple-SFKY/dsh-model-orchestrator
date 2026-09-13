/**
 * Dynamic model discovery and capability profiling.
 *
 * The pool is read from the live LLM service on every refresh. Nothing about a
 * model is hardcoded: no model id, provider, or vendor name appears in this
 * file. A model that appears in the pool is profiled on the spot; a model that
 * disappears is dropped.
 *
 * Evidence is layered and each layer is tagged with where it came from, so the
 * matcher can weight a measured fact above an inferred one and so the UI can be
 * honest about what is known:
 *
 *   `metadata`  — authoritative host facts (modality, context, output, efforts)
 *   `declared`  — the provider's own description/name text
 *   `calibrated`— the model's answer to the orchestrator's own self-probe
 *
 * @module dsh-model-orchestrator/discovery
 */
import { isRecord, str, uniqueStrings, routeKey, tokenize, uint, stableHash } from './util.js';
import { applyRoutePolicy, describePolicy, readSubagentRoutePolicy } from './route-policy.js';

/** Where one piece of evidence came from, strongest first. */
export const EVIDENCE_SOURCES = Object.freeze(['metadata', 'calibrated', 'declared']);

/** Relative trust per evidence source. */
export const SOURCE_CONFIDENCE = Object.freeze({
  metadata: 1,
  calibrated: 0.8,
  declared: 0.45,
});

/**
 * @typedef {object} ModelProfile
 * @property {string} route
 * @property {string} provider
 * @property {string} model
 * @property {string} name
 * @property {string} [description]
 * @property {number} confidence   // 0..1, how well evidenced this profile is
 * @property {string[]} evidence   // sources that contributed
 * @property {object} facts        // authoritative host facts
 * @property {object} derived      // inferences with their provenance
 */

/** Read the raw authoritative facts for one route. */
async function readFacts(llm, provider, model, signal) {
  const facts = {
    modalities: undefined,
    contextWindow: undefined,
    defaultMaxTokens: undefined,
    efforts: undefined,
    defaultEffort: undefined,
    name: undefined,
    description: undefined,
  };

  // `listModels` is the cheap, always-available catalog view.
  try {
    const catalog = await llm.listModels(provider);
    const entry = Array.isArray(catalog) ? catalog.find((row) => row?.id === model) : undefined;
    if (entry !== undefined) {
      if (Array.isArray(entry.inputModalities)) {
        facts.modalities = uniqueStrings(entry.inputModalities);
      }
      facts.name = str(entry.name);
      facts.description = str(entry.description);
    }
  } catch {
    // Advisory catalog failure is not fatal: `resolveModelInfo` may still work.
  }

  // `resolveModelInfo` is the exact-route, authoritative view.
  try {
    const resolved = await llm.resolveModelInfo(provider, model, signal);
    if (isRecord(resolved)) {
      if (Array.isArray(resolved.inputModalities)) {
        facts.modalities = uniqueStrings(resolved.inputModalities);
      }
      const contextWindow = uint(resolved.context?.contextWindow);
      if (contextWindow !== undefined) facts.contextWindow = contextWindow;
      const defaultMaxTokens = uint(resolved.defaultMaxTokens);
      if (defaultMaxTokens !== undefined) facts.defaultMaxTokens = defaultMaxTokens;
      if (Array.isArray(resolved.reasoning?.efforts)) {
        facts.efforts = uniqueStrings(resolved.reasoning.efforts.map((effort) => effort?.id));
      }
      const defaultEffort = str(resolved.reasoning?.defaultEffort);
      if (defaultEffort !== undefined) facts.defaultEffort = defaultEffort;
      // Reasoning arrives in three states, and collapsing them loses the one that
      // changes routing: a provider that reasons WITHOUT exposing a level to pick
      // (the model thinks, the provider drives the depth) is not a model that
      // cannot reason, and treating it as one rejected it from difficult work.
      if (resolved.reasoning === undefined || resolved.reasoning === null) {
        facts.reasoningMode = 'none';
      } else {
        facts.reasoningMode =
          Array.isArray(facts.efforts) && facts.efforts.length > 0 ? 'adjustable' : 'automatic';
      }
      facts.name = str(resolved.name) ?? facts.name;
      facts.description = str(resolved.description) ?? facts.description;
    }
  } catch {
    // An exact-route resolution failure leaves the catalog facts in place.
  }

  return facts;
}

/**
 * Derive searchable text for one model from its declared identity.
 *
 * Only host-provided text is used: the model's own name and description. This is
 * the weakest evidence layer and is always overridable.
 */
function declaredText(facts, provider, model) {
  return [facts.name, facts.description, model, provider].filter((part) => typeof part === 'string').join(' ');
}

/**
 * Classify a model into a coarse capability tier from *only* measurable facts.
 *
 * The tier is a summary for display and for tie-breaking; it is never used to
 * bypass the requirement checks in the matcher.
 *
 * @param facts - authoritative facts.
 * @returns `'deep'|'balanced'|'fast'|'unknown'`.
 */
export function classifyTier(facts) {
  // "Reasons at all", not "has a level to pick": an automatic-reasoning model is a
  // deep model by the same evidence the adjustable one is.
  const hasReasoning =
    (Array.isArray(facts.efforts) && facts.efforts.length > 0) ||
    facts.reasoningMode === 'automatic';
  const context = facts.contextWindow ?? 0;
  const output = facts.defaultMaxTokens ?? 0;
  // One branch, not two: the first version tested a window/output threshold and
  // returned the same thing the next line returned unconditionally, so the
  // threshold never decided anything.
  if (hasReasoning) return 'deep';
  if (context >= 64000 || output >= 8192) return 'balanced';
  if (context > 0 || output > 0) return 'fast';
  return 'unknown';
}

/**
 * Build a profile for one discovered model.
 *
 * @param facts - authoritative facts from {@link readFacts}.
 * @param provider - provider route id.
 * @param model - model id.
 * @param calibration - optional calibrated claims: `{ keywords: string[],
 *   strengths: string[], limits?: string }`.
 * @returns {ModelProfile}
 */
export function buildProfile(facts, provider, model, calibration) {
  const evidence = ['metadata'];
  const derived = {};

  const declaredTokens = new Set(tokenize(declaredText(facts, provider, model)));
  derived.keywords = [...declaredTokens];
  derived.keywordSource = 'declared';

  // Only assert modality when the host actually stated it. An absent
  // `inputModalities` means unknown, which is not the same as "no image input".
  derived.supportsImage =
    facts.modalities === undefined ? undefined : facts.modalities.includes('image');
  derived.modalities = facts.modalities;

  derived.tier = classifyTier(facts);
  derived.hasReasoning = Array.isArray(facts.efforts) && facts.efforts.length > 0;

  let confidence = 0.4;
  if (facts.modalities !== undefined) confidence += 0.15;
  if (facts.contextWindow !== undefined) confidence += 0.15;
  if (facts.defaultMaxTokens !== undefined) confidence += 0.1;
  if (Array.isArray(facts.efforts)) confidence += 0.1;
  if (facts.description !== undefined) confidence += 0.05;

  if (isRecord(calibration)) {
    const calibratedKeywords = uniqueStrings(calibration.keywords ?? []);
    if (calibratedKeywords.length > 0) {
      evidence.push('calibrated');
      derived.keywords = uniqueStrings([...derived.keywords, ...calibratedKeywords]);
      derived.keywordSource = 'calibrated+declared';
      derived.strengths = uniqueStrings(calibration.strengths ?? []);
      derived.calibratedAt = uint(calibration.at);
      confidence = Math.min(1, confidence + 0.2);
    }
    const limits = str(calibration.limits);
    if (limits !== undefined) derived.calibratedLimits = limits;
  }

  if (facts.description !== undefined && !evidence.includes('declared')) evidence.push('declared');

  return {
    route: routeKey(provider, model),
    provider,
    model,
    name: facts.name ?? model,
    ...(facts.description === undefined ? {} : { description: facts.description }),
    confidence: Number(confidence.toFixed(2)),
    evidence,
    facts: { ...facts },
    derived: { ...derived, keywords: derived.keywords ?? [] },
    fingerprint: stableHash(
      JSON.stringify([
        facts.modalities ?? null,
        facts.contextWindow ?? null,
        facts.defaultMaxTokens ?? null,
        facts.efforts ?? null,
        facts.name ?? null,
        facts.description ?? null,
        derived.calibratedAt ?? null,
      ]),
    ),
  };
}

/**
 * Discover every model in every registered provider and profile each one.
 *
 * @param ctx - the plugin context (needs `llm`).
 * @param options - `{ signal, calibrations, onProblem }`.
 * @returns `{ models: ModelProfile[], problems: string[], discoveredAt: number }`.
 */
export async function discoverModels(ctx, options = {}) {
  const llm = ctx.get('llm');
  const problems = [];
  const models = [];
  const seen = new Set();

  if (llm === undefined || typeof llm.listProviders !== 'function') {
    return { models: [], problems: ['Service "llm" is unavailable'], discoveredAt: Date.now() };
  }

  let providers = [];
  try {
    providers = llm.listProviders() ?? [];
  } catch (error) {
    return {
      models: [],
      problems: [`llm.listProviders() failed: ${String(error?.message ?? error)}`],
      discoveredAt: Date.now(),
    };
  }

  const calibrations = isRecord(options.calibrations) ? options.calibrations : {};

  for (const provider of providers) {
    if (options.signal?.aborted) break;
    const providerId = str(provider?.id);
    if (providerId === undefined) continue;

    let catalog = [];
    try {
      catalog = (await llm.listModels(providerId)) ?? [];
    } catch (error) {
      const problem = `provider "${providerId}" could not list models: ${String(error?.message ?? error)}`;
      problems.push(problem);
      options.onProblem?.(problem);
      continue;
    }

    for (const entry of Array.isArray(catalog) ? catalog : []) {
      const modelId = str(entry?.id);
      if (modelId === undefined) continue;
      const key = routeKey(providerId, modelId);
      if (key === undefined || seen.has(key)) continue;
      seen.add(key);

      const facts = await readFacts(llm, providerId, modelId, options.signal);
      // The catalog entry is authoritative for identity text when resolution
      // did not supply it.
      facts.name = facts.name ?? str(entry?.name);
      facts.description = facts.description ?? str(entry?.description);
      if (facts.modalities === undefined && Array.isArray(entry?.inputModalities)) {
        facts.modalities = uniqueStrings(entry.inputModalities);
      }
      models.push(buildProfile(facts, providerId, modelId, calibrations[key]));
    }
  }

  models.sort((left, right) => left.route.localeCompare(right.route));
  return { models, problems, discoveredAt: Date.now(), advertised: models.length };
}

/**
 * The live pool. Holds the latest discovery result and re-discovers on demand
 * and whenever the LLM adapter topology changes.
 *
 * The pool is never persisted. Only calibrations (keyed by route) survive a
 * restart, and a calibration whose route is absent from the pool is inert.
 */
export class ModelPool {
  #models = [];
  #problems = [];
  #discoveredAt = 0;
  #calibrations = {};
  #preferences = {};
  #policy = { present: false, enabled: false, routes: [] };
  #filtered = { droppedByPolicy: [], droppedByPreference: [], constrained: false };
  #refreshing;
  #lastError;

  constructor(calibrations = {}, preferences = {}) {
    this.#calibrations = isRecord(calibrations) ? calibrations : {};
    // The user's own route preferences narrow the pool on top of the
    // deployment's subagent policy.
    this.#preferences = isRecord(preferences) ? preferences : {};
  }

  /** Current profiles. */
  models() {
    return this.#models;
  }

  /** Problems from the last discovery. */
  problems() {
    return this.#problems;
  }

  /** The deployment route policy read during the last refresh. */
  policy() {
    return { ...this.#policy };
  }

  /** A displayable account of what the policy and preferences excluded. */
  filterReport() {
    return {
      ...this.#filtered,
      policy: describePolicy(this.#policy),
    };
  }

  /**
   * Replace the user's route preferences.
   *
   * The next refresh re-applies them, so a preference change takes effect on the
   * pool rather than only on the next match.
   */
  setPreferences(preferences) {
    this.#preferences = isRecord(preferences) ? preferences : {};
  }

  /** When the pool was last refreshed. */
  discoveredAt() {
    return this.#discoveredAt;
  }

  /** The last refresh failure, if any. */
  lastError() {
    return this.#lastError;
  }

  /** Look up one profile by `provider/model`. */
  get(route) {
    const key = str(route);
    return key === undefined ? undefined : this.#models.find((model) => model.route === key);
  }

  /** All distinct provider ids currently holding at least one model. */
  providers() {
    return uniqueStrings(this.#models.map((model) => model.provider));
  }



  /**
   * Re-read the live pool.
   *
   * Concurrent callers share one in-flight discovery so an event storm cannot
   * multiply provider I/O.
   *
   * @param ctx - plugin context.
   * @param options - `{ signal }`.
   * @returns the discovery result.
   */
  async refresh(ctx, options = {}) {
    if (this.#refreshing !== undefined) return this.#refreshing;
    this.#refreshing = (async () => {
      try {
        const result = await discoverModels(ctx, {
          signal: options.signal,
          calibrations: this.#calibrations,
        });
        // Discovery reads the registry; the deployment's subagent route policy and
        // the user's own preferences decide which of those routes are actually on
        // offer. Filtering here means every downstream consumer — matching, the
        // panel, the tools — sees the same pool.
        const policy = readSubagentRoutePolicy(ctx);
        const filtered = applyRoutePolicy(result.models, {
          policy,
          allowedRoutes: this.#preferences.allowedRoutes,
          deniedRoutes: this.#preferences.deniedRoutes,
        });

        this.#models = filtered.models;
        this.#policy = policy;
        this.#filtered = {
          droppedByPolicy: filtered.droppedByPolicy,
          droppedByPreference: filtered.droppedByPreference,
          constrained: filtered.constrained,
        };
        this.#problems = [
          ...result.problems,
          // If the policy would leave NOTHING routable, say so plainly instead of
          // presenting an empty pool as if the deployment had no models.
          ...(filtered.constrained && filtered.models.length === 0
            ? [
                `the deployment's subagent route policy matched none of the ${result.models.length} advertised model(s), so nothing is routable`,
              ]
            : []),
        ];
        this.#discoveredAt = result.discoveredAt;
        this.#lastError = undefined;
        return result;
      } catch (error) {
        this.#lastError = String(error?.message ?? error);
        this.#problems = [this.#lastError];
        throw error;
      } finally {
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  }
}

/** A stable identity for a discovery snapshot, for change detection in the UI. */
export function poolFingerprint(pool) {
  return stableHash(pool.models().map((model) => `${model.route}:${model.fingerprint}`).join('|'));
}

/**
 * Domains a model's OWN declaration names, matched against the taxonomy's cues.
 *
 * This is the only per-domain evidence the harness can offer: a provider's
 * description of its model. A model with no description yields an empty list, and
 * the panel says so rather than inventing an assessment. The returned labels are
 * descriptor labels, so the panel never has to own a domain vocabulary.
 *
 * @param model - one profile.
 * @param taxonomy - the taxonomy whose descriptors supply the cue vocabulary.
 * @returns up to `limit` matched descriptor labels, strongest first.
 */
export function declaredDomains(model, taxonomy, limit = 4) {
  const text = [model?.description, model?.name].filter((part) => typeof part === 'string').join(' ');
  if (text.trim() === '') return [];
  const tokens = new Set(tokenize(text));
  const scored = [];
  for (const descriptor of taxonomy.list()) {
    // A descriptor only contributes cues when it names a real subject area;
    // level descriptors (`depth.*`, `capacity.*`) are not domains.
    if (descriptor.group === 'depth' || descriptor.group === 'capacity') continue;
    let hits = 0;
    let total = 0;
    for (const sig of descriptor.signals) {
      if (sig.type !== 'keywords') continue;
      for (const keyword of sig.keywords ?? []) {
        total += 1;
        const wanted = tokenize(keyword);
        if (wanted.length === 0) continue;
        const matched = wanted.every((token) =>
          [...tokens].some(
            (present) =>
              present === token ||
              (token.length >= 5 && present.length >= 5 && (present.startsWith(token) || token.startsWith(present))),
          ),
        );
        if (matched) hits += 1;
      }
    }
    if (hits > 0 && total > 0) scored.push({ label: descriptor.label, id: descriptor.id, hits });
  }
  scored.sort((left, right) => right.hits - left.hits || left.label.localeCompare(right.label));
  return scored.slice(0, limit).map((entry) => entry.label);
}
