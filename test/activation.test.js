/**
 * Activation tests: drive the real `apply()` against a host-shaped context.
 *
 * This exists because a live deployment found something no other test could. The plugin
 * activated, nine subsystems reported themselves enabled, and the control panel was
 * `disabled: "Cannot access 'locale' before initialization"` — the locale reader was
 * declared BELOW the route installer that consumes it, and the installer's `ctx.inject`
 * fired synchronously. Two things were true at once: the fault isolation worked exactly
 * as designed (one subsystem down, the plugin alive, the reason named), and the ordering
 * was simply wrong.
 *
 * A source-text check cannot catch that, and neither can a unit test of any one module.
 * Only running `apply()` with an injection that fires immediately does — which is what
 * the harness itself does when the web server is already mounted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDshInstall, materialize, ROOT } from './helpers/host-install.js';

const HOST = findDshInstall();
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/**
 * The plugin, materialized beside the installed host.
 *
 * `lib/tools.js` imports the host's `defineTool` at load time, so an activation test has
 * to run the copy that resolves `@deepseek-ai/*` the way an installed plugin does. This
 * is the same helper the rest of the suite uses for real host contracts.
 */
let materialized;
async function pluginOnHost(t) {
  if (HOST === undefined) {
    t.skip('no DSH installation is present');
    return undefined;
  }
  if (materialized === undefined) {
    materialized = await materialize(HOST, 'index.js', { manifest });
  }
  return materialized.module;
}

/**
 * A context that satisfies the compatibility gate and fires `inject` SYNCHRONOUSLY.
 *
 * Synchronous injection is the case that broke: with the web server already present the
 * callback runs during `apply()`, so anything it closes over must already be
 * initialized.
 *
 * @param options - `{ services, home }`.
 * @returns `{ ctx, registered, mounts, effects, warnings }`.
 */
function hostContext(options = {}) {
  const registered = [];
  const mounts = [];
  const effects = [];
  const warnings = [];

  const llm = {
    listProviders: () => [{ id: 'p1', name: 'Provider one' }],
    listModels: async (provider) => [{ provider, id: 'm1', name: 'M1', inputModalities: ['text'] }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    resolveCallConfig: async (config) => config,
  };

  const services = {
    llm,
    subagents: {
      list: () => ['spawn'],
      start: async () => {},
      getProvider: () => ({
        name: 'spawn',
        capabilities: { agentOptions: true, persona: true },
      }),
      listDescendants: async () => [],
    },
    tools: {
      register: (definition) => {
        registered.push(definition.name);
        return () => {};
      },
    },
    systemPrompt: { section: () => () => {} },
    webServer: {
      register: (route) => {
        mounts.push(route.path);
        return () => {};
      },
    },
    commands: {
      register: (definition) => {
        mounts.push(`command:${definition.name}`);
        return () => {};
      },
    },
    settings: { get: () => undefined },
    web: { search: async () => ({ sources: [] }) },
    ...options.services,
  };

  const ctx = {
    logger: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
    get: (key) => services[key],
    on: () => () => {},
    effect: (factory) => {
      const dispose = factory();
      effects.push(dispose);
      return () => {};
    },
    inject: (names, callback) => {
      // Synchronous, like the real service when it is already mounted.
      const scoped = { ...ctx };
      for (const name of names) scoped[name] = services[name];
      callback(scoped);
      return () => {};
    },
  };
  // A Cordis plugin context exposes every injected service as a PROPERTY
  // (`ctx.tools.register(...)`), not only through `get`. A mock with just `get` made the
  // tools subsystem fail to find its own registry — which the guard then reported as
  // "tools is disabled" rather than as a broken test double.
  for (const [name, service] of Object.entries(services)) ctx[name] = service;

  return { ctx, registered, mounts, effects, warnings, services };
}

test('apply() activates with a synchronous injection, and mounts the panel', async (t) => {
  const plugin = await pluginOnHost(t);
  if (plugin === undefined) return;
  const { apply } = plugin;
  const home = mkdtempSync(join(tmpdir(), 'orch-activate-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const host = hostContext();
  try {
    await apply(host.ctx);

    // The panel is the subsystem the ordering bug took down. Its route is proof.
    assert.ok(
      host.mounts.some((path) => path.endsWith('/state')),
      `the control routes must mount; mounted: ${JSON.stringify(host.mounts)}`,
    );
    assert.ok(
      host.mounts.includes('command:model-orchestrator'),
      `the command must register; mounted: ${JSON.stringify(host.mounts)}`,
    );
    // Every tool the plugin declares.
    const { TOOL_NAMES } = await import(join(materialized.scratch, 'lib', 'schemas.js'));
    for (const name of Object.values(TOOL_NAMES)) {
      assert.ok(host.registered.includes(name), `${name} must register`);
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a subsystem that fails to register is isolated and reported, not thrown', async (t) => {
  // The same guard that kept this ordering bug from taking the harness down. The tools
  // subsystem is made to throw, and everything else must still come up.
  const plugin = await pluginOnHost(t);
  if (plugin === undefined) return;
  const { apply } = plugin;
  const home = mkdtempSync(join(tmpdir(), 'orch-activate-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  // The stub is installed BEFORE the context is built, because a Cordis context exposes
  // injected services as properties: patching `services` afterwards would leave
  // `ctx.tools` pointing at the working double.
  const host = hostContext({
    services: {
      tools: {
        register: () => {
          throw new Error('tool name "run_code" is reserved');
        },
      },
    },
  });
  try {
    await apply(host.ctx);
    assert.ok(
      host.warnings.some((message) => /tools is disabled/.test(message)),
      `the failure must be reported; warnings: ${JSON.stringify(host.warnings)}`,
    );
    // The panel and the command are independent of the tools and must still mount.
    assert.ok(host.mounts.some((path) => path.endsWith('/state')));
    assert.ok(host.mounts.includes('command:model-orchestrator'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('the status tool reports the host language and which source decided it', async (t) => {
  // The harness renders a third-party command's copy verbatim, so "why is my slash
  // command still English?" has exactly one answer, and it has to be readable. The
  // tools module needs the host, so this runs against the materialized copy.
  const plugin = await pluginOnHost(t);
  if (plugin === undefined) return;
  const { registerOrchestratorTools } = await import(join(materialized.scratch, 'lib', 'tools.js'));
  const { createHostLocale } = await import(join(materialized.scratch, 'lib', 'host-locale.js'));
  const { Taxonomy } = await import(join(materialized.scratch, 'lib', 'taxonomy.js'));

  const locale = createHostLocale({ ctx: { inject: () => () => {} }, initial: 'zh' });
  const registered = [];
  registerOrchestratorTools(
    {
      tools: {
        register: (definition) => {
          registered.push(definition);
          return () => {};
        },
      },
    },
    {
      engine: { refresh: async () => ({ models: [] }), inFlightCount: 0 },
      pool: { models: () => [], providers: () => [], problems: () => [], discoveredAt: () => 0 },
      taxonomy: new Taxonomy(),
      store: {
        snapshot: () => ({
          mode: 'auto',
          guided: { capabilities: [] },
          preferences: {},
          profiles: {},
          research: {},
        }),
      },
      health: undefined,
      locale,
    },
  );
  const status = registered.find((definition) => definition.name === 'orchestrate_status');
  const value = await status.execute({}, { signal: new AbortController().signal });
  assert.deepEqual(value.locale, { language: 'zh', source: 'initial', explicit: true });
  locale.dispose();
});
