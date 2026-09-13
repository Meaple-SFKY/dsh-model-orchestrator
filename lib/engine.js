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
import { contentToText, isRecord, routeKey, str, truncate, uniqueStrings, uint, clamp } from './util.js';
import { analysisFromModel, analysisFromText, chooseRoute, rankModels } from './matching.js';
import { poolFingerprint } from './discovery.js';

/** How many characters of a child's output are kept in a plan summary. */
const PREVIEW_CHARS = 1200;

/**
 * Descriptor groups that describe capability LEVEL rather than subject area.
 *
 * A level requirement (`depth.difficult`, `capacity.very_long`) shapes *how* a
 * unit is routed; it never defines a unit of its own. Treating it as a domain
 * would split one coherent task across two children doing the same work.
 */
const LEVEL_GROUPS = Object.freeze(new Set(['depth', 'capacity']));

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
  return parts.join('\n\n');
}

/**
 * Derive an abort signal for one child from a run-level signal.
 * @param signal - the run-level signal.
 * @returns `{ signal, cancel }`.
 */
function childSignal(signal) {
  const controller = new AbortController();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else {
      const onAbort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }
  return { signal: controller.signal, cancel: (reason) => controller.abort(reason) };
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

/** One result of a spawned child, normalized to plain data. */
function normalizeChildResult(run, result) {
  const output = Array.isArray(result?.output) ? result.output : [];
  const text = contentToText(output);
  return {
    childId: run?.id === undefined ? undefined : String(run.id),
    stopReason: str(result?.stopReason) ?? 'error',
    text,
    preview: truncate(text, PREVIEW_CHARS),
    output,
    ...(result?.structured === undefined ? {} : { structured: result.structured }),
    ...(str(result?.diagnostic) === undefined ? {} : { diagnostic: str(result.diagnostic) }),
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
    const ranked = rankModels(this.pool, this.taxonomy, analysis, {
      preferences: this.preferences,
    });

    const tier = planTier(analysis, this.preferences);
    const units = tier === 'direct' ? [] : this.#composeUnits(task, analysis, ranked, tier);

    return {
      mode: this.mode,
      tier,
      task,
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
      warnings: this.#warnings(tier, ranked, analysis),
    };
  }

  /**
   * Execute a task end to end.
   *
   * @param request - `{ task, analysis?, units?, tier?, captain, signal, onProgress }`.
   * @returns a run document containing every expert result for the captain.
   */
  async run(request) {
    await this.#ensurePool();

    const task = String(request.task ?? '');
    const analysis = this.#analyze(task, request);
    const ranked = rankModels(this.pool, this.taxonomy, analysis, {
      preferences: this.preferences,
    });

    const tier = str(request.tier) ?? planTier(analysis, this.preferences);
    const runId = randomUUID();

    if (tier === 'direct') {
      return this.#finishRun({
        runId,
        task,
        analysis,
        tier,
        units: [],
        results: [],
        startedAt: Date.now(),
        captain: request.captain,
      });
    }

    const units = this.#composeUnits(task, analysis, ranked, tier, request.units);
    const limits = this.preferences;
    const maxAgents = clamp(limits.maxAgentsPerRun, 1, 64);
    const selected = units.slice(0, maxAgents);
    const dropped = units.slice(maxAgents);

    const runSignal = childSignal(request.signal);
    this.inFlight.add(runSignal);

    try {
      const results = await this.#executeUnits(selected, {
        captain: request.captain,
        signal: runSignal.signal,
        concurrency: limits.maxParallel,
        onProgress: request.onProgress,
      });

      return this.#finishRun({
        runId,
        task,
        analysis,
        tier,
        units: selected,
        results,
        dropped,
        startedAt: Date.now(),
        captain: request.captain,
      });
    } finally {
      this.inFlight.delete(runSignal);
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

    const reasoningEffort = str(request.reasoningEffort);
    const maxTokens = uint(request.maxTokens);
    const agentOptions = {
      provider: chosen.provider,
      model: chosen.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    };

    const child = await this.#spawnOne({
      prompt: str(request.prompt) ?? task,
      originalTask: task,
      persona,
      // The calling agent is the parent, so the delegated child is attributed
      // to the session that asked for the work.
      parent: request.captain,
      agentOptions,
      signal: request.signal,
      label: str(request.label) ?? (str(request.capability) ?? chosen.route),
    });

    const runId = randomUUID();
    const run = this.#finishRun({
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
        },
      ],
      results: [child],
      startedAt: Date.now(),
      captain: request.captain,
    });
    // `dispatch` always reports its own outcome, so a caller can branch on `ok`
    // without inspecting the tier or the child's stop reason.
    return { ok: true, route: chosen.route, routeReason: reason, ...run };
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
    if (this.pool.models().length > 0 || this.pool.lastError() !== undefined) return;
    await this.refresh({});
  }

  #analyze(task, request) {
    if (isRecord(request.analysis) || Array.isArray(request.requirements)) {
      const supplied = isRecord(request.analysis)
        ? request.analysis
        : { requirements: request.requirements };
      const fromModel = analysisFromModel(this.taxonomy, supplied);
      if (fromModel.requirements.length > 0) return fromModel;
    }

    // Guided mode: the user selected capability areas for this session, so they
    // seed the requirement set before the task's own vocabulary narrows it.
    // The fallback vocabulary is configuration, so an operator can replace the
    // built-in hints instead of being stuck with the author's phrasing.
    const local = analysisFromText(this.taxonomy, task, { preferences: this.preferences });
    const guided = this.store.snapshot().guided.capabilities;
    if (guided.length > 0) {
      const seeded = guided
        .filter((id) => this.taxonomy.has(id))
        .map((id) => ({ capability: id, weight: 0.7, reason: 'selected in Guided mode' }));
      const byId = new Map();
      for (const requirement of [...seeded, ...local.requirements]) {
        const existing = byId.get(requirement.capability);
        if (existing === undefined || requirement.weight > existing.weight) {
          byId.set(requirement.capability, requirement);
        }
      }
      const merged = [...byId.values()].sort((left, right) => right.weight - left.weight);
      return {
        ...local,
        requirements: merged,
        source: 'guided',
        guidedCapabilities: uniqueStrings(guided),
      };
    }
    return local;
  }

  #composeUnits(task, analysis, ranked, tier, suppliedUnits) {
    const units = [];

    /** Route one cluster against its own capabilities plus the task's level. */
    const chooseRouteFor = (requirements) => {
      const ranking = rankModels(
        this.pool,
        this.taxonomy,
        { summary: task, complexity: analysis.complexity, requirements, source: analysis.source },
        { preferences: this.preferences },
      );
      return {
        chosen: ranking.candidates[0],
        alternatives: ranking.candidates.slice(1, 4),
        rejected: ranking.rejected,
        reason: ranking.summary.poolEmpty ? 'the live model pool is empty' : undefined,
      };
    };

    if (Array.isArray(suppliedUnits) && suppliedUnits.length > 0) {
      for (const [index, unit] of suppliedUnits.entries()) {
        if (!isRecord(unit)) continue;
        units.push({
          id: str(unit.id) ?? `unit-${index + 1}`,
          capabilityId: str(unit.capabilityId) ?? 'supplied',
          capabilityLabel: str(unit.capabilityLabel) ?? str(unit.capabilityId) ?? 'supplied work',
          prompt: String(unit.prompt ?? ''),
          route: str(unit.route),
          provider: str(unit.provider),
          model: str(unit.model),
          routeReason: 'supplied by the caller',
          dependsOn: Array.isArray(unit.dependsOn) ? unit.dependsOn.map(String) : [],
          alternatives: [],
          originalTask: task,
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
      const clusters = new Map();
      for (const requirement of analysis.requirements) {
        const descriptor = this.taxonomy.get(requirement.capability);
        if (descriptor === undefined) continue;
        if (LEVEL_GROUPS.has(descriptor.group)) {
          levelRequirements.push(requirement);
          continue;
        }
        const existing = clusters.get(descriptor.group);
        if (existing === undefined) clusters.set(descriptor.group, [requirement]);
        else existing.push(requirement);
      }

      for (const [group, requirements] of clusters) {
        const primary = requirements[0];
        const descriptor = this.taxonomy.get(primary.capability);
        // Route on the cluster's own capability AND the task's level
        // requirements together: a difficult coding task must be routed to a
        // model that is both coding-capable and reasoning-capable.
        const decision = chooseRouteFor([...requirements, ...levelRequirements]);
        if (decision.chosen === undefined) {
          units.push({
            id: `${group}-unrouted`,
            capabilityId: primary.capability,
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
          id: group,
          capabilityId: descriptor?.id ?? primary.capability,
          capabilityLabel: descriptor?.label ?? primary.capability,
          prompt: this.#unitPrompt(task, requirements),
          route: decision.chosen.route,
          provider: decision.chosen.provider,
          model: decision.chosen.model,
          routeReason:
            decision.chosen.matched.length > 0
              ? decision.chosen.matched.slice(0, 4).join('; ')
              : decision.chosen.pinned === true
                ? 'pinned by capability mapping'
                : 'best available capability fit',
          // Carry the descriptor's own routing facts into the child request so
          // the matched model is used the way the capability intends.
          ...descriptorRouting(descriptor),
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

      // Chain the units whenever a task yields several of them.
      //
      // A multi-unit plan almost always carries an implied ORDER: the same task
      // decomposed into "research, then review, then summarise" is a pipeline, and
      // running those in parallel means each stage loses the previous stage's
      // findings. Chaining makes each unit see its predecessor's output, which is
      // what `#executeUnits` already supports.
      //
      // It must NOT depend on the routing tier: a two-cluster task can be judged
      // `specialist` and still be a pipeline, which is exactly the case that
      // silently produced three independent agents instead of a chain.
      //
      // A caller that supplies its own units keeps full control of the graph, and
      // a single unit has nothing to depend on.
      if (units.length > 1) {
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

  #warnings(tier, ranked, analysis) {
    const warnings = [];
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
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    const results = new Map();
    const completed = [];

    // Resolve dependency waves. Each wave is independent internally, so it runs
    // with bounded concurrency; the next wave sees the prior wave's findings.
    let pending = units.filter((unit) => (unit.dependsOn ?? []).length === 0);
    const remaining = new Set(units.filter((unit) => (unit.dependsOn ?? []).length > 0));

    const runWave = async (wave) => {
      const sharedContext = completed.slice(-4).map((entry) => entry.preview);
      const waveResults = await mapLimited(wave, context.concurrency, async (unit) => {
        if (unit.unrouted === true || unit.provider === undefined || unit.model === undefined) {
          return {
            id: unit.id,
            capabilityId: unit.capabilityId,
            route: undefined,
            ok: false,
            error: unit.routeReason ?? 'no route could be selected',
            cancelled: true,
          };
        }
        try {
          const child = await this.#spawnOne({
            prompt: childPrompt({ ...unit, sharedContext }),
            originalTask: unit.originalTask,
            persona: specialistPersona({
              capabilityId: unit.capabilityId,
              capabilityLabel: unit.capabilityLabel,
            }),
            // The calling agent owns every child it pays for, so it is the parent.
            parent: context.captain,
            agentOptions: {
              provider: unit.provider,
              model: unit.model,
              ...(str(unit.reasoningEffort) === undefined
                ? {}
                : { reasoningEffort: unit.reasoningEffort }),
              ...(Number.isSafeInteger(unit.maxTokens) ? { maxTokens: unit.maxTokens } : {}),
            },
            signal: context.signal,
            label: `${unit.capabilityLabel} via ${unit.route}`,
          });
          return {
            id: unit.id,
            capabilityId: unit.capabilityId,
            capabilityLabel: unit.capabilityLabel,
            route: unit.route,
            routeReason: unit.routeReason,
            dependsOn: unit.dependsOn ?? [],
            ok: child.stopReason === 'completed',
            ...child,
          };
        } catch (error) {
          return {
            id: unit.id,
            capabilityId: unit.capabilityId,
            capabilityLabel: unit.capabilityLabel,
            route: unit.route,
            ok: false,
            error: String(error?.message ?? error),
          };
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
        if ((unit.dependsOn ?? []).every((dependency) => results.has(dependency))) {
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

  #finishRun(info) {
    const completed = info.results.filter((entry) => entry.ok === true).length;
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
