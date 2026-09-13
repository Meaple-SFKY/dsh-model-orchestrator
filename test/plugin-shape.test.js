/**
 * Plugin-shape tests: the manifest contract, the bundle patch, the client
 * bundle's module-loader contract, and the tool schemas the host will accept.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { declaredDshRange } from '../lib/compatibility.js';
import { DELEGATION_LABEL_MARKER } from '../lib/util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const patchText = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
const clientSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

/**
 * Locate the installed DSH tree.
 *
 * The plugin is developed outside the harness, so its checkout cannot resolve
 * `@deepseek-ai/*` on its own — that only works once the package is installed
 * into a profile. Tests that must exercise the real host contract therefore
 * locate the installation explicitly, by walking up from this repo and by
 * checking the Node installation's own `node_modules` (where a global `dsh`
 * lives). An explicit override is honoured first.
 *
 * @returns the DSH package directory, or `undefined`.
 */
function findDshInstall() {
  const override = process.env.DSH_TEST_HOST
  if (typeof override === 'string' && override !== '') return override

  const candidates = []
  // 1. An ancestor node_modules (a workspace checkout that has one).
  let directory = ROOT
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(directory, 'node_modules', '@deepseek-ai', 'dsh'))
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  // 2. The Node installation's global node_modules, beside this executable.
  const executable = process.execPath
  if (typeof executable === 'string' && executable !== '') {
    const binDirectory = dirname(executable)
    candidates.push(join(binDirectory, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
    candidates.push(join(binDirectory, 'node_modules', '@deepseek-ai', 'dsh'))
  }
  // 3. An installed profile under a harness home.
  for (const home of [process.env.DSH_HOME, join(homedir(), '.dsh')]) {
    if (typeof home !== 'string' || home === '') continue
    try {
      for (const entry of readdirSync(join(home, 'profiles'))) {
        candidates.push(join(home, 'profiles', entry, 'node_modules', '@deepseek-ai', 'dsh'))
      }
    } catch {
      // No profiles directory.
    }
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(join(candidate, 'package.json'))) return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/**
 * The host tool compiler, or `undefined` when no DSH installation is present.
 *
 * A missing installation is an environment fact: the plugin is developed
 * standalone, and the schema checks then cannot run. A missing compiler under a
 * present installation is not tolerated — that would make those checks vacuous.
 */
async function loadHostTools() {
  const install = findDshInstall()
  if (install === undefined) return undefined
  const compiler = join(install, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
  if (!existsSync(compiler)) {
    throw new Error(
      `a DSH installation was found at ${install} but its tool compiler is missing; the schema checks would be vacuous`,
    )
  }
  return import(pathToFileURL(compiler).href)
}

/**
 * Minimal reader for the bundle-patch dialect this plugin ships.
 *
 * The patch is deliberately small and flat, so a full YAML dependency is not
 * warranted in the test suite. It understands the two constructs the format
 * uses: a top-level sequence of mappings, and nested `insert:` sequences of
 * mappings with scalar values.
 *
 * @param text - the patch file text.
 * @returns the parsed entry list.
 */
function parsePatch(text) {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, (match) => (match.includes("'") ? match : '')))
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));

  const entries = [];
  let current = null;
  let insert = null;
  let row = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0 && trimmed.startsWith('- ')) {
      current = {};
      entries.push(current);
      insert = null;
      row = null;
      // The sequence item may itself open a mapping, as in `- insert:`.
      const rest = trimmed.slice(2).trim();
      if (rest.endsWith(':')) {
        insert = [];
        current[rest.slice(0, -1)] = insert;
      } else {
        const pair = splitPair(rest);
        if (pair) current[pair[0]] = pair[1];
      }
      continue;
    }
    if (current === null) continue;

    if (trimmed === 'insert:') {
      insert = [];
      current.insert = insert;
      continue;
    }

    if (insert !== null && trimmed.startsWith('- ')) {
      row = {};
      insert.push(row);
      const pair = splitPair(trimmed.slice(2).trim());
      if (pair) row[pair[0]] = pair[1];
      continue;
    }
    if (row !== null) {
      const pair = splitPair(trimmed);
      if (pair) row[pair[0]] = pair[1];
    }
  }
  return entries;
}

/** Split `key: value`, unquoting a single-quoted scalar. */
function splitPair(text) {
  const index = text.indexOf(':');
  if (index === -1) return undefined;
  const key = text.slice(0, index).trim();
  let value = text.slice(index + 1).trim();
  if (value === '') return [key, ''];
  if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  if (value === 'true') return [key, true];
  if (value === 'false') return [key, false];
  return [key, value];
}

test('the package declares the publication metadata a marketplace needs', () => {
  assert.equal(manifest.name, 'dsh-model-orchestrator');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'version must be semver');
  assert.ok(typeof manifest.description === 'string' && manifest.description.length > 40);
  assert.equal(manifest.license, 'MIT');
  assert.ok(manifest.repository?.url, 'a repository is required for publication');
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.includes('dsh-plugin'));
  assert.equal(manifest.publishConfig?.access, 'public');
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the bundle patch must ship');
  assert.ok(manifest.files.includes('compatibility.json'));
});

test('the host range is declared in both sites the ecosystem reads', () => {
  assert.equal(manifest.engines.dsh, '0.1.5-rc.1');
  assert.equal(manifest.dsh.engines.dsh, manifest.engines.dsh);
  assert.equal(declaredDshRange(manifest), manifest.engines.dsh, 'top-level engines.dsh wins');
});

test('every imported host package is declared, and version-pinned', () => {
  // Import analysis: a peer range that drifts from the declared host range would
  // let the plugin load against packages it was not written for.
  const sources = ['compatibility.js', 'discovery.js', 'matching.js', 'engine.js', 'tools.js', 'index.js', 'routes.js'];
  const imported = new Set();
  for (const file of sources) {
    const text = readFileSync(join(ROOT, 'lib', file), 'utf8');
    for (const match of text.matchAll(/from\s+'(@deepseek-ai\/[^']+)'/g)) imported.add(match[1]);
    for (const match of text.matchAll(/require_?\(\s*'([^']+)'\s*\)/g)) {
      if (match[1].startsWith('@deepseek-ai/')) imported.add(match[1]);
    }
  }
  const declared = new Set(Object.keys(manifest.peerDependencies ?? {}));
  for (const pkg of imported) {
    assert.ok(declared.has(pkg), `"${pkg}" is imported but not declared in peerDependencies`);
  }
  for (const [pkg, range] of Object.entries(manifest.peerDependencies ?? {})) {
    assert.match(range, /\d+\.\d+\.\d+/, `peer range for ${pkg} must be a semver range`);
  }
});

test('the bundle patch mounts exactly one row named after the package', () => {
  const entries = parsePatch(patchText);
  assert.ok(Array.isArray(entries), 'a bundle patch is a top-level YAML array');
  assert.equal(entries.length, 1);
  const insert = entries[0].insert;
  assert.ok(Array.isArray(insert) && insert.length === 1, 'exactly one row is inserted');
  const row = insert[0];
  assert.equal(row.id, 'model-orchestrator');
  assert.equal(row.name, manifest.name, 'the row name must equal the package name');
});

test('the plugin publishes no service, so it needs no isolate realm', () => {
  // A row that publishes a service may not sit loose in a preset; this plugin
  // consumes host capabilities only.
  const patchEntries = parsePatch(patchText);
  const serialized = JSON.stringify(patchEntries);
  assert.ok(!serialized.includes('isolate'), 'no isolate realm is needed or wanted');
  assert.ok(!serialized.includes('disabled'), 'no row is disabled');
  const indexSource = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
  assert.ok(!/\bctx\.provide\s*\(/.test(indexSource), 'the plugin must not provide a service');
});

test('the compatibility metadata agrees with the manifest', () => {
  const compatibility = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8'));
  assert.equal(compatibility.declaredRange, manifest.engines.dsh);
  assert.deepEqual(compatibility.requiredServices, ['llm', 'subagents', 'tools', 'systemPrompt']);
  for (const entry of compatibility.supportedHosts) {
    assert.match(entry.version, /^\d+\.\d+\.\d+/);
    assert.ok(['recommended', 'compatible', 'legacy', 'preview'].includes(entry.track));
  }
});

test('the client bundle is loadable through the harness module loader', async () => {
  // Execute the bundle exactly as the browser would: as its own module, with
  // the loader global present, and assert the plugin it registers is well formed.
  let registration
  const requireShim = (id) => {
    if (id === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (initial) => [initial, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
      }
    }
    throw new Error(`unexpected module request: ${id}`)
  }
  const loaderGlobal = {
    __ModuleLoader__: {
      load: (entry) => {
        registration = entry
      },
    },
  }
  // The bundle is written for the browser: it references the bare `window`
  // global. Run it as a real module with that global installed.
  const previousWindow = globalThis.window
  globalThis.window = loaderGlobal
  const scratch = mkdtempSync(join(tmpdir(), 'orch-client-'))
  const bundlePath = join(scratch, 'client.mjs')
  writeFileSync(bundlePath, clientSource, 'utf8')
  try {
    await import(pathToFileURL(bundlePath).href)
  } finally {
    globalThis.window = previousWindow
    rmSync(scratch, { recursive: true, force: true })
  }

  assert.ok(registration, 'the bundle must call window.__ModuleLoader__.load')
  assert.equal(registration.id, manifest.name, 'the bundle id must match the package name')
  assert.equal(typeof registration.factory, 'function')

  const plugin = registration.factory(requireShim)
  assert.equal(plugin.name, manifest.name)
  assert.deepEqual([...plugin.inject].sort(), ['locale', 'slots'])
  assert.equal(typeof plugin.apply, 'function')

  // Drive apply against a mock slots service and assert both seats register.
  const injections = []
  const registered = []
  const disposers = []
  const localeRegistrations = []
  const ctx = {
    effect: (factory) => {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: {
      inject: (key, callback) => {
        injections.push(key)
        callback()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
    locale: {
      register: (ns, dicts) => {
        localeRegistrations.push({ ns, dicts })
        return () => {}
      },
      bind: (ns) => (key) => `[${ns}:${key}]`,
    },
  }
  plugin.apply(ctx)

  assert.deepEqual(injections.sort(), ['conversation.view', 'settings.section'])
  assert.equal(registered.length, 2)
  // The board is a first-class Conversation view beside Chat and Trajectory, not
  // an ambient strip over the composer.
  const view = registered.find((entry) => entry.options.name === 'conversation.view')
  assert.ok(view, 'the board must register into conversation.view')
  assert.equal(view.options.order, 20, 'it sits after Chat (0) and Trajectory (10)')
  assert.equal(
    registered.some((entry) => entry.options.name === 'conversation.input.dock'),
    false,
    'the plugin must not add a composer strip',
  )
  assert.equal(localeRegistrations.length, 1, 'the plugin must register one locale namespace')
  assert.equal(localeRegistrations[0].ns, 'modelOrchestrator')
  for (const entry of registered) {
    assert.equal(
      entry.options.locale,
      'modelOrchestrator',
      'every slot registration must carry the locale namespace so the shell injects `t`',
    )
    assert.equal(typeof entry.options.label, 'function', 'the label must be a thunk so it follows the locale')
  }
  for (const entry of registered) {
    assert.ok(entry.options.id, 'every registration needs an id');
    assert.equal(typeof entry.options.order, 'number');
    assert.ok(typeof entry.options.label === 'string' || typeof entry.options.label === 'function');
    assert.equal(typeof entry.component, 'function', 'a slot entry renders a component');
  }
  assert.notEqual(
    registered[0].options.id,
    registered[1].options.id,
    'the two seats must not collide on id',
  )
});

test('the client bundle declares no JSX and no undeclared imports', () => {
  // The bundle is served verbatim; a bare JSX expression would be a syntax error
  // in the browser, and an undeclared require would throw at load.
  assert.ok(!/<[A-Za-z][\s/>]/.test(clientSource.replace(/=>/g, '')), 'no JSX element syntax');
  const requested = [...clientSource.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(requested)], ['react'], 'only react may be requested at runtime');
});

test('the board parses the very marker the host-side label builder writes', () => {
  // The client bundle imports nothing, so this one string is duplicated by
  // necessity: the host writes it into every delegation label and the board
  // splits the label on it to recover the route. If they ever diverge, every
  // delegation silently loses its route on the board — which is precisely the
  // defect this pair exists to prevent.
  assert.ok(
    clientSource.includes(`'${DELEGATION_LABEL_MARKER}'`),
    `the client bundle must split labels on ${JSON.stringify(DELEGATION_LABEL_MARKER)}`,
  );
  assert.ok(
    clientSource.includes(`lastIndexOf(ROUTE_MARKER)`),
    'the client must locate the marker with lastIndexOf, so a name containing it cannot win',
  );
});

test('every shipped tool parameter spec compiles under the real DSL', async () => {
  // The plugin's OWN parameter specs are compiled with the host's real
  // `defineTool`. This is the check that a schema mistake cannot survive to a
  // boot; it works whether or not the plugin is installed, because the specs are
  // plain data and only the compiler comes from the host.
  const host = await loadHostTools();
  if (host === undefined) return; // no DSH install on this machine
  const { defineTool } = host;
  const { TOOL_NAMES, toolParameterSpecs } = await import('../lib/schemas.js');

  assert.ok(Object.keys(TOOL_NAMES).length >= 7);
  for (const [key, value] of Object.entries(TOOL_NAMES)) {
    assert.match(value, /^orchestrate_[a-z_]+$/, `${key} must be a stable tool name`);
    assert.ok(value.length <= 64, `${key} tool name must fit the model-facing limit`);
  }

  const specs = toolParameterSpecs();
  assert.deepEqual(
    Object.keys(specs).sort(),
    Object.values(TOOL_NAMES).sort(),
    'every declared tool must expose its parameter spec for validation',
  );

  for (const [name, parameters] of Object.entries(specs)) {
    // Compiling is the assertion: the host compiler throws on any unsupported
    // key, wrong node type, or missing `additionalProperties` on an object.
    const compiled = defineTool({
      name,
      description: `compile check for ${name}`,
      parameters,
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'x' }] },
      execute: async () => ({}),
    });
    assert.equal(compiled.name, name);
    assert.ok(compiled.output.schema, `${name} must expose its output schema`);
  }
});

test('the schema validators in these tests actually reject a bad schema', async () => {
  // Guards against the whole class of bug the live boot found: an array node
  // carrying `additionalProperties`, which the parameter DSL rejects. If the
  // validator stopped rejecting it, every check above would be vacuous.
  const host = await loadHostTools();
  if (host === undefined) return;
  const { defineTool } = host;

  assert.throws(
    () =>
      defineTool({
        name: 'bad_schema_probe',
        description: 'a deliberately malformed definition used to prove the check has teeth',
        parameters: {
          list: { type: 'array', additionalProperties: true, items: { type: 'string' } },
        },
        output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'x' }] },
        execute: async () => ({}),
      }),
    /additionalProperties is not supported by the value schema DSL/,
  );

  assert.throws(
    () =>
      defineTool({
        name: 'missing_openness_probe',
        description: 'an object root without additionalProperties must be rejected',
        parameters: { root: { type: 'object', properties: { a: { type: 'string' } } } },
        output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'x' }] },
        execute: async () => ({}),
      }),
    /additionalProperties/,
  );
});

test('the plugin never introduces a competing task or progress surface', async () => {
  // Hard requirement: DSH owns task lists, step status, and progress. The
  // orchestrator is a scheduler invoked inside that flow, so it must not add a
  // task tool, a task store, a progress event, or a task view.
  const { TOOL_NAMES, toolParameterSpecs } = await import('../lib/schemas.js');
  const forbiddenToolWords = ['todo', 'task', 'step', 'plan_mode', 'planmode', 'progress', 'checklist'];
  for (const name of Object.values(TOOL_NAMES)) {
    for (const word of forbiddenToolWords) {
      assert.ok(
        !name.includes(word),
        `tool "${name}" looks like a task/progress surface (contains "${word}")`,
      );
    }
    assert.ok(name.startsWith('orchestrate_'), `tool "${name}" must be namespaced as a routing tool`);
  }

  // No parameter accepts a plan, a task list, or a step status.
  const serialized = JSON.stringify(toolParameterSpecs()).toLowerCase();
  for (const word of ['tasklist', 'task_list', 'steps', 'todostatus', 'stepstatus', 'progress']) {
    assert.ok(!serialized.includes(word), `a tool parameter exposes "${word}"`);
  }

  // The plugin registers no session event, so it cannot inject progress rows
  // into the transcript.
  const sources = ['index.js', 'engine.js', 'tools.js', 'routes.js'];
  for (const file of sources) {
    const text = readFileSync(join(ROOT, 'lib', file), 'utf8');
    assert.ok(
      !/\.session\.append\s*\(/.test(text),
      `lib/${file} appends a session event, which would add a competing progress surface`,
    );
    assert.ok(
      !/ctx\.emit\s*\(/.test(text),
      `lib/${file} emits a custom event, which would duplicate host progress signalling`,
    );
  }

  // The panel renders routing capacity, never a task list. The capacity FIGURES
  // moved to the Orchestrator board, which shows them per session; the settings
  // page keeps only the boundary note, so the board is what must carry them now.
  assert.ok(!/RunHistory/.test(clientSource), 'the panel must not render a run/task history');
  assert.ok(
    /CapacityNote/.test(clientSource) && /capacity\.note/.test(clientSource),
    'the settings page must keep the no-task-state note',
  );
  assert.ok(
    /dshmo-cardhead[\s\S]{0,120}capacity\.title/.test(clientSource),
    'the board must show the routing-capacity figures',
  );
  assert.ok(
    !/RoutingCapacity/.test(clientSource),
    'the duplicated settings-page capacity card must be gone, not merely unused',
  );
  assert.ok(
    !/(taskList|TaskList|\.tasks\b|\.steps\b)/.test(clientSource),
    'the panel must not read task or step state',
  );
});

test('the documented disable row matches the bundle row the loader mounts', () => {
  // Disabling is done through the loader row, so the documented patch must name
  // exactly the row this bundle inserts — otherwise the toggle silently no-ops.
  const entries = parsePatch(patchText)
  const rowId = entries[0].insert[0].id
  assert.equal(rowId, 'model-orchestrator')

  // The README documents the exact patch shape; keep them in agreement.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.ok(
    readme.includes(`- id: ${rowId}\n  disabled: true`),
    'the README must document a disable row naming the real row id',
  )

  // And the row id must be the one a user patch layer targets, i.e. it must not
  // be nested under a group that a `- id:` patch could not address directly.
  assert.equal(typeof entries[0].insert, 'object');
});

test('the plugin registers nothing when it never activates', () => {
  // A disabled row means the loader never calls `apply`. This asserts the
  // contract that makes that safe: `apply` is the only thing that registers
  // anything, so no partial state can exist without it.
  const indexSource = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const outsideApply = indexSource.slice(indexSource.indexOf('export async function apply'))
  // Every registration lives inside apply (checked by counting call sites there).
  for (const marker of [
    'registerOrchestratorTools(',
    'ctx.systemPrompt.section(',
    'installControlRoutesDeferred(',
    'ctx.effect(',
  ]) {
    const inApply = outsideApply.includes(marker)
    assert.ok(inApply, `${marker} must be called from apply, so a disabled row registers nothing`)
    const total = indexSource.split(marker).length - 1
    const outside = total - (outsideApply.split(marker).length - 1)
    assert.equal(outside, 0, `${marker} is also called outside apply, which a disabled row would still run`)
  }

  // No module-scope side effect: importing the entry must not touch a host.
  const beforeApply = indexSource.slice(0, indexSource.indexOf('export async function apply'))
  assert.ok(
    !/\bctx\./.test(beforeApply.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    'module scope must not touch ctx: an import that never activates must do nothing',
  )
});

test('no ambient composer strip and no parallel task surface', () => {
  // Earlier the plugin rendered a strip above the composer. The board replaced
  // it, and this guards against it creeping back: an ambient strip duplicates
  // the board while crowding the composer.
  assert.ok(
    !/conversation\.input\.dock/.test(clientSource),
    'the client must not register a composer strip',
  )
  assert.ok(
    !/OrchestratorDock/.test(clientSource),
    'the retired dock component must be gone, not merely unused',
  )
  // And the board must read the harness session tree rather than keep a copy.
  assert.ok(
    /ROUTES\.tree|\/tree/.test(clientSource),
    'the board must read the delegation graph from the host',
  )
});

test('no injected stylesheet holds a backtick, and the board keeps its width chain', () => {
  // Regression guard for a mistake made three times while editing: an injected
  // stylesheet lives in a template literal, so a backtick inside one of its CSS
  // comments terminates the literal early and the bundle becomes a syntax error.
  // `node --check` catches it, but only if it is run; this catches it in the suite.
  //
  // Every stylesheet is checked, not just the first: the panel and the board each
  // inject one, and a guard that silently inspected only one of them would pass
  // while the other was broken.
  const marker = 'style.textContent = `'
  const sheets = []
  for (let at = clientSource.indexOf(marker); at !== -1; at = clientSource.indexOf(marker, at + 1)) {
    const end = clientSource.indexOf('`', at + marker.length)
    assert.notEqual(end, -1, 'every stylesheet template literal must be terminated')
    sheets.push(clientSource.slice(at + marker.length, end))
  }
  assert.ok(sheets.length >= 2, `expected a panel and a board stylesheet, found ${sheets.length}`);
  for (const body of sheets) {
    assert.ok(!body.includes('`'), 'no injected stylesheet may contain a backtick');
  }

  // The board's own stylesheet must still declare the width chain it depends on.
  const board = sheets.find((body) => body.includes('.dshmo-board{'))
  assert.ok(board !== undefined, 'the board root rule must be present')
  assert.match(board, /--dsh-chat-content-width/, 'the width must follow the shell variable');
});;

test('the capability areas are gated on Guided and revealed with a transition', () => {
  // They were rendered unconditionally, so in Auto the panel offered a control
  // that changed nothing. The gate is pinned here because a refactor that drops it
  // would look harmless and read as a broken control to the user.
  assert.match(clientSource, /useReveal\(state\?\.mode === 'guided'\)/, 'the picker must be gated on Guided');
  assert.ok(
    /reveal\.mounted[\s\S]{0,400}CapabilityPicker/.test(clientSource),
    'the picker must render through the reveal wrapper, not bare',
  );
  const uses = [...clientSource.matchAll(/h\(CapabilityPicker/g)].length;
  assert.equal(uses, 1, 'the picker must be rendered in exactly one place — inside the reveal');

  // The transition itself, including the reduced-motion escape hatch.
  assert.match(clientSource, /\.dshmo-reveal\{/, 'the reveal rule must exist');
  assert.match(clientSource, /\.dshmo-reveal\.is-open\{/, 'the open state must be class-driven');
  assert.match(clientSource, /prefers-reduced-motion: reduce/, 'motion must be switchable off');

  // The exit delay must outlast the CSS transition, or the collapse is cut short.
  const css = /\.dshmo-reveal\{[\s\S]*?max-height (\d+)ms/.exec(clientSource);
  const js = /setMounted\(false\), (\d+)\)/.exec(clientSource);
  assert.ok(css !== null && js !== null, 'both durations must be present');
  assert.ok(Number(js[1]) >= Number(css[1]), `unmount (${js[1]}ms) must not precede the transition (${css[1]}ms)`);
});
