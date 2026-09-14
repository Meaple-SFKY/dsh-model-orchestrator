/**
 * Activation-health tests.
 *
 * The contract that matters: a subsystem that fails is DISABLED and recorded, never
 * thrown. A rejected `apply()` is not a local failure — the harness's boot audit fails
 * the composition entry and disposes the whole context, so one broken tool schema used
 * to take unrelated plugins down with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealth } from '../lib/health.js';

test('a failing subsystem is disabled and recorded, not thrown', () => {
  const warnings = [];
  const health = createHealth({ logger: { warn: (message) => warnings.push(message) } });

  let reachedAfter = false;
  assert.doesNotThrow(() => {
    const value = health.run('tools', () => {
      throw new Error('tool name "run_code" is reserved');
    });
    assert.equal(value, undefined);
    // The next subsystem still registers: this is the whole point.
    reachedAfter = true;
  });
  assert.equal(reachedAfter, true);

  const snapshot = health.snapshot();
  assert.deepEqual(snapshot.disabled, [
    { name: 'tools', status: 'disabled', reason: 'tool name "run_code" is reserved' },
  ]);
  assert.equal(snapshot.degraded.length, 0);
  assert.match(warnings.join('\n'), /tools is disabled/);
});

test('a step that succeeds is enabled without any explicit call', () => {
  const health = createHealth();
  health.run('taxonomy', () => 3);
  assert.deepEqual(health.snapshot().subsystems, [{ name: 'taxonomy', status: 'enabled' }]);
});

test('a step that reports its own state is not overwritten with enabled', () => {
  // The control panel sets `disabled` from inside its own step when the deployment
  // mounts no web server; marking it enabled afterwards would be a lie.
  const health = createHealth();
  health.run('controlPanel', () => {
    health.disable('controlPanel', 'this deployment mounted no web server');
    return () => {};
  });
  assert.deepEqual(health.snapshot().disabled, [
    { name: 'controlPanel', status: 'disabled', reason: 'this deployment mounted no web server' },
  ]);
});

test('degraded and disabled are distinguishable in the report', () => {
  const health = createHealth({ host: { optionalMissing: ['webServer', 'commands'] } });
  health.enabled('tools');
  health.degraded('webSearch', 'no search provider answered');
  health.disable('command', 'no commands registry');
  const snapshot = health.snapshot();
  assert.deepEqual(snapshot.missingDependencies, ['webServer', 'commands']);
  assert.deepEqual(
    snapshot.degraded.map((entry) => entry.name),
    ['webSearch'],
  );
  assert.deepEqual(
    snapshot.disabled.map((entry) => entry.name),
    ['command'],
  );
  assert.equal(snapshot.subsystems.length, 3);
});

test('a late-mounted optional service stops being reported as missing', () => {
  // Live verification found the report contradicting itself: `webServer absent` beside
  // `controlPanel enabled`. The activation-time list is a snapshot; the health read is
  // not, so it re-probes.
  let mounted = false;
  const health = createHealth({
    host: { optionalMissing: ['webServer', 'commands'] },
    probe: () => (mounted ? ['commands'] : ['webServer', 'commands']),
  });
  assert.deepEqual(health.snapshot().missingDependencies, ['webServer', 'commands']);
  mounted = true;
  assert.deepEqual(health.snapshot().missingDependencies, ['commands']);
});

test('a failed live probe falls back to the activation-time list', () => {
  const health = createHealth({
    host: { optionalMissing: ['webServer'] },
    probe: () => {
      throw new Error('probe unavailable');
    },
  });
  assert.deepEqual(health.snapshot().missingDependencies, ['webServer']);
});

test('an unknown status or subsystem name is ignored rather than recorded', () => {
  const health = createHealth();
  health.set('tools', 'sideways');
  health.set(undefined, 'enabled');
  assert.deepEqual(health.snapshot().subsystems, []);
});

test('a subsystem whose availability is decided at read time is not frozen at activation', () => {
  // An optional service is frequently mounted AFTER the plugin activates; deciding once
  // would report a working surface as permanently disabled.
  let mounted = false;
  const health = createHealth();
  health.check('webSearch', () => mounted, 'this deployment exposes no web search service');
  assert.deepEqual(health.snapshot().disabled, [
    { name: 'webSearch', status: 'disabled', reason: 'this deployment exposes no web search service' },
  ]);

  mounted = true;
  const after = health.snapshot();
  assert.deepEqual(after.disabled, []);
  assert.deepEqual(after.subsystems, [{ name: 'webSearch', status: 'enabled' }]);
});

test('a throwing availability check is reported as unavailable, never as a crash', () => {
  const health = createHealth();
  health.check('webSearch', () => {
    throw new Error('service probe exploded');
  }, 'unavailable');
  const snapshot = health.snapshot();
  assert.equal(snapshot.subsystems[0].status, 'disabled');
});

test('an explicitly recorded status wins over a live check for the same subsystem', () => {
  const health = createHealth();
  health.check('tools', () => true, 'unused');
  health.disable('tools', 'a duplicate name was refused');
  assert.deepEqual(health.snapshot().disabled, [
    { name: 'tools', status: 'disabled', reason: 'a duplicate name was refused' },
  ]);
});
