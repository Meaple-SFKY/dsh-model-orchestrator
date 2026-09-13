/**
 * Compatibility gate tests.
 *
 * The requirement is absolute: an unsupported host must be refused loudly, with
 * a precise reason, and nothing may be registered. These tests pin that contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as compatibility from '../lib/compatibility.js';
import {
  assertCompatible,
  declaredDshRange,
  isExactVersion,
  loadSemver,
  matchesExactPrereleasePin,
  probeRuntime,
  readOwnManifest,
  resolveDshVersion,
  resolveHostVersions,
  satisfiesHost,
} from '../lib/compatibility.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** A context exposing a fully working host contract. */
function healthyContext(overrides = {}) {
  const llm = {
    listProviders: () => [{ id: 'p1', name: 'Provider one' }],
    listModels: async (provider) =>
      provider === 'p1' ? [{ provider, id: 'm1', name: 'M1', inputModalities: ['text'] }] : [],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    // The engine's pre-flight calls this before every delegation, so a host without
    // it is not healthy — the gate under-checked it until the contract moved to the
    // document, which is how this stub came to be missing a method in use.
    resolveCallConfig: async (config) => config,
    ...overrides.llm,
  };
  const services = {
    llm,
    subagents: { list: () => ['spawn'], start: async () => {}, getProvider: () => undefined },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    ...overrides.services,
  };
  const removed = new Set(overrides.missing ?? []);
  const stripped = new Set(overrides.stripMethods ?? []);
  const ctx = {
    get(key) {
      if (removed.has(key)) return undefined;
      const service = services[key];
      if (service === undefined) return undefined;
      if (stripped.size === 0) return service;
      const copy = { ...service };
      for (const entry of stripped) {
        const [serviceName, method] = entry.split('.');
        if (serviceName === key) delete copy[method];
      }
      return copy;
    },
  };
  return ctx;
}

/** A logger capturing what the gate reported. */
function captureLogger() {
  const entries = [];
  return {
    entries,
    error: (message) => entries.push({ level: 'error', message }),
    warn: (message) => entries.push({ level: 'warn', message }),
    info: (message) => entries.push({ level: 'info', message }),
  };
}

test('the declared range is read from the manifest in the ecosystem order', () => {
  assert.equal(declaredDshRange(manifest), '0.1.5-rc.1');
  assert.equal(declaredDshRange({ dsh: { engines: { dsh: '1.2.3' } } }), '1.2.3');
  // Top-level wins when both are present.
  assert.equal(
    declaredDshRange({ engines: { dsh: '9.9.9' }, dsh: { engines: { dsh: '1.1.1' } } }),
    '9.9.9',
  );
  assert.equal(declaredDshRange({}), undefined);
});

test('an exact prerelease pin admits the release core, not a different one', () => {
  assert.equal(matchesExactPrereleasePin('0.1.5-rc.1', '0.1.5-rc.2'), true);
  assert.equal(matchesExactPrereleasePin('0.1.5-rc.1', '0.1.5'), true);
  assert.equal(matchesExactPrereleasePin('0.1.5-rc.1', '0.1.4'), false);
  assert.equal(matchesExactPrereleasePin('0.1.5-rc.1', '0.2.0'), false);
  assert.equal(matchesExactPrereleasePin('^0.1.5', '0.1.5-rc.1'), false);
});

test('range evaluation is correct with and without semver', () => {
  const pinned = '0.1.5-rc.1';
  assert.equal(satisfiesHost(undefined, pinned, '0.1.5-rc.1'), true);
  assert.equal(satisfiesHost(undefined, pinned, '0.1.5-rc.2'), true);
  assert.equal(satisfiesHost(undefined, pinned, '0.1.4'), false);
  assert.equal(satisfiesHost(undefined, pinned, '0.2.0'), false);
  assert.equal(satisfiesHost(undefined, '', '0.1.5-rc.1'), false, 'an empty range admits nothing');

  // A wide range is not decidable without semver, so it must not be guessed.
  assert.equal(satisfiesHost(undefined, '^0.1.5', '0.1.5-rc.1'), false);
  assert.equal(satisfiesHost(undefined, '>=0.1.0', '0.1.5-rc.1'), false);

  const semver = loadSemver();
  if (semver !== undefined) {
    assert.equal(satisfiesHost(semver, '^0.1.5', '0.1.5-rc.1'), true);
    assert.equal(satisfiesHost(semver, '^0.1.5', '0.2.0'), false);
    assert.equal(satisfiesHost(semver, '>=0.1.0 <0.2.0', '0.1.5-rc.1'), true);
  }
});

test('isExactVersion recognises only a single exact version', () => {
  assert.equal(isExactVersion('0.1.5-rc.1'), true);
  assert.equal(isExactVersion('0.1.5'), true);
  assert.equal(isExactVersion('^0.1.5'), false);
  assert.equal(isExactVersion('0.1.5-rc.1 || 0.1.4'), false);
});

test('the running host version is resolved from the installed tree', () => {
  const { host, anchors } = resolveHostVersions();
  // On a machine with no DSH install this is legitimately absent; the gate then
  // refuses activation, which the next test covers.
  if (host === undefined) {
    assert.equal(resolveDshVersion(), undefined);
    return;
  }
  assert.match(host.version, /^\d+\.\d+\.\d+/);
  assert.ok(Object.keys(anchors).length >= 1);
});

test('a healthy host activates and reports its range', async () => {
  if (resolveDshVersion() === undefined) return; // requires an installed host
  const logger = captureLogger();
  const result = await assertCompatible(healthyContext(), logger);
  assert.equal(result.name, manifest.name);
  assert.equal(result.version, manifest.version);
  assert.equal(result.range, manifest.engines.dsh);
  assert.equal(result.runningVersion, resolveDshVersion().version);
  assert.equal(logger.entries.filter((entry) => entry.level === 'error').length, 0);
});

test('a missing required Service refuses activation and names it', async () => {
  const logger = captureLogger();
  await assert.rejects(
    () => assertCompatible(healthyContext({ missing: ['subagents'] }), logger),
    (error) => {
      assert.equal(error.code, 'ORCHESTRATOR_INCOMPATIBLE_HOST');
      assert.match(error.message, /incompatible host/);
      assert.ok(error.reasons.some((reason) => /Service "subagents" is not available/.test(reason)));
      assert.match(error.message, /Required host range/);
      return true;
    },
  );
  // The refusal must be visible, not silent.
  assert.ok(logger.entries.some((entry) => entry.level === 'error'));
  assert.ok(
    logger.entries.some((entry) => /did not register any tool/.test(entry.message)),
    'the disable notice must state that nothing was registered',
  );
});

test('a missing required method refuses activation and names the method', async () => {
  const logger = captureLogger();
  await assert.rejects(
    () => assertCompatible(healthyContext({ stripMethods: ['llm.listModels'] }), logger),
    (error) => {
      assert.ok(
        error.reasons.some((reason) => /"llm" is missing method "listModels\(\)"/.test(reason)),
        `expected a missing-method reason, got: ${error.reasons.join(' | ')}`,
      );
      return true;
    },
  );
});

test('an empty model pool refuses activation', async () => {
  const logger = captureLogger();
  await assert.rejects(
    () => assertCompatible(healthyContext({ llm: { listProviders: () => [] } }), logger),
    /model pool is empty/,
  );
});

test('the gate performs NO model-listing network I/O', async (t) => {
  // The gate resolves the running host, which a bare checkout cannot.
  if (resolveDshVersion() === undefined) return t.skip('no DSH installation is present');
  // Regression, found by timing a real profile boot: the gate probed every
  // provider with listModels(), which for the bundled third-party provider is a
  // live HTTP request with a 10s timeout. That turned every boot into a
  // multi-second network wait (measured: 5.6s of a 6.7s boot).
  let listingCalls = 0;
  const ctx = healthyContext({
    llm: {
      listModels: async () => {
        listingCalls += 1;
        throw new Error('this provider would block on a real network call');
      },
      resolveModelInfo: async () => {
        throw new Error('the gate must not resolve model metadata either');
      },
    },
  });
  const logger = captureLogger();
  // Activation succeeds: a slow or offline provider is a runtime condition, not
  // an incompatibility, and it must never block boot.
  await assertCompatible(ctx, logger);
  assert.equal(listingCalls, 0, 'the gate must not call listModels()');
});

test('a deployment with a provider route but no answering provider still activates', async (t) => {
  if (resolveDshVersion() === undefined) return t.skip('no DSH installation is present');
  // The pool reports the failure as a problem when discovery runs; activation is
  // not the place to require a network answer.
  const ctx = healthyContext({
    llm: { listModels: async () => { throw new Error('offline'); } },
  });
  const logger = captureLogger();
  const result = await assertCompatible(ctx, logger);
  assert.equal(result.runningVersion !== undefined || result.range !== undefined, true);
});

test('a provider registered without a usable id is refused', async (t) => {
  if (resolveDshVersion() === undefined) return t.skip('no DSH installation is present');
  const ctx = healthyContext({ llm: { listProviders: () => [{ name: 'no id here' }] } });
  await assert.rejects(
    () => assertCompatible(ctx, captureLogger()),
    /No LLM provider route is registered/,
  );
});

test('the probe reports optional services as absent without failing', async () => {
  const probe = await probeRuntime(healthyContext());
  assert.deepEqual(probe.problems, []);
  // Asserted against the document rather than a literal list: the optional set is
  // the deployment's to declare, and it grew (web, commands) without the probe
  // needing a change.
  const documented = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8')).optionalServices;
  assert.deepEqual([...probe.optionalMissing].sort(), [...documented].sort());
});

test('the probe does not treat an optional service as required', async () => {
  const ctx = healthyContext({
    services: { workflowEngine: { start: () => {} } },
  });
  const probe = await probeRuntime(ctx);
  assert.equal(probe.optionalMissing.includes('workflowEngine'), false);
});

test('the refusal message states the requirement and what was found', async () => {
  const logger = captureLogger();
  const error = await assertCompatible(healthyContext({ missing: ['tools'] }), logger).catch((e) => e);
  assert.ok(error instanceof Error);
  assert.ok(error.reasons.length >= 1);
  assert.match(error.message, /dsh-model-orchestrator \d+\.\d+\.\d+/);
  // A reader must learn both sides of the mismatch.
  assert.match(error.message, /Required host range: dsh /);
  // And must be told how to get back to a working session.
  assert.match(error.message, /Recovery: remove the plugin from this profile/);
  assert.match(error.message, /dsh plugin --profile <name> remove dsh-model-orchestrator/);
  assert.equal(error.code, 'ORCHESTRATOR_INCOMPATIBLE_HOST');
  assert.equal(error.name, 'OrchestratorIncompatibleHostError');
});

test('the enforced contract comes from compatibility.json, and the fallback agrees', () => {
  // Two copies of one contract is how the gate came to omit
  // `llm.resolveCallConfig` (which the engine's pre-flight calls, so the gate let
  // through hosts that would fail later) and to demand `tools.restrict` (which
  // nothing calls, so it refused hosts that were fine).
  const { loadContract, __internals } = compatibility;
  const contract = loadContract();
  const json = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8'));

  assert.deepEqual(
    contract.required.map((entry) => entry.service).sort(),
    [...json.requiredServices].sort(),
    'every required service in the document must be enforced',
  );
  for (const entry of contract.required) {
    assert.deepEqual(
      entry.methods,
      json.requiredServiceMethods[entry.service],
      `${entry.service}: the enforced methods must be the documented ones`,
    );
  }
  assert.deepEqual(
    contract.optional.map((entry) => entry.service).sort(),
    [...json.optionalServices].sort(),
    'every documented optional service must be treated as optional',
  );

  // The fallback is only for a missing document, and must not drift from it.
  const fallback = Object.fromEntries(
    __internals.FALLBACK_REQUIRED_CONTRACT.map((entry) => [entry.service, entry.methods]),
  );
  assert.deepEqual(fallback, json.requiredServiceMethods);
});

test('every method the gate demands is a method the plugin actually calls', () => {
  // The other direction of the same drift: a required method nothing calls makes
  // the plugin refuse a host it could have worked on.
  const { loadContract } = compatibility;
  const sources = readdirSync(join(ROOT, 'lib'))
    .filter((name) => name.endsWith('.js') && name !== 'compatibility.js')
    .map((name) => readFileSync(join(ROOT, 'lib', name), 'utf8'))
    .join('\n');
  for (const entry of loadContract().required) {
    for (const method of entry.methods) {
      assert.ok(
        sources.includes(method),
        `${entry.service}.${method} is required but never called anywhere in lib/`,
      );
    }
  }
});
