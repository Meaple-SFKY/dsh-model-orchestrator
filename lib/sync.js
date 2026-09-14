/**
 * One sync pass over the model pool.
 *
 * Triggered by a person pressing Sync, never by activation or a poll: it spends
 * real web requests and a real model call, so it is not something the plugin does
 * behind anyone's back. One pass runs at a time; a second request while one is in
 * flight joins it rather than starting a competing sweep.
 *
 * The research itself is INJECTED as a function rather than imported, for two
 * reasons. The seam it needs (web search plus one reconciling model call, see
 * `lib/web-research.js`) is async, host-coupled and slow, so keeping this module
 * free of it keeps the whole pass testable without a harness; and the seam is
 * deliberately separable — the pass, the validation and the storage are what this
 * plugin owns, while "go and read the web" is a capability it borrows.
 *
 * @module dsh-model-orchestrator/sync
 */
import { mergeResearch, normalizeResearch, researchFor, researchPrompt } from './model-research.js';
import { isRecord, str } from './util.js';

/** Most routes one pass will research, so a large pool cannot become a long bill. */
export const MAX_PER_PASS = 24;

/**
 * How many providers one pass researches at once.
 *
 * The pass is grouped by provider so that one unreachable route cannot cost every
 * other provider its facts — which is what a single call over the whole pool did:
 * the reconciling route answering with prose, or failing outright, took the other
 * four providers' results with it. Grouping alone would turn one model call into
 * one per provider, so the groups overlap: two at a time hides most of that added
 * latency without turning Sync into a burst of provider traffic.
 */
export const PROVIDER_CONCURRENCY = 2;

/**
 * Group routes by the provider that serves them.
 *
 * The key falls back to the vendor prefix of the route, so a pool row that carries
 * no explicit `provider` still groups under its own vendor rather than collapsing
 * every such row into one anonymous batch.
 *
 * @param models - live pool rows.
 * @returns `[{ provider, models }]` in first-seen order.
 */
export function groupByProvider(models) {
  const groups = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const route = str(model?.route) ?? '';
    const provider = str(model?.provider) ?? (route.includes('/') ? route.split('/')[0] : 'unknown');
    const existing = groups.get(provider);
    if (existing === undefined) groups.set(provider, [model]);
    else existing.push(model);
  }
  return [...groups.entries()].map(([provider, group]) => ({ provider, models: group }));
}

/** Run workers with a bounded concurrency, preserving input order. */
async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : 1, items.length));
  const runners = [];
  for (let index = 0; index < size; index += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const current = cursor;
          cursor += 1;
          if (current >= items.length) return;
          results[current] = await worker(items[current], current);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

/**
 * Create the single-pass sync runner.
 *
 * @param options - `{ pool, store, runResearch, logger, now, providerConcurrency }`,
 *   where `runResearch` is `({ models, prompt, signal, provider }) => Promise<structured answer>`.
 * @returns `{ start, status, cancel }`.
 */
export function createSyncRunner({
  pool,
  store,
  runResearch,
  logger,
  now = () => Date.now(),
  providerConcurrency = PROVIDER_CONCURRENCY,
}) {
  let inFlight = null;
  let controller = null;
  let last = { status: 'idle' };

  /** Routes with no fresh research of their own, unless the caller forces a sweep. */
  function targetsFor(force) {
    const research = store.snapshot().research;
    const models = pool.models();
    if (force === true) return models.slice(0, MAX_PER_PASS);
    return models.filter((model) => researchFor(research, model) === undefined).slice(0, MAX_PER_PASS);
  }

  /**
   * Research everything not yet known, or everything again when `force` is set.
   *
   * Not an `async` function on purpose: an async wrapper mints a fresh promise on
   * every call, so "a second request joins the running sweep" would be false even
   * while only one sweep ran. Returning the SAME promise is what makes the
   * contract real.
   *
   * @param options - `{ force, signal }`.
   * @returns a promise for the settled status.
   */
  function start({ force = false, signal: callerSignal } = {}) {
    if (inFlight !== null) return inFlight;
    const models = targetsFor(force);
    if (models.length === 0) {
      last = {
        status: 'idle',
        reason: 'every route in the pool already has researched facts',
        at: now(),
      };
      return Promise.resolve(last);
    }

    // One controller per sweep, so `cancel` can abort the work instead of merely
    // forgetting about it.
    const own = new AbortController();
    controller = own;
    // A caller-supplied signal cancels the sweep too, so a request-scoped cancel
    // cannot leave research running behind it.
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) own.abort();
      else callerSignal.addEventListener('abort', () => own.abort(), { once: true });
    }
    const signal = own.signal;

    let sweep;
    sweep = (async () => {
      const startedAt = now();
      const batches = groupByProvider(models);
      last = { status: 'running', startedAt, total: models.length, providers: batches.length };
      try {
        // Each provider is researched on its own, and its facts are written as soon
        // as it answers. A provider that is unreachable, or whose reconciling answer
        // cannot be read, therefore costs only its OWN routes: the sweep continues,
        // the other providers' facts are stored, and the failure is reported against
        // the provider that caused it. Previously one bad answer discarded the whole
        // pass, which read to the user as "sync did nothing" for five providers.
        let done = 0;
        const outcomes = await mapLimited(batches, providerConcurrency, async ({ provider, models: batch }) => {
          if (signal.aborted) return { provider, status: 'cancelled', requested: batch.length };
          try {
            const answer = await runResearch({
              models: batch,
              prompt: researchPrompt(batch),
              signal,
              provider,
            });
            if (signal.aborted) return { provider, status: 'cancelled', requested: batch.length };
            const { entries, problems } = normalizeResearch(answer, {
              models: batch,
              at: now(),
              // Stamped from the answer's own report of which route did the work,
              // which `runResearch` sets — not read out of the validated payload,
              // where no schema declares it.
              ...(str(answer?.agentModel) === undefined ? {} : { agentModel: str(answer.agentModel) }),
            });
            const stored = Object.keys(entries).length;
            store.update((state) => {
              state.research = mergeResearch(state.research, entries);
            });
            done += 1;
            last = { ...last, done };
            return {
              provider,
              status: 'done',
              requested: batch.length,
              stored,
              // Reported, never silent: a researcher that answered about a route it
              // was not asked about, or produced an unusable price, is visible here.
              ...(problems.length === 0 ? {} : { problems }),
              unmatched: Object.values(entries).filter((entry) => entry.matched !== true).length,
            };
          } catch (error) {
            done += 1;
            last = { ...last, done };
            const message = String(error?.message ?? error);
            logger?.warn?.(`sync: research failed for provider "${provider}": ${message}`);
            return {
              provider,
              status: 'error',
              requested: batch.length,
              error: message,
              // The research failure carries what it saw when it gave up — the
              // answer's length and opening text — so "no JSON object" is
              // actionable instead of a dead end.
              ...(isRecord(error?.detail) ? { detail: error.detail } : {}),
            };
          }
        });

        if (signal.aborted) {
          last = {
            status: 'cancelled',
            startedAt,
            finishedAt: now(),
            requested: models.length,
            providers: outcomes,
          };
          return last;
        }

        const failed = outcomes.filter((outcome) => outcome.status === 'error');
        const succeeded = outcomes.filter((outcome) => outcome.status === 'done');
        const stored = succeeded.reduce((total, outcome) => total + (outcome.stored ?? 0), 0);
        const unmatched = succeeded.reduce((total, outcome) => total + (outcome.unmatched ?? 0), 0);
        const problems = succeeded.flatMap((outcome) => outcome.problems ?? []);
        // Three outcomes, not two. A pass where SOME providers answered is neither a
        // success (the panel would hide the failure) nor a failure (the facts that
        // did land are real and stored), so it reports itself as partial and names
        // both sides.
        const status = failed.length === 0 ? 'done' : succeeded.length === 0 ? 'error' : 'partial';
        last = {
          status,
          startedAt,
          finishedAt: now(),
          requested: models.length,
          stored,
          // Per-provider outcomes: which provider answered, how many routes it
          // covered, and — when it did not — why not.
          providers: outcomes,
          ...(failed.length === 0
            ? {}
            : {
                error: failed
                  .map((outcome) => `provider "${outcome.provider}": ${outcome.error}`)
                  .join('; '),
                failedProviders: failed.map((outcome) => outcome.provider),
                // The first failure's evidence, promoted so a surface that reads only
                // the sweep — the panel's error line — still has the answer excerpt.
                ...(isRecord(failed[0]?.detail) ? { detail: failed[0].detail } : {}),
              }),
          ...(problems.length === 0 ? {} : { problems }),
          unmatched,
          writeError: store.writeError,
        };
        logger?.info?.(
          `sync: researched ${stored}/${models.length} route(s) across ${succeeded.length}/${outcomes.length} provider(s).`,
        );
      } catch (error) {
        // A failed sweep is a status, not a thrown error: the panel polls this,
        // and nothing about routing depends on it having succeeded.
        last = {
          status: signal.aborted ? 'cancelled' : 'error',
          startedAt,
          finishedAt: now(),
          ...(signal.aborted ? {} : { error: String(error?.message ?? error) }),
          ...(isRecord(error?.detail) ? { detail: error.detail } : {}),
        };
        if (!signal.aborted) logger?.warn?.(`sync: research failed: ${String(error)}`);
      } finally {
        // Only release the slot if this is still the running sweep. Clearing it
        // unconditionally is how a cancelled sweep used to let a second one start
        // beside it — the opposite of one at a time.
        if (inFlight === sweep) {
          inFlight = null;
          controller = null;
        }
      }
      return last;
    })();

    inFlight = sweep;
    return sweep;
  }

  return {
    start,
    status: () => ({ ...last }),
    /**
     * Abort an in-flight sweep, for teardown.
     *
     * Aborts for real: the sweep stops at its next awaited boundary and refuses to
     * write, so a plugin reload cannot leave a research pass storing facts after
     * its registrations are gone.
     */
    cancel: () => {
      controller?.abort();
      controller = null;
    },
  };
}
