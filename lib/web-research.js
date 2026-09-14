/**
 * The "go and read the web" half of a sync.
 *
 * Two host services do the work — never `fetch` from the plugin: `ctx.web` for
 * search, and `ctx.llm` for the model call. Both are the harness's own seams, so
 * attribution headers, provider routing and retry stay where they belong.
 *
 * The shape is deliberately two-stage. The plugin issues the searches (one per
 * route, from the id and the advertised name), then hands the collected sources to
 * a model and asks it to reconcile them into the researched shape. The model still
 * does the judging — which sources are credible, whether the id corresponds to a
 * published model at all, whether a price is a list price — but the plugin decides
 * what it is allowed to see, which is what makes the result checkable.
 *
 * A settings-page action has no agent, so there is no legitimate parent for a
 * research subagent; that is why this path talks to `llm` directly instead of
 * spawning one. It also means the call must be cheap and bounded: a handful of
 * searches, one model call, no tool loop.
 *
 * @module dsh-model-orchestrator/web-research
 */
import { str } from './util.js';

/** How many sources per route are collected, and how much of each is kept. */
const SOURCES_PER_ROUTE = 5;
const SNIPPET_CHARS = 700;

/** Instructions for the reconciliation call. Model-facing, so English. */
const RESEARCH_SYSTEM = [
  'You reconcile public sources into facts about AI models.',
  '',
  'You will receive one block per model route: the route string, the model id as the',
  'deployment spells it, its advertised name and description, and the search results',
  'the caller collected for it.',
  '',
  'Answer with JSON only, matching exactly this shape:',
  '{ "results": [ { "route": string, "matched": boolean, "publicName"?: string,',
  '  "vendor"?: string, "inputPerMTok"?: number, "outputPerMTok"?: number,',
  '  "strengths"?: string[], "notes"?: string, "sources"?: string[] } ] }',
  '',
  'Rules, all of which matter more than completeness:',
  '- One entry per route, `route` copied verbatim. Never invent a route.',
  '- `matched` is true only when the sources let you CONFIRM that the route serves a',
  '  real, publicly documented model. If the id looks plausible but nothing confirms',
  '  it, answer false and say so in `notes`. A false answer is a useful answer.',
  '- Omit a price you did not find. Never estimate, average sources, or convert',
  '  currencies with a guessed rate. A free tier is not a list price.',
  '- `sources` must be URLs you were actually given. Do not cite anything else.',
  '- Keep `strengths` to short phrases, and never let marketing copy stand in for a',
  '  measured benchmark: if the only support is the vendor praising itself, say so.',
].join('\n');

/**
 * A research answer that could not be read, carrying what was actually seen.
 *
 * The bare message was the whole failure the user got — "the research answer
 * contained no JSON object" — from which nothing can be concluded or fixed: not
 * whether the model answered prose, answered nothing, or wrapped its JSON in a way
 * the parser missed. The detail travels with the error so the sync status can
 * report the answer's length and opening text.
 */
export class ResearchAnswerError extends Error {
  /**
   * @param message - the human-readable failure.
   * @param detail - machine-readable evidence: `{ length, excerpt, fenced, ... }`.
   */
  constructor(message, detail) {
    super(message);
    this.name = 'ResearchAnswerError';
    this.detail = detail;
  }
}

/**
 * A bounded, printable view of an answer: enough to diagnose, short enough to show.
 *
 * @param text - the raw text.
 * @param limit - how many characters of it to keep.
 * @returns `{ length, excerpt }`.
 */
export function describeAnswer(text, limit = 600) {
  const raw = String(text ?? '');
  return {
    length: raw.length,
    excerpt: raw.length > limit ? `${raw.slice(0, limit)}…` : raw,
  };
}

/**
 * Read the JSON out of a model answer.
 *
 * A fenced block is accepted because that is what models emit, and a bare object is
 * accepted because that is what was asked for. Nothing else is: a prose answer
 * cannot be partially trusted into facts, and the caller's validator has nothing to
 * validate, so the honest outcome is a clear failure — now a failure that says what
 * it saw.
 *
 * @param text - the raw answer.
 * @returns the parsed object.
 * @throws {ResearchAnswerError} when no JSON object can be read.
 */
export function parseJsonAnswer(text) {
  const raw = String(text ?? '').trim();
  const seen = describeAnswer(raw);
  if (raw === '') {
    throw new ResearchAnswerError(
      'the research answer was empty: the reconciling model returned no text at all',
      { ...seen, empty: true, fenced: false, objectFound: false },
    );
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced === null ? raw : fenced[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new ResearchAnswerError(
      `the research answer contained no JSON object: it was ${raw.length} character(s)${
        fenced === null ? ' with no fenced block' : ' inside a fenced block'
      } and began ${JSON.stringify(seen.excerpt)}`,
      { ...seen, empty: false, fenced: fenced !== null, objectFound: false },
    );
  }
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (error) {
    const parseError = String(error?.message ?? error);
    const part = describeAnswer(slice);
    throw new ResearchAnswerError(
      `the research answer was not valid JSON: ${parseError} (the object was ${slice.length} character(s) and began ${JSON.stringify(part.excerpt)})`,
      { ...seen, empty: false, fenced: fenced !== null, objectFound: true, parseError, candidateLength: slice.length, candidateExcerpt: part.excerpt },
    );
  }
}

/** How many distinct routes one reconciliation will try before giving up. */
const MAX_RESEARCHER_ROUTES = 3;

/**
 * Create the web searcher and reconciler.
 *
 * @param options - `{ ctx, pool, taxonomy, web, chooseRoute, store, logger }`, where
 *   `web` returns the resolved web service (or `undefined` when the deployment has none).
 * @returns `runResearch({ models, prompt, signal, provider })`, resolving to the researched answer.
 */
export function createWebResearch({ ctx, pool, taxonomy, web, chooseRoute, store, logger }) {
  /**
   * Which routes may do the reconciling, best first.
   *
   * A single chosen route used to be the whole fallback chain, so one unreachable
   * model route — a provider that was down, or an alias that had been retargeted —
   * ended the entire sweep. Every candidate here is a real route from the live pool,
   * so a failure on the first is retried on the next instead of reported upward.
   */
  function researcherCandidates() {
    const models = pool.models();
    if (models.length === 0) return [];
    const out = [];
    const add = (candidate) => {
      if (
        candidate === undefined ||
        candidate === null ||
        str(candidate.route) === undefined ||
        str(candidate.provider) === undefined ||
        str(candidate.model) === undefined
      ) {
        return;
      }
      if (out.some((entry) => entry.route === candidate.route)) return;
      out.push({ route: candidate.route, provider: candidate.provider, model: candidate.model });
    };
    try {
      const decision = chooseRoute(
        pool,
        taxonomy,
        { capability: 'web.information', weight: 1 },
        { preferences: store?.snapshot?.().preferences ?? {} },
      );
      add(decision?.chosen ?? decision);
      for (const alternative of Array.isArray(decision?.alternatives) ? decision.alternatives : []) {
        add(alternative);
      }
    } catch {
      // Fall through to the pool: a reconciliation call is not worth failing a sync
      // over, and the choice is reported with the result either way.
    }
    for (const model of models) add(model);
    return out.slice(0, MAX_RESEARCHER_ROUTES);
  }

  /** Collect the public sources for one route. */
  async function sourcesFor(model, signal) {
    const service = web();
    if (service === undefined || typeof service.search !== 'function') return [];
    const query = [model.model, model.name, 'pricing per million tokens'].filter(Boolean).join(' ');
    try {
      const result = await service.search({ query, maxResults: SOURCES_PER_ROUTE }, signal);
      return (result?.sources ?? []).map((source) => ({
        url: str(source?.url) ?? '',
        title: str(source?.title),
        snippet: str(source?.snippet),
      }));
    } catch (error) {
      // One route's search failing must not lose the others: the block is simply
      // handed over with no sources, which the model then reports as unconfirmed.
      logger?.warn?.(`sync: search failed for ${model.route}: ${String(error)}`);
      return [];
    }
  }

  /** Render one route's block for the reconciliation prompt. */
  function blockFor(model, sources) {
    const lines = [`## ${model.route}`, `model id: ${model.model ?? ''}`];
    if (model.name !== undefined) lines.push(`advertised name: ${model.name}`);
    if (model.description !== undefined) lines.push(`advertised description: ${model.description}`);
    lines.push('search results:');
    if (sources.length === 0) lines.push('(none returned)');
    for (const source of sources) {
      lines.push(`- ${source.title ?? ''} ${source.url}`.trim());
      if (source.snippet !== undefined) lines.push(`  ${source.snippet.slice(0, SNIPPET_CHARS)}`);
    }
    return lines.join('\n');
  }

  /** Ask one route to reconcile the collected blocks, and read its answer. */
  async function reconcile(route, prompt, signal) {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
    const message = createUserMessage({
      content: [{ type: 'text', text: `Reconcile these model routes.\n\n${prompt}` }],
      source: { kind: 'user' },
    });

    let text = '';
    let chunks = 0;
    let finishReason;
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: RESEARCH_SYSTEM,
      messages: [message],
      maxTokens: 8000,
      ...(signal === undefined ? {} : { signal }),
    });
    for await (const chunk of stream) {
      chunks += 1;
      if (typeof chunk?.finishReason === 'string') finishReason = chunk.finishReason;
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    }

    try {
      return parseJsonAnswer(text);
    } catch (error) {
      // Attach what only this frame knows: which route answered, how much of a
      // stream it produced, and why it stopped.
      if (error instanceof ResearchAnswerError) {
        error.detail = {
          ...error.detail,
          route: route.route,
          chunks,
          ...(finishReason === undefined ? {} : { finishReason }),
        };
      }
      throw error;
    }
  }

  return async function runResearch({ models, signal }) {
    const service = web();
    if (service === undefined || typeof service.search !== 'function') {
      throw new Error('this deployment exposes no web search service, so nothing can be researched');
    }
    const candidates = researcherCandidates();
    if (candidates.length === 0) {
      throw new Error('the model pool is empty, so there is nothing to research with');
    }

    const blocks = [];
    for (const model of models) {
      const sources = await sourcesFor(model, signal);
      blocks.push(blockFor(model, sources));
    }
    const prompt = blocks.join('\n\n');

    let lastError;
    for (const route of candidates) {
      try {
        const parsed = await reconcile(route, prompt, signal);
        return { ...parsed, agentModel: route.route };
      } catch (error) {
        lastError = error;
        // A route that produced some text and then failed is not retried on another
        // route: the answer exists and is unreadable, which is a different failure
        // from a route that never answered at all.
        const produced = Number(error?.detail?.length) > 0;
        if (produced || signal?.aborted === true) throw error;
        logger?.warn?.(
          `sync: reconciling route ${route.route} failed, trying the next candidate: ${String(error?.message ?? error)}`,
        );
      }
    }
    throw lastError ?? new Error('no route could reconcile the researched sources');
  };
}
