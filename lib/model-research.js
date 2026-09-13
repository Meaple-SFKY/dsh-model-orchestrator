/**
 * Public model facts, researched on demand and kept as declared evidence.
 *
 * The host reports no pricing at all (DESIGN §1.4), and `preferCheaper` was
 * therefore shaping tie-breaks on a tier proxy that is identical across every
 * route in a pool like this one — a switch that did nothing. This module holds
 * the answer: what a model publicly IS, what it publicly COSTS, and where that
 * came from.
 *
 * It knowingly crosses a line this plugin drew for itself. The README says it
 * will not fetch public model data from the network, because "a plugin that
 * guessed at their identity from a name would be inventing capability rather
 * than measuring it". Three things make that objection answerable here, and all
 * three are load-bearing:
 *
 *  1. **It is user-initiated.** Nothing is fetched on activation or on a poll; a
 *     person presses Sync. Nothing about the network happens behind their back.
 *  2. **Provenance is part of the record.** Every entry carries its sources, the
 *     time it was read, the route that read it, and whether the researcher could
 *     confirm the id maps to a real published model at all. An entry that could
 *     not be confirmed is stored as unconfirmed rather than dropped, so the panel
 *     can show exactly what is known and what is not.
 *  3. **It never overrides a measurement.** Prices only shape tie-breaks, and a
 *     researched claim is weaker evidence than anything the host measures. The
 *     matcher's hard requirements reject before any of this is consulted.
 *
 * Entries are keyed by MODEL IDENTITY, not by route, for the same reason
 * assignments are: the pool churns underneath, and what was learned about a model
 * is still true of it after its route is respelled.
 *
 * @module dsh-model-orchestrator/model-research
 */
import { isRecord, str, uniqueStrings } from './util.js';
import { candidateKeys } from './model-identity.js';

/** Upper bounds, so a runaway answer cannot grow the state file without limit. */
const MAX_RESULTS = 64;
const MAX_LIST = 12;
const MAX_TEXT = 600;

/**
 * The structured answer a research subagent must report.
 *
 * Written in the host's tool-parameter DSL, not plain JSON Schema, because that is
 * what `outputSchema` carries: the root is an IMPLICIT open object, so this object
 * IS the properties map, and `required` is a boolean per property rather than an
 * array. Verified by compiling it through the host's real `defineTool`, the same
 * way every tool spec in this plugin is checked — an invalid schema here would
 * otherwise only surface as a failed sync.
 *
 * `matched` is deliberately required and deliberately present on every row: the
 * point of the step is to say whether an id maps to a published model, so a
 * researcher that cannot confirm one must say so rather than invent a name.
 */
export const RESEARCH_SCHEMA = Object.freeze({
  results: {
    type: 'array',
    required: true,
    description: 'One entry per requested route, in the order they were given.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        route: {
          type: 'string',
          required: true,
          description: 'The exact route string you were asked about, copied verbatim.',
        },
        matched: {
          type: 'boolean',
          required: true,
          description:
            'True only if you confirmed from public sources that this route serves a real, publicly documented model. False when you could not confirm it.',
        },
        publicName: {
          type: 'string',
          description: 'The model name as its publisher writes it. Omit when unmatched.',
        },
        vendor: {
          type: 'string',
          description: 'The organisation that publishes the model. Omit when unmatched.',
        },
        inputPerMTok: {
          type: 'number',
          description:
            'Published list price per million input tokens in USD. Omit when no public price exists; never estimate one.',
        },
        outputPerMTok: {
          type: 'number',
          description:
            'Published list price per million output tokens in USD. Omit when no public price exists; never estimate one.',
        },
        strengths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'At most a few short phrases naming what public sources say this model is notably good at.',
        },
        notes: {
          type: 'string',
          description: 'Anything that makes the finding usable or doubtful, such as an alias guess.',
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'The URLs you actually read. A claim without one is not usable.',
        },
      },
    },
  },
});

/**
 * The instruction handed to the research subagent.
 *
 * Model-facing, so English by the repository's policy. It says what to search, how
 * to answer, and — most importantly — that "I could not confirm this" is a valid
 * and expected answer, because a researcher told only to fill in a table will
 * invent a row.
 *
 * @param models - the live pool rows to research.
 * @returns the prompt text.
 */
export function researchPrompt(models) {
  const rows = (Array.isArray(models) ? models : []).map((model) => {
    const parts = [`- route: ${model.route}`, `  model id: ${model.model ?? ''}`];
    if (model.name !== undefined) parts.push(`  advertised name: ${model.name}`);
    if (model.description !== undefined) parts.push(`  advertised description: ${model.description}`);
    const facts = [];
    if (Number.isSafeInteger(model.facts?.contextWindow)) {
      facts.push(`context ${model.facts.contextWindow}`);
    }
    if (Array.isArray(model.facts?.efforts) && model.facts.efforts.length > 0) {
      facts.push(`reasoning efforts ${model.facts.efforts.join('/')}`);
    }
    if (facts.length > 0) parts.push(`  host-reported facts: ${facts.join(', ')}`);
    return parts.join('\n');
  });

  return [
    'Research the following model routes and report what each one publicly is.',
    '',
    'A route id is a deployment\'s own string and often repeats the publisher: the id',
    '`vendor/model-name` and the advertised name may describe the same public model,',
    'while a route may also point at something with no public identity at all.',
    'Your job is to say which of those two it is, using public sources.',
    '',
    'For EACH route, search the public web and then report:',
    '1. `matched` — did you CONFIRM that this route serves a real, publicly documented',
    '   model? Answer false when you could not confirm it. A false answer is useful and',
    '   expected; an invented name is not. Never guess a model from a plausible-looking id.',
    '2. The public model name and its publishing organisation, as the publisher writes them.',
    '3. Published list prices per million input and output tokens, in USD. Use the',
    '   publisher\'s own price list. Omit the field entirely when no public price exists —',
    '   never estimate, convert with a guessed rate, or average several sources into one',
    '   number. A free tier is not a price.',
    '4. A few short phrases naming what public sources say the model is notably good at.',
    '5. The URLs you actually read. Prefer the publisher\'s own documentation over',
    '   aggregators and blog posts, and say so in `notes` when your only evidence is weaker.',
    '',
    'Report exactly one result per route, in the order given, with the route string',
    'copied verbatim. Call `structured_output` exactly once when you are done.',
    '',
    'Routes:',
    ...rows,
  ].join('\n');
}

/**
 * Validate a research answer into the stored shape.
 *
 * Unusable rows are dropped, never repaired: a negative price, a non-finite
 * number, or a missing route is a reason to discard that row rather than to invent
 * a plausible value for it.
 *
 * @param input - the subagent's structured answer.
 * @param options - `{ models, at, agentModel }` — the pool rows the answer must
 *   correspond to, and the provenance to stamp on each stored entry.
 * @returns `{ entries, problems }`, where `entries` is keyed by route and
 *   `problems` names everything that could not be used, including a single
 *   unusable field on a row that was kept.
 */
export function normalizeResearch(input, { models = [], at = Date.now(), agentModel } = {}) {
  const entries = {};
  const problems = [];
  const raw = Array.isArray(input?.results) ? input.results.slice(0, MAX_RESULTS) : [];

  // Only routes the caller actually asked about are accepted: a researcher that
  // answers about something else is answering a different question.
  const known = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const route = str(model?.route);
    if (route !== undefined) known.set(route, model);
  }

  for (const row of raw) {
    if (!isRecord(row)) {
      problems.push('a result that was not an object');
      continue;
    }
    const route = str(row.route);
    if (route === undefined || !known.has(route)) {
      problems.push(`result for an unknown route: ${JSON.stringify(row.route ?? null)}`);
      continue;
    }
    const price = (value) => {
      if (value === undefined || value === null) return undefined;
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number) || number < 0) return undefined;
      return Math.round(number * 1e6) / 1e6;
    };
    const input1 = price(row.inputPerMTok);
    const output1 = price(row.outputPerMTok);
    if (row.inputPerMTok !== undefined && row.inputPerMTok !== null && input1 === undefined) {
      problems.push(`${route}: unusable input price ${JSON.stringify(row.inputPerMTok)}`);
    }

    const model = known.get(route);
    entries[route] = {
      route,
      // Keyed for lookup AND kept legible: the candidate keys are recomputed at
      // read time, so this is provenance rather than the index itself.
      identityKeys: candidateKeys(model),
      matched: row.matched === true,
      ...(str(row.publicName) === undefined ? {} : { publicName: str(row.publicName).slice(0, 120) }),
      ...(str(row.vendor) === undefined ? {} : { vendor: str(row.vendor).slice(0, 80) }),
      ...(input1 === undefined ? {} : { inputPerMTok: input1 }),
      ...(output1 === undefined ? {} : { outputPerMTok: output1 }),
      ...(input1 === undefined && output1 === undefined ? {} : { currency: str(row.currency) ?? 'USD' }),
      ...(Array.isArray(row.strengths)
        ? { strengths: uniqueStrings(row.strengths.map((entry) => str(entry)).filter(Boolean))
            .map((entry) => entry.slice(0, 80))
            .slice(0, MAX_LIST) }
        : {}),
      ...(str(row.notes) === undefined ? {} : { notes: str(row.notes).slice(0, MAX_TEXT) }),
      ...(Array.isArray(row.sources)
        ? { sources: uniqueStrings(row.sources.map((entry) => str(entry)).filter(Boolean)).slice(0, MAX_LIST) }
        : {}),
      at,
      ...(agentModel === undefined ? {} : { agentModel }),
    };
  }

  return { entries, problems };
}

/**
 * Merge freshly researched entries into the stored map.
 *
 * Keyed by identity when one can be computed, with the route as the fallback for a
 * route the identity layer cannot key — so a model renamed by its provider keeps
 * what was learned about it.
 *
 * @param current - the stored map.
 * @param entries - `{ route: entry }` from {@link normalizeResearch}.
 * @returns the next map.
 */
export function mergeResearch(current, entries) {
  const next = { ...(isRecord(current) ? current : {}) };
  for (const entry of Object.values(entries ?? {})) {
    const identity = entry.identityKeys?.find((key) => key !== '');
    const key = identity ?? entry.route;
    next[key] = { ...(next[key] ?? {}), ...entry };
  }
  return next;
}

/**
 * The researched facts for one route, if any.
 *
 * Looked up by identity, so an entry survives the provider respelling the route:
 * the entry's own candidate keys are recomputed from the LIVE row, and the stored
 * `route` is only a fallback for a row the identity layer cannot key.
 *
 * @param research - the stored map.
 * @param model - the live pool row.
 * @returns the entry, or `undefined`.
 */
export function researchFor(research, model) {
  if (!isRecord(research)) return undefined;
  const keys = candidateKeys(model);
  for (const key of keys) {
    if (isRecord(research[key])) return research[key];
  }
  const route = str(model?.route);
  return route === undefined ? undefined : research[route];
}

/**
 * The effective price of a route for comparison purposes.
 *
 * Output tokens dominate most specialist work, but a model that is cheap on one
 * side and ruinous on the other must not read as cheap overall, so the two are
 * averaged rather than one being ignored. A route with no researched price returns
 * `undefined` and keeps the tier proxy.
 *
 * @param entry - a researched entry.
 * @returns a USD-per-million figure, or `undefined`.
 */
export function priceOf(entry) {
  if (!isRecord(entry)) return undefined;
  const input = Number.isFinite(entry.inputPerMTok) ? entry.inputPerMTok : undefined;
  const output = Number.isFinite(entry.outputPerMTok) ? entry.outputPerMTok : undefined;
  if (input === undefined && output === undefined) return undefined;
  if (input === undefined) return output;
  if (output === undefined) return input;
  return (input + output) / 2;
}

/**
 * How much a route costs relative to the most expensive priced route in the pool.
 *
 * Normalised against the pool rather than against an absolute figure, because a
 * deployment's mix is what "expensive" means in context, and an absolute scale
 * would be wrong for the next deployment.
 *
 * @param models - the live pool rows.
 * @param research - the stored map.
 * @returns a `Map` of route to a 0..1 ratio, plus the priced count.
 */
export function priceRatios(models, research) {
  const prices = new Map();
  let highest = 0;
  for (const model of Array.isArray(models) ? models : []) {
    const price = priceOf(researchFor(research, model));
    if (price === undefined) continue;
    prices.set(String(model.route), price);
    highest = Math.max(highest, price);
  }
  const ratios = new Map();
  if (highest <= 0) return ratios;
  for (const [route, price] of prices) ratios.set(route, price / highest);
  return ratios;
}

/**
 * Validate the stored research map for persistence.
 *
 * Kept separate from {@link normalizeResearch}: that validates an ANSWER against
 * the routes it was asked about, while this validates what is already stored, and
 * must survive a hand-edited file without discarding the whole block.
 *
 * @param input - the stored map.
 * @returns a normalised map.
 */
export function normalizeResearchMap(input) {
  const out = {};
  if (!isRecord(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    const name = str(key);
    if (name === undefined || !isRecord(value)) continue;
    const entry = {};
    const route = str(value.route);
    if (route !== undefined) entry.route = route.slice(0, 200);
    entry.matched = value.matched === true;
    for (const field of ['publicName', 'vendor', 'notes']) {
      const text = str(value[field]);
      if (text !== undefined) entry[field] = text.slice(0, MAX_TEXT);
    }
    for (const field of ['inputPerMTok', 'outputPerMTok']) {
      const number = value[field];
      if (typeof number === 'number' && Number.isFinite(number) && number >= 0) {
        entry[field] = number;
      }
    }
    const currency = str(value.currency);
    if (currency !== undefined) entry.currency = currency.slice(0, 8);
    for (const field of ['strengths', 'sources']) {
      if (Array.isArray(value[field])) {
        entry[field] = uniqueStrings(value[field].map((item) => str(item)).filter(Boolean))
          .map((item) => item.slice(0, 200))
          .slice(0, MAX_LIST);
      }
    }
    if (Array.isArray(value.identityKeys)) {
      entry.identityKeys = uniqueStrings(
        value.identityKeys.map((item) => str(item)).filter(Boolean),
      ).slice(0, 8);
    }
    const at = value.at;
    if (typeof at === 'number' && Number.isFinite(at) && at > 0) entry.at = at;
    const agentModel = str(value.agentModel);
    if (agentModel !== undefined) entry.agentModel = agentModel.slice(0, 200);
    out[name] = entry;
  }
  return out;
}
