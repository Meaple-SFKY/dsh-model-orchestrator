/**
 * `/model-orchestrator` command tests.
 *
 * These run with no DSH installation, on purpose: the command layer is the one
 * place this plugin hands the user's own words back to the agent, and the module
 * is written to be loadable without a host so that path is always covered rather
 * than skipped on a developer machine.
 *
 * The behaviour under test is the contract the host actually enforces: a command
 * handler runs WITHOUT the command line reaching the model
 * (`CommandDefinition.handler`), so anything the model is meant to see has to be
 * delivered by the handler itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_NAME,
  USAGE,
  directiveText,
  installCommandDeferred,
  parseCommandInput,
  statusText,
} from '../lib/commands.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A host-free stand-in for the command registry, the agent, and the message factory. */
function harness({ commands = true, followup = true, factory = true } = {}) {
  const registered = [];
  const messages = [];
  const disposed = [];

  const registry = {
    register: (definition) => {
      registered.push(definition);
      return () => disposed.push(definition.name);
    },
  };

  const ctx = {
    inject: (services, callback) => {
      assert.deepEqual(services, ['commands'], 'the command service must be injected by name');
      // A missing service means the callback never fires, exactly as Cordis behaves.
      if (commands) callback({ get: () => undefined, commands: registry });
      return () => {};
    },
  };

  const agent = followup ? { followup: (message) => messages.push(message) } : {};

  const deps = {
    logger: undefined,
    state: () => ({ mode: 'auto', poolSize: 7, capabilityCount: 24, inFlight: 0 }),
  };
  if (factory) {
    deps.createUserMessage = (input) => ({ id: 'message-1', role: 'user', ...input });
  } else {
    deps.createUserMessage = () => {
      throw new Error('no message factory');
    };
  }

  return { ctx, deps, registered, messages, disposed, agent };
}

test('the command is registered under a stable name with a discovery hint', () => {
  const h = harness();
  const dispose = installCommandDeferred(h.ctx, h.deps);
  try {
    assert.equal(h.registered.length, 1, 'exactly one command must be registered');
    const definition = h.registered[0];
    assert.equal(definition.name, COMMAND_NAME);
    assert.equal(definition.name, 'model-orchestrator');
    assert.ok(definition.description.length > 0);
    assert.equal(definition.input.hint, '[<task> | status]');
    // The follow-up message carries the task verbatim, so recording rawInput too
    // would duplicate the user's words in the session log.
    assert.equal(definition.recordInput, false);
    assert.equal(typeof definition.handler, 'function');
  } finally {
    dispose();
  }
});

test('an empty invocation reports usage instead of routing an empty task', async () => {
  const h = harness();
  installCommandDeferred(h.ctx, h.deps);
  const definition = h.registered[0];

  for (const rawInput of ['', '   ']) {
    const result = await definition.handler({ agent: h.agent, rawInput });
    assert.equal(result.kind, 'error');
    assert.equal(result.text, USAGE);
  }
  assert.equal(h.messages.length, 0, 'nothing may be delivered for an empty invocation');
});

test('a task is delivered to the agent as one user message carrying the task verbatim', async () => {
  const h = harness();
  installCommandDeferred(h.ctx, h.deps);
  const definition = h.registered[0];

  const task = '请完成一次关于“未来 3 年 AI Agent 开发工具发展趋势”的小型技术研究。';
  const result = await definition.handler({ agent: h.agent, rawInput: `  ${task}  ` });

  assert.equal(result.kind, 'success');
  assert.equal(h.messages.length, 1, 'the task must be delivered exactly once');
  const message = h.messages[0];
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'user');
  const text = message.content.map((block) => block.text).join('\n');
  assert.ok(text.includes(task), 'the task must reach the agent verbatim');
  assert.match(text, /orchestrate_run/, 'the directive must name the tool to use');
  assert.match(text, /subagent/, 'the directive must name the tool it replaces');
  assert.match(text, /unitModelPreference/, 'the directive must say how to route per unit');
});

test('status reports live routing capacity and never wakes the agent', async () => {
  const h = harness();
  installCommandDeferred(h.ctx, h.deps);
  const definition = h.registered[0];

  for (const rawInput of ['status', '  STATUS  ']) {
    const result = await definition.handler({ agent: h.agent, rawInput });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /mode auto/);
    assert.match(result.text, /7 model\(s\)/);
    assert.match(result.text, /24 capabilit\(ies\)/);
    assert.match(result.text, /0 delegation\(s\) in flight/);
  }
  assert.equal(h.messages.length, 0, 'a status query is not a task and must not open a turn');
});

test('only a standalone status word is a sub-command', () => {
  assert.deepEqual(parseCommandInput('status'), { kind: 'status' });
  assert.deepEqual(parseCommandInput(' Status '), { kind: 'status' });
  assert.deepEqual(parseCommandInput(''), { kind: 'empty' });
  // A real task that merely begins with the word is still a task.
  assert.deepEqual(parseCommandInput('status of the migration'), {
    kind: 'task',
    task: 'status of the migration',
  });
});

test('a missing command registry leaves the rest of the plugin working', () => {
  const h = harness({ commands: false });
  const dispose = installCommandDeferred(h.ctx, h.deps);
  assert.equal(h.registered.length, 0);
  assert.doesNotThrow(() => dispose(), 'the disposer must be safe with nothing registered');
});

test('a failing message factory is reported, not thrown', async () => {
  const h = harness({ factory: false });
  installCommandDeferred(h.ctx, h.deps);
  const result = await h.registered[0].handler({ agent: h.agent, rawInput: 'do a thing' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /no message factory/);
  assert.equal(h.messages.length, 0);
});

test('an invocation with no usable agent is refused rather than silently dropped', async () => {
  const h = harness({ followup: false });
  installCommandDeferred(h.ctx, h.deps);
  const result = await h.registered[0].handler({ agent: h.agent, rawInput: 'do a thing' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /No live agent/);
});

test('the disposer unregisters the command', () => {
  const h = harness();
  const dispose = installCommandDeferred(h.ctx, h.deps);
  dispose();
  assert.deepEqual(h.disposed, [COMMAND_NAME]);
});

test('the command layer imports nothing from the host at load time', () => {
  // The property that makes this module testable without a DSH installation: a
  // static host import would fail to resolve on a host-free machine and the whole
  // command path would go uncovered. The host factory is reached lazily, inside a
  // running harness, and only when it was not injected.
  const source = readFileSync(join(ROOT, 'lib', 'commands.js'), 'utf8');
  const staticImports = [...source.matchAll(/^\s*import[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(staticImports, ['./util.js'], 'only local modules may be imported statically');
  assert.match(source, /await import\('@deepseek-ai\/dsh-llm'\)/, 'the host factory stays lazy');
});

test('the directive names the failure it prevents', () => {
  const text = directiveText('x');
  assert.match(text, /default model/, 'the directive must say why native delegation is wrong here');
  assert.ok(statusText(undefined).startsWith('Model Orchestrator — mode auto'));
});
