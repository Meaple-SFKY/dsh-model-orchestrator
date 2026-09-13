/**
 * Durable orchestrator state.
 *
 * Only *preferences*, *calibrations*, and learned capability descriptors
 * persist. Two things are deliberately absent:
 *
 *   - the **live model pool**, which is rediscovered on every activation and
 *     whenever the adapter topology changes, so a stale pool can never route
 *     work;
 *   - any **task or run state**, because DSH's own session log and subagent
 *     registry are the single source of truth for what was done and what is in
 *     progress. A second store here would be a conflicting progress surface.
 *
 * Calibrations are keyed by `provider/model` route. A calibration whose route is
 * absent from the current pool is inert and is pruned on write, which keeps the
 * file aligned with reality without ever inventing a route.
 *
 * @module dsh-model-orchestrator/persistence
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isRecord, str, uint, uniqueStrings, clamp } from './util.js';

/** Current on-disk schema. A newer file is refused rather than partially read. */
export const STATE_SCHEMA_VERSION = 1;

/** Modes the orchestrator supports. */
export const MODES = Object.freeze(['auto', 'guided']);

/**
 * The default state. Every field is a *preference*; none names a model.
 * @returns a fresh default state object.
 */
export function defaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    mode: 'auto',
    guided: { capabilities: [] },
    preferences: {
      preferCheaper: true,
      maxParallel: 4,
      maxAgentsPerRun: 12,
      allowMultiAgent: true,
      deniedRoutes: [],
      allowedRoutes: [],
      calibrationEnabled: true,
      captainMode: 'main',
      // Reasoning effort each route is dispatched with, keyed by `provider/model`.
      // Absent means "let the model resolve its own default".
      reasoningEffort: {},
      // Decision cues used ONLY when no calling model supplied an analysis. Empty
      // means "use the built-in fallback".
      decisionCues: {},
    },
    taxonomy: { custom: [] },
    profiles: {},
    updatedAt: Date.now(),
  };
}

/** Clamp and validate a preference block. */
function normalizePreferences(input) {
  const base = defaultState().preferences;
  if (!isRecord(input)) return base;
  // Accept zero and negative values so an explicit (even mistaken) number is
  // clamped into range rather than silently replaced by the default.
  const bounded = (value, fallback, min, max) => {
    if (!Number.isSafeInteger(value)) return fallback;
    return clamp(value, min, max);
  };
  return {
    preferCheaper: input.preferCheaper !== false,
    maxParallel: bounded(input.maxParallel, base.maxParallel, 1, 16),
    maxAgentsPerRun: bounded(input.maxAgentsPerRun, base.maxAgentsPerRun, 1, 64),
    allowMultiAgent: input.allowMultiAgent !== false,
    deniedRoutes: uniqueStrings(Array.isArray(input.deniedRoutes) ? input.deniedRoutes : []),
    allowedRoutes: uniqueStrings(Array.isArray(input.allowedRoutes) ? input.allowedRoutes : []),
    calibrationEnabled: input.calibrationEnabled !== false,
    captainMode: input.captainMode === 'spawned' ? 'spawned' : 'main',
    reasoningEffort: normalizeRouteMap(input.reasoningEffort),
    // Carried through, never dropped. This block is re-normalized on EVERY save
    // and on read, so a key missing here is silently discarded — which is exactly
    // what had happened to `decisionCues`: `orchestrate_configure` reported it
    // applied, and it was gone before it could ever be used.
    decisionCues: normalizeCueMap(input.decisionCues),
  };
}

/** A `{ route: value }` map of non-empty strings, dropping anything else. */
function normalizeRouteMap(input) {
  const out = {};
  if (!isRecord(input)) return out;
  for (const [route, value] of Object.entries(input)) {
    const key = str(route);
    const text = str(value);
    if (key === undefined || text === undefined) continue;
    out[key] = text.slice(0, 64);
  }
  return out;
}

/** A `{ group: [cue] }` map, dropping empty or malformed groups. */
function normalizeCueMap(input) {
  const out = {};
  if (!isRecord(input)) return out;
  for (const [group, value] of Object.entries(input)) {
    const key = str(group);
    if (key === undefined || !Array.isArray(value)) continue;
    const cues = uniqueStrings(
      value.map((entry) => str(entry)).filter((entry) => entry !== undefined),
    );
    if (cues.length > 0) out[key] = cues;
  }
  return out;
}

/** Validate a calibration map, dropping unusable entries. */
function normalizeProfiles(input) {
  const out = {};
  if (!isRecord(input)) return out;
  for (const [route, value] of Object.entries(input)) {
    if (str(route) === undefined || !isRecord(value)) continue;
    const entry = {};
    const strengths = uniqueStrings(Array.isArray(value.strengths) ? value.strengths : []);
    if (strengths.length > 0) entry.strengths = strengths.slice(0, 24);
    const keywords = uniqueStrings(Array.isArray(value.keywords) ? value.keywords : []);
    if (keywords.length > 0) entry.keywords = keywords.slice(0, 120);
    const limits = str(value.limits);
    if (limits !== undefined) entry.limits = limits.slice(0, 800);
    const at = uint(value.at);
    if (at !== undefined) entry.at = at;
    if (Object.keys(entry).length > 0) out[route] = entry;
  }
  return out;
}

/**
 * Coerce a parsed state document into a valid state.
 * @param input - the parsed document.
 * @returns a normalized state.
 */
export function normalizeState(input) {
  const base = defaultState();
  if (!isRecord(input)) return base;
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    mode: MODES.includes(input.mode) ? input.mode : base.mode,
    guided: {
      capabilities: uniqueStrings(
        isRecord(input.guided) && Array.isArray(input.guided.capabilities)
          ? input.guided.capabilities
          : [],
      ),
    },
    preferences: normalizePreferences(input.preferences),
    taxonomy: {
      custom:
        isRecord(input.taxonomy) && Array.isArray(input.taxonomy.custom)
          ? input.taxonomy.custom
          : [],
    },
    profiles: normalizeProfiles(input.profiles),
    updatedAt: uint(input.updatedAt) ?? Date.now(),
  };
}

/**
 * The durable store. Reads once at construction and writes atomically.
 */
export class OrchestratorStore {
  #path;
  #state;
  #writeError;

  /**
   * @param directory - the state directory (typically `$DSH_HOME/orchestrator`).
   */
  constructor(directory) {
    this.#path = join(directory, 'state.json');
    this.directory = directory;
    this.#state = this.#read();
  }

  /** The absolute state file path. */
  get path() {
    return this.#path;
  }

  /** The last write failure, if any (surfaced rather than swallowed). */
  get writeError() {
    return this.#writeError;
  }

  #read() {
    try {
      if (!existsSync(this.#path)) return defaultState();
      const raw = readFileSync(this.#path, 'utf8');
      const parsed = JSON.parse(raw);
      const schema = uint(parsed?.schemaVersion);
      if (schema !== undefined && schema > STATE_SCHEMA_VERSION) {
        // A newer schema means a newer plugin wrote this file. Reading it
        // partially could route work on misunderstood preferences, so the
        // in-memory state falls back to defaults and the file is left intact.
        this.#writeError = `state file schemaVersion ${schema} is newer than supported ${STATE_SCHEMA_VERSION}; using defaults without overwriting`;
        return defaultState();
      }
      return normalizeState(parsed);
    } catch (error) {
      this.#writeError = `could not read ${this.#path}: ${String(error?.message ?? error)}`;
      return defaultState();
    }
  }

  /** A defensive copy of the current state. */
  snapshot() {
    return structuredClone(this.#state);
  }

  /** Replace the state wholesale (normalizing it) and persist. */
  replace(next) {
    this.#state = normalizeState(next);
    return this.save();
  }

  /**
   * Mutate the state through a callback and persist.
   * @param mutator - receives the live state; may mutate it.
   * @returns the persisted state.
   */
  update(mutator) {
    mutator(this.#state);
    this.#state.schemaVersion = STATE_SCHEMA_VERSION;
    this.#state.updatedAt = Date.now();
    return this.save();
  }

  /**
   * Persist atomically: write a sibling temp file, then rename over the target.
   *
   * A crash therefore leaves either the old file or the new one, never a
   * truncated document. A write failure is recorded and reported, not hidden.
   *
   * @returns the persisted state.
   */
  save() {
    this.#state = normalizeState(this.#state);
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const temp = `${this.#path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.#state, null, 2)}\n`, 'utf8');
      try {
        renameSync(temp, this.#path);
      } catch (error) {
        try {
          unlinkSync(temp);
        } catch {
          // The temp file is best-effort cleanup only.
        }
        throw error;
      }
      this.#writeError = undefined;
    } catch (error) {
      this.#writeError = `could not write ${this.#path}: ${String(error?.message ?? error)}`;
    }
    return this.snapshot();
  }

  /**
   * Prune calibrations whose route is not in the live pool.
   *
   * This is what keeps the persisted file from accumulating routes that no
   * longer exist, without ever removing a preference.
   *
   * @param liveRoutes - routes currently discoverable.
   * @returns the number of entries dropped.
   */
  pruneProfiles(liveRoutes) {
    const live = new Set(uniqueStrings(liveRoutes));
    let dropped = 0;
    this.update((state) => {
      for (const route of Object.keys(state.profiles)) {
        if (!live.has(route)) {
          delete state.profiles[route];
          dropped += 1;
        }
      }
    });
    return dropped;
  }
}

/**
 * Resolve the default state directory under a DSH home.
 *
 * @param dshHome - the harness home directory.
 * @returns the orchestrator's state directory.
 */
export function stateDirectory(dshHome) {
  const home = str(dshHome);
  if (home === undefined) throw new Error('stateDirectory requires a harness home path');
  return join(home, 'orchestrator');
}
