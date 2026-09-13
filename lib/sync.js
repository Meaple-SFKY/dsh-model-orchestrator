/**
 * One sync pass over the model pool.
 *
 * Triggered by a person pressing Sync, never by activation or a poll: it spends
 * real web requests and a real model call, so it is not something the plugin does
 * behind anyone's back. One pass runs at a time; a second request while one is in
 * flight joins it rather than starting a competing sweep.
 *
 * The research itself is INJECTED as a function rather than imported, for two
 * reasons. The host seam it needs (`ctx.subagents.start` with a structured-output
 * schema) is async, host-coupled and slow, so keeping this module free of it keeps
 * the whole pass testable without a harness; and the seam is deliberately
 * separable — the pass, the validation and the storage are what this plugin owns,
 * while "go and read the web" is a capability it borrows.
 *
 * @module dsh-model-orchestrator/sync
 */
import { mergeResearch, normalizeResearch, researchFor, researchPrompt } from './model-research.js';

/** Most routes one pass will research, so a large pool cannot become a long bill. */
export const MAX_PER_PASS = 24;

/**
 * Create the single-pass sync runner.
 *
 * @param options - `{ pool, store, runResearch, logger, now }`, where `runResearch`
 *   is `({ models, prompt, signal }) => Promise<structured answer>`.
 * @returns `{ start, status, cancel }`.
 */
export function createSyncRunner({ pool, store, runResearch, logger, now = () => Date.now() }) {
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
      last = { status: 'running', startedAt, total: models.length };
      try {
        const answer = await runResearch({
          models,
          prompt: researchPrompt(models),
          signal,
        });
        // Aborted mid-flight: a partial sweep must not be written, and must not
        // report itself as done.
        if (signal.aborted) {
          last = { status: 'cancelled', startedAt, finishedAt: now(), requested: models.length };
          return last;
        }
        const { entries, problems } = normalizeResearch(answer, {
          models,
          at: now(),
          ...(answer?.agentModel === undefined ? {} : { agentModel: answer.agentModel }),
        });
        const stored = Object.keys(entries).length;
        store.update((state) => {
          state.research = mergeResearch(state.research, entries);
        });
        last = {
          status: 'done',
          startedAt,
          finishedAt: now(),
          requested: models.length,
          stored,
          // Reported, never silent: a researcher that answered about a route it was
          // not asked about, or produced an unusable price, is visible here.
          ...(problems.length === 0 ? {} : { problems }),
          unmatched: Object.values(entries).filter((entry) => entry.matched !== true).length,
          writeError: store.writeError,
        };
        logger?.info?.(`sync: researched ${stored}/${models.length} route(s).`);
      } catch (error) {
        // A failed sweep is a status, not a thrown error: the panel polls this,
        // and nothing about routing depends on it having succeeded.
        last = {
          status: signal.aborted ? 'cancelled' : 'error',
          startedAt,
          finishedAt: now(),
          ...(signal.aborted ? {} : { error: String(error?.message ?? error) }),
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
