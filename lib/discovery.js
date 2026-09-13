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
  const hasReasoning = Array.isArray(facts.efforts) && facts.efforts.length > 0;
  const context = facts.contextWindow ?? 0;
  const output = facts.defaultMaxTokens ?? 0;
  if (hasReasoning && (context >= 128000 || output >= 8192)) return 'deep';
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
  return { models, problems, discoveredAt: Date.now() };
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
  #listeners = new Set();
  #refreshing;
  #lastError;

  constructor(calibrations = {}) {
    this.#calibrations = isRecord(calibrations) ? calibrations : {};
  }

  /** Current profiles. */
  models() {
    return this.#models;
  }

  /** Problems from the last discovery. */
  problems() {
    return this.#problems;
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

  /** Subscribe to pool changes. Returns a disposer. */
  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    for (const listener of [...this.#listeners]) {
      try {
        listener(this);
      } catch {
        // An observer must never break a refresh.
      }
    }
  }

  /** Replace the stored calibrations (used after a calibration run). */
  setCalibrations(calibrations) {
    this.#calibrations = isRecord(calibrations) ? calibrations : {};
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
        const previous = this.#models.map((model) => `${model.route}:${model.fingerprint}`).join('|');
        this.#models = result.models;
        this.#problems = result.problems;
        this.#discoveredAt = result.discoveredAt;
        this.#lastError = undefined;
        const next = this.#models.map((model) => `${model.route}:${model.fingerprint}`).join('|');
        if (previous !== next) this.#emit();
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
 * Capability rating for a whole pool, computed from measured facts only.
 *
 * ## Why these are RELATIVE
 *
 * The host exposes no absolute quality score and no price. What it does expose is
 * measurable: whether a model advertises reasoning efforts, its context window,
 * the output budget the deployment sends, and which input modalities it accepts.
 * A rating is therefore computed **within the current pool**, so a 5-star model is
 * the strongest one available right now, not an absolute claim. Removing the
 * strongest model promotes the next one — which is the honest behavior, and the
 * reason the panel says so.
 *
 * No model name, provider, or vendor takes part in this computation.
 *
 * @param models - profiles from one discovery pass.
 * @returns a map of route to `{ stars, comparable, score }`, where `stars` is
 *   `null` when the pool has no measurable spread (nothing to rank).
 */
export function ratePool(models) {
  const rateable = Array.isArray(models) ? models : [];

  // ---- capability index ----------------------------------------------------
  // log2 of the context window so a 1M-token window does not dominate a 128k one;
  // this is capacity, not quality, and is weighted as such.
  const index = rateable.map((model) => {
    const context = model.facts?.contextWindow ?? 0;
    const capacity = context > 0 ? Math.log2(context) : 0;
    const reasoning = model.derived?.hasReasoning === true ? 1 : 0;
    const breadth = (model.facts?.modalities?.length ?? 0) > 1 ? 1 : 0;
    return {
      route: model.route,
      value: reasoning * 2 + capacity + breadth * 0.5,
      reasoning,
      capacity,
      breadth,
    };
  });

  const values = index.map((entry) => entry.value);
  const max = values.length > 0 ? Math.max(...values) : 0;
  const min = values.length > 0 ? Math.min(...values) : 0;
  const span = max - min;

  // A pool with no measurable spread has nothing to rank. Presenting "5 stars"
  // there would read as an absolute top score when it only means "equal to the
  // only thing we have", so the rating is withheld (`stars: null`) and the panel
  // says the models are equivalent on measured capability.
  const comparable = span > 0;

  const ratings = {};
  for (const entry of index) {
    const normalized = comparable ? (entry.value - min) / span : null;
    const stars = comparable
      ? Math.max(1, Math.min(5, Math.round(1 + normalized * 4)))
      : null;
    ratings[entry.route] = {
      stars,
      comparable,
      score: normalized === null ? null : Number(normalized.toFixed(3)),
    };
  }
  return ratings;
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
