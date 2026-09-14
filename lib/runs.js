/**
 * The orchestration journal: what this plugin did, while it is doing it.
 *
 * The plugin deliberately kept no run state at all — DSH's session log and subagent
 * registry are the single source of truth for what ran and what is in progress — and
 * that remains true for PROGRESS. But two features cannot be built from the harness's
 * tree alone, because the harness never knew about them:
 *
 *   - a unit asking an already-finished SIBLING a question needs to know which units of
 *     THIS run have finished, what they answered, and on which route to ask again;
 *   - a review loop needs the reviewer's verdict, the objection it raised, and which
 *     round it belongs to.
 *
 * Both are plugin-owned facts about plugin-owned work, so they live here: in memory,
 * bounded, and scoped to a session. Nothing here is persisted — a restart forgets it,
 * which is the honest behaviour for "what is this run doing right now" — and nothing
 * here is exposed as task or progress state.
 *
 * @module dsh-model-orchestrator/runs
 */
import { isRecord, str, uniqueStrings } from './util.js';

/** Runs kept per process. The board only ever reads the newest few. */
export const MAX_TRACKED_RUNS = 24;

/** Units kept per run, so a runaway graph cannot grow the journal without bound. */
export const MAX_TRACKED_UNITS = 400;

/** The longest a unit's inline summary may be on the board. */
const SUMMARY_CHARS = 400;

/** A bounded, single-line view of an answer, for the board and for reports. */
function summarize(text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= SUMMARY_CHARS ? flat : `${flat.slice(0, SUMMARY_CHARS - 1)}…`;
}

/**
 * Create the per-process run journal.
 *
 * @param options - `{ logger, now, maxRuns }`.
 * @returns the journal API.
 */
export function createRunJournal({ logger, now = () => Date.now(), maxRuns = MAX_TRACKED_RUNS } = {}) {
  /** runId -> run record. Insertion-ordered, oldest evicted first. */
  const runs = new Map();

  /** Drop the oldest runs once the bound is exceeded. */
  function trim() {
    while (runs.size > maxRuns) {
      const oldest = runs.keys().next().value;
      runs.delete(oldest);
    }
  }

  /** The mutable unit record for one run, created on first mention. */
  function unitOf(run, unit) {
    const id = str(unit?.id) ?? 'unit';
    let record = run.units.get(id);
    if (record === undefined) {
      record = {
        id,
        capabilityId: str(unit?.capabilityId),
        capabilityLabel: str(unit?.capabilityLabel),
        route: str(unit?.route),
        provider: str(unit?.provider),
        model: str(unit?.model),
        decidedBy: str(unit?.decidedBy),
        routeReason: str(unit?.routeReason),
        dependsOn: Array.isArray(unit?.dependsOn) ? unit.dependsOn.map(String) : [],
        reviews: Array.isArray(unit?.reviews) ? unit.reviews.map(String) : [],
        status: 'pending',
        startedAt: undefined,
        finishedAt: undefined,
        elapsedMs: undefined,
        childId: undefined,
        artifact: undefined,
        summary: undefined,
        error: undefined,
        stopReason: undefined,
        text: undefined,
        structured: undefined,
        questionsAsked: [],
        questionsAnswered: [],
        rounds: 0,
      };
      if (run.units.size < MAX_TRACKED_UNITS) run.units.set(id, record);
    } else {
      // Later mentions carry the fields the composer only learns as it goes.
      for (const key of ['capabilityId', 'capabilityLabel', 'route', 'provider', 'model', 'decidedBy', 'routeReason']) {
        const value = str(unit?.[key]);
        if (value !== undefined) record[key] = value;
      }
      if (Array.isArray(unit?.dependsOn) && unit.dependsOn.length > 0) {
        record.dependsOn = uniqueStrings([...record.dependsOn, ...unit.dependsOn.map(String)]);
      }
      if (Array.isArray(unit?.reviews) && unit.reviews.length > 0) {
        record.reviews = uniqueStrings([...record.reviews, ...unit.reviews.map(String)]);
      }
    }
    return record;
  }

  /**
   * The plugin-known edges of one run, in the board's vocabulary.
   *
   * `task`       — the user's task to every unit it dispatched
   * `dependency` — a unit to the unit that had to finish first
   * `question`   — an asker to the sibling it asked
   * `review`     — a reviewer to the unit it reviewed
   * `output`     — a settled unit feeding the captain's final output
   */
  function edgesFor(run) {
    if (run === undefined) return [];
    const edges = [];
    for (const unit of run.units.values()) {
      edges.push({ kind: 'task', from: 'task', to: unit.id, status: unit.status });
      for (const dependency of unit.dependsOn ?? []) {
        edges.push({ kind: 'dependency', from: dependency, to: unit.id, status: unit.status });
      }
      for (const reviewed of unit.reviews ?? []) {
        edges.push({ kind: 'review', from: unit.id, to: reviewed, status: unit.status });
      }
      if (unit.status === 'completed') {
        edges.push({ kind: 'output', from: unit.id, to: 'output', status: unit.status });
      }
    }
    for (const question of run.questions) {
      edges.push({
        kind: 'question',
        from: question.from,
        to: question.to,
        status: question.ok ? 'completed' : 'failed',
      });
    }
    return edges;
  }

  /** Recompute the counters a viewer reads directly. */
  function recount(run) {
    let completed = 0;
    let failed = 0;
    let running = 0;
    for (const unit of run.units.values()) {
      if (unit.status === 'completed') completed += 1;
      else if (unit.status === 'failed') failed += 1;
      else if (unit.status === 'running') running += 1;
    }
    run.counts = {
      delegations: run.units.size,
      running,
      completed,
      failed,
      questions: run.questions.length,
      reviews: run.reviews.length,
    };
  }

  return {
    /**
     * Start tracking one run.
     *
     * @param info - `{ runId, sessionId, task, tier, units }`.
     * @returns the run record.
     */
    begin(info) {
      const runId = str(info?.runId) ?? `run-${runs.size + 1}`;
      const run = {
        runId,
        sessionId: str(info?.sessionId),
        task: String(info?.task ?? ''),
        tier: str(info?.tier) ?? 'specialist',
        status: 'running',
        startedAt: Number.isSafeInteger(info?.startedAt) ? info.startedAt : now(),
        finishedAt: undefined,
        elapsedMs: undefined,
        units: new Map(),
        questions: [],
        reviews: [],
        output: { status: 'pending' },
        counts: { delegations: 0, running: 0, completed: 0, failed: 0, questions: 0, reviews: 0 },
        error: undefined,
      };
      for (const unit of Array.isArray(info?.units) ? info.units : []) unitOf(run, unit);
      runs.set(runId, run);
      trim();
      return run;
    },

    /** Whether a run is tracked. */
    has: (runId) => runs.has(str(runId) ?? ''),

    /** One run record, or `undefined`. */
    get: (runId) => runs.get(str(runId) ?? ''),

    /** Mark one unit as started. */
    unitStarted(runId, unit) {
      const run = runs.get(str(runId) ?? '');
      if (run === undefined) return undefined;
      const record = unitOf(run, unit);
      record.status = 'running';
      record.startedAt = now();
      recount(run);
      return record;
    },

    /**
     * Record one finished unit.
     *
     * @param runId - the run.
     * @param unit - the unit that ran.
     * @param result - its result, as returned to the caller.
     */
    unitFinished(runId, unit, result) {
      const run = runs.get(str(runId) ?? '');
      if (run === undefined) return undefined;
      const record = unitOf(run, unit);
      record.status = result?.ok === true ? 'completed' : 'failed';
      record.finishedAt = now();
      record.elapsedMs = Number.isSafeInteger(result?.elapsedMs)
        ? result.elapsedMs
        : record.startedAt === undefined
          ? undefined
          : record.finishedAt - record.startedAt;
      record.childId = str(result?.childId);
      record.route = str(result?.route) ?? record.route;
      record.summary = summarize(result?.text ?? result?.preview);
      record.error = str(result?.error);
      record.stopReason = str(result?.stopReason);
      // Kept so a sibling can be asked a follow-up question about what it actually
      // said, without a second trip through the harness session log.
      record.text = typeof result?.text === 'string' ? result.text : undefined;
      record.structured = result?.structured;
      if (isRecord(result?.artifact)) {
        record.artifact = { path: str(result.artifact.path), bytes: result.artifact.bytes };
      }
      recount(run);
      return record;
    },

    /** Record a unit's re-run round (the review loop). */
    unitReran(runId, unitId, round) {
      const run = runs.get(str(runId) ?? '');
      const record = run?.units.get(str(unitId) ?? '');
      if (record === undefined) return undefined;
      record.rounds = Math.max(record.rounds ?? 0, Number.isSafeInteger(round) ? round : 0);
      return record;
    },

    /** Finish a run. */
    finish(runId, patch = {}) {
      const run = runs.get(str(runId) ?? '');
      if (run === undefined) return undefined;
      run.status = str(patch.status) ?? 'done';
      run.finishedAt = now();
      run.elapsedMs = run.finishedAt - run.startedAt;
      if (str(patch.error) !== undefined) run.error = str(patch.error);
      // The output node is what the user finally receives. It is only "settled" once
      // every unit has settled, which is why the board can render it as waiting.
      run.output = {
        status: run.counts.running > 0 ? 'pending' : 'done',
        at: run.finishedAt,
        ...(run.counts.completed > 0
          ? { summary: summarize(patch.outputSummary ?? run.counts.completed + ' unit(s) answered') }
          : {}),
      };
      recount(run);
      return run;
    },

    /**
     * The units of one run that can be asked a question right now.
     *
     * A unit still RUNNING is deliberately absent: it has no answer yet, and queueing
     * the question would either deadlock the asker or duplicate the work.
     *
     * @param runId - the run.
     * @returns `[{ id, capabilityLabel, route, summary }]`.
     */
    askable(runId) {
      const run = runs.get(str(runId) ?? '');
      if (run === undefined) return [];
      const out = [];
      for (const unit of run.units.values()) {
        if (unit.status !== 'completed') continue;
        out.push({
          id: unit.id,
          ...(unit.capabilityLabel === undefined ? {} : { capabilityLabel: unit.capabilityLabel }),
          ...(unit.route === undefined ? {} : { route: unit.route }),
          ...(unit.summary === undefined ? {} : { summary: unit.summary }),
        });
      }
      return out;
    },

    /**
     * Record one sibling question and its answer.
     *
     * @param runId - the run.
     * @param entry - `{ from, to, question, ok, answer, elapsedMs }`.
     */
    recordQuestion(runId, entry) {
      const run = runs.get(str(runId) ?? '');
      if (run === undefined) return undefined;
      const record = {
        from: str(entry?.from) ?? 'unknown',
        to: str(entry?.to) ?? 'unknown',
        question: summarize(entry?.question),
        ok: entry?.ok === true,
        at: now(),
        elapsedMs: Number.isSafeInteger(entry?.elapsedMs) ? entry.elapsedMs : undefined,
        ...(str(entry?.answer) === undefined ? {} : { answerPreview: summarize(entry.answer) }),
        ...(str(entry?.error) === undefined ? {} : { error: str(entry.error) }),
      };
      run.questions.push(record);
      const asker = run.units.get(record.from);
      if (asker !== undefined) asker.questionsAsked = uniqueStrings([...(asker.questionsAsked ?? []), record.to]);
      const target = run.units.get(record.to);
      if (target !== undefined) target.questionsAnswered = uniqueStrings([...(target.questionsAnswered ?? []), record.from]);
      recount(run);
      return record;
    },

    /**
     * Record one review adjudication.
     *
     * @param runId - the run.
     * @param entry - `{ reviewer, round, verdict, objections, readable }`.
     */
    recordReview(runId, entry) {
      const run = runs.get(str(runId) ?? '');
      if (run === undefined) return undefined;
      const record = {
        reviewer: str(entry?.reviewer) ?? 'unknown',
        round: Number.isSafeInteger(entry?.round) ? entry.round : 1,
        // `unknown` is a first-class verdict: a reviewer whose answer cannot be read
        // has NOT approved anything, and recording it as approval would be a lie.
        verdict: str(entry?.verdict) ?? 'unknown',
        readable: entry?.readable !== false,
        at: now(),
        objections: (Array.isArray(entry?.objections) ? entry.objections : []).map((objection) => ({
          unit: str(objection?.unit),
          issue: summarize(objection?.issue),
        })),
      };
      run.reviews.push(record);
      recount(run);
      return record;
    },

    /**
     * The plugin-known edges of one run.
     *
     * @param runId - the run.
     * @returns the edge list.
     */
    edges: (runId) => edgesFor(runs.get(str(runId) ?? '')),

    /**
     * The journal as plain data: what the board renders.
     *
     * A run started by a DESCENDANT session belongs to the board of its ancestor: a unit
     * that orchestrates its own sub-run is part of the same picture, and its run would
     * otherwise be invisible from the session the user is looking at.
     *
     * @param sessions - one session id, a list of them, or `undefined` for every run.
     * @returns `{ runs }`.
     */
    view(sessions) {
      const wanted =
        sessions === undefined
          ? undefined
          : new Set(
              (Array.isArray(sessions) ? sessions : [sessions])
                .map((value) => str(value))
                .filter((value) => value !== undefined),
            );
      const out = [];
      for (const run of runs.values()) {
        if (wanted !== undefined && (run.sessionId === undefined || !wanted.has(run.sessionId))) continue;
        out.push({
          runId: run.runId,
          ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
          task: run.task,
          tier: run.tier,
          status: run.status,
          startedAt: run.startedAt,
          ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
          ...(run.elapsedMs === undefined ? {} : { elapsedMs: run.elapsedMs }),
          ...(run.error === undefined ? {} : { error: run.error }),
          counts: run.counts,
          output: run.output,
          units: [...run.units.values()].map((unit) => ({
            id: unit.id,
            ...(unit.childId === undefined ? {} : { childId: unit.childId }),
            ...(unit.capabilityId === undefined ? {} : { capabilityId: unit.capabilityId }),
            ...(unit.capabilityLabel === undefined ? {} : { capabilityLabel: unit.capabilityLabel }),
            ...(unit.route === undefined ? {} : { route: unit.route }),
            ...(unit.decidedBy === undefined ? {} : { decidedBy: unit.decidedBy }),
            ...(unit.routeReason === undefined ? {} : { routeReason: unit.routeReason }),
            dependsOn: unit.dependsOn,
            reviews: unit.reviews,
            // WHO this unit is waiting for, named. "Not started" and "waiting on a
            // dependency" are different states, and only the second has an answer to
            // "waiting for what".
            waitingOn: (unit.dependsOn ?? []).filter((id) => {
              const dependency = run.units.get(id);
              return dependency === undefined || dependency.status !== 'completed';
            }),
            status: unit.status,
            ...(unit.startedAt === undefined ? {} : { startedAt: unit.startedAt }),
            ...(unit.elapsedMs === undefined ? {} : { elapsedMs: unit.elapsedMs }),
            ...(unit.artifact === undefined || unit.artifact.path === undefined ? {} : { artifact: unit.artifact }),
            ...(unit.summary === undefined ? {} : { summary: unit.summary }),
            ...(unit.error === undefined ? {} : { error: unit.error }),
            ...(unit.stopReason === undefined ? {} : { stopReason: unit.stopReason }),
            rounds: unit.rounds ?? 0,
            questionsAsked: unit.questionsAsked ?? [],
            questionsAnswered: unit.questionsAnswered ?? [],
          })),
          edges: edgesFor(run),
          questions: run.questions,
          reviews: run.reviews,
        });
      }
      return { runs: out };
    },
  };
}
