/**
 * Activation health: what this plugin actually turned on, and what it could not.
 *
 * Two problems this exists for.
 *
 * FIRST, activation fragility. Every registration step in `apply()` was unwrapped, and
 * a rejected `apply()` is not a local failure: the harness's boot audit treats a failed
 * composition entry as fatal and disposes the whole context, so one bad tool schema or
 * one unavailable optional service took unrelated plugins down with it. Each subsystem
 * is therefore registered INSIDE a guard here, and a failure disables that subsystem
 * and is recorded instead of thrown.
 *
 * SECOND, invisible degradation. "The panel did not appear" and "the slash command is
 * not registered" were log lines only, so a user saw a plugin that seemed to work while
 * a whole surface was silently missing. Every subsystem reports its status, and the
 * panel and `orchestrate_status` show the list.
 *
 * The compatibility gate is deliberately NOT covered: refusing an incompatible host is
 * a decision, not an accident, and it must stay loud.
 *
 * @module dsh-model-orchestrator/health
 */
import { str } from './util.js';

/** The states one subsystem can be in. */
export const HEALTH_STATUSES = Object.freeze(['enabled', 'degraded', 'disabled']);

/**
 * Create the health record.
 *
 * @param options - `{ host, logger }`, where `host` carries `optionalMissing`.
 * @returns `{ set, enabled, degrade, disable, run, snapshot }`.
 */
export function createHealth({ host, logger, probe } = {}) {
  /** subsystem -> { status, reason? } */
  const entries = new Map();
  /** subsystem -> { check, reason } — evaluated at read time, not at activation. */
  const checks = new Map();

  function set(subsystem, status, reason) {
    const name = str(subsystem);
    if (name === undefined || !HEALTH_STATUSES.includes(status)) return;
    entries.set(name, { status, ...(str(reason) === undefined ? {} : { reason: str(reason) }) });
  }

  /**
   * The optional services this deployment does not provide, as of NOW.
   *
   * Preferring the live probe over the activation-time list is what keeps the report
   * from contradicting itself: a service that mounted after activation is present, and
   * saying otherwise next to an enabled subsystem is worse than saying nothing.
   */
  function absentDependencies() {
    try {
      const live = probe?.();
      if (Array.isArray(live)) return [...live];
    } catch {
      // A failed probe falls back to the activation-time list rather than reporting
      // nothing missing.
    }
    return Array.isArray(host?.optionalMissing) ? [...host.optionalMissing] : [];
  }

  return {
    set,
    /** Mark one subsystem as working. */
    enabled: (subsystem) => set(subsystem, 'enabled'),
    /** Mark one subsystem as partially working, with the reason. */
    degraded: (subsystem, reason) => set(subsystem, 'degraded', reason),
    /** Mark one subsystem as not working, with the reason. */
    disable: (subsystem, reason) => set(subsystem, 'disabled', reason),

    /**
     * Report a subsystem whose availability is decided at READ time.
     *
     * An optional service is frequently mounted AFTER this plugin activates, so asking
     * once at activation would report a working surface as permanently disabled — the
     * opposite of what this record is for.
     *
     * @param subsystem - the surface.
     * @param available - a predicate, evaluated on every read.
     * @param reason - why it is unavailable, when the predicate is false.
     */
    check(subsystem, available, reason) {
      const name = str(subsystem);
      if (name === undefined || typeof available !== 'function') return;
      checks.set(name, { available, reason: str(reason) });
    },

    /**
     * Run one registration step, containing its failure.
     *
     * A throw disables the named subsystem, records why, and returns `undefined` — it
     * never propagates, because propagating is what failed the whole composition.
     *
     * @param subsystem - the surface being registered.
     * @param step - the work.
     * @returns the step's value, or `undefined` when it failed.
     */
    run(subsystem, step) {
      try {
        const value = step();
        // A step that reports its own absence (no web server, no command registry)
        // has already set its status; only a silent success is marked enabled here.
        if (!entries.has(String(subsystem))) set(subsystem, 'enabled');
        return value;
      } catch (error) {
        const message = String(error?.message ?? error);
        set(subsystem, 'disabled', message);
        logger?.warn?.(`orchestrator: ${subsystem} is disabled: ${message}`);
        return undefined;
      }
    },

    /**
     * The report both surfaces render.
     *
     * @returns `{ missingDependencies, subsystems, degraded, disabled }`.
     */
    snapshot() {
      const subsystems = [...entries.entries()].map(([name, entry]) => ({ name, ...entry }));
      for (const [name, entry] of checks) {
        if (entries.has(name)) continue;
        let ok = false;
        try {
          ok = entry.available() === true;
        } catch {
          ok = false;
        }
        subsystems.push({
          name,
          status: ok ? 'enabled' : 'disabled',
          ...(ok || entry.reason === undefined ? {} : { reason: entry.reason }),
        });
      }
      return {
        // Optional services this deployment does not provide, re-checked on every read
        // so a late mount is not reported as permanently absent.
        missingDependencies: absentDependencies(),
        subsystems,
        degraded: subsystems.filter((entry) => entry.status === 'degraded'),
        disabled: subsystems.filter((entry) => entry.status === 'disabled'),
      };
    },
  };
}
