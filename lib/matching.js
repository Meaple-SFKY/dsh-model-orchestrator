/**
 * Task analysis and deterministic capability matching.
 *
 * Two halves:
 *
 *  - **Analysis** turns a task description into a requirement set. It can be
 *    driven by the calling model (the strong path: the model knows what its own
 *    task needs) or derived locally from vocabulary (the zero-config path, used
 *    for Auto mode when no analysis was supplied).
 *  - **Matching** scores every live model against a requirement set. It is
 *    deterministic, inspectable, and never invents capability: a hard
 *    requirement that cannot be evidenced rejects the model outright rather
 *    than silently downgrading it.
 *
 * @module dsh-model-orchestrator/matching
 */
import { clamp, isRecord, str, tokenize, uniqueStrings } from './util.js';
import { cuesFromPreferences, resolveCues } from './decision-vocabulary.js';
import { SOURCE_CONFIDENCE } from './discovery.js';
import { synthesizeCapability } from './taxonomy.js';

/** Hard floors used when a requirement does not state its own. */
export const DEFAULTS = Object.freeze({
  minContextWindow: 0,
  minOutputTokens: 0,
  maxParallel: 4,
});

/**
 * @typedef {object} Requirement
 * @property {string} capability     // descriptor id
 * @property {number} weight         // 0..1 relative importance
 * @property {boolean} [required]    // hard: must be evidenced
 * @property {number} [minContextWindow]
 * @property {number} [minOutputTokens]
 * @property {boolean} [needsImageInput]
 * @property {string} [reason]
 */

/**
 * @typedef {object} TaskAnalysis
 * @property {string} summary
 * @property {'trivial'|'simple'|'specialist'|'complex'} complexity
 * @property {Requirement[]} requirements
 * @property {'auto'|'local'|'model'|'manual'} source
 * @property {string[]} [domains]
 * @property {string[]} [notes]
 */

/**
 * A catalog of task-type cues used only by the local fallback analyzer.
 *
 * These are *generic* cues about verb shape and scale, not domain→model maps.
 * They never select a model; they only decide whether a task likely needs one
 * specialist or several, which is a routing-tier question.
 */


/** An independent-concern cue, suggesting parallel specialists. */

/**
 * Depth cues: vocabulary that indicates multi-step work where an early mistake
 * is expensive. This is a *level* judgement, independent of subject domain, and
 * it maps onto the domain-free `depth.difficult` descriptor.
 */

/**
 * Routine cues: mechanical, fully specified work with no hidden decisions.
 */

/** Count how many cues from a list appear in a lowercased haystack. */
function cueHits(haystack, cues) {
  let hits = 0;
  for (const cue of cues) if (haystack.includes(cue)) hits += 1;
  return hits;
}

/**
 * Groups that describe capability LEVEL rather than subject area.
 *
 * These must never be counted as independent concerns: one difficult
 * investigation is still one specialist's job, and treating "depth" as a second
 * domain would split a single coherent task across two children.
 */
const LEVEL_GROUPS = Object.freeze(new Set(['depth', 'capacity']));

/** The subject-area groups of a requirement set. */
function domainGroups(requirements) {
  const groups = new Set();
  for (const requirement of requirements) {
    const group = requirement.capability.split('.')[0];
    if (!LEVEL_GROUPS.has(group)) groups.add(group);
  }
  return groups;
}

/**
 * Morphology-tolerant token match.
 *
 * A task says "implement" where a descriptor says "implementation", so exact
 * token equality misses the obvious match. Two tokens are considered equal when
 * one is a prefix of the other and both are long enough for that to be
 * meaningful. Short tokens still require exact equality so "code" cannot match
 * "coding-something-unrelated" by accident.
 */
const PREFIX_MATCH_MIN = 5;

function tokenMatches(wanted, present) {
  if (wanted === present) return true;
  if (wanted.length < PREFIX_MATCH_MIN || present.length < PREFIX_MATCH_MIN) return false;
  return wanted.startsWith(present) || present.startsWith(wanted);
}

/**
 * Whether every token of a keyword is evidenced by a token set.
 *
 * @param keyword - the descriptor keyword, possibly multi-word.
 * @param tokens - the profile's tokens.
 * @returns whether the keyword is matched.
 */
function keywordMatchesTokens(keyword, tokens) {
  const wanted = tokenize(keyword);
  if (wanted.length === 0) return false;
  for (const token of wanted) {
    let found = false;
    for (const present of tokens) {
      if (tokenMatches(token, present)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/**
 * Whether a keyword contains CJK characters, which the tokenizer splits per
 * character and therefore cannot match as a token set.
 *
 * @param value - the keyword.
 * @returns true when it must be matched as a contiguous substring.
 */
function isCjk(value) {
  for (const char of String(value ?? '')) {
    if (char.charCodeAt(0) > 0x2e80) return true;
  }
  return false;
}

/** Clamp a weight into `(0, 1]`. */
function weight(value, fallback = 0.5) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return clamp(numeric, 0.01, 1);
}

/** Normalize one caller-supplied requirement. */
function normalizeRequirement(input) {
  if (!isRecord(input)) return undefined;
  const capability = str(input.capability) ?? str(input.id);
  if (capability === undefined) return undefined;
  const out = {
    capability,
    weight: weight(input.weight, 0.6),
  };
  if (input.required === true) out.required = true;
  if (Number.isSafeInteger(input.minContextWindow) && input.minContextWindow > 0) {
    out.minContextWindow = input.minContextWindow;
  }
  if (Number.isSafeInteger(input.minOutputTokens) && input.minOutputTokens > 0) {
    out.minOutputTokens = input.minOutputTokens;
  }
  if (input.needsImageInput === true) out.needsImageInput = true;
  // Carried, not scored: the reasoning level a caller wants for this unit is a
  // routing fact for the engine, not evidence about the model. Dropping it here
  // made a caller's own level silently unenforceable.
  const reasoningEffort = str(input.reasoningEffort);
  if (reasoningEffort !== undefined) out.reasoningEffort = reasoningEffort;
  const reason = str(input.reason);
  if (reason !== undefined) out.reason = reason;
  return out;
}

/**
 * Score how strongly a capability descriptor is evidenced by a model profile.
 *
 * @param descriptor - a {@link CapabilityDescriptor}.
 * @param profile - a ModelProfile.
 * @returns `{ score, hardFailures, matched, missingRequired }`.
 */
export function scoreCapability(descriptor, profile, pool = {}) {
  let score = 0;
  let possible = 0;
  const matched = [];
  const hardFailures = [];
  let missingRequired = false;

  const keywords = new Set(profile.derived?.keywords ?? []);
  const strengthTokens = new Set(
    (profile.derived?.strengths ?? []).flatMap((entry) => tokenize(entry)),
  );

  for (const sig of descriptor.signals) {
    const sigWeight = typeof sig.weight === 'number' ? sig.weight : 1;
    possible += sigWeight;
    let hit = 0;
    let detail;

    switch (sig.type) {
      case 'modality': {
        const supports = profile.derived?.supportsImage;
        if (sig.modality === 'image') {
          if (supports === true) {
            hit = 1;
            detail = 'declares image input';
          } else if (supports === false) {
            detail = 'declares text-only input';
          } else if (sig.required === true) {
            hardFailures.push(`image input is unverified for ${profile.route}`);
            missingRequired = true;
          } else {
            detail = 'image input unknown';
          }
        } else {
          hit = 1;
          detail = 'text input';
        }
        break;
      }
      case 'contextAtLeast': {
        const value = profile.facts?.contextWindow;
        if (value === undefined) {
          if (sig.required === true) {
            hardFailures.push(`context window is unknown for ${profile.route}`);
            missingRequired = true;
          }
        } else if (value >= (sig.min ?? 0)) {
          // Meeting the floor is necessary but not sufficient: capacity is a
          // capability, so a route with more headroom scores higher. The scale is
          // RELATIVE to the largest window in the pool rather than an absolute
          // token count, so no magic threshold decides the ranking and a pool of
          // small or large models grades the same way. log2 keeps a 2x window from
          // counting as twice the capability.
          const ceiling = Number.isFinite(pool.maxContextWindow) && pool.maxContextWindow > 0
            ? Math.max(pool.maxContextWindow, value)
            : value;
          const ratio = Math.log2(value / Math.max(1, sig.min ?? 0));
          const span = Math.log2(ceiling / Math.max(1, sig.min ?? 0));
          // Requiring headroom is normal: a task that states 900k tokens in a pool
          // whose smallest window is 500k still has all candidates clearing a
          // modest floor. So the score is the capacity RATIO to the requirement
          // (2x the needed room beats 1.5x), blended with the pool-relative span
          // so the widest window still edges ahead.
          const headroom = 1 - 1 / (1 + ratio);
          hit = span <= 0 ? 1 : clamp(0.6 * headroom + 0.4 * (ratio / span), 0, 1);
          detail = `context ${value} ≥ ${sig.min} (${Math.round(hit * 100)}% of the pool's headroom)`;
        } else {
          if (sig.required === true) {
            hardFailures.push(`context window ${value} < required ${sig.min}`);
            missingRequired = true;
          }
          detail = `context ${value} < ${sig.min}`;
        }
        break;
      }
      case 'outputAtLeast': {
        // `defaultMaxTokens` is the cap THIS DEPLOYMENT chose to send, not the
        // model's output ceiling. It is therefore evidence about expected
        // response size, never a hard model limit — no requirement may reject a
        // model on it.
        const value = profile.facts?.defaultMaxTokens;
        if (value === undefined) {
          hit = sig.required === true ? 0.4 : 0.35;
        } else if (value >= (sig.min ?? 0)) {
          hit = 1;
          detail = `deployment output cap ${value} ≥ ${sig.min}`;
        } else {
          hit = 0.25;
          detail = `deployment output cap ${value} < ${sig.min}`;
        }
        break;
      }
      case 'reasoning': {
        const efforts = profile.facts?.efforts;
        const has = Array.isArray(efforts) && efforts.length > 0;
        const wanted = Array.isArray(sig.efforts) ? sig.efforts : [];
        if (sig.max === 0) {
          // "does not need reasoning" is a soft preference for cheaper routes.
          hit = has ? 0.2 : 1;
        } else if (!has) {
          if (sig.required === true) {
            hardFailures.push(`no reasoning effort is exposed for ${profile.route}`);
            missingRequired = true;
          }
        } else if (wanted.length === 0) {
          hit = 1;
          detail = `reasoning efforts: ${efforts.join(', ')}`;
        } else if (wanted.some((effort) => efforts.includes(effort))) {
          hit = 1;
          detail = `supports ${wanted.filter((e) => efforts.includes(e)).join(', ')}`;
        } else if (sig.required === true) {
          hardFailures.push(`none of reasoning efforts [${wanted.join(', ')}] is exposed`);
          missingRequired = true;
        }
        break;
      }
      case 'keywords': {
        const wantedTokens = sig.keywords ?? [];
        let hits = 0;
        for (const keyword of wantedTokens) {
          if (keywordMatchesTokens(keyword, keywords)) hits += 1;
          else if (strengthTokens.size > 0 && keywordMatchesTokens(keyword, strengthTokens)) hits += 1;
        }
        if (wantedTokens.length > 0) {
          if (hits > 0) {
            hit = clamp(0.5 + (hits / wantedTokens.length) * 0.5, 0, 1);
            detail = `${hits}/${wantedTokens.length} declared cues`;
          }
        }
        break;
      }
      default:
        hit = 0;
    }

    if (hit > 0) {
      score += sigWeight * hit;
      if (detail !== undefined) matched.push(`${descriptor.id}: ${detail}`);
    }
  }

  for (const sig of descriptor.antiSignals ?? []) {
    const sigWeight = typeof sig.weight === 'number' ? sig.weight : 1;
    const wantedTokens = sig.keywords ?? [];
    let hits = 0;
    for (const keyword of wantedTokens) {
      if (keywordMatchesTokens(keyword, keywords)) hits += 1;
    }
    if (hits > 0) {
      score -= sigWeight * clamp(hits / Math.max(1, wantedTokens.length), 0, 1);
      matched.push(`${descriptor.id}: penalized by ${hits} anti-cue(s)`);
    }
  }

  let normalized = possible === 0 ? 0 : clamp(score / possible, 0, 1);
  // A descriptor with no textual evidence contributes a small floor instead of a
  // veto. Its hard requirements were already checked above, so the model IS
  // eligible, and descriptors combine by geometric mean - a hard zero therefore
  // disqualified a model outright on the strength of wording alone. The floor is
  // deliberately far below a real match: it exists so that one silent descriptor
  // cannot veto, NOT so that silence outranks evidence. Discrimination is then
  // left to the axes the host can actually measure.
  const UNEVIDENCED_FLOOR = 0.02;
  if (possible > 0 && score === 0) {
    normalized = UNEVIDENCED_FLOOR;
    matched.push(`${descriptor.id}: no stated evidence; ranked on measured capability`);
  }
  // Evidence quality caps the confidence the matcher may place in this match.
  const confidence = SOURCE_CONFIDENCE[profile.derived?.keywordSource === 'calibrated+declared' ? 'calibrated' : 'declared'];
  return {
    score: normalized,
    confidence,
    matched,
    hardFailures,
    missingRequired,
  };
}

/**
 * Build a requirement set from a calling-model analysis, validating each entry
 * against the taxonomy and synthesizing descriptors for unknown capabilities.
 *
 * @param taxonomy - the {@link Taxonomy}.
 * @param input - the model-supplied analysis.
 * @returns {TaskAnalysis}
 */
export function analysisFromModel(taxonomy, input) {
  const raw = Array.isArray(input?.requirements) ? input.requirements : [];
  const requirements = [];
  const synthesized = [];

  /**
   * The caller's own model preferences.
   *
   * Route ids in a deployment are frequently opaque provider aliases, and whether
   * a given alias corresponds to a strong coding model or a strong vision model is
   * knowledge the CALLING model already has and this plugin does not. So the
   * caller may name the models it judges best; the plugin does not take that on
   * trust — it resolves the names against the live pool and reports what it could
   * not resolve rather than quietly ignoring it.
   */
  // Per-unit model preferences.
  //
  // A whole-task preference is often too coarse: one plan can hold a vision unit
  // and a maths unit, and the model that should read the diagram is not the model
  // that should do the derivation. Each entry names the capability, cluster, or
  // unit it applies to; units matching it are routed with that preference, and
  // units matching nothing keep the task-level preference or the measured ranking.
  const unitPreferences = [];
  const rawUnitPreferences = Array.isArray(input?.unitModelPreference) ? input.unitModelPreference : [];
  for (const entry of rawUnitPreferences) {
    if (!isRecord(entry)) continue;
    const target = str(entry.capability) ?? str(entry.group) ?? str(entry.id);
    if (target === undefined) continue;
    const list = Array.isArray(entry.routes) ? entry.routes : [];
    const routes = [];
    for (const item of list) {
      const direct = str(isRecord(item) ? item.route : item);
      const itemProvider = isRecord(item) ? str(item.provider) : undefined;
      const itemModel = isRecord(item) ? str(item.model) : undefined;
      const route =
        direct ?? (itemProvider !== undefined && itemModel !== undefined ? `${itemProvider}/${itemModel}` : undefined);
      if (route === undefined) continue;
      routes.push({ route, reason: isRecord(item) ? str(item.reason) : undefined });
    }
    if (routes.length === 0) continue;
    unitPreferences.push({ target, routes });
  }

  const preferences = [];
  const unresolved = [];
  const rawPreferences = Array.isArray(input?.modelPreference) ? input.modelPreference : [];
  for (const entry of rawPreferences) {
    if (!isRecord(entry)) continue;
    const direct = str(entry.route);
    const provider = str(entry.provider);
    const model = str(entry.model);
    const route = direct ?? (provider !== undefined && model !== undefined ? `${provider}/${model}` : undefined);
    if (route === undefined) continue;
    preferences.push({ route, reason: str(entry.reason) });
  }

  for (const candidate of raw) {
    const normalized = normalizeRequirement(candidate);
    if (normalized === undefined) continue;

    if (!taxonomy.has(normalized.capability)) {
      // The model named a capability the taxonomy does not know. That is
      // expected for a new domain: mint a descriptor from the caller's own
      // vocabulary instead of failing the task.
      try {
        const descriptor = synthesizeCapability({
          label: str(candidate.label) ?? normalized.capability,
          group: str(candidate.group) ?? normalized.capability.split('.')[0],
          summary: str(candidate.reason),
          keywords: uniqueStrings([
            ...(Array.isArray(candidate.keywords) ? candidate.keywords : []),
            normalized.capability.split('.').join(' '),
          ]),
          minContextWindow: normalized.minContextWindow,
          minOutputTokens: normalized.minOutputTokens,
          needsImageInput: normalized.needsImageInput === true,
        });
        // Keep the caller's id when it is well-formed so the plan stays legible.
        const registered = taxonomy.register({ ...descriptor, id: normalized.capability });
        synthesized.push(registered);
      } catch {
        continue;
      }
    }
    requirements.push(normalized);
  }

  // The model's own statement of complexity is a claim; multi-step and parallel
  // cues in the text are observations. Take the more demanding of the two so a
  // task described as a sequence is never silently downgraded to one specialist.
  const claimed = ['trivial', 'simple', 'specialist', 'complex'].includes(input?.complexity)
    ? input.complexity
    : undefined;
  // Carry each stated capability's OWN hard requirements into the caller's
  // entries.
  //
  // A caller naming `multimodal.screenshot` means "this must read an image", but it
  // cannot be expected to restate the descriptor's modality floor. Without this the
  // requirement was only a preference, so a text-only route could be assigned to
  // work it cannot do — and a per-unit model preference for such a route then
  // slipped past the constraint entirely.
  for (const requirement of requirements) {
    const descriptor = taxonomy.get(requirement.capability);
    if (descriptor === undefined) continue;
    for (const sig of descriptor.signals) {
      if (sig.type === 'modality' && sig.modality === 'image' && sig.required === true) {
        requirement.needsImageInput = true;
      }
      if (sig.type === 'contextAtLeast' && sig.required === true && requirement.minContextWindow === undefined) {
        requirement.minContextWindow = sig.min;
      }
      if (sig.type === 'outputAtLeast' && sig.required === true && requirement.minOutputTokens === undefined) {
        requirement.minOutputTokens = sig.min;
      }
    }
  }

  const observed = inferComplexity(
    requirements,
    [str(input?.summary) ?? '', ...(Array.isArray(input?.domains) ? input.domains : [])].join(' '),
  );
  // The calling model's judgement is authoritative and used as given.
  //
  // This previously took the MAXIMUM of the claimed and locally observed levels,
  // framed as "the model may under-estimate but the plugin catches it". That is
  // backwards: with levels ordered trivial < simple < specialist < complex, a model
  // claiming `complex` against a locally observed `specialist` was silently
  // DEMOTED, and a model claiming `trivial` was silently promoted. The local
  // observation is a phrase-list guess and the claim is a reading of the task, so
  // the guess must not overrule it.
  const complexity = claimed ?? observed;

  return {
    summary: str(input?.summary) ?? '',
    complexity,
    requirements,
    source: 'model',
    domains: uniqueStrings(Array.isArray(input?.domains) ? input.domains : []),
    notes: uniqueStrings(Array.isArray(input?.notes) ? input.notes : []),
    synthesized,
    modelPreference: preferences,
    unitModelPreference: unitPreferences,
  };
}

/**
 * Derive a requirement set locally from a task description.
 *
 * This is the zero-config path: it matches the task's own vocabulary against
 * the taxonomy's declared cues. Capability descriptors stay the source of
 * truth, so extending the taxonomy immediately extends this analyzer.
 *
 * @param taxonomy - the {@link Taxonomy}.
 * @param text - the task description.
 * @returns {TaskAnalysis}
 */
export function analysisFromText(taxonomy, text, options = {}) {
  const tokens = new Set(tokenize(text));
  const haystack = String(text ?? '').toLowerCase();
  const requirements = [];
  // The fallback vocabulary. When a caller passes its own it replaces the
  // built-in hints outright, because judging the task is the caller's decision and
  // the built-in lists are only there for when nobody made one.
  // A partial map is completed from the defaults, so supplying one group cannot
  // leave the others undefined.
  const cues =
    options.cues === undefined
      ? cuesFromPreferences(options.preferences).cues
      : resolveCues(options.cues).cues;

  for (const descriptor of taxonomy.list()) {
    const keywordSignals = descriptor.signals.filter((sig) => sig.type === 'keywords');
    if (keywordSignals.length === 0) continue;

    let hits = 0;
    let total = 0;
    for (const sig of keywordSignals) {
      for (const keyword of sig.keywords ?? []) {
        total += 1;
        // CJK is matched as a CONTIGUOUS substring, never as a bag of characters.
        //
        // The tokenizer emits one token per CJK character, so treating a keyword as
        // a token set made "图表" match any text containing both 图 and 表 anywhere,
        // and made a single character like 图 match every compound containing it -
        // so "画一张柱状图" (plot a bar chart) was read as a request to READ an
        // image. Requiring adjacency is what the character-based tokenizer needs.
        if (isCjk(keyword)) {
          if (haystack.includes(keyword.toLowerCase())) hits += 1;
          continue;
        }
        if (keyword.includes(' ')) {
          if (haystack.includes(keyword.toLowerCase())) hits += 1;
          continue;
        }
        if (keywordMatchesTokens(keyword, tokens)) hits += 1;
      }
    }
    if (hits === 0 || total === 0) continue;

    const ratio = hits / total;
    const requirement = {
      capability: descriptor.id,
      weight: weight(clamp(0.35 + ratio * 1.4, 0.2, 0.95)),
      reason: `matched ${hits} declared cue(s) for ${descriptor.label}`,
    };

    // Push hard facts declared by the descriptor into the requirement.
    for (const sig of descriptor.signals) {
      if (sig.type === 'modality' && sig.modality === 'image' && sig.required === true) {
        requirement.needsImageInput = true;
      }
      if (sig.type === 'contextAtLeast' && sig.required === true) {
        requirement.minContextWindow = sig.min;
      }
      if (sig.type === 'outputAtLeast' && sig.required === true) {
        requirement.minOutputTokens = sig.min;
      }
    }
    requirements.push(requirement);
  }

  requirements.sort((left, right) => right.weight - left.weight);

  // Level requirement. Domain vocabulary is a poor router, because a model is
  // rarely described in the task's own terms. Depth is different: it is a
  // property of the *work*, and the host measures the facts that evidence it, so
  // it routes reliably even for a domain no model has ever mentioned.
  if (cueHits(haystack, cues.deep) >= 1) {
    requirements.unshift({
      capability: 'depth.difficult',
      weight: 0.7,
      required: true,
      reason: 'the task asks for multi-step work where an early mistake is expensive',
    });
  } else if (cueHits(haystack, cues.routine) >= 1 && requirements.length <= 1) {
    requirements.push({
      capability: 'depth.routine',
      weight: 0.4,
      reason: 'the task looks mechanical and fully specified',
    });
  }

  // Hard facts stated in the task itself.
  //
  // Domain vocabulary is a weak router, but a number the user wrote is not: when a
  // task says how much material it carries, every model that cannot hold it is
  // simply not eligible, and among those that can, the one with more headroom is
  // the better fit. Both facts are read from the TEXT rather than inferred,
  // because inventing a size for every task would filter the pool on a guess.
  const declaredContext = declaredContextWindow(haystack);
  const existingFloor = requirements.find((req) => typeof req.minContextWindow === 'number');
  if (declaredContext !== undefined && (existingFloor === undefined || declaredContext > existingFloor.minContextWindow)) {
    requirements.unshift({
      capability: 'capacity.very_long',
      weight: 0.8,
      required: true,
      minContextWindow: declaredContext,
      reason: `the task states about ${declaredContext} tokens of material`,
    });
  }
  // Added only when the taxonomy did not already recognize the visual need, so the
  // requirement is not counted twice.
  if (cueHits(haystack, cues.image) >= 1 && !requirements.some((req) => req.needsImageInput === true)) {
    requirements.unshift({
      capability: 'multimodal.screenshot',
      weight: 0.75,
      required: true,
      needsImageInput: true,
      reason: 'the task refers to visual material the model must read',
    });
  }

  return {
    summary: text,
    complexity: inferComplexity(requirements, text, cues),
    requirements,
    source: 'local',
    domains: uniqueStrings(requirements.map((req) => req.capability.split('.')[0])),
  };
}


/**
 * Read an explicit material size out of a task.
 *
 * Recognizes a number with an optional thousands separator and a magnitude word,
 * in either English or Chinese. Only an explicitly stated size counts: a task that
 * merely says "long" gets no floor, because guessing one would filter the pool on
 * something the user never asked for.
 *
 * @param haystack - the lower-cased task text.
 * @returns the stated size in tokens, or undefined when none is stated.
 */
function declaredContextWindow(haystack) {
  const patterns = [
    // "900,000 token(s)", "1.05m tokens", "500k token", "128000 tokens"
    /(\d[\d.,]*)\s*(k|m|万|千)?\s*(?:tokens?|token|字|词)/g,
    // "128k context", "1m context window"
    /(\d[\d.,]*)\s*(k|m)?\s*(?:context|上下文|窗口)/g,
  ];
  let best;
  for (const pattern of patterns) {
    for (const match of haystack.matchAll(pattern)) {
      const raw = match[1].replace(/[,，]/g, '');
      let value = Number.parseFloat(raw);
      if (!Number.isFinite(value) || value <= 0) continue;
      const unit = (match[2] ?? '').toLowerCase();
      if (unit === 'k' || unit === '千') value *= 1000;
      else if (unit === 'm') value *= 1_000_000;
      else if (unit === '万') value *= 10_000;
      // A bare small number is far more likely to be a count of items than a
      // context size, so it is not treated as a floor.
      if (value < 1000) continue;
      if (best === undefined || value > best) best = Math.round(value);
    }
  }
  return best;
}

/**
 * Decide the routing tier a requirement set implies.
 *
 * @param requirements - normalized requirements.
 * @param text - the original text, when available.
 * @returns `'trivial'|'simple'|'specialist'|'complex'`.
 */
export function inferComplexity(requirements, text, cues) {
  const haystack = String(text ?? '').toLowerCase();
  const required = requirements.filter((req) => req.required === true);
  const strong = requirements.filter((req) => req.weight >= 0.5);

  // `cues` is threaded in so a caller-supplied vocabulary replaces the hints;
  // with none, the built-in fallback is read here.
  const vocabulary = cues ?? cuesFromPreferences(undefined).cues;
  const trivialCue = vocabulary.trivial.some((cue) => haystack.includes(cue));
  const multiStep = vocabulary.multiStep.filter((cue) => haystack.includes(cue)).length;
  const parallelCue = vocabulary.parallel.some((cue) => haystack.includes(cue));
  const deep = cueHits(haystack, vocabulary.deep);
  // Only subject-area groups count as independent concerns; level descriptors
  // are excluded so depth never splits one coherent task.
  const groups = domainGroups(requirements);

  if (requirements.length === 0) return trivialCue ? 'trivial' : 'simple';
  if (trivialCue && requirements.length <= 1) return 'trivial';

  // Several independent CONCERNS warrant several specialists. Depth alone does
  // not: one difficult investigation is still one specialist's job, so step
  // cues never escalate a single-cluster task into a multi-agent run.
  const independentConcerns = groups.size >= 3 || (groups.size >= 2 && (parallelCue || multiStep >= 1));
  if (independentConcerns || (groups.size >= 2 && deep >= 2)) return 'complex';

  if (required.length >= 1 || strong.length >= 1 || groups.size >= 1) return 'specialist';
  return 'simple';
}

/**
 * Rank every live model against one requirement set.
 *
 * @param pool - the {@link ModelPool}.
 * @param taxonomy - the {@link Taxonomy}.
 * @param analysis - a {@link TaskAnalysis}.
 * @param options - `{ preferences, pinnedRoute }`.
 * @returns `{ candidates, rejected, summary }`.
 */
export function rankModels(pool, taxonomy, analysis, options = {}) {
  const preferences = isRecord(options.preferences) ? options.preferences : {};
  const denied = new Set(uniqueStrings(preferences.deniedRoutes ?? []));
  const allowed = new Set(uniqueStrings(preferences.allowedRoutes ?? []));
  const preferCheaper = preferences.preferCheaper !== false;

  const candidates = [];
  const rejected = [];

  // The largest context window in the pool is the scale for capacity scoring; a
  // pool of one still grades against itself, which yields a full score.
  const windows = pool.models().map((entry) => entry.facts?.contextWindow).filter((v) => Number.isFinite(v) && v > 0);
  const scoringPool = { maxContextWindow: windows.length > 0 ? Math.max(...windows) : undefined };

  for (const profile of pool.models()) {
    if (denied.has(profile.route)) {
      rejected.push({ route: profile.route, reason: 'denied by preference' });
      continue;
    }
    if (allowed.size > 0 && !allowed.has(profile.route)) {
      rejected.push({ route: profile.route, reason: 'not in the allowed route list' });
      continue;
    }

    const hardFailures = [];
    const matched = [];
    // The explicit facts on the requirements that this route happens to clear.
    // Reported so the reason for a choice names the constraint that actually
    // decided it, instead of only the descriptor's generic default floor.
    const clearedFloors = [];
    // The running confidence-weighted product of per-requirement satisfaction.
    let product = 1;
    let totalWeight = 0;

    for (const requirement of analysis.requirements) {
      const descriptor = taxonomy.get(requirement.capability);
      if (descriptor === undefined) continue;

      // Explicit requirement facts are hard even when the descriptor is soft.
      if (requirement.needsImageInput === true && profile.derived?.supportsImage !== true) {
        hardFailures.push(
          profile.derived?.supportsImage === false
            ? 'declares text-only input but the task needs image input'
            : 'image input is unverified',
        );
      }
      if (Number.isSafeInteger(requirement.minContextWindow)) {
        const context = profile.facts?.contextWindow;
        if (context !== undefined && context < requirement.minContextWindow) {
          hardFailures.push(`context ${context} < required ${requirement.minContextWindow}`);
        } else if (context !== undefined) {
          clearedFloors.push(`clears the ${requirement.minContextWindow}-token floor for "${requirement.capability}"`);
        }
      }
      if (requirement.needsImageInput === true && profile.derived?.supportsImage === true) {
        clearedFloors.push(`can read images as "${requirement.capability}" requires`);
      }
      // Note: `minOutputTokens` is deliberately NOT a hard rejection. The only
      // host-exposed output figure is a deployment-chosen cap, not the model's
      // ceiling, so treating it as a hard limit would reject capable models.

      const scored = scoreCapability(descriptor, profile, scoringPool);
      if (scored.missingRequired) hardFailures.push(...scored.hardFailures);

      // Capability fit is CONJUNCTIVE, not an average: a model that cannot do a
      // required thing is not rescued by being excellent at something adjacent.
      // Multiplying each requirement's satisfaction means one weak dimension
      // penalizes the whole route proportionally to its weight.
      totalWeight += requirement.weight;
      const confidence = SOURCE_CONFIDENCE[
        profile.derived?.keywordSource === 'calibrated+declared' ? 'calibrated' : 'declared'
      ];
      const satisfaction = clamp(scored.score * confidence, 0, 1);
      product *= Math.max(satisfaction, 0.01) ** requirement.weight;
      matched.push(...scored.matched);

      if (requirement.required === true && scored.score < 0.4) {
        hardFailures.push(
          `required capability "${requirement.capability}" is not evidenced (score ${scored.score.toFixed(2)})`,
        );
      }
    }

    if (hardFailures.length > 0) {
      rejected.push({ route: profile.route, reason: uniqueStrings(hardFailures).join('; ') });
      continue;
    }

    // Normalize by the total requirement weight so the geometric mean stays in
    // [0,1] regardless of how many requirements a task has.
    const rawFit = totalWeight === 0 ? 0 : clamp(product ** (1 / totalWeight), 0, 1);
    let score = rawFit * profile.confidence;

    // Cost shaping: without a price feed, tier is the only honest proxy for
    // relative expense, and it is derived from measured facts only.
    let costPenalty = 0;
    if (preferCheaper) {
      if (profile.derived?.tier === 'deep') costPenalty = 0.08;
      else if (profile.derived?.tier === 'fast') costPenalty = -0.04;
    }
    if (analysis.complexity === 'trivial' && profile.derived?.tier === 'deep') costPenalty += 0.1;
    score -= costPenalty;

    const isPinned = options.pinnedRoute === profile.route;
    if (isPinned) score += 0.5;

    candidates.push({
      route: profile.route,
      provider: profile.provider,
      model: profile.model,
      name: profile.name,
      tier: profile.derived?.tier ?? 'unknown',
      score: Number(clamp(score, 0, 2).toFixed(4)),
      fit: Number(rawFit.toFixed(4)),
      confidence: profile.confidence,
      costPenalty: Number(costPenalty.toFixed(4)),
      evidence: profile.evidence,
      supportsImage: profile.derived?.supportsImage,
      contextWindow: profile.facts?.contextWindow,
      matched: uniqueStrings(matched).slice(0, 12),
      // The explicit requirement facts this route clears. Kept separate from
      // `matched`, which is descriptor evidence: these are the constraints that
      // actually decided the choice.
      clearedConstraints: uniqueStrings(clearedFloors).slice(0, 6),
      ...(isPinned ? { pinned: true } : {}),
    });
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.route.localeCompare(right.route);
  });

  // The caller's model preference is applied LAST, and only as a change of ORDER.
  //
  // It cannot resurrect a rejected route: every hard requirement has already been
  // enforced, so a preference can only choose among candidates the plugin has
  // independently judged eligible. That is the division of labour - the calling
  // model supplies knowledge of the models, and the plugin keeps the deployment's
  // constraints authoritative.
  const declaredPreferences = Array.isArray(analysis.modelPreference) ? analysis.modelPreference : [];
  const preferred = [];
  const unresolved = [];
  let ordered = candidates;
  if (declaredPreferences.length > 0) {
    const rank = new Map();
    for (const entry of declaredPreferences) {
      if (!rank.has(entry.route)) rank.set(entry.route, rank.size);
    }
    const byRoute = new Map(candidates.map((candidate) => [candidate.route, candidate]));
    for (const entry of declaredPreferences) {
      if (!byRoute.has(entry.route)) {
        // Reported rather than swallowed: an alias the pool does not know is the
        // most useful thing to tell the caller.
        unresolved.push(entry.route);
      }
    }
    const chosen = [];
    for (const entry of declaredPreferences) {
      const candidate = byRoute.get(entry.route);
      if (candidate !== undefined && !chosen.includes(candidate)) {
        // The preference is the caller's, so it is recorded on the candidate and
        // the measured fit is kept beside it rather than discarded.
        candidate.preferred = true;
        candidate.preferenceReason = entry.reason;
        chosen.push(candidate);
      }
    }
    // The caller's order is preserved among the candidates it named, and only the
    // rest keep the measured ordering. Re-sorting the whole list by score would
    // discard the caller's ranking whenever a lower-scored model was preferred,
    // which is the entire point of stating a preference.
    const rest = candidates
      .filter((candidate) => !chosen.includes(candidate))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.route.localeCompare(right.route);
      });
    ordered = [...chosen, ...rest];
    if (chosen.length > 0) preferred.push(...chosen.map((candidate) => candidate.route));
  }

  return {
    candidates: ordered,
    rejected,
    preferred,
    unresolvedPreferences: uniqueStrings(unresolved),
    summary: {
      analyzed: analysis.requirements.length,
      evaluated: pool.models().length,
      viable: ordered.length,
      rejected: rejected.length,
      poolEmpty: pool.models().length === 0,
    },
  };
}

/**
 * Choose a route for one capability requirement.
 *
 * @returns `{ chosen, alternatives, rejected }` with `chosen === undefined`
 *   when nothing can serve the requirement, so the caller can refuse loudly.
 */
export function chooseRoute(pool, taxonomy, requirement, options = {}) {
  const analysis = {
    summary: requirement.capability,
    complexity: 'specialist',
    requirements: [requirement],
    source: options.source ?? 'auto',
  };
  const ranked = rankModels(pool, taxonomy, analysis, options);
  return {
    chosen: ranked.candidates[0],
    alternatives: ranked.candidates.slice(1, 4),
    rejected: ranked.rejected,
    ...(ranked.candidates.length === 0 && ranked.summary.poolEmpty
      ? { reason: 'the live model pool is empty' }
      : {}),
  };
}
