/**
 * Activation compatibility gate.
 *
 * The plugin must never run against an unsupported host. Before it registers a
 * single tool or prompt section it proves three things and refuses to activate
 * otherwise:
 *
 *  1. **Declared range** — the `engines.dsh` range this package publishes (and
 *     the mirror under `dsh.engines.dsh`) admits the running DSH version.
 *  2. **Runtime contract** — every host Service and method this plugin calls is
 *     actually present, by name.
 *  3. **A routable pool** — at least one provider route is registered.
 *
 * The gate performs NO network I/O. It originally probed each provider with
 * `listModels()` to prove the pool was usable, which was a real mistake: a
 * provider's model listing can be a live HTTP request (the bundled third-party
 * provider refetches its catalog on every call with a 10s timeout), so the gate
 * turned every profile boot into a multi-second network wait. Presence of a
 * route is a structural fact; whether a provider ANSWERS is a runtime condition
 * that the pool reports as a problem when it fails, without blocking activation.
 *
 * Every failure produces one precise, user-facing reason naming the requirement
 * and what was found. There is no silent degradation path: `assertCompatible`
 * throws and the caller lets the composition row fail loudly.
 *
 * @module dsh-model-orchestrator/compatibility
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { str } from './util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const require_ = createRequire(import.meta.url);

/**
 * The host Services and methods this plugin calls, used when the manifest's
 * `compatibility.json` cannot be read.
 *
 * The JSON is the SOURCE OF TRUTH and is what the gate actually enforces — see
 * {@link loadContract}. This list exists only so a package whose data file is
 * missing still gates instead of activating unchecked, and a test asserts the two
 * agree, because they did not: this list omitted `llm.resolveCallConfig`, which
 * the pre-flight in the engine does call (so the gate passed hosts that would fail
 * later), and it demanded `tools.restrict`, which nothing in the plugin calls (so
 * the gate refused hosts that were fine). Two copies of one contract is how both
 * happened.
 */
const FALLBACK_REQUIRED_CONTRACT = Object.freeze([
  { service: 'llm', methods: ['listProviders', 'listModels', 'resolveModelInfo', 'resolveCallConfig'] },
  { service: 'subagents', methods: ['list', 'start', 'getProvider'] },
  { service: 'tools', methods: ['register'] },
  { service: 'systemPrompt', methods: ['section'] },
]);

/** The services that may be absent; used only when the JSON cannot be read. */
const FALLBACK_OPTIONAL_CONTRACT = Object.freeze([
  { service: 'workflowEngine', methods: ['start'] },
]);

/** The compatibility document, read once: it ships beside the manifest. */
let contractCache;

/**
 * Load the enforced host contract from `compatibility.json`.
 *
 * @returns `{ required, optional }`, as service/method entries.
 */
export function loadContract() {
  if (contractCache !== undefined) return contractCache;
  try {
    const document = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'compatibility.json'), 'utf8'));
    const required = Object.entries(document?.requiredServiceMethods ?? {}).map(([service, methods]) => ({
      service,
      methods: Array.isArray(methods) ? methods.filter((method) => typeof method === 'string') : [],
    }));
    const optional = (Array.isArray(document?.optionalServices) ? document.optionalServices : [])
      .filter((service) => typeof service === 'string')
      .map((service) => ({ service, methods: [] }));
    if (required.length === 0) throw new Error('compatibility.json declares no required methods');
    contractCache = { required, optional };
  } catch {
    // A missing or unusable data file must not mean "activate unchecked".
    contractCache = { required: FALLBACK_REQUIRED_CONTRACT, optional: FALLBACK_OPTIONAL_CONTRACT };
  }
  return contractCache;
}

/**
 * Read this package's own manifest.
 * @returns the parsed manifest.
 * @throws when the manifest is missing or unreadable.
 */
export function readOwnManifest() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
}

/**
 * The host version range this package declares.
 *
 * Top-level `engines.dsh` wins when both declaration sites are present, matching
 * how the community marketplace reads a manifest.
 *
 * @param manifest - this package's manifest.
 * @returns the declared range, or `undefined` when none is declared.
 */
export function declaredDshRange(manifest) {
  const top = str(manifest?.engines?.dsh);
  if (top !== undefined) return top;
  return str(manifest?.dsh?.engines?.dsh);
}

/**
 * Resolution anchors, in preference order.
 *
 * `@deepseek-ai/dsh` carries the authoritative host version. The other entries
 * are declared peers of this plugin, so resolving any of them proves the host
 * package tree is reachable; they are fallbacks for a deployment that ships the
 * sub-packages without the CLI package alongside the plugin.
 */
const VERSION_ANCHORS = Object.freeze([
  '@deepseek-ai/dsh/package.json',
  '@deepseek-ai/dsh-llm/package.json',
  '@deepseek-ai/dsh-subagent/package.json',
]);

/**
 * Resolve the versions of the DSH packages currently visible to this plugin.
 *
 * Resolution is anchored at this package, so it finds the same host package tree
 * the host itself loaded this plugin from. Both `import.meta.url` and the package
 * root are tried, because a bundler or loader may present either.
 *
 * @param extraBases - additional resolution anchors, tried after the package's
 *   own. A development checkout passes the located DSH installation here.
 * @returns `{ host, anchors }` where `host` is the authoritative `@deepseek-ai/dsh`
 *   version (or `undefined`) and `anchors` maps every resolved anchor to its version.
 */
export function resolveHostVersions(...extraBases) {
  const anchors = {};
  const requires = [];
  const bases = [import.meta.url, join(PACKAGE_ROOT, 'package.json'), ...extraBases];
  for (const base of bases) {
    try {
      requires.push(createRequire(base));
    } catch {
      // An unusable anchor is simply skipped.
    }
  }

  for (const anchor of VERSION_ANCHORS) {
    for (const require_ of requires) {
      try {
        const manifestPath = require_.resolve(anchor);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const version = str(manifest?.version);
        if (version !== undefined) {
          anchors[anchor] = { version, path: manifestPath };
          break;
        }
      } catch {
        // Try the next anchor or requirement base.
      }
    }
  }

  const host = anchors['@deepseek-ai/dsh/package.json'];
  return { host, anchors };
}

/**
 * Resolve the version of the DSH installation currently running this plugin.
 *
 * @returns `{ version, path }`, or `undefined` when the authoritative CLI
 *   package is not resolvable.
 */
export function resolveDshVersion() {
  return resolveHostVersions().host;
}

/**
 * Load `semver`, preferring the copy the host installation itself uses.
 *
 * Resolving through the resolved `@deepseek-ai/dsh` manifest means range
 * evaluation matches the host's own tooling exactly and never duplicates a
 * dependency. A standalone copy is used as a fallback for a deployment where the
 * host manifest is not reachable but `semver` is.
 *
 * @param hostManifestPath - resolved `@deepseek-ai/dsh/package.json`, when known.
 * @returns the semver module, or `undefined` when unavailable.
 */
export function loadSemver(hostManifestPath) {
  const bases = [];
  if (typeof hostManifestPath === 'string' && hostManifestPath !== '') bases.push(hostManifestPath);
  bases.push(import.meta.url);
  for (const base of bases) {
    try {
      return createRequire(base)('semver');
    } catch {
      // Try the next base.
    }
  }
  return undefined;
}

/**
 * Match an exact prerelease pin without `semver`.
 *
 * Prerelease versions such as `0.1.5-rc.1` are not admitted by plain `^0.1.5`,
 * so an exact prerelease pin is additionally accepted when it matches the
 * running version's release core. This keeps an exact pin like `0.1.5-rc.1`
 * working without silently widening a range the author narrowed.
 *
 * @param range - the declared range.
 * @param version - the running host version.
 * @returns whether the pin matches.
 */
export function matchesExactPrereleasePin(range, version) {
  const pin = /^(\d+\.\d+\.\d+)-[0-9A-Za-z.-]+$/.exec(String(range ?? '').trim());
  const running = /^(\d+\.\d+\.\d+)(?:-|$)/.exec(String(version ?? '').trim());
  return pin !== null && running !== null && pin[1] === running[1];
}

/**
 * Evaluate a host version against a declared range.
 *
 * `semver` is used when available so range semantics match the ecosystem's
 * tooling exactly. When it is not resolvable, only an exact prerelease pin can
 * be evaluated — any wider range is refused rather than guessed, because a wrong
 * "compatible" answer here would let the plugin run unsupported.
 *
 * @param semver - the semver implementation, or `undefined`.
 * @param range - the declared range.
 * @param version - the running host version.
 * @returns whether the host is admitted.
 */
export function satisfiesHost(semver, range, version) {
  const declared = String(range ?? '').trim();
  const running = String(version ?? '').trim();
  if (declared === '' || running === '') return false;

  if (semver !== undefined && typeof semver.satisfies === 'function') {
    try {
      if (semver.satisfies(running, declared, { includePrerelease: true })) return true;
    } catch {
      // An unparseable range falls through to the exact-pin check below.
    }
    if (matchesExactPrereleasePin(declared, running)) return true;
    return false;
  }

  // No semver: an exact version pin (release or prerelease) is still decidable.
  if (declared === running) return true;
  return matchesExactPrereleasePin(declared, running);
}

/**
 * Whether a declared range is narrow enough to evaluate without `semver`.
 * @param range - the declared range.
 * @returns true when the range is a single exact version.
 */
export function isExactVersion(range) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(range ?? '').trim());
}

/** Human-readable summary of a semver range, for error messages. */
function rangeBounds(semver, range) {
  try {
    const min = semver.minVersion(range);
    if (min === null) return undefined;
    return `>= ${min.version}`;
  } catch {
    return undefined;
  }
}

/**
 * Inspect one Service contract entry against the live context.
 * @param ctx - the plugin context.
 * @param entry - `{ service, methods }` to probe.
 * @returns a list of precise problems; empty when the contract holds.
 */
function inspectService(ctx, entry) {
  const problems = [];
  const service = ctx.get(entry.service);
  if (service === undefined) {
    problems.push(`Service "${entry.service}" is not available`);
    return problems;
  }
  for (const method of entry.methods) {
    if (typeof service[method] !== 'function') {
      problems.push(`Service "${entry.service}" is missing method "${method}()"`);
    }
  }
  return problems;
}

/**
 * Probe the runtime contract and the live model pool.
 *
 * @param ctx - the plugin context.
 * @param options - `{ signal }` for the pool probe.
 * @returns `{ problems: string[], providers: string[] }`.
 */
export async function probeRuntime(ctx, options = {}) {
  const problems = [];

  const contract = loadContract();
  for (const entry of contract.required) problems.push(...inspectService(ctx, entry));

  const llm = ctx.get('llm');
  if (llm !== undefined && typeof llm.listProviders === 'function') {
    let providers = [];
    try {
      providers = llm.listProviders() ?? [];
    } catch (error) {
      problems.push(`Service "llm".listProviders() threw: ${String(error?.message ?? error)}`);
    }
    if (providers.length === 0) {
      problems.push(
        'No LLM provider route is registered: the model pool is empty, so no task can be routed',
      );
    } else {
      // Structural only: a registered route means something can be attempted.
      // Whether a provider actually answers is discovered later and reported as a
      // pool problem, so a slow or offline endpoint never blocks boot.
      const routable = providers.filter((provider) => str(provider?.id) !== undefined);
      if (routable.length === 0) {
        problems.push('No LLM provider route is registered with a usable id');
      }
    }
  }

  const optional = [];
  for (const entry of contract.optional) {
    const missing = inspectService(ctx, entry);
    if (missing.length > 0) optional.push(entry.service);
  }

  return { problems, optionalMissing: optional };
}

/**
 * The activation gate. Aggregates every incompatibility into one error.
 *
 * @param ctx - the plugin context.
 * @param logger - an optional logger for the disable notice.
 * @returns `{ version, range, optionalMissing, semver }` on success.
 * @throws {Error} with a `[dsh-model-orchestrator] incompatible host` message.
 */
export async function assertCompatible(ctx, logger) {
  const manifest = readOwnManifest();
  const range = declaredDshRange(manifest);
  const name = str(manifest.name) ?? 'dsh-model-orchestrator';
  const version = str(manifest.version) ?? '0.0.0';
  const resolved = resolveHostVersions();
  const running = resolved.host;
  const semver = loadSemver(running?.path);

  const reasons = [];

  if (range === undefined) {
    reasons.push(
      `This package declares no host compatibility range; add "engines.dsh" to package.json`,
    );
  } else if (running === undefined) {
    reasons.push(
      `The running DSH version could not be resolved (needs "@deepseek-ai/dsh/package.json"); requires dsh ${range}`,
    );
  } else if (semver === undefined && !isExactVersion(range)) {
    // A wide range cannot be evaluated without semver, and answering "yes"
    // without evaluating would run the plugin unsupported.
    reasons.push(
      `The "semver" module could not be loaded, so the declared range "${range}" cannot be evaluated against ${running.version}`,
    );
  } else if (!satisfiesHost(semver, range, running.version)) {
    const bounds = semver === undefined ? undefined : rangeBounds(semver, range);
    reasons.push(
      `DSH ${running.version} does not satisfy the declared range "${range}"${
        bounds === undefined ? '' : ` (${bounds})`
      }`,
    );
  }

  const probe = await probeRuntime(ctx, {});
  reasons.push(...probe.problems);

  if (reasons.length > 0) {
    const header = `${name} ${version}: incompatible host — the plugin is disabled`;
    const lines = reasons.map((reason, index) => `  ${index + 1}. ${reason}`);
    const requirement =
      range === undefined
        ? '  Required: an explicit "engines.dsh" host range.'
        : `  Required host range: dsh ${range}${running === undefined ? '' : `  (running: ${running.version})`}`;
    // The refusal fails this composition row, which is what makes it impossible
    // to miss. Tell the user exactly how to get back to a working session.
    const recovery =
      '  Recovery: remove the plugin from this profile with `dsh plugin --profile <name> remove ' +
      name +
      '`, or install a build whose "engines.dsh" admits this host.';
    const message = `${header}\n${lines.join('\n')}\n${requirement}\n${recovery}`;
    logger?.error?.(message);
    logger?.warn?.(
      `${name} did not register any tool, prompt section, or route because the host is incompatible.`,
    );
    const error = new Error(message);
    error.name = 'OrchestratorIncompatibleHostError';
    error.code = 'ORCHESTRATOR_INCOMPATIBLE_HOST';
    error.reasons = reasons;
    error.declaredRange = range;
    error.runningVersion = running?.version;
    throw error;
  }

  return {
    name,
    version,
    range,
    runningVersion: running?.version,
    optionalMissing: probe.optionalMissing,
    semver,
  };
}

/** Exported for tests and for the self-check script. */
export const __internals = {
  FALLBACK_REQUIRED_CONTRACT,
  FALLBACK_OPTIONAL_CONTRACT,
  loadContract,
  PACKAGE_ROOT,
};
