/**
 * Persistence tests: atomic writes, bounded history, schema handling, and the
 * core guarantee that the live model pool is never stored.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OrchestratorStore,
  STATE_SCHEMA_VERSION,
  defaultState,
  normalizeState,
  stateDirectory,
} from '../lib/persistence.js';

function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'orch-store-'));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('a fresh store starts from documented defaults', () => {
  const { directory, cleanup } = scratch();
  try {
    const store = new OrchestratorStore(directory);
    const state = store.snapshot();
    assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
    assert.equal(state.mode, 'auto');
    assert.deepEqual(state.guided.capabilities, []);
    assert.deepEqual(state.profiles, {});
    assert.ok(!('runs' in state), 'the orchestrator must keep no run history');
    assert.equal(store.writeError, undefined);
  } finally {
    cleanup();
  }
});

test('preferences round-trip across a restart', () => {
  const { directory, cleanup } = scratch();
  try {
    const first = new OrchestratorStore(directory);
    first.update((state) => {
      state.mode = 'guided';
      state.guided.capabilities = ['software.implementation', 'data.analysis'];
      state.preferences.maxParallel = 7;
      state.preferences.preferCheaper = false;
      state.preferences.deniedRoutes = ['p1/slow'];
    });

    const second = new OrchestratorStore(directory);
    const state = second.snapshot();
    assert.equal(state.mode, 'guided');
    assert.deepEqual(state.guided.capabilities, ['software.implementation', 'data.analysis']);
    assert.equal(state.preferences.maxParallel, 7);
    assert.equal(state.preferences.preferCheaper, false);
    assert.deepEqual(state.preferences.deniedRoutes, ['p1/slow']);
  } finally {
    cleanup();
  }
});

test('the live model pool is never written to disk', () => {
  const { directory, cleanup } = scratch();
  try {
    const store = new OrchestratorStore(directory);
    // Calibrations are keyed by route and are the ONLY model-derived data kept.
    store.update((state) => {
      state.profiles['p1/m1'] = { strengths: ['careful'], keywords: ['reasoning'], at: 1 };
    });
    const raw = readFileSync(store.path, 'utf8');
    assert.ok(raw.includes('p1/m1'), 'calibrations are stored');
    const parsed = JSON.parse(raw);
    // No pool snapshot of any kind may appear.
    for (const forbidden of [
      'models',
      'pool',
      'catalog',
      'providers',
      'contextWindow',
      'inputModalities',
      // Task and progress state belongs to DSH, never to this store.
      'runs',
      'tasks',
      'steps',
    ]) {
      assert.ok(!(forbidden in parsed), `the state file must not persist "${forbidden}"`);
    }
  } finally {
    cleanup();
  }
});

test('stale calibrations are pruned against the live pool', () => {
  const { directory, cleanup } = scratch();
  try {
    const store = new OrchestratorStore(directory);
    store.update((state) => {
      state.profiles['p1/live'] = { strengths: ['a'], at: 1 };
      state.profiles['p1/gone'] = { strengths: ['b'], at: 2 };
    });
    const dropped = store.pruneProfiles(['p1/live', 'p1/new']);
    assert.equal(dropped, 1);
    const state = store.snapshot();
    assert.ok('p1/live' in state.profiles, 'a live route keeps its calibration');
    assert.ok(!('p1/gone' in state.profiles), 'a route that left the pool is pruned');
  } finally {
    cleanup();
  }
});

test('a newer schema is refused rather than partially applied', () => {
  const { directory, cleanup } = scratch();
  try {
    writeFileSync(
      join(directory, 'state.json'),
      JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION + 5, mode: 'guided' }),
    );
    const store = new OrchestratorStore(directory);
    assert.match(store.writeError, /newer than supported/);
    // It must fall back to defaults WITHOUT overwriting the newer file.
    assert.equal(store.snapshot().mode, 'auto');
    const raw = JSON.parse(readFileSync(store.path, 'utf8'));
    assert.equal(raw.schemaVersion, STATE_SCHEMA_VERSION + 5, 'the newer file must be left intact');
  } finally {
    cleanup();
  }
});

test('a corrupt state file falls back to defaults and reports the problem', () => {
  const { directory, cleanup } = scratch();
  try {
    writeFileSync(join(directory, 'state.json'), '{ this is not json');
    const store = new OrchestratorStore(directory);
    assert.match(store.writeError, /could not read/);
    assert.equal(store.snapshot().mode, 'auto');
  } finally {
    cleanup();
  }
});

test('an out-of-range preference is clamped rather than rejected', () => {
  const state = normalizeState({
    mode: 'nonsense',
    preferences: { maxParallel: 9999, maxAgentsPerRun: -4, captainMode: 'weird' },
  });
  assert.equal(state.mode, 'auto', 'an unknown mode falls back to auto');
  assert.equal(state.preferences.maxParallel, 16);
  assert.equal(state.preferences.maxAgentsPerRun, 1);
  assert.equal(state.preferences.captainMode, 'main');
});

test('unusable calibration entries are dropped, not carried forward', () => {
  const state = normalizeState({
    profiles: {
      'p1/ok': { strengths: ['x'], keywords: ['y'], at: 5 },
      'p1/empty': {},
      'p1/bad': 'not an object',
      '': { strengths: ['x'] },
    },
  });
  assert.deepEqual(Object.keys(state.profiles), ['p1/ok']);
});

test('the state directory is derived from the harness home', () => {
  assert.equal(stateDirectory('/tmp/home'), join('/tmp/home', 'orchestrator'));
});

test('a write leaves no temporary file behind', () => {
  const { directory, cleanup } = scratch();
  try {
    const store = new OrchestratorStore(directory);
    store.update((state) => {
      state.mode = 'guided';
    });
    const leftovers = readdirSync(directory).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'the atomic write must clean up its temp file');
    assert.ok(existsSync(store.path));
  } finally {
    cleanup();
  }
});

test('defaultState returns independent copies', () => {
  const first = defaultState();
  first.preferences.deniedRoutes.push('p1/x');
  first.guided.capabilities.push('a.b');
  const second = defaultState();
  assert.deepEqual(second.preferences.deniedRoutes, []);
  assert.deepEqual(second.guided.capabilities, []);
});

test('the state schema contains no task, step, or run state', () => {
  // Pins the contract with the host: DSH owns task lists, step status, and
  // progress, so this store must never grow a parallel copy.
  const keys = Object.keys(defaultState()).sort();
  assert.deepEqual(keys, ['guided', 'mode', 'preferences', 'profiles', 'schemaVersion', 'taxonomy', 'updatedAt']);
  for (const forbidden of ['runs', 'tasks', 'steps', 'progress', 'todo', 'plan']) {
    assert.ok(!keys.includes(forbidden), `state must not contain "${forbidden}"`);
  }
});

test('every preference key survives a write and a reload', () => {
  // Regression: `normalizePreferences` re-normalizes on EVERY save and on read, so
  // a key it does not carry is silently discarded. `decisionCues` was missing, which
  // made the operator-replaceable cue vocabulary impossible to keep — the configure
  // path reported it applied and it was gone before it could ever be used.
  const directory = mkdtempSync(join(tmpdir(), 'orch-persist-keys-'));
  try {
    const store = new OrchestratorStore(directory);
    const declared = Object.keys(defaultState().preferences).sort();
    store.update((state) => {
      state.preferences.decisionCues = { math: ['推导', '证明'] };
      state.preferences.reasoningEffort = { 'p1/m1': 'high' };
    });

    for (const preferences of [
      store.snapshot().preferences,
      JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).preferences,
      new OrchestratorStore(directory).snapshot().preferences,
    ]) {
      assert.deepEqual(
        Object.keys(preferences).sort(),
        declared,
        'a normalized preference block must keep every declared key',
      );
      assert.deepEqual(preferences.decisionCues, { math: ['推导', '证明'] });
      assert.deepEqual(preferences.reasoningEffort, { 'p1/m1': 'high' });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('malformed preference entries are dropped without taking the block with them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orch-persist-bad-'));
  try {
    const store = new OrchestratorStore(directory);
    store.update((state) => {
      state.preferences.reasoningEffort = { 'p1/m1': 'high', 'p1/bad': 42, 'p1/empty': '' };
      state.preferences.decisionCues = { math: ['ok'], empty: [], broken: 'not-an-array' };
    });
    const preferences = new OrchestratorStore(directory).snapshot().preferences;
    assert.deepEqual(preferences.reasoningEffort, { 'p1/m1': 'high' });
    assert.deepEqual(preferences.decisionCues, { math: ['ok'] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('capability assignments survive a write and a reload', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orch-persist-assign-'));
  try {
    const store = new OrchestratorStore(directory);
    store.update((state) => {
      state.preferences.capabilityAssignments = {
        'multimodal.vision': { models: ['gemini-3.8-flash'], family: true },
        software: 'deepseek-v4.1-flash',
        broken: { models: [] },
      };
    });
    const preferences = new OrchestratorStore(directory).snapshot().preferences;
    assert.deepEqual(preferences.capabilityAssignments, {
      'multimodal.vision': { models: ['gemini-3.8-flash'], family: true },
      software: { models: ['deepseek-v4.1-flash'], family: false },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
