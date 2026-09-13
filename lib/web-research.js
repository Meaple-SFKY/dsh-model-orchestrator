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
import { researchFor } from './model-research.js';

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
 * Build the runner.
 *
 * @param options - `{ ctx, pool, taxonomy, web, chooseRoute, logger }`, where `web`
 *   returns the resolved web service (or `undefined` when the deployment has none).
 * @returns `runResearch({ models, prompt, signal })`, resolving to the researched answer.
 */
export function createWebResearch({ ctx, pool, taxonomy, web, chooseRoute, store, logger }) {
  /** Which route does the reconciling, chosen the same way any other unit is. */
  function researcherRoute() {
    const models = pool.models();
    if (models.length === 0) return undefined;
    try {
      const decision = chooseRoute(
        pool,
        taxonomy,
        { capability: 'web.information', weight: 1 },
        { preferences: store?.snapshot?.().preferences ?? {} },
      );
      const chosen = decision?.chosen ?? decision;
      if (chosen?.route !== undefined) return chosen;
    } catch {
      // Fall through to the first route: a reconciliation call is not worth failing
      // a sync over, and the choice is reported with the result either way.
    }
    return { route: models[0].route, provider: models[0].provider, model: models[0].model };
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

  return async function runResearch({ models, signal }) {
    const service = web();
    if (service === undefined || typeof service.search !== 'function') {
      throw new Error('this deployment exposes no web search service, so nothing can be researched');
    }
    const route = researcherRoute();
    if (route === undefined) throw new Error('the model pool is empty, so there is nothing to research with');

    const blocks = [];
    for (const model of models) {
      const sources = await sourcesFor(model, signal);
      blocks.push(blockFor(model, sources));
    }

    const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
    const message = createUserMessage({
      content: [{ type: 'text', text: `Reconcile these model routes.\n\n${blocks.join('\n\n')}` }],
      source: { kind: 'user' },
    });

    let text = '';
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: RESEARCH_SYSTEM,
      messages: [message],
      maxTokens: 8000,
      ...(signal === undefined ? {} : { signal }),
    });
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    }

    const parsed = parseJsonAnswer(text);
    return { ...parsed, agentModel: route.route };
  };
}

/**
 * Read the JSON out of a model answer.
 *
 * A fenced block is accepted because that is what models emit, and a bare object is
 * accepted because that is what was asked for. Nothing else is: a prose answer
 * cannot be partially trusted into facts, and the caller's validator has nothing to
 * validate, so the honest outcome is a clear failure.
 *
 * @param text - the raw answer.
 * @returns the parsed object.
 */
export function parseJsonAnswer(text) {
  const raw = String(text ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced === null ? raw : fenced[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('the research answer contained no JSON object');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new Error(`the research answer was not valid JSON: ${String(error?.message ?? error)}`);
  }
}

/** Reported so a sync can say which routes it deliberately skipped. */
export { researchFor };
