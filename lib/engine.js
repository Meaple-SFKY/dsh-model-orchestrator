/**
 * The orchestration engine.
 *
 * Responsibilities, in order:
 *   1. keep the model pool fresh,
 *   2. turn a task into an analysis and a plan,
 *   3. execute that plan at the right tier,
 *   4. hand every expert result back to the calling (captain) agent.
 *
 * Execution tiers (see `planTier`):
 *
 *   `direct`      — the calling agent executes; no child is spawned.
 *   `specialist`  — one child runs on the matched route.
 *   `multi-agent` — several children run on matched routes, optionally in
 *                   dependency waves, and are aggregated.
 *
 * The engine owns only its own plain data. It reads leaf fields from host
 * objects and never serializes an Agent, Session, or Service.
 *
 * @module dsh-model-orchestrator/engine
 */
import { randomUUID } from 'node:crypto';
import { contentToText, delegationLabel, isRecord, routeKey, str, truncate, uniqueStrings, uint, clamp } from './util.js';
import { analysisFromModel, analysisFromText, chooseRoute, rankModels } from './matching.js';
import { poolFingerprint } from './discovery.js';
// Aliased: `preferenceFor` is also the name of the caller-supplied per-unit
// preferences helper inside `#composeUnits`, and the two are different ladders.
import {
  preferenceFor as assignedPreferenceFor,
  preferenceSignature,
  resolveAssignments,
} from './assignments.js';
import { priceRatios } from './model-research.js';
import { boundInline } from './artifacts.js';
import { createRunJournal } from './runs.js';

/** How many characters of a child's output are kept in a plan summary. */
const PREVIEW_CHARS = 1200;

/**
 * Default cap on a dependency handoff, in characters.
 *
 * A dependent unit receives the answering unit's FULL answer, which is the point of
 * a dependency — but an answer can be arbitrarily long, and a handoff is pasted
 * into a child's prompt. The cap keeps one long upstream answer from crowding out
 * the dependent unit's own instructions; the artifact path is included so nothing
 * is actually lost.
 */
export const DEFAULT_HANDOFF_CHARS = 12_000;

/**
 * Descriptor groups that describe capability LEVEL rather than subject area.
 *
 * A level requirement (`depth.difficult`, `capacity.very_long`) shapes *how* a
 * unit is routed; it never defines a unit of its own. Treating it as a domain
 * would split one coherent task across two children doing the same work.
 */
const LEVEL_GROUPS = Object.freeze(new Set(['depth', 'capacity']));

/**
 * Most routes one unit will be attempted on.
 *
 * The user's table may name up to eight ordered candidates. Trying all eight would
 * turn one failed unit into eight model calls, so a unit exhausts at most two
 * candidates beyond its first: enough to survive a single dead route, bounded enough
 * that a systematically failing capability cannot become a bill.
 */
const MAX_ROUTE_ATTEMPTS = 3;

/**
 * Defaults for the two bounded collaborations a run allows.
 *
 * Both are deliberately small. A question is a real model call against a unit that has
 * already answered, and a review round re-runs work that was already paid for — so each
 * has a ceiling that makes a runaway loop impossible rather than merely unlikely.
 */
export const DEFAULT_QUESTION_LIMIT = 4;
export const DEFAULT_QUESTION_TIMEOUT_MS = 240_000;
export const DEFAULT_REVIEW_ROUNDS = 2;

/**
 * Read a reviewer's verdict out of its answer.
 *
 * A structured result is authoritative when the child was asked for one. Otherwise the
 * first JSON object in the text is read, which is the shape the review prompt asks for.
 * A verdict that cannot be read is reported as `unknown` and the loop STOPS: an
 * unreadable answer is not approval, and continuing would either re-run work on a
 * misreading or declare success on nothing.
 *
 * @param result - a unit result.
 * @returns `{ readable, verdict, objections, raw }`.
 */
export function readVerdict(result) {
  const candidates = [];
  if (isRecord(result?.structured)) candidates.push(result.structured);
  const text = typeof result?.text === 'string' ? result.text : '';
  if (text !== '') {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const source = fenced === null ? text : fenced[1];
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        candidates.push(JSON.parse(source.slice(start, end + 1)));
      } catch {
        // Unreadable JSON is the `unknown` case below.
      }
    }
  }
  for (const candidate of candidates) {
    const verdict = str(candidate?.verdict)?.toLowerCase();
    if (verdict === undefined) continue;
    const normalized = verdict === 'approve' || verdict === 'approved' ? 'approve' : verdict === 'reject' || verdict === 'rejected' ? 'reject' : 'unknown';
    const objections = (Array.isArray(candidate?.objections) ? candidate.objections : [])
      .map((entry) => ({
        unit: str(isRecord(entry) ? entry.unit : undefined),
        issue: str(isRecord(entry) ? (entry.issue ?? entry.reason ?? entry.detail) : entry),
      }))
      .filter((entry) => entry.unit !== undefined || entry.issue !== undefined);
    return { readable: true, verdict: normalized, objections, raw: candidate };
  }
  return { readable: false, verdict: 'unknown', objections: [], raw: undefined };
}

/** Persona prefix that turns a child into a focused specialist. */
function specialistPersona(spec) {
  const lines = [
    `You are a focused specialist subagent inside a Model Orchestrator run.`,
    `Your assigned capability area: ${spec.capabilityLabel}${spec.capabilityId === undefined ? '' : ` (${spec.capabilityId})`}.`,
    'Work only on the assigned unit of work. Be concrete and return a complete, self-contained answer:',
    'the captain cannot see your intermediate steps and will deliver your output to the user.',
  ];
  if (str(spec.outputContract) !== undefined) {
    lines.push(`Expected output: ${spec.outputContract}`);
  }
  if (executionNote(spec) !== undefined) lines.push(executionNote(spec));
  return lines.join('\n');
}

function executionNote(spec) {
  return str(spec?.executionPrompt);
}

/**
 * Plain-language text for the stop reasons a child can settle with.
 *
 * The harness reports WHY a child stopped; the model side does not always attach a
 * message. A unit result that carried only `stopReason` and an empty `error` told the
 * captain that something failed but nothing about what — a one-shot child that ran out
 * of output budget and one that was cancelled were indistinguishable.
 */
const STOP_REASON_TEXT = Object.freeze({
  'max-tokens': 'the child ran out of output budget before answering',
  'max_tokens': 'the child ran out of output budget before answering',
  refusal: 'the child model refused the request',
  aborted: 'the child was cancelled before it answered',
  cancelled: 'the child was cancelled before it answered',
  timeout: 'the child exceeded its time limit',
  error: 'the child reported an error',
});

/**
 * Explain a failed child, given only its stop reason and whatever text it produced.
 *
 * @param stopReason - the host's stop reason.
 * @param text - the text the child did produce, if any.
 * @param diagnostic - an optional host diagnostic.
 * @returns the `error` text for the unit result.
 */
function describeChildFailure(stopReason, text, diagnostic) {
  const base = STOP_REASON_TEXT[stopReason] ?? `the child stopped with reason "${stopReason}"`;
  const said = String(text ?? '').trim();
  const parts = [said === '' ? `${base}, and returned no message` : base];
  if (str(diagnostic) !== undefined) parts.push(`diagnostic: ${str(diagnostic)}`);
  return parts.join('; ');
}

/**
 * Build one child prompt from a unit of work.
 *
 * The child receives the original task context so an expert answer is grounded
 * in the real request rather than the orchestrator's paraphrase alone.
 */
function childPrompt(unit) {
  const parts = [];
  if (str(unit.originalTask) !== undefined) {
    parts.push(`Overall task (for context):\n${unit.originalTask}`);
  }
  parts.push(`Your unit of work:\n${unit.prompt}`);
  if (Array.isArray(unit.sharedContext) && unit.sharedContext.length > 0) {
    parts.push(`Shared findings so far:\n${unit.sharedContext.join('\n---\n')}`);
  }
  if (typeof unit.askContext === 'string' && unit.askContext !== '') {
    parts.push(unit.askContext);
  }
  return parts.join('\n\n');
}

/**
 * The context one unit receives from units that already answered.
 *
 * Two kinds of context, deliberately different. A unit that DECLARED a dependency
 * receives the dependency's complete answer, because that is what depending on it
 * means — the preview is exactly the part that loses the reasoning the dependent unit
 * needs. Every other unit still sees a bounded digest of recent completions, so a
 * parallel run keeps some cross-unit awareness without every prompt carrying every
 * other unit's full text.
 *
 * @param unit - the unit about to run.
 * @param results - results keyed by unit id.
 * @param completed - the completed results, in completion order.
 * @param handoff - `{ strategy, maxChars, includeStructured }`.
 * @returns an array of prompt sections.
 */
function handoffContext(unit, results, completed, handoff) {
  // A reviewed unit is treated exactly like a dependency: the reviewer needs the full
  // answer to judge it, which is the whole point of reviewing it.
  const dependsOn = uniqueStrings([
    ...(Array.isArray(unit.dependsOn) ? unit.dependsOn : []),
    ...(Array.isArray(unit.reviews) ? unit.reviews : []),
  ]);
  const sections = [];

  if (dependsOn.length > 0) {
    for (const id of dependsOn) {
      const upstream = results.get(id);
      if (upstream === undefined || upstream.ok !== true) continue;
      const label = upstream.capabilityLabel ?? upstream.capabilityId ?? id;
      const body =
        handoff.strategy === 'summary' ? upstream.preview ?? '' : upstream.text ?? '';
      const capped =
        body.length <= handoff.maxChars
          ? body
          : `${body.slice(0, handoff.maxChars)}\n\n… [${body.length - handoff.maxChars} character(s) elided]`;
      const lines = [`Shared findings from "${label}" (unit ${id}, which you depend on):`, capped];
      const structured = handoff.includeStructured ? upstream.structured : undefined;
      if (structured !== undefined) {
        let encoded;
        try {
          encoded = JSON.stringify(structured);
        } catch {
          encoded = undefined;
        }
        if (encoded !== undefined && encoded.length <= handoff.maxChars) {
          lines.push(`Its structured result:\n${encoded}`);
        }
      }
      sections.push(lines.join('\n'));    }
    return sections;
  }

  // No declared dependency: a bounded digest only. Deliberately the preview, never
  // the full answer — the whole reason a unit is independent is that it does not need
  // its siblings' text.
  for (const entry of completed.slice(-4)) {
    const label = entry.capabilityLabel ?? entry.capabilityId ?? entry.id;
    sections.push(`Completed unit "${label}" (${entry.id}) — summary:\n${entry.preview ?? ''}`);
  }
  return sections;
}

/**
 * Derive an abort signal for one child from a run-level signal.
 * @param signal - the run-level signal.
 * @returns `{ signal, cancel }`.
 */
/**
 * How long a discovery is trusted before the next call that needs the pool re-reads it.
 *
 * Discovery ran only when the pool was EMPTY, so it effectively ran once per process:
 * a deployment that changed its provider's model list, or its subagent route policy,
 * saw nothing until a restart. Neither change emits the host's adapter-topology event,
 * and the panel's Refresh could not reach the pool either. This bounds the staleness of
 * the first, the provider-id check below catches the second immediately, and an
 * explicit refresh (the panel's Refresh, `orchestrate_models { refresh: true }`, or the
 * `/state?force=1` route) bypasses both.
 *
 * Deliberately lazy: the re-read happens when something next needs the pool, so an
 * idle plugin asks the providers nothing. Five minutes is a compromise — a provider
 * listing can be a live HTTP round trip, so a shorter window would make ordinary tool
 * calls slow, and a longer one would leave a policy change invisible for longer than
 * an operator is willing to wait.
 */
const POOL_TTL_MS = 5 * 60 * 1000;

/**
 * How long one `run` may take before it aborts itself and reports what finished.
 *
 * The caller's tool-call ceiling is the hard limit it actually hits (30 minutes in
 * the deployment this was written against), and a call that hits it returns a timeout
 * error and NOTHING else — every unit that had already answered is lost with the
 * call. Finishing first turns that total loss into partial results.
 *
 * Overridable per call with `budgetMs`, which is what a caller on a shorter ceiling
 * should pass.
 */
const DEFAULT_RUN_BUDGET_MS = 1_500_000;

function childSignal(signal) {
  const controller = new AbortController();
  // The listener is kept so it can be REMOVED. A caller's signal is typically the
  // session-scoped `exec.signal`, which outlives every run: leaving the listener on
  // it accumulated one closure per orchestration for the life of the session.
  let detach = () => {};
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      const onAbort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      detach = () => signal.removeEventListener('abort', onAbort);
    }
  }
  return {
    signal: controller.signal,
    cancel: (reason) => controller.abort(reason),
    detach,
  };
}

/**
 * The compact report of the standing division of labour for one run.
 *
 * Reported on every plan and run, not only when something is wrong: the pool
 * churns, so a table that has stopped matching anything has to be visible rather
 * than felt as "the routing got worse". `unassigned` names the live routes no
 * entry mentions, which is how a newly added model becomes a decision instead of
 * something the table silently ignores.
 *
 * @param report - a resolved assignment report.
 * @returns plain data for the tool output.
 */
function assignmentReport(report) {
  return {
    count: report?.count ?? 0,
    applied: (report?.entries ?? []).map((entry) => ({
      key: entry.key,
      models: entry.models,
      family: entry.family,
      routes: entry.routes,
      ...(entry.unresolved.length === 0 ? {} : { unresolved: entry.unresolved }),
    })),
    unresolved: report?.unresolved ?? [],
    unassigned: report?.unassigned ?? [],
  };
}

/**
 * Translate a descriptor's declared requirements into child-request options.
 *
 * A descriptor expresses *preferences* about how its capability should be run
 * (a reasoning level, an output budget). These become concrete `agentOptions`
 * only when the descriptor actually asked for them; otherwise the target model
 * resolves its own defaults, which is the honest behavior.
 */
function descriptorRouting(descriptor) {
  const out = {};
  if (descriptor === undefined) return out;
  for (const sig of descriptor.signals ?? []) {
    if (sig.type !== 'reasoning') continue;
    const efforts = Array.isArray(sig.efforts) ? sig.efforts : [];
    if (efforts.length > 0) out.reasoningEffort = efforts[0];
  }
  for (const sig of descriptor.signals ?? []) {
    if (sig.type === 'outputAtLeast' && Number.isSafeInteger(sig.min) && sig.required === true) {
      out.maxTokens = sig.min;
    }
  }
  return out;
}

/** Run tasks with a bounded concurrency, preserving input order. */
async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = [];
  const size = clamp(Number.isSafeInteger(limit) ? limit : 1, 1, Math.max(1, items.length));
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
 * The route strings a preference list names.
 *
 * The two ladders carry different shapes — an assignment is a list of route strings,
 * a caller preference is a list of `{ route, reason }` entries — and both end up in
 * the same report, so they are read through one function rather than stringified.
 *
 * @param list - the preference entries.
 * @returns the route strings, in order.
 */
function routesOf(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => (typeof entry === 'string' ? entry : str(entry?.route)))
    .filter((route) => route !== undefined);
}

/**
 * The unit's own instruction, recovered from its prompt.
 *
 * The composer builds a prompt as "Perform the part of the task that concerns: …",
 * so the re-run passes the whole thing back rather than trying to reconstruct it.
 */
function originalUnitPrompt(unit) {
  return `Your unit of work:\n${unit.prompt}`;
}

/** One result of a spawned child, normalized to plain data. */
function normalizeChildResult(run, result) {
  const output = Array.isArray(result?.output) ? result.output : [];
  const text = contentToText(output);
  const stopReason = str(result?.stopReason) ?? 'error';
  const diagnostic = str(result?.diagnostic);
  // A child that did not complete ALWAYS reports why. Reading only `output` and
  // `stopReason` left `error` absent for a one-shot child that failed without a
  // message, so the captain saw `ok: false` and nothing else.
  const error = stopReason === 'completed' ? undefined : describeChildFailure(stopReason, text, diagnostic);
  return {
    childId: run?.id === undefined ? undefined : String(run.id),
    stopReason,
    text,
    preview: truncate(text, PREVIEW_CHARS),
    output,
    ...(error === undefined ? {} : { error }),
    ...(result?.structured === undefined ? {} : { structured: result.structured }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

/**
 * The orchestrator. One instance per plugin activation.
 */
export class Orchestrator {
  /**
   * @param options - `{ ctx, pool, taxonomy, store, preferences, logger }`.
   */
  constructor(options) {
    this.ctx = options.ctx;
    this.pool = options.pool;
    this.taxonomy = options.taxonomy;
    this.store = options.store;
    this.logger = options.logger;
    // Optional: the run-artifact writer. Absent in tests and in any deployment that
    // composes the plugin without one, in which case results stay inline unchanged.
    this.artifacts = options.artifacts;
    // What this plugin knows about its own runs: which units finished, what they
    // answered, and which of them can still be asked a question. Never persisted, and
    // never a progress surface — DSH owns progress.
    this.journal = options.journal ?? createRunJournal({ logger: options.logger });
    this.inFlight = new Set();
  }

  /** Current preferences (live state, not a snapshot). */
  get preferences() {
    return this.store.snapshot().preferences;
  }

  /** Current mode. */
  get mode() {
    return this.store.snapshot().mode;
  }

  /**
   * Refresh the live pool and prune calibrations for routes that vanished.
   * @param options - `{ signal }`.
   */
  async refresh(options = {}) {
    // The pool applies the user's route preferences on top of the deployment
    // policy, so they are handed over before every refresh.
    if (typeof this.pool.setPreferences === 'function') {
      this.pool.setPreferences(this.preferences);
    }
    const result = await this.pool.refresh(this.ctx, options);
    // Keep the persisted calibration file aligned with the live pool. This never
    // writes a route: it only removes calibrations whose route is gone.
    if (this.store.snapshot().preferences.calibrationEnabled) {
      try {
        this.store.pruneProfiles(result.models.map((model) => model.route));
      } catch (error) {
        this.logger?.warn?.(`orchestrator: could not prune stale calibrations: ${String(error)}`);
      }
    }
    return result;
  }

  /**
   * Produce a plan without executing it.
   *
   * @param request - `{ task, analysis?, requirements?, mode?, capabilities? }`.
   * @returns a plan document.
   */
  async plan(request) {
    await this.#ensurePool();

    const task = String(request.task ?? '');
    const analysis = this.#analyze(task, request);
    // Resolved ONCE per call: `#priceRatios` clones the whole persisted state, and
    // asking for it per ranking call meant a plan with several clusters cloned it
    // several times over for a value that cannot change mid-plan.
    const prices = this.#priceRatios();
    const ranked = rankModels(this.pool, this.taxonomy, analysis, {
      preferences: this.preferences,
      priceRatios: prices,
    });

    // A forced tier is honoured here exactly as `run` honours it. `plan` used to
    // ignore the request entirely, so the tool's newly-declared `tier` would have
    // been a third silently-ignored argument in the same afternoon.
    const tier = str(request.tier) ?? planTier(analysis, this.preferences);
    const assignments = resolveAssignments(this.preferences.capabilityAssignments, this.pool.models());
    const units =
      tier === 'direct' ? [] : this.#composeUnits(task, analysis, ranked, tier, undefined, assignments, prices, analysis.chain);

    return {
      mode: this.mode,
      tier,
      task,
      assignments: assignmentReport(assignments),
      analysis: {
        summary: analysis.summary,
        complexity: analysis.complexity,
        source: analysis.source,
        domains: analysis.domains ?? [],
        requirements: analysis.requirements.map((requirement) => {
          const descriptor = this.taxonomy.get(requirement.capability);
          const route = units.find((unit) => unit.capabilityId === requirement.capability);
          return {
            capability: requirement.capability,
            label: descriptor?.label ?? requirement.capability,
            group: descriptor?.group ?? 'unknown',
            weight: requirement.weight,
            required: requirement.required === true,
            ...(requirement.reason === undefined ? {} : { reason: requirement.reason }),
            ...(route?.route === undefined ? {} : { route: route.route }),
          };
        }),
      },
      units: units.map((unit) => ({
        id: unit.id,
        capabilityId: unit.capabilityId,
        capabilityLabel: unit.capabilityLabel,
        prompt: unit.prompt,
        route: unit.route,
        provider: unit.provider,
        model: unit.model,
        routeReason: unit.routeReason,
        ...(unit.decidedBy === undefined ? {} : { decidedBy: unit.decidedBy }),
        ...(unit.overriddenCallerPreference === undefined
          ? {}
          : { overriddenCallerPreference: unit.overriddenCallerPreference }),
        ...(unit.unrouted === true ? { unrouted: true } : {}),
        dependsOn: unit.dependsOn,
        ...(unit.alternatives.length === 0 ? {} : { alternatives: unit.alternatives }),
      })),
      pool: {
        size: this.pool.models().length,
        providers: this.pool.providers(),
        fingerprint: poolFingerprint(this.pool),
        discoveredAt: this.pool.discoveredAt(),
      },
      rejected: ranked.rejected.slice(0, 12),
      warnings: this.#warnings(tier, ranked, analysis, units),
    };
  }

  /**
   * Execute a task end to end.
   *
   * @param request - `{ task, analysis?, units?, tier?, captain, signal, onProgress }`.
   * @returns a run document containing every expert result for the captain.
   */
  async run(request) {
    // Captured BEFORE any work. `elapsedMs` was computed against a `startedAt` taken
    // as the run document was assembled — after every child had already finished — so
    // it always reported a few milliseconds and told the caller nothing about how long
    // the run actually took.
    const startedAt = Date.now();
    await this.#ensurePool();

    const task = String(request.task ?? '');
    const analysis = this.#analyze(task, request);
    const prices = this.#priceRatios();
    const ranked = rankModels(this.pool, this.taxonomy, analysis, {
      preferences: this.preferences,
      priceRatios: prices,
    });

    // A caller that supplies its own units is asking for delegation explicitly, so a
    // tier this plugin merely INFERRED must not discard them. It did: a supplied
    // two-unit graph was dropped without a word whenever the task text read as
    // direct, which made "a caller that supplies its own units keeps full control of
    // the graph" false in exactly the case where the caller was most explicit.
    // An explicit `tier: 'direct'` still wins — that is the caller saying so.
    const suppliedUnits =
      Array.isArray(request.units) && request.units.length > 0 ? request.units : undefined;
    const forcedTier = str(request.tier);
    const tier =
      forcedTier ??
      (suppliedUnits === undefined ? planTier(analysis, this.preferences) : 'specialist');
    const runId = randomUUID();
    const assignments = resolveAssignments(this.preferences.capabilityAssignments, this.pool.models());

    if (tier === 'direct') {
      return this.#finishRun({
        runId,
        task,
        analysis,
        tier,
        units: [],
        results: [],
        startedAt,
        captain: request.captain,
        assignments,
      });
    }

    const units = this.#composeUnits(
      task,
      analysis,
      ranked,
      tier,
      suppliedUnits,
      assignments,
      prices,
      request.chain === true || analysis.chain === true,
    );
    const limits = this.preferences;
    const maxAgents = clamp(limits.maxAgentsPerRun, 1, 64);
    const selected = units.slice(0, maxAgents);
    const dropped = units.slice(maxAgents);

    this.journal.begin({
      runId,
      sessionId: request.captain?.id === undefined ? undefined : String(request.captain.id),
      task,
      tier,
      startedAt,
      units: selected,
    });

    const runSignal = childSignal(request.signal);
    this.inFlight.add(runSignal);

    // Finish before the caller's ceiling does, so a long run returns what completed
    // instead of a timeout error and nothing at all.
    const budgetMs = uint(request.budgetMs) ?? DEFAULT_RUN_BUDGET_MS;
    let budgetExhausted = false;
    const budgetTimer = setTimeout(() => {
      budgetExhausted = true;
      runSignal.cancel('run budget exhausted');
    }, budgetMs);
    budgetTimer.unref?.();

    try {
      const results = await this.#executeUnits(selected, {
        captain: request.captain,
        signal: runSignal.signal,
        concurrency: limits.maxParallel,
        onProgress: request.onProgress,
        runId,
      });

      // The review loop runs AFTER the dependency waves, because a reviewer must see
      // the answers it reviews. An objection goes back to the unit it names and that
      // unit is re-run; the rounds are bounded.
      await this.#runReviewLoop({
        runId,
        units: selected,
        results,
        context: {
          captain: request.captain,
          signal: runSignal.signal,
          concurrency: limits.maxParallel,
        },
      });

      const document = this.#finishRun({
        runId,
        task,
        analysis,
        tier,
        units: selected,
        results,
        dropped,
        startedAt,
        captain: request.captain,
        assignments,
      });
      this.journal.finish(runId, {
        status: budgetExhausted ? 'aborted' : 'done',
        ...(budgetExhausted ? { error: 'run budget exhausted' } : {}),
      });
      // Every unit's complete answer goes to disk before the document is bounded, so
      // the caller keeps the full content even when the harness would have elided it.
      const finishedAt = Date.now();
      const withArtifacts = this.#attachArtifacts(document, {
        captain: request.captain,
        startedAt,
        finishedAt,
      });
      return {
        ...withArtifacts,
        budgetMs,
        ...(budgetExhausted ? { budgetExhausted: true } : {}),
      };
    } finally {
      clearTimeout(budgetTimer);
      this.inFlight.delete(runSignal);
      // The listener this run attached to the caller's signal has to come off, or a
      // session-scoped signal accumulates one per orchestration. `dispatch` did this;
      // `run`, which is the common path, did not — so the leak the earlier fix was
      // written for survived on the path that matters most.
      runSignal.detach();
    }
  }

  /**
   * Dispatch one explicit unit of work to one route.
   *
   * This is the low-level primitive behind `orchestrate_dispatch`, and is what a
   * caller uses when it already knows the decomposition and only needs routing.
   */
  async dispatch(request) {
    await this.#ensurePool();

    // Registered exactly as a run's signal is, so teardown aborts this child too
    // and `/state` counts it as in flight. Without it a dispatch could not be
    // cancelled and was invisible to the capacity figures.
    const runSignal = childSignal(request.signal);
    this.inFlight.add(runSignal);
    try {
      return await this.#dispatchRegistered(request, runSignal.signal);
    } finally {
      this.inFlight.delete(runSignal);
      runSignal.detach();
    }
  }

  /** The body of {@link dispatch}, after its signal has been registered. */
  async #dispatchRegistered(request, signal) {
    const task = String(request.task ?? '');
    const explicitRoute = routeKey(request.provider, request.model);
    let chosen;
    let reason = 'explicitly requested';

    if (explicitRoute !== undefined) {
      const profile = this.pool.get(explicitRoute);
      if (profile === undefined) {
        return {
          ok: false,
          error: `route "${explicitRoute}" is not in the live model pool`,
          pool: { size: this.pool.models().length, providers: this.pool.providers() },
        };
      }
      chosen = {
        route: profile.route,
        provider: profile.provider,
        model: profile.model,
        name: profile.name,
        tier: profile.derived?.tier ?? 'unknown',
        score: 1,
        evidence: profile.evidence,
      };
    } else {
      const capabilityId = str(request.capability);
      const descriptor = capabilityId === undefined ? undefined : this.taxonomy.get(capabilityId);
      if (descriptor === undefined) {
        const available = this.taxonomy.list().map((entry) => entry.id);
        return {
          ok: false,
          error:
            capabilityId === undefined
              ? 'either a capability or an explicit provider+model route is required'
              : `unknown capability "${capabilityId}"`,
          availableCapabilities: available.slice(0, 60),
        };
      }
      const decision = chooseRoute(
        this.pool,
        this.taxonomy,
        { capability: descriptor.id, weight: 1 },
        { preferences: this.preferences },
      );
      if (decision.chosen === undefined) {
        return {
          ok: false,
          error: `no model in the live pool can serve "${descriptor.id}"`,
          reason: decision.reason,
          rejected: decision.rejected.slice(0, 12),
        };
      }
      chosen = decision.chosen;
      reason =
        decision.chosen.matched.length > 0
          ? decision.chosen.matched.join('; ')
          : 'best available fit for the capability';
    }

    const persona =
      str(request.persona) ??
      specialistPersona({
        capabilityId: str(request.capability),
        capabilityLabel: str(request.capability) ?? chosen.route,
        outputContract: str(request.outputContract),
        executionPrompt: str(request.executionPrompt),
      });

    const reasoningEffort = this.#resolveEffort(request.reasoningEffort, chosen.route);
    const maxTokens = uint(request.maxTokens);
    const agentOptions = {
      provider: chosen.provider,
      model: chosen.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    };

    const unitStartedAt = Date.now();
    const child = await this.#spawnOne({
      prompt: str(request.prompt) ?? task,
      originalTask: task,
      persona,
      // The calling agent is the parent, so the delegated child is attributed
      // to the session that asked for the work.
      parent: request.captain,
      agentOptions,
      signal,
      // The route is part of the label, not decoration: it is the only durable
      // record of it (see `delegationLabel`). A dispatch that omitted it showed
      // up on the board as a delegation with no route, while an `orchestrate_run`
      // delegation on the same engine showed one.
      label: delegationLabel(str(request.label) ?? str(request.capability), chosen.route),
    });

    // An explicit level this route cannot express is dropped and SAID, not sent to
    // fail at the adapter (see `#resolveEffort`).
    const askedEffort = str(request.reasoningEffort);
    const effortUnavailable =
      askedEffort !== undefined && reasoningEffort !== askedEffort ? askedEffort : undefined;

    const runId = randomUUID();
    // The dispatch result is a real unit result: it carries an id, its outcome, and
    // its own duration. It previously reused the raw child object, which has no `id`,
    // so `counts` reported 0 completed / 1 failed for a dispatch that had SUCCEEDED
    // and the routes list came back empty.
    const ok = child.stopReason === 'completed';
    const unitResult = {
      id: 'dispatch',
      capabilityId: str(request.capability) ?? 'explicit',
      capabilityLabel: str(request.label) ?? str(request.capability) ?? 'dispatch',
      route: chosen.route,
      routeReason: reason,
      elapsedMs: Date.now() - unitStartedAt,
      ...(effortUnavailable === undefined ? {} : { effortUnavailable }),
      ok,
      ...child,
    };
    const document = this.#finishRun({
      runId,
      task,
      analysis: {
        summary: task,
        complexity: 'specialist',
        requirements: [],
        source: 'auto',
      },
      tier: 'specialist',
      units: [
        {
          id: 'dispatch',
          capabilityId: str(request.capability) ?? 'explicit',
          route: chosen.route,
          routeReason: reason,
          ...(effortUnavailable === undefined ? {} : { effortUnavailable }),
        },
      ],
      results: [unitResult],
      startedAt: unitStartedAt,
      captain: request.captain,
    });
    const finishedAt = Date.now();
    const run = this.#attachArtifacts(document, {
      captain: request.captain,
      startedAt: unitStartedAt,
      finishedAt,
    });
    // `dispatch` always reports its own outcome, so a caller can branch on `ok`
    // without inspecting the tier or the child's stop reason.
    return {
      ok: true,
      route: chosen.route,
      routeReason: reason,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(effortUnavailable === undefined ? {} : { effortUnavailable }),
      ...run,
    };
  }

  /**
   * Ask a SIBLING unit of the same run a question, and return its answer.
   *
   * The point is to let work that has already been done answer a follow-up, instead
   * of the asking unit re-deriving the same context or the captain losing it. The
   * unit is asked on the route it originally ran on, with its own answer as context,
   * so the follow-up is answered by the model that did the work.
   *
   * Three bounds make this safe rather than a way to multiply a run's cost:
   * a per-run question budget, a per-question timeout, and a refusal for a unit that
   * is still RUNNING — it has no answer yet, so queueing would either deadlock the
   * asker or duplicate the work. The refusal names the units that CAN be asked.
   *
   * @param request - `{ runId, from, to, question, captain, signal }`.
   * @returns `{ ok, answer?, error?, askable }`.
   */
  async ask(request) {
    const runId = str(request?.runId);
    const to = str(request?.to);
    const question = str(request?.question);

    // Only a run THIS process is tracking can be asked: the question is answered from
    // what the run produced, and a restarted process has nothing to answer from.
    const tracked = runId === undefined ? undefined : this.journal.get(runId);
    if (tracked === undefined) {
      return {
        ok: false,
        error: runId === undefined ? 'runId is required' : `run "${runId}" is not tracked by this process`,
        askable: [],
      };
    }
    const askable = this.journal.askable(runId);
    if (question === undefined) {
      return { ok: false, error: 'question is required', askable };
    }

    const policy = this.#questionPolicy();
    const from = str(request?.from) ?? 'captain';
    const asked = tracked.questions.filter((entry) => entry.from === from).length;
    if (asked >= policy.maxPerRun) {
      return {
        ok: false,
        error: `question budget exhausted (${policy.maxPerRun} per run)`,
        askable,
      };
    }

    const target = tracked.units.get(to ?? '');
    if (target === undefined) {
      return { ok: false, error: `no unit "${to ?? ''}" in run "${runId}"`, askable };
    }
    if (target.status === 'running') {
      return {
        ok: false,
        error: `unit "${to}" is still running, so it cannot answer yet`,
        // Named explicitly: the caller is told who CAN answer instead of guessing.
        askable: askable.filter((entry) => entry.id !== to),
      };
    }
    if (target.status !== 'completed') {
      return {
        ok: false,
        error: `unit "${to}" did not complete, so there is no answer to question`,
        askable,
      };
    }

    const profile = target.route === undefined ? undefined : this.pool.get(target.route);
    if (profile === undefined) {
      return {
        ok: false,
        error: `the route "${target.route ?? 'unknown'}" unit "${to}" ran on has left the live pool`,
        askable,
      };
    }

    const startedAt = Date.now();
    const bounded = childSignal(request?.signal);
    const timer = setTimeout(() => bounded.cancel('question timed out'), policy.timeoutMs);
    timer.unref?.();
    try {
      const child = await this.#spawnOne({
        prompt: [
          `You answered an earlier unit of work. Another unit of the same run is asking a`,
          `follow-up question about it. Answer the question directly and concretely.`,
          ``,
          `The unit you answered (${target.capabilityLabel ?? target.id}):`,
          String(target.text ?? '').slice(0, DEFAULT_HANDOFF_CHARS),
          ``,
          `Question:`,
          question,
        ].join('\n'),
        originalTask: tracked.task,
        persona: specialistPersona({
          capabilityId: target.capabilityId,
          capabilityLabel: target.capabilityLabel ?? target.id,
          outputContract: 'a direct answer to the question, grounded in the work above',
        }),
        parent: request?.captain,
        agentOptions: { provider: profile.provider, model: profile.model },
        signal: bounded.signal,
        label: delegationLabel(`${target.capabilityLabel ?? target.id} (question)`, target.route),
      });
      const elapsedMs = Date.now() - startedAt;
      const ok = child.stopReason === 'completed';
      this.journal.recordQuestion(runId, {
        from,
        to: target.id,
        question,
        ok,
        ...(ok ? { answer: child.text } : {}),
        ...(ok ? {} : { error: child.error ?? `stopped with ${child.stopReason}` }),
        elapsedMs,
      });
      return {
        ok,
        from,
        to: target.id,
        route: target.route,
        elapsedMs,
        ...(ok ? { answer: child.text } : {}),
        ...(ok ? {} : { error: child.error ?? `the unit stopped with reason "${child.stopReason}"` }),
        // Reported on every outcome, so the caller learns who else is available.
        askable: this.journal.askable(runId).filter((entry) => entry.id !== target.id),
      };
    } catch (error) {
      this.journal.recordQuestion(runId, {
        from,
        to: target.id,
        question,
        ok: false,
        error: String(error?.message ?? error),
        elapsedMs: Date.now() - startedAt,
      });
      return {
        ok: false,
        error: String(error?.message ?? error),
        askable: this.journal.askable(runId),
      };
    } finally {
      clearTimeout(timer);
      bounded.detach();
    }
  }

  /**
   * Abort every delegated child this orchestrator currently has in flight.
   *
   * Called from plugin teardown so a reload cannot orphan a running child. It
   * deliberately exposes no listing: the orchestrator keeps no queryable run
   * state, because DSH already owns task and progress reporting.
   *
   * @param reason - the cancellation reason.
   * @returns how many in-flight delegations were aborted.
   */
  abortAll(reason) {
    let aborted = 0;
    for (const controller of [...this.inFlight]) {
      try {
        controller.cancel(reason ?? 'orchestrator disposed');
        aborted += 1;
      } catch {
        // Best effort: a controller that already settled is not an error.
      }
    }
    this.inFlight.clear();
    return aborted;
  }

  /** How many delegated children are in flight right now. */
  get inFlightCount() {
    return this.inFlight.size;
  }

  // ---- internals -----------------------------------------------------------

  async #ensurePool() {
    if (this.pool.models().length === 0 || this.pool.lastError() !== undefined) {
      await this.refresh({});
      return;
    }
    if (!this.#poolIsStale()) return;
    // A stale pool is refreshed LAZILY, and a failure keeps the pool that already
    // exists: a provider that is slow or offline must degrade routing, never break
    // the call that happened to trip the timer.
    try {
      await this.refresh({});
    } catch (error) {
      this.logger?.warn?.(
        `orchestrator: could not refresh a stale model pool, keeping the previous one: ${String(error)}`,
      );
    }
  }

  /**
   * Whether the live provider topology differs from what the last discovery saw.
   *
   * A synchronous registry read — no provider I/O — so a poll can afford it. It is
   * what lets the control panel follow a provider that registered AFTER this plugin
   * activated: the panel used to serve whatever the activation-time discovery saw
   * until someone pressed Refresh, so it could report one provider while the tools,
   * which call {@link Orchestrator.#ensurePool}, already saw five. The panel and the
   * tools read one pool; the panel simply never asked it to move.
   *
   * @returns `true` when the live provider set no longer matches the advertised one.
   */
  poolTopologyChanged() {
    const advertised = this.pool.advertisedProviders?.();
    if (!Array.isArray(advertised)) return false;
    const live = this.#liveProviderIds();
    if (live === undefined) return false;
    return live.join('\u0000') !== [...advertised].sort().join('\u0000');
  }

  /**
   * Whether the pool should be re-read before it is used.
   *
   * The provider check is a synchronous registry read, so it is cheap enough to run on
   * every call and catches an adapter appearing or disappearing even if the host's
   * change event is never emitted.
   */
  #poolIsStale() {
    if (this.poolTopologyChanged()) return true;
    const seenAt = this.pool.discoveredAt?.() ?? 0;
    return Date.now() - seenAt > POOL_TTL_MS;
  }

  /** The provider ids the service currently registers, or `undefined` if unreadable. */
  #liveProviderIds() {
    const llm = this.ctx.get('llm');
    if (llm === undefined || typeof llm.listProviders !== 'function') return undefined;
    try {
      const providers = llm.listProviders() ?? [];
      return uniqueStrings(providers.map((provider) => str(provider?.id)).filter((id) => id !== undefined)).sort();
    } catch {
      return undefined;
    }
  }

  /**
   * Re-narrow the pool after a route preference changed, without re-discovering.
   *
   * `allowedRoutes` and `deniedRoutes` are read from local state, so changing them in
   * the panel used to leave the displayed pool filtered by the OLD sets until the TTL
   * expired: the panel said one thing and routing did another.
   *
   * @returns the number of routable models.
   */
  refilterPool() {
    if (typeof this.pool.setPreferences === 'function') {
      this.pool.setPreferences(this.preferences);
    }
    return typeof this.pool.refilter === 'function' ? this.pool.refilter() : this.pool.models().length;
  }

  #analyze(task, request) {
    const supplied = isRecord(request.analysis)
      ? request.analysis
      : Array.isArray(request.requirements)
        ? { requirements: request.requirements }
        : undefined;

    const local = this.#localAnalysis(task);
    if (supplied === undefined) return local;

    const fromModel = analysisFromModel(this.taxonomy, supplied);
    if (fromModel.requirements.length > 0) {
      // The caller stated its own decomposition, which is its judgement ABOUT THE
      // TASK. The areas the user selected for this session are a different thing —
      // an instruction from the person — and returning here dropped them, so a
      // caller that answered at all silently overrode the user's own session
      // setting. They are merged instead, with the caller winning wherever both
      // name the same capability, because for that capability it is the more
      // specific statement.
      return this.#withGuidedAreas(fromModel, 'model');
    }

    // The caller sent an analysis but stated no requirements: it left exactly that
    // one field for the vocabulary to fill. Discarding the whole analysis along
    // with that field also threw away the caller's own complexity reading and the
    // model preferences it had named — `analysis.unitModelPreference` silently did
    // nothing on this path, which is the difference between heterogeneous units
    // routed to different models and every unit inheriting one default.
    const claimed = ['trivial', 'simple', 'specialist', 'complex'].includes(supplied.complexity)
      ? supplied.complexity
      : undefined;
    return {
      ...fromModel,
      requirements: local.requirements,
      complexity: claimed ?? local.complexity,
      source: 'model+local',
    };
  }

  /**
   * Requirements read from the task's own vocabulary, plus the Guided-mode seed.
   *
   * Guided mode: the user selected capability areas for this session, so they seed
   * the requirement set before the task's own vocabulary narrows it. The fallback
   * vocabulary is configuration, so an operator can replace the built-in hints
   * instead of being stuck with the author's phrasing.
   */
  #localAnalysis(task) {
    const local = analysisFromText(this.taxonomy, task, { preferences: this.preferences });
    return this.#withGuidedAreas(local, 'local');
  }

  /**
   * Fold the user's Guided capability areas into an analysis.
   *
   * These are the areas the person selected for the SESSION, so they seed the
   * requirement set whatever produced the rest of it — and they apply only in
   * Guided mode, because Auto means "read each task and decide by itself", which is
   * what the panel says and what the mode is for. Areas left selected while Auto is
   * on are kept for when Guided comes back, not applied.
   *
   * Merge rule, and it is the opposite of the caller-preference ladder on purpose:
   * for a capability BOTH name, the caller's requirement wins (it is the more
   * specific statement about this task); an area the caller did not name is ADDED,
   * because nothing else was going to bring it up and the user asked for it.
   *
   * @param analysis - the analysis to seed.
   * @param origin - `'local'` or `'model'`, used to name the resulting source.
   * @returns the analysis, with the areas applied when there are any.
   */
  #withGuidedAreas(analysis, origin) {
    if (this.mode !== 'guided') return analysis;
    const guided = this.store.snapshot().guided.capabilities;
    if (guided.length === 0) return analysis;

    const byId = new Map(analysis.requirements.map((requirement) => [requirement.capability, requirement]));
    const seeds = [];
    let added = 0;
    for (const id of guided) {
      if (!this.taxonomy.has(id)) continue;
      const existing = byId.get(id);
      if (existing === undefined) {
        const seed = { capability: id, weight: 0.7, reason: 'selected in Guided mode' };
        byId.set(id, seed);
        seeds.push(seed);
        added += 1;
      } else if (existing.weight < 0.7) {
        // An area the task also mentioned: the seed raises its weight, which is
        // what "this session cares about it" should mean, without discarding the
        // caller's own reason for naming it.
        byId.set(id, { ...existing, weight: 0.7 });
      }
    }

    // Order matters downstream: a cluster's primary requirement is the first one
    // the composition meets, and the caller's own order is a deliberate sequence.
    // So a caller's list keeps its order and only the ADDED areas are appended —
    // the local path keeps the weight ordering it always had.
    const requirements =
      origin === 'local'
        ? [...byId.values()].sort((left, right) => right.weight - left.weight)
        : [...analysis.requirements.map((requirement) => byId.get(requirement.capability)), ...seeds];
    return {
      ...analysis,
      requirements,
      // The source names what actually contributed, so a plan can be read back
      // without guessing whether the areas were in play.
      source: added === 0 && origin === 'model' ? analysis.source : `${origin === 'local' ? '' : `${origin}+`}guided`,
      guidedCapabilities: uniqueStrings(guided),
    };
  }

  /**
   * Resolve the reasoning effort one delegation runs with.
   *
   * Order, highest first:
   *
   *   1. the caller's own choice for the unit — the model reading the task decides;
   *   2. the preference configured for the chosen route in the model pool;
   *   3. the capability descriptor's declared level, when it names one;
   *   4. nothing, which leaves the target model to apply its own default.
   *
   * A configured id the route does not currently advertise is IGNORED rather than
   * sent: the host rejects an unsupported effort outright
   * (`UNSUPPORTED_REASONING_EFFORT`), so a preference left over from an adapter
   * change would fail the child instead of quietly degrading.
   *
   * @param requested - the caller's own effort for this unit, when it named one.
   * @param route - the exact `provider/model` the unit was routed to.
   * @param fallback - the descriptor's declared level, when it has one.
   * @returns the effort id to send, or `undefined` to send none.
   */
  /**
   * The reasoning level to send for one unit, or `undefined` to send none.
   *
   * EVERY source is checked against what the destination route can express. The
   * caller's own value used to be returned unvalidated, on the theory that the
   * caller's judgement outranks the plugin's — and then the preflight rejected the
   * route at the adapter and the unit produced no answer at all, because the caller
   * named a level from its own vocabulary (`medium`, the common low/medium/high
   * triad) on a route that advertises `low`/`high`/`max`. A level the route cannot
   * express is not a judgement this plugin can honour, and dropping it — the route
   * then resolves its own default — is strictly better than losing the answer. The
   * drop is reported to the caller as `effortUnavailable`, never swallowed.
   *
   * The predicate is deliberately the same `#acceptsEffort` the configured
   * preference uses: a route that advertises levels must contain this one, while a
   * route that advertises none and reasons automatically still takes a hand-set
   * level (see `effortPatch`).
   */
  #resolveEffort(requested, route, fallback) {
    const explicit = str(requested);
    if (explicit !== undefined) {
      return this.#acceptsEffort(route, explicit) ? explicit : undefined;
    }
    const configured = str(this.preferences.reasoningEffort?.[str(route)]);
    if (configured !== undefined && this.#acceptsEffort(route, configured)) return configured;
    const declared = str(fallback);
    if (declared !== undefined && this.#acceptsEffort(route, declared)) return declared;
    return undefined;
  }

  /**
   * Whether a route may be sent one effort id.
   *
   * Two acceptances, and the distinction is the point:
   *
   *  - the route ADVERTISES the id — a measured fact;
   *  - the route reasons without advertising levels at all, and the id was set
   *    deliberately. Nothing can verify it, so a wrong value fails at dispatch
   *    with the adapter's own error; that is the operator's informed choice, and
   *    the alternative (silently ignoring what they asked for) is worse. It is
   *    marked `unverified` where it is set, so it is never mistaken for a checked
   *    preference.
   *
   * A route that advertises a list keeps the strict rule: an id that is no longer
   * on it is ignored rather than sent, because that is a stale entry rather than a
   * decision.
   */
  #acceptsEffort(route, effort) {
    if (this.#advertises(route, effort)) return true;
    const facts = this.pool.get(str(route))?.facts;
    const advertisesAny = Array.isArray(facts?.efforts) && facts.efforts.length > 0;
    return advertisesAny !== true && facts?.reasoningMode === 'automatic';
  }

  /**
   * Researched prices, normalised within the live pool.
   *
   * Empty until the user syncs. Resolved on every ranking call rather than cached
   * because a sync can land between two calls, and a stale price scale would shape
   * tie-breaks against a pool that no longer exists.
   */
  #priceRatios() {
    return priceRatios(this.pool.models(), this.store.snapshot().research);
  }

  /** Whether the live profile for a route advertises one reasoning effort id. */
  #advertises(route, effort) {
    const key = str(route);
    if (key === undefined) return false;
    const efforts = this.pool.get(key)?.facts?.efforts;
    return Array.isArray(efforts) && efforts.includes(effort);
  }

  #composeUnits(task, analysis, ranked, tier, suppliedUnits, assignments, prices, chain) {
    const units = [];

    /**
     * The caller's per-unit preferences, matched to a unit by its capability id,
     * its cluster, or its unit id.
     *
     * Most specific match wins, so a preference for `multimodal.screenshot` beats
     * one for the whole `multimodal` cluster on that unit alone. A unit that matches
     * nothing keeps the task-level preference.
     */
    const unitPreferences = Array.isArray(analysis.unitModelPreference) ? analysis.unitModelPreference : [];
    const preferenceFor = ({ capabilityId, group }) => {
      // Most specific first: the exact capability, then the cluster. Iterating the
      // TARGETS in that order - rather than testing each entry against every target
      // - is what makes the narrow name win when a caller supplies both.
      //
      // The unit id is deliberately NOT a target: a cluster's unit id IS its group
      // name, so including it would duplicate the cluster and let a cluster-wide
      // preference shadow a capability-specific one.
      const wanted = [capabilityId, group].filter((value) => typeof value === 'string');
      for (const target of wanted) {
        const match = unitPreferences.find((entry) => entry.target === target);
        if (match !== undefined) return match.routes;
      }
      return undefined;
    };

    /** Route one cluster against its own capabilities plus the task's level. */
    const chooseRouteFor = (requirements, preference) => {
      const ranking = rankModels(
        this.pool,
        this.taxonomy,
        {
          summary: task,
          complexity: analysis.complexity,
          requirements,
          source: analysis.source,
          // A per-unit preference replaces the task-level one for this unit: the
          // caller was more specific, so it is more informed here.
          modelPreference: preference ?? analysis.modelPreference,
        },
        { preferences: this.preferences, priceRatios: prices },
      );
      return {
        chosen: ranking.candidates[0],
        alternatives: ranking.candidates.slice(1, 4),
        rejected: ranking.rejected,
        // What the preference ACTUALLY did: which routes it reordered into place, and
        // which it named that the pool does not have. Without these the result could
        // not say whether a stated preference was honoured, beaten by the table, or
        // never matched anything.
        preferred: ranking.preferred,
        unresolvedPreferences: ranking.unresolvedPreferences,
        reason: ranking.summary.poolEmpty ? 'the live model pool is empty' : undefined,
      };
    };

    /**
     * Who decided a unit's route.
     *
     * The user's standing table is FIRST: a capability the user has configured always
     * follows the table, which is what makes it a division of labour rather than a
     * suggestion. The calling model's own statements sit below it, and the result names
     * which of them won so "why is this on that model" is answerable from the run.
     *
     * @param tableApplies - whether the assignment resolved to a usable route list.
     * @param callerPreference - the caller's per-unit preference, when it named one.
     * @param preferred - the routes the applied preference actually reordered.
     * @returns `'assignment' | 'caller-unit' | 'caller-task' | 'measured'`.
     */
    const decidedByFor = (tableApplies, callerPreference, preferred) => {
      if (tableApplies) return 'assignment';
      if (callerPreference !== undefined) return 'caller-unit';
      if (Array.isArray(preferred) && preferred.length > 0) return 'caller-task';
      return 'measured';
    };

    /**
     * The preference list a unit is routed with, in precedence order.
     *
     * Returned with its attribution so the reason and the result agree by construction.
     *
     * @param capability - the capability the unit is being routed by.
     * @param group - its cluster.
     * @returns `{ preference, decidedBy, assigned, callerPreference, overridden }`.
     */
    const routingInputs = (capability, group) => {
      const callerPreference = preferenceFor({ capabilityId: capability, group });
      const assigned = assignedPreferenceFor(assignments, { capability, group });
      const tableApplies = Array.isArray(assigned) && assigned.length > 0;
      const preference = tableApplies
        ? assigned.map((route) => ({ route, reason: 'standing capability assignment' }))
        : callerPreference;
      return {
        preference,
        assigned: tableApplies ? assigned : undefined,
        callerPreference,
        tableApplies,
      };
    };

    /**
     * What the user's table actually displaced, if anything.
     *
     * Only reported when the outcome DIFFERS from what the caller asked for. Naming a
     * preference as "overridden" while routing to the very route it named is a false
     * accusation: it tells the caller its input was ignored when it was honoured, and
     * it made every table-driven unit look like a conflict. A live check caught exactly
     * that — the table and the caller agreed, and the result still claimed an override.
     *
     * @param inputs - a {@link routingInputs} result.
     * @param chosenRoute - the route that was actually selected.
     * @returns the displaced routes, or `undefined` when nothing was displaced.
     */
    const overriddenBy = (inputs, chosenRoute) => {
      if (!inputs.tableApplies || inputs.callerPreference === undefined) return undefined;
      const wanted = routesOf(inputs.callerPreference);
      if (wanted.length === 0) return undefined;
      // The caller's own first choice is what it would have got, so a table that lands
      // on it displaced nothing. The whole list is reported when it did not, because
      // the caller needs to see everything its statement lost to.
      if (wanted[0] === chosenRoute) return undefined;
      return wanted;
    };

    if (Array.isArray(suppliedUnits) && suppliedUnits.length > 0) {
      for (const [index, unit] of suppliedUnits.entries()) {
        if (!isRecord(unit)) continue;
        const id = str(unit.id) ?? `unit-${index + 1}`;
        const capabilityId = str(unit.capabilityId) ?? 'supplied';
        const label = str(unit.capabilityLabel) ?? str(unit.capabilityId) ?? 'supplied work';
        const base = {
          id,
          capabilityId,
          capabilityLabel: label,
          prompt: String(unit.prompt ?? ''),
          dependsOn: Array.isArray(unit.dependsOn) ? unit.dependsOn.map(String) : [],
          // A unit that declares what it REVIEWS is scheduled after those units and
          // receives their complete answers, so the list has to survive composition.
          reviews: Array.isArray(unit.reviews) ? unit.reviews.map(String) : [],
          originalTask: task,
        };

        // A supplied unit may pin its own route, name a provider and model, or leave the
        // choice to the orchestrator. The first and third are documented on the parameter
        // and NEITHER worked: `route` was copied onto the unit but never resolved into the
        // provider and model a dispatch needs, and an omitted route was never routed at
        // all. Every caller-supplied unit therefore reached the dispatch guard with no
        // provider, which reported the unit's route REASON as its error — so a caller that
        // had supplied a perfectly good graph read `error: "supplied by the caller"` and
        // concluded its units had been rejected.
        const explicitProvider = str(unit.provider);
        const explicitModel = str(unit.model);
        const requested =
          str(unit.route) ??
          (explicitProvider === undefined || explicitModel === undefined
            ? undefined
            : routeKey(explicitProvider, explicitModel));

        const pinned = requested === undefined ? undefined : this.pool.get(requested);
        if (pinned !== undefined) {
          units.push({
            ...base,
            route: pinned.route,
            provider: pinned.provider,
            model: pinned.model,
            routeReason: `supplied by the caller, pinned to ${pinned.route}`,
            decidedBy: 'caller-pin',
            alternatives: [],
          });
          continue;
        }

        // No usable pin: route it by the capability it names, EXACTLY as a derived unit
        // is routed — same ladder, same precedence. The user's standing capability
        // assignment applies here too.
        //
        // It did not. This branch consulted only the caller's own
        // `unitModelPreference`, so a caller that supplied its own unit graph silently
        // bypassed the division of labour the user had configured: a table saying
        // "implementation to DeepSeek, architecture to GPT" was honoured for derived
        // units and ignored for supplied ones, which is the opposite of what a caller
        // supplying units would expect.
        //
        // A named route that is NOT in the live pool takes this path too — the pool
        // changes under a session (a deployment that edits its provider's models is the
        // case this was reported from), and losing the whole unit to a stale name is
        // worse than routing it and saying so.
        const suppliedGroup = capabilityId.split('.')[0];
        const inputs = routingInputs(capabilityId, suppliedGroup);
        const decision = chooseRouteFor(
          [{ capability: capabilityId, weight: 1, required: false }],
          inputs.preference,
        );
        const suppliedDecidedBy = decidedByFor(
          inputs.tableApplies,
          inputs.callerPreference,
          decision.preferred,
        );
        const suppliedOverridden = overriddenBy(inputs, decision.chosen?.route);
        if (decision.chosen === undefined) {
          units.push({
            ...base,
            route: undefined,
            provider: undefined,
            model: undefined,
            routeReason: `supplied by the caller, but no model could serve "${capabilityId}"${
              decision.reason === undefined ? '' : `: ${decision.reason}`
            }`,
            unrouted: true,
            alternatives: [],
          });
          continue;
        }
        const suppliedWhy = (() => {
          const measured =
            decision.chosen.matched.slice(0, 3).join('; ') || 'best available capability fit';
          if (inputs.tableApplies) {
            const displaced =
              suppliedOverridden === undefined
                ? ''
                : `; it overrode the caller's unitModelPreference (${suppliedOverridden.join(', ')})`;
            return `assigned: ${capabilityId} → ${inputs.assigned.join(', ')} (${measured})${displaced}`;
          }
          if (inputs.callerPreference !== undefined) {
            return `the caller's unitModelPreference (${routesOf(inputs.callerPreference).join(', ')}): ${measured}`;
          }
          if (decision.preferred.length > 0) {
            return `the caller's modelPreference (${decision.preferred.join(', ')}): ${measured}`;
          }
          return measured;
        })();
        units.push({
          ...base,
          route: decision.chosen.route,
          provider: decision.chosen.provider,
          model: decision.chosen.model,
          routeReason:
            requested === undefined
              ? `supplied by the caller, routed by "${capabilityId}": ${suppliedWhy}`
              : `supplied by the caller, but "${requested}" is not in the live pool; routed by "${capabilityId}" instead: ${suppliedWhy}`,
          decidedBy: requested === undefined ? suppliedDecidedBy : 'caller-pin',
          ...(suppliedOverridden === undefined
            ? {}
            : { overriddenCallerPreference: suppliedOverridden }),
          ...(requested === undefined ? {} : { routeRequested: requested }),
          ...(inputs.assigned === undefined || inputs.assigned.length < 2
            ? {}
            : { fallbacks: inputs.assigned.filter((route) => route !== decision.chosen.route) }),
          alternatives: decision.alternatives.map((candidate) => ({
            route: candidate.route,
            score: candidate.score,
          })),
        });
      }
    } else {
      // One unit per distinct capability cluster, in descending weight. Two
      // requirements that share a cluster and resolve to the same route are
      // merged, so a plan never pays twice for the same specialist.
      //
      // Level groups (`depth`, `capacity`) are separated out first: they state
      // how hard the work is, not what kind of expertise it needs. Left in the
      // cluster map they would spawn a second, redundant child asking the same
      // model to redo the same task.
      const levelRequirements = [];
      // One bucket per (cluster, effective preference). Capabilities in one
      // cluster that resolve to the SAME preferred routes stay one delegation;
      // ones that differ are split, because otherwise a standing table saying
      // "architecture to GPT, implementation to DeepSeek" would be merged back
      // into a single unit on a single model — the exact case it exists for.
      const buckets = new Map();
      for (const requirement of analysis.requirements) {
        const descriptor = this.taxonomy.get(requirement.capability);
        if (descriptor === undefined) continue;
        if (LEVEL_GROUPS.has(descriptor.group)) {
          levelRequirements.push(requirement);
          continue;
        }
        const signature = preferenceSignature(assignments, {
          capability: requirement.capability,
          group: descriptor.group,
        });
        const bucketKey = `${descriptor.group}\u0000${signature}`;
        const existing = buckets.get(bucketKey);
        if (existing === undefined) {
          buckets.set(bucketKey, { group: descriptor.group, requirements: [requirement] });
        } else {
          existing.requirements.push(requirement);
        }
      }

      // Unit ids must be unique: `#executeUnits` keys its results by id, so two
      // units sharing one id means the second overwrites the first and a
      // specialist's answer silently disappears from the run. A split cluster
      // produces exactly that, which is the headline case for assignments — so the
      // ordinal is part of the id rather than implied by the group.
      const groupOrdinals = new Map();

      for (const { group, requirements } of buckets.values()) {
        const primary = requirements[0];
        const ordinal = (groupOrdinals.get(group) ?? 0) + 1;
        groupOrdinals.set(group, ordinal);
        const unitId = ordinal === 1 ? group : `${group}-${ordinal}`;
        const descriptor = this.taxonomy.get(primary.capability);
        // Route on the cluster's own capability AND the task's level
        // requirements together: a difficult coding task must be routed to a
        // model that is both coding-capable and reasoning-capable.
        //
        // The preference ladder, highest first: what the calling model said about
        // THIS unit, then the user's standing assignment, then the calling model's
        // task-level judgement, then the measured ranking. The assignment sits
        // above the task-level preference on purpose — a table the user set up is
        // what they asked for, and a chatty caller must not quietly defeat it; the
        // more specific per-unit statement still wins.
        // The ladder, highest first: the user's standing capability assignment, then
        // what the calling model said about THIS unit, then the calling model's
        // task-level judgement, then the measured ranking. The table is FIRST on
        // purpose — a capability the user configured is a decision they made once and
        // expect to hold, and a chatty caller must not quietly defeat it. Every rung is
        // attributed in the result, so an override is stated rather than implied.
        const inputs = routingInputs(primary.capability, group);
        const decision = chooseRouteFor([...requirements, ...levelRequirements], inputs.preference);
        const decidedBy = decidedByFor(
          inputs.tableApplies,
          inputs.callerPreference,
          decision.preferred,
        );
        const overridden = overriddenBy(inputs, decision.chosen?.route);
        const routing = descriptorRouting(descriptor);
        const askedEffort = requirements
          .map((entry) => str(entry.reasoningEffort))
          .find((value) => value !== undefined);
        const effort = this.#resolveEffort(
          askedEffort,
          decision.chosen?.route,
          routing.reasoningEffort,
        );
        // Named when the caller asked for a level this route cannot express, so the
        // result says why the unit ran at the route's own default instead of only
        // reporting the level that was used.
        const effortUnavailable =
          askedEffort !== undefined && effort !== askedEffort ? askedEffort : undefined;
        if (decision.chosen === undefined) {
          units.push({
            id: `${unitId}-unrouted`,
            capabilityId: primary.capability,
            // Every capability this unit covers, so a caller can see that one unit
            // serves several and `plan()` can map each requirement to its route.
            capabilityIds: requirements.map((requirement) => requirement.capability),
            capabilityLabel: descriptor?.label ?? primary.capability,
            prompt: this.#unitPrompt(task, requirements),
            route: undefined,
            provider: undefined,
            model: undefined,
            routeReason: `no model could serve this capability${
              decision.reason === undefined ? '' : `: ${decision.reason}`
            }`,
            dependsOn: [],
            alternatives: [],
            originalTask: task,
            unrouted: true,
          });
          continue;
        }
        units.push({
          id: unitId,
          capabilityId: descriptor?.id ?? primary.capability,
          capabilityIds: requirements.map((requirement) => requirement.capability),
          capabilityLabel: descriptor?.label ?? primary.capability,
          prompt: this.#unitPrompt(task, requirements),
          route: decision.chosen.route,
          provider: decision.chosen.provider,
          model: decision.chosen.model,
          routeReason: (() => {
            // Name the constraint that actually decided the choice. A bound
            // requirement (a stated size, a required modality) is the reason; the
            // descriptor's generic evidence is only the fallback.
            const decided = decision.chosen.clearedConstraints ?? [];
            const measured =
              decided.length > 0
                ? [...decided, ...decision.chosen.matched.slice(0, 2)].join('; ')
                : decision.chosen.matched.length > 0
                  ? decision.chosen.matched.slice(0, 4).join('; ')
                  : decision.chosen.pinned === true
                    ? 'pinned by capability mapping'
                    : 'best available capability fit';
            // Say WHO decided, and which entry did it — otherwise "why is this on
            // Gemini" is unanswerable from the result, and a table that has quietly
            // stopped matching looks like a ranking change instead of a stale entry.
            if (decidedBy === 'assignment') {
              const displaced =
                overridden === undefined
                  ? ''
                  : `; it overrode the caller's unitModelPreference (${overridden.join(', ')})`;
              return `assigned: ${primary.capability} → ${inputs.assigned.join(', ')} (${measured})${displaced}`;
            }
            if (decidedBy === 'caller-unit') {
              return `the caller's unitModelPreference (${routesOf(inputs.callerPreference).join(', ')}): ${measured}`;
            }
            if (decidedBy === 'caller-task') {
              return `the caller's modelPreference (${decision.preferred.join(', ')}): ${measured}`;
            }
            return measured;
          })(),
          decidedBy,
          ...(overridden === undefined ? {} : { overriddenCallerPreference: overridden }),
          // Every other ordered candidate the table named, so a route that fails can
          // fall through to the next one instead of losing the unit.
          ...(inputs.assigned === undefined || inputs.assigned.length < 2
            ? {}
            : { fallbacks: inputs.assigned.filter((route) => route !== decision.chosen.route) }),
          // Carry the descriptor's own routing facts into the child request so
          // the matched model is used the way the capability intends.
          ...routing,
          // The reasoning level for this unit, resolved against the live route.
          // Absent rather than `undefined`: the host's lossless-JSON check rejects
          // an explicitly-undefined property.
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
          ...(effortUnavailable === undefined ? {} : { effortUnavailable }),
          dependsOn: [],
          alternatives: decision.alternatives.map((candidate) => ({
            route: candidate.route,
            score: candidate.score,
          })),
          originalTask: task,
        });
      }

      // Fall back to the single best route when nothing matched by vocabulary,
      // rather than refusing a task the pool could obviously still attempt.
      if (units.length === 0) {
        const best = ranked.candidates[0];
        units.push({
          id: 'general',
          capabilityId: 'general',
          capabilityLabel: 'General work',
          prompt: task,
          route: best?.route,
          provider: best?.provider,
          model: best?.model,
          routeReason:
            best === undefined
              ? 'the live model pool is empty'
              : 'no capability cue matched; using the best-evidenced general route',
          dependsOn: [],
          alternatives: ranked.candidates.slice(1, 4).map((candidate) => ({
            route: candidate.route,
            score: candidate.score,
          })),
          originalTask: task,
          unrouted: best === undefined,
        });
      }

      // Chain the units ONLY when the caller asked for it.
      //
      // This used to be automatic for every multi-unit plan, on the theory that a
      // decomposition carries an implied order ("research, then review, then
      // summarise"). That is true of a pipeline and false of a plan whose parts are
      // independent — and the independent case is the common one for the work this
      // plugin sees. An eight-requirement research task became seven sequential
      // agents, each doing its own retrieval and each waiting on all of its
      // predecessors; the run hit the caller's thirty-minute tool ceiling with NO
      // results at all, because a timeout discards everything rather than what
      // finished. The asymmetry is what decides this: a parallel unit may lose some
      // cross-unit context, a serial run that times out loses all of it.
      //
      // `chain: true` restores the pipeline, and a caller that supplies its own
      // units still controls the graph outright — its `dependsOn` is never rewritten.
      if (chain === true && units.length > 1) {
        for (let index = 1; index < units.length; index += 1) {
          units[index].dependsOn = [units[index - 1].id];
        }
      }
    }

    return units;
  }

  #unitPrompt(task, requirements) {
    const labels = requirements
      .map((requirement) => this.taxonomy.get(requirement.capability)?.label ?? requirement.capability)
      .join(', ');
    return `Perform the part of the task that concerns: ${labels}.\n\nTask:\n${task}`;
  }

  #warnings(tier, ranked, analysis, units = []) {
    const warnings = [];
    // A LEVEL requirement (how hard the work is, how much room it needs) is
    // applied to every unit, because it is stated by the task rather than by a
    // cluster. When one of those floors excludes routes that a unit could
    // otherwise use, the caller usually meant it for one unit only - and the
    // caller can say so by putting the floor on that unit's own requirement.
    const levelFloors = analysis.requirements.filter(
      (req) =>
        (this.taxonomy.get(req.capability)?.group === 'capacity' ||
          this.taxonomy.get(req.capability)?.group === 'depth') &&
        Number.isSafeInteger(req.minContextWindow),
    );
    if (units.length > 1 && levelFloors.length > 0) {
      const widest = Math.max(...levelFloors.map((req) => req.minContextWindow));
      warnings.push(
        `The task-level context floor (${widest} tokens) applies to ALL ${units.length} units. If it belongs to only one of them, move it onto that unit's own requirement so the others stay free to route elsewhere.`,
      );
    }
    if (ranked.summary.poolEmpty) {
      warnings.push('The live model pool is empty; nothing can be routed.');
    }
    if (tier !== 'direct' && ranked.candidates.length === 0 && !ranked.summary.poolEmpty) {
      warnings.push('No model satisfied the hard requirements; execution would run unrouted.');
    }
    if (analysis.requirements.length === 0) {
      warnings.push('No capability cue matched the task; consider passing an explicit analysis.');
    }
    if (this.pool.problems().length > 0) {
      warnings.push(...this.pool.problems());
    }
    return warnings;
  }

  async #executeUnits(units, context) {
    const results = new Map();
    const completed = [];

    // What each unit must wait for: its declared dependencies AND the units it
    // reviews. A reviewer cannot judge an answer that has not been produced, so
    // `reviews` is a scheduling edge as well as a reported one.
    const prerequisitesOf = (unit) =>
      uniqueStrings([...(unit.dependsOn ?? []), ...(unit.reviews ?? [])]);

    // Resolve dependency waves. Each wave is independent internally, so it runs
    // with bounded concurrency; the next wave sees the prior wave's findings.
    let pending = units.filter((unit) => prerequisitesOf(unit).length === 0);
    const remaining = new Set(units.filter((unit) => prerequisitesOf(unit).length > 0));

    const handoff = this.#handoffPolicy();

    const runWave = async (wave) => {
      const waveResults = await mapLimited(wave, context.concurrency, async (unit) => {
        // Per unit, not per wave: a unit that declared a dependency receives that
        // dependency's COMPLETE answer, while an independent unit receives only a
        // bounded digest of recent completions.
        const sharedContext = handoffContext(unit, results, completed, handoff);
        // The sibling-question roster. Handed to the unit in its own prompt, because
        // the child has no other way to learn its run id or who has finished — and a
        // capability the unit cannot discover is a capability it will not use.
        const askContext =
          context.runId === undefined ? undefined : this.#askPrompt(context.runId, unit.id);
        const unitStartedAt = Date.now();
        if (unit.unrouted === true || unit.provider === undefined || unit.model === undefined) {
          return {
            id: unit.id,
            capabilityId: unit.capabilityId,
            route: undefined,
            ok: false,
            // A route REASON is not a failure reason. Reporting `unit.routeReason` here is
            // how a supplied unit came back as `error: "supplied by the caller"` and sent
            // its caller looking for a bug in its own arguments.
            error: `no route: ${
              unit.routeReason ?? 'no model could serve this capability'
            }`,
            ...(str(unit.routeRequested) === undefined ? {} : { routeRequested: unit.routeRequested }),
            // And nothing was cancelled: this unit was never started. Saying otherwise
            // invites the reader to hunt for an abort that never happened.
            notStarted: true,
          };
        }
        try {
          // The ordered candidate chain the user's table supplied. A route that
          // cannot answer falls through to the next candidate, which is what an
          // ORDERED list of models is for — the first version stopped at the first
          // candidate and reported the failure, so a fallback never ran.
          const candidates = [unit.route, ...(Array.isArray(unit.fallbacks) ? unit.fallbacks : [])]
            .filter((route, index, all) => route !== undefined && all.indexOf(route) === index)
            .map((route) => ({ route, profile: this.pool.get(route) }))
            .filter((candidate) => candidate.profile !== undefined)
            .slice(0, MAX_ROUTE_ATTEMPTS);
          context.runId === undefined ? undefined : this.journal.unitStarted(context.runId, unit);
          if (candidates.length === 0) {
            // Every candidate the unit could run on has left the live pool. Reported as
            // the routing failure it is, rather than as an undefined-property crash.
            const gone = {
              id: unit.id,
              capabilityId: unit.capabilityId,
              capabilityLabel: unit.capabilityLabel,
              route: unit.route,
              elapsedMs: Date.now() - unitStartedAt,
              ok: false,
              error: `no route: "${unit.route ?? 'unknown'}" is no longer in the live model pool`,
              notStarted: true,
            };
            if (context.runId !== undefined) this.journal.unitFinished(context.runId, unit, gone);
            return gone;
          }
          let chosenCandidate = candidates[0];
          let child;
          let attempts = 0;
          for (const candidate of candidates) {
            attempts += 1;
            // A route the pool lost between composition and execution is skipped
            // rather than attempted.
            child = await this.#spawnOne({
              prompt: childPrompt({ ...unit, sharedContext, askContext }),
              originalTask: unit.originalTask,
              persona: specialistPersona({
                capabilityId: unit.capabilityId,
                capabilityLabel: unit.capabilityLabel,
              }),
              // The calling agent owns every child it pays for, so it is the parent.
              parent: context.captain,
              agentOptions: {
                provider: candidate.profile.provider,
                model: candidate.profile.model,
                ...(str(unit.reasoningEffort) === undefined
                  ? {}
                  : { reasoningEffort: unit.reasoningEffort }),
                ...(Number.isSafeInteger(unit.maxTokens) ? { maxTokens: unit.maxTokens } : {}),
              },
              signal: context.signal,
              label: delegationLabel(unit.capabilityLabel, candidate.route),
            });
            if (child.stopReason === 'completed') {
              chosenCandidate = candidate;
              break;
            }
            // Only a route that produced NOTHING falls through. A child that answered
            // and then failed is a content problem, and paying a second model for it
            // would not fix it.
            if (String(child.text ?? '').trim() !== '') {
              chosenCandidate = candidate;
              break;
            }
            chosenCandidate = candidate;
          }
          // Reported only when another candidate actually carried the unit.
          const fallbackFrom =
            attempts > 1 && chosenCandidate.route !== unit.route ? unit.route : undefined;
          const finished = {
            id: unit.id,
            capabilityId: unit.capabilityId,
            capabilityLabel: unit.capabilityLabel,
            route: chosenCandidate.route,
            routeReason: unit.routeReason,
            ...(unit.decidedBy === undefined ? {} : { decidedBy: unit.decidedBy }),
            ...(unit.overriddenCallerPreference === undefined
              ? {}
              : { overriddenCallerPreference: unit.overriddenCallerPreference }),
            ...(fallbackFrom === undefined ? {} : { fallbackFrom, routeAttempts: attempts }),
            // The caller asked for a route the pool did not have, and a candidate the
            // table named was used instead: reported so the substitution is visible.
            ...(unit.routeRequested === undefined || chosenCandidate.route === unit.routeRequested
              ? {}
              : { routeRequested: unit.routeRequested }),
            // Reported so the level actually used is auditable rather than implied —
            // and so is a level the caller asked for that the route could not take.
            ...(str(unit.reasoningEffort) === undefined ? {} : { reasoningEffort: unit.reasoningEffort }),
            ...(str(unit.effortUnavailable) === undefined ? {} : { effortUnavailable: unit.effortUnavailable }),
            dependsOn: unit.dependsOn ?? [],
            // How long THIS unit took. The run reported a single total that was
            // always near zero; per-unit timing is what shows which unit was slow.
            elapsedMs: Date.now() - unitStartedAt,
            ok: child.stopReason === 'completed',
            ...child,
          };
          if (context.runId !== undefined) this.journal.unitFinished(context.runId, unit, finished);
          return finished;
        } catch (error) {
          const failed = {
            id: unit.id,
            capabilityId: unit.capabilityId,
            capabilityLabel: unit.capabilityLabel,
            route: unit.route,
            elapsedMs: Date.now() - unitStartedAt,
            ok: false,
            error: String(error?.message ?? error),
          };
          if (context.runId !== undefined) this.journal.unitFinished(context.runId, unit, failed);
          return failed;
        }
      });
      for (const entry of waveResults) {
        results.set(entry.id, entry);
        if (entry.ok === true) completed.push(entry);
      }
      context.onProgress?.({
        wave: wave.map((unit) => unit.id),
        completed: completed.length,
        total: units.length,
      });
    };

    while (pending.length > 0) {
      await runWave(pending);
      const next = [];
      for (const unit of [...remaining]) {
        if (prerequisitesOf(unit).every((dependency) => results.has(dependency))) {
          next.push(unit);
          remaining.delete(unit);
        }
      }
      pending = next;
      if (pending.length === 0 && remaining.size > 0) {
        // A dependency cycle or a missing dependency: run the rest rather than
        // silently dropping work, and mark why.
        for (const unit of remaining) results.set(unit.id, {
          id: unit.id,
          ok: false,
          error: 'dependency could not be satisfied (cycle or unknown id)',
        });
        remaining.clear();
      }
    }

    return units.map((unit) => results.get(unit.id)).filter((entry) => entry !== undefined);
  }

  /**
   * Validate one exact provider/model/effort route against the live adapter.
   *
   * `resolveCallConfig` rejects an unsupported reasoning effort and materializes
   * adapter defaults. Calling it here means an unroutable or misadvertised route
   * fails with a precise orchestrator-level error before any child is created.
   * A provider whose listing is advisory may still resolve, so a failure here is
   * reported verbatim rather than mapped to a generic message.
   */
  async #preflight(agentOptions, signal) {
    const llm = this.ctx.get('llm');
    if (llm === undefined || typeof llm.resolveCallConfig !== 'function') return;
    const route = routeKey(agentOptions?.provider, agentOptions?.model);
    if (route === undefined) return;
    try {
      await llm.resolveCallConfig(
        {
          provider: agentOptions.provider,
          model: agentOptions.model,
          ...(str(agentOptions.reasoningEffort) === undefined
            ? {}
            : { reasoningEffort: agentOptions.reasoningEffort }),
        },
        signal,
      );
    } catch (error) {
      throw new Error(
        `orchestrator: route "${route}" was rejected by the live LLM adapter: ${String(error?.message ?? error)}`,
        { cause: error },
      );
    }
  }

  /** Spawn one child on one route, always disposing it. */
  async #spawnOne(spec) {
    const subagents = this.ctx.get('subagents');
    if (subagents === undefined) throw new Error('Service "subagents" is unavailable');

    const providerName = str(this.preferences.childProvider) ?? 'spawn';
    let provider = subagents.getProvider(providerName);
    if (provider === undefined) {
      const available = subagents.list() ?? [];
      const fallback = available.includes('spawn') ? 'spawn' : available[0];
      if (fallback === undefined) {
        throw new Error(
          `no subagent provider is registered (available: none); the composition needs a subagent provider row`,
        );
      }
      provider = subagents.getProvider(fallback);
    }
    if (provider === undefined) {
      throw new Error(`subagent provider "${providerName}" is not registered`);
    }
    if (provider.capabilities?.agentOptions !== true) {
      throw new Error(
        `subagent provider "${provider.name}" cannot set a child model route (agentOptions capability is absent), so the orchestrator cannot route work`,
      );
    }

    // Validate the exact route against the live adapter before delegating.
    // Model selection here is plugin-side (a trusted seam), so it bypasses the
    // model-facing allow-list; validating with the same call the host uses keeps
    // a misadvertised route from failing deep inside the child instead.
    await this.#preflight(spec.agentOptions, spec.signal);

    const request = {
      label: truncate(spec.label ?? 'orchestrator unit', 120),
      prompt: [{ type: 'text', text: spec.prompt }],
      parent: spec.parent,
      signal: spec.signal,
      agentOptions: spec.agentOptions,
    };
    if (provider.capabilities?.persona === true && str(spec.persona) !== undefined) {
      request.persona = spec.persona;
    }
    if (Number.isSafeInteger(spec.maxDepth) && provider.capabilities?.depthLimit === true) {
      request.maxDepth = spec.maxDepth;
    }
    if (isRecord(spec.outputSchema) && provider.capabilities?.outputSchema === true) {
      request.outputSchema = spec.outputSchema;
    }

    const run = await subagents.start(provider.name, request);
    try {
      const result = await run.result;
      return normalizeChildResult(run, result);
    } finally {
      try {
        await run.dispose();
      } catch (error) {
        this.logger?.warn?.(`orchestrator: disposing child failed: ${String(error)}`);
      }
    }
  }

  /**
   * What one unit is told about the siblings it may question.
   *
   * @param runId - the run.
   * @param selfId - the unit being spawned, never offered to itself.
   * @returns the prompt section, or `undefined` when nothing is askable.
   */
  #askPrompt(runId, selfId) {
    let askable;
    try {
      askable = this.journal.askable(runId).filter((entry) => entry.id !== selfId);
    } catch {
      return undefined;
    }
    if (askable.length === 0) return undefined;
    const lines = [
      `Completed sibling units of this run that you may question:`,
      ...askable.map(
        (entry) =>
          `- ${entry.id}${entry.capabilityLabel === undefined ? '' : ` (${entry.capabilityLabel})`}${
            entry.summary === undefined ? '' : `: ${entry.summary}`
          }`,
      ),
      `Run id: ${runId}`,
      `To ask one, call orchestrate_ask with { runId: "${runId}", to: "<unit id>", question: "..." }.`,
      `A unit still running cannot be asked; omit "to" and the tool will list who can.`,
    ];
    return lines.join('\n');
  }

  /** The sibling-question budget in force. */
  #questionPolicy() {
    const configured = isRecord(this.preferences.questions) ? this.preferences.questions : {};
    return {
      maxPerRun:
        Number.isSafeInteger(configured.maxPerRun) && configured.maxPerRun >= 0
          ? Math.min(configured.maxPerRun, 32)
          : DEFAULT_QUESTION_LIMIT,
      timeoutMs:
        Number.isSafeInteger(configured.timeoutMs) && configured.timeoutMs >= 1_000
          ? Math.min(configured.timeoutMs, 1_800_000)
          : DEFAULT_QUESTION_TIMEOUT_MS,
    };
  }

  /** The review-round budget in force. */
  #reviewPolicy() {
    const configured = isRecord(this.preferences.review) ? this.preferences.review : {};
    return {
      maxRounds:
        Number.isSafeInteger(configured.maxRounds) && configured.maxRounds >= 0
          ? Math.min(configured.maxRounds, 5)
          : DEFAULT_REVIEW_ROUNDS,
    };
  }

  /**
   * The review loop: judge, object, re-run, judge again.
   *
   * A unit that declares `reviews: [ids]` is a REVIEWER: it runs after those units and
   * receives their full answers (see {@link handoffContext}). Its verdict is read from
   * its answer; a rejection with objections sends each objected unit back for another
   * attempt with the objection appended, after which the reviewer judges again.
   *
   * The loop always terminates, for three independent reasons: the round count is
   * capped, an unreadable verdict records `unknown` and STOPS, and a verdict with no
   * addressable objection has nothing to send back. An unreadable verdict never counts
   * as approval — that would be reporting success the reviewer did not give.
   *
   * @param info - `{ runId, units, results, context }`.
   */
  async #runReviewLoop({ runId, units, results, context }) {
    const reviewers = units.filter((unit) => (unit.reviews ?? []).length > 0);
    if (reviewers.length === 0) return;
    const { maxRounds } = this.#reviewPolicy();

    for (let round = 1; round <= maxRounds; round += 1) {
      const objections = [];
      for (const reviewer of reviewers) {
        const result = results.find((entry) => entry.id === reviewer.id);
        if (result === undefined) continue;
        const verdict = readVerdict(result);
        this.journal.recordReview(runId, {
          reviewer: reviewer.id,
          round,
          verdict: verdict.verdict,
          readable: verdict.readable,
          objections: verdict.objections,
        });
        // Unreadable: recorded as `unknown` and the loop stops. Guessing here would
        // either re-run work on a misreading or declare an approval nobody gave.
        if (!verdict.readable) break;
        if (verdict.verdict !== 'reject') continue;
        for (const objection of verdict.objections) {
          const target = objection.unit === undefined ? undefined : reviewer.reviews.find((id) => id === objection.unit);
          if (target === undefined) continue;
          objections.push({ unit: target, issue: objection.issue ?? 'the reviewer objected without stating why' });
        }
      }
      if (objections.length === 0 || round >= maxRounds) {
        // The last round's verdict is final; it is reported either way.
        return;
      }

      for (const { unit: unitId, issue } of objections) {
        const unit = units.find((entry) => entry.id === unitId);
        const index = results.findIndex((entry) => entry.id === unitId);
        if (unit === undefined || index === -1) continue;
        const previous = results[index];
        if (unit.provider === undefined || unit.model === undefined) continue;
        // The re-run receives its own previous answer and the objection, so it revises
        // rather than starting over — and the review's reason is part of its prompt.
        const revised = await this.#spawnOne({
          prompt: [
            `Your previous answer was reviewed and an objection was raised. Revise your answer`,
            `so that the objection is resolved. Keep everything that was already correct.`,
            ``,
            `The objection:`,
            issue,
            ``,
            `Your previous answer:`,
            String(previous.text ?? '').slice(0, DEFAULT_HANDOFF_CHARS),
            ``,
            originalUnitPrompt(unit),
          ].join('\n'),
          originalTask: unit.originalTask,
          persona: specialistPersona({
            capabilityId: unit.capabilityId,
            capabilityLabel: unit.capabilityLabel,
          }),
          parent: context.captain,
          agentOptions: {
            provider: unit.provider,
            model: unit.model,
            ...(str(unit.reasoningEffort) === undefined ? {} : { reasoningEffort: unit.reasoningEffort }),
          },
          signal: context.signal,
          label: delegationLabel(`${unit.capabilityLabel} (round ${round + 1})`, unit.route),
        }).catch((error) => ({ stopReason: 'error', text: '', error: String(error?.message ?? error) }));

        results[index] = {
          ...previous,
          ok: revised.stopReason === 'completed',
          text: revised.text ?? '',
          preview: revised.preview ?? truncate(revised.text ?? '', PREVIEW_CHARS),
          stopReason: revised.stopReason,
          childId: revised.childId,
          elapsedMs: revised.elapsedMs,
          revizedByReview: true,
          reviewRound: round + 1,
          objection: issue,
          ...(revised.error === undefined ? {} : { error: revised.error }),
        };
        this.journal.unitReran(runId, unitId, round + 1);
        this.journal.unitFinished(runId, unit, results[index]);
      }

      // The reviewer judges the revised answers: it is re-run on the same route, with
      // the same full-answer handoff, for the next round.
      for (const reviewer of reviewers) {
        const index = results.findIndex((entry) => entry.id === reviewer.id);
        if (index === -1) continue;
        const previous = results[index];
        if (reviewer.provider === undefined || reviewer.model === undefined) continue;
        const revised = await this.#spawnOne({
          prompt: childPrompt({
            ...reviewer,
            sharedContext: handoffContext(reviewer, new Map(results.map((e) => [e.id, e])), [], this.#handoffPolicy()),
          }),
          originalTask: reviewer.originalTask,
          persona: specialistPersona({
            capabilityId: reviewer.capabilityId,
            capabilityLabel: reviewer.capabilityLabel,
          }),
          parent: context.captain,
          agentOptions: {
            provider: reviewer.provider,
            model: reviewer.model,
            ...(str(reviewer.reasoningEffort) === undefined ? {} : { reasoningEffort: reviewer.reasoningEffort }),
          },
          signal: context.signal,
          label: delegationLabel(`${reviewer.capabilityLabel} (round ${round + 1})`, reviewer.route),
        }).catch((error) => ({ stopReason: 'error', text: '', error: String(error?.message ?? error) }));

        results[index] = {
          ...previous,
          ok: revised.stopReason === 'completed',
          text: revised.text ?? '',
          preview: revised.preview ?? truncate(revised.text ?? '', PREVIEW_CHARS),
          stopReason: revised.stopReason,
          childId: revised.childId,
          elapsedMs: revised.elapsedMs,
          reviewRound: round + 1,
          ...(revised.error === undefined ? {} : { error: revised.error }),
        };
        this.journal.unitReran(runId, reviewer.id, round + 1);
        this.journal.unitFinished(runId, reviewer, results[index]);
      }
    }
  }

  /**
   * The dependency-handoff policy in force for this run.
   *
   * Two things are configurable and both matter: how much a dependent unit receives
   * (the complete upstream answer, or its bounded preview), and the character ceiling
   * the handoff may occupy in the child's prompt.
   *
   * @returns `{ strategy, maxChars, includeStructured }`.
   */
  #handoffPolicy() {
    const configured = isRecord(this.preferences.handoff) ? this.preferences.handoff : {};
    const maxChars =
      Number.isSafeInteger(configured.maxChars) && configured.maxChars >= 500
        ? Math.min(configured.maxChars, 200_000)
        : DEFAULT_HANDOFF_CHARS;
    return {
      strategy: configured.strategy === 'summary' ? 'summary' : 'full',
      maxChars,
      includeStructured: configured.includeStructured !== false,
    };
  }

  /**
   * Write every unit's answer to disk, then bound the copy returned inline.
   *
   * The order matters: the files are written from the FULL answers, and only then is
   * the document the model sees trimmed. A caller that reads a bounded answer can
   * always follow `artifact.path` to the rest.
   *
   * @param run - the finished run document.
   * @param info - `{ captain, startedAt, finishedAt }`.
   * @returns the document with bounded results and an `artifacts` block.
   */
  #attachArtifacts(run, info) {
    const writer = this.artifacts;
    if (writer === undefined || typeof writer.writeRun !== 'function' || run.results.length === 0) {
      return run;
    }
    let written;
    try {
      written = writer.writeRun({
        runId: run.runId,
        task: run.task,
        startedAt: info.startedAt,
        finishedAt: info.finishedAt,
        results: run.results,
        captain: info.captain,
      });
    } catch (error) {
      // A writer that throws is a writer that produced no artifacts, not a failed
      // run: the caller still gets every unit result inline.
      written = { files: {}, problems: [String(error?.message ?? error)] };
    }
    const files = isRecord(written?.files) ? written.files : {};
    const results = run.results.map((result) => {
      const file = files[result.id];
      const path = str(file?.path);
      const bound = boundInline(result.text, path);
      return {
        ...result,
        text: bound.text,
        ...(bound.truncated ? { textTruncated: true, elidedChars: bound.elidedChars } : {}),
        ...(path === undefined ? {} : { artifact: { path, bytes: file?.bytes } }),
      };
    });
    const problems = Array.isArray(written?.problems) ? written.problems : [];
    const dir = str(written?.dir);
    const index = str(written?.index);
    return {
      ...run,
      results,
      // Rebuilt from the bounded results, so the digest never carries more than the
      // results themselves do.
      aggregated: aggregate(results),
      artifacts: {
        count: Object.keys(files).length,
        ...(dir === undefined ? {} : { dir }),
        ...(index === undefined ? {} : { index }),
        ...(problems.length === 0 ? {} : { problems }),
      },
    };
  }

  #finishRun(info) {
    const completed = info.results.filter((entry) => entry.ok === true).length;
    // What the run's collaborations produced, reported to the caller: which sibling
    // questions were asked and answered, and which review verdicts were reached. Both
    // are omitted when they never happened, so an ordinary run's result is unchanged.
    const journalRun = this.journal.get(info.runId);
    const failed = info.results.length - completed;
    const routes = uniqueStrings(
      info.results.map((entry) => entry.route).filter((route) => route !== undefined),
    );

    const run = {
      runId: info.runId,
      tier: info.tier,
      task: info.task,
      // Every expert result is returned to the captain, which owns the final
      // delivery. The orchestrator never speaks to the user itself.
      results: info.results,
      aggregated: aggregate(info.results),
      analysis: {
        summary: info.analysis?.summary ?? info.task,
        complexity: info.analysis?.complexity ?? 'simple',
        source: info.analysis?.source ?? 'auto',
        requirements: (info.analysis?.requirements ?? []).map((requirement) => ({
          capability: requirement.capability,
          weight: requirement.weight,
          required: requirement.required === true,
        })),
      },
      routes,
      // The standing table, resolved against the live pool: what it applied, what
      // it could not resolve, and which live routes it does not mention at all.
      assignments: assignmentReport(info.assignments),
      counts: { total: info.results.length, completed, failed, dropped: info.dropped?.length ?? 0 },
      dropped: (info.dropped ?? []).map((unit) => ({
        id: unit.id,
        capabilityId: unit.capabilityId,
        reason: 'exceeded the configured per-run agent limit',
      })),
      pool: {
        size: this.pool.models().length,
        providers: this.pool.providers(),
        fingerprint: poolFingerprint(this.pool),
      },
      elapsedMs: Date.now() - info.startedAt,
      captain: info.captain === undefined ? undefined : { id: String(info.captain.id) },
      guidance: guidance(info.tier, completed, failed),
      ...(journalRun === undefined || journalRun.questions.length === 0
        ? {}
        : { questions: journalRun.questions }),
      ...(journalRun === undefined || journalRun.reviews.length === 0
        ? {}
        : { reviews: journalRun.reviews }),
    };

    // No run record is written. DSH's session log already records this turn and
    // every child it produced, so a parallel history here would be a second,
    // conflicting source of truth. The result object below is returned to the
    // caller and lives only as long as the tool call it belongs to.
    return run;
  }
}

/**
 * The smallest useful aggregation: the captain receives each expert answer plus
 * a flat list of findings it can synthesize from. Deliberately not a summary —
 * the orchestrator has no model call of its own and must not pretend to.
 */
function aggregate(results) {
  const parts = [];
  for (const entry of results) {
    const label = entry.capabilityLabel ?? entry.capabilityId ?? entry.id;
    if (entry.ok === true) {
      parts.push(`### ${label} (${entry.route})\n${entry.preview}`);
    } else {
      parts.push(`### ${label} — FAILED\n${entry.error ?? entry.diagnostic ?? 'no detail'}`);
    }
  }
  return parts.join('\n\n');
}

function guidance(tier, completed, failed) {
  const lines = [];
  if (tier === 'direct') {
    lines.push('No delegation was needed; the captain executes this task itself.');
  } else {
    lines.push(
      `Delegate-and-deliver: ${completed} specialist result(s) returned${failed > 0 ? `, ${failed} failed` : ''}.`,
    );
    lines.push(
      'The captain owns the final answer: synthesize the findings above, resolve conflicts between them, and close any failed unit itself rather than forwarding raw output verbatim.',
    );
  }
  return lines.join(' ');
}

/** Decide the routing tier for an analysis. */
export function planTier(analysis, preferences) {
  const allowMulti = preferences?.allowMultiAgent !== false;
  // Level groups (`depth`, `capacity`) describe how hard the work is, not how
  // many kinds of expertise it needs, so they never trigger a multi-agent run.
  const levelGroups = new Set(['depth', 'capacity']);
  const groups = new Set(
    analysis.requirements
      .map((requirement) => requirement.capability.split('.')[0])
      .filter((group) => !levelGroups.has(group)),
  );
  const hasLevelRequirement = analysis.requirements.some((requirement) =>
    levelGroups.has(requirement.capability.split('.')[0]),
  );
  switch (analysis.complexity) {
    case 'trivial':
      return 'direct';
    case 'complex':
      return allowMulti && groups.size >= 2 ? 'multi-agent' : 'specialist';
    case 'specialist':
      return analysis.requirements.length === 0 && !hasLevelRequirement ? 'direct' : 'specialist';
    default:
      return analysis.requirements.length === 0 && !hasLevelRequirement ? 'direct' : 'specialist';
  }
}
