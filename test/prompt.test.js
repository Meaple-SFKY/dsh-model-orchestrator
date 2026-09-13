/**
 * Routing-policy prompt tests.
 *
 * The section is a shipped feature in its own right, and its delegation half
 * exists to close one observed failure: a captain that delegated four
 * heterogeneous research units through the native `subagent` tool with no route,
 * so every child inherited the deployment's single default child model and the
 * whole run looked like one model. That guidance is the plugin's only lever over
 * how the captain delegates, so it must not quietly disappear.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { usageSectionText } from '../lib/prompt.js';

const section = usageSectionText({
  toolNames: 'orchestrate_run, orchestrate_dispatch',
  mode: 'auto',
  poolSize: 7,
});

test('the section names the native-delegation trap and the way out of it', () => {
  assert.match(section, /native `subagent` tool/, 'must name the competing tool');
  assert.match(section, /differ in kind/, 'must state the trigger: heterogeneous units');
  assert.match(
    section,
    /default child\s+model/i,
    'must name the failure: every child inherits one default route',
  );
  assert.match(section, /provider` and `model`/, 'must say how to route natively if you still do');
});

test('the section still reports the live mode and pool size', () => {
  assert.match(section, /Mode: Auto/);
  assert.match(section, /Live model pool: 7 model\(s\)/);
  assert.match(usageSectionText({ toolNames: 'x', mode: 'guided', poolSize: 1 }), /Mode: Guided/);
});

test('a state reader that throws cannot break the section', () => {
  // The section is assembled on every prompt build, so a failing live-state
  // reader must degrade to a sane default rather than take the prompt down.
  const text = usageSectionText({
    toolNames: 'x',
    mode: () => {
      throw new Error('boom');
    },
    poolSize: () => {
      throw new Error('boom');
    },
  });
  assert.match(text, /Mode: Auto/);
  assert.match(text, /Live model pool: 0 model\(s\)/);
});
