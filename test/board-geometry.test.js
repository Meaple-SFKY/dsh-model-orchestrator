/**
 * Board geometry tests.
 *
 * These exist because a person looking at the board reported that SOME wires are not
 * tightly connected to their boxes — something no host-side test can see, and something
 * that only shows up for particular graph shapes rather than all of them.
 *
 * The harness renders the real board component in Node with a small React stand-in
 * (working hooks, a stubbed `fetch` that serves the `/state` and `/tree` documents),
 * then walks the rendered tree and MEASURES it: every wire's first and last point must
 * lie on the perimeter of a box. A wire that starts in mid-air is exactly the defect
 * that was reported, and this is how it stays fixed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SOURCE = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

/** A component instance's hook store, keyed by render pass. */
function makeHooks() {
  const store = { index: 0, slots: [], passes: 0, dirty: false };
  return store;
}

/** A small React stand-in: inspectable elements, and hooks that actually work. */
function makeReact() {
  const instances = new Set();
  const react = {
    createElement(type, props, ...children) {
      return {
        type,
        props: { ...(props ?? {}) },
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined),
      };
    },
    useState(initial) {
      const store = current.store;
      const index = store.index++;
      if (store.slots[index] === undefined) store.slots[index] = { value: initial };
      const slot = store.slots[index];
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (value !== slot.value) {
          slot.value = value;
          store.dirty = true;
        }
      }];
    },
    useRef(initial) {
      const store = current.store;
      const index = store.index++;
      if (store.slots[index] === undefined) store.slots[index] = { value: initial, ref: true };
      return store.slots[index];
    },
    useMemo(factory, deps) {
      const store = current.store;
      const index = store.index++;
      const key = JSON.stringify(deps ?? []);
      if (store.slots[index] === undefined || store.slots[index].key !== key) {
        store.slots[index] = { value: factory(), key };
      }
      return store.slots[index].value;
    },
    useCallback(fn) {
      const store = current.store;
      const index = store.index++;
      if (store.slots[index] === undefined) store.slots[index] = { value: fn };
      return store.slots[index].value;
    },
    useEffect(factory) {
      current.effects.push(factory);
      return () => {};
    },
    // Registered so the harness can find every hook store that belongs to one render.
    __instances: instances,
  };
  // ONE hook store per component instance: React keeps state across renders and only
  // resets the hook CURSOR. Resetting the slots too is how the first version of this
  // harness lost every fetch — each pass rendered from an empty state forever.
  const store = makeHooks();
  let current = { store, effects: [] };
  react.__beginRender = () => {
    store.index = 0;
    store.dirty = false;
    current = { store, effects: [] };
    return current;
  };
  react.__current = () => current;
  return react;
}

/** Load the bundle and return the board component together with its React stand-in. */
async function loadBoard() {
  const react = makeReact();
  let registration;
  const window = { __ModuleLoader__: { load: (entry) => { registration = entry } } };
  const previousWindow = globalThis.window;
  globalThis.window = window;
  const directory = mkdtempSync(join(tmpdir(), 'orch-geometry-'));
  const bundlePath = join(directory, 'client.mjs');
  writeFileSync(bundlePath, CLIENT_SOURCE, 'utf8');
  try {
    await import(pathToFileURL(bundlePath).href);
  } finally {
    globalThis.window = previousWindow;
    rmSync(directory, { recursive: true, force: true });
  }
  assert.ok(registration, 'the bundle must register through the module loader');

  let board;
  const plugin = registration.factory((id) => {
    if (id === 'react') return react;
    throw new Error(`unexpected module request: ${id}`);
  });
  plugin.apply({
    // Registrations live inside effects, so the factory has to run for the board to
    // reach `slots.register` at all.
    effect: (factory) => factory(),
    on: () => () => {},
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        if (options.name === 'conversation.view') board = component;
        return () => {};
      },
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      getLocale: () => ({ active: 'en', locales: [], revision: 1 }),
    },
  });
  assert.ok(board, 'the board component must be registered');
  return { board, react };
}

/** Collect every rendered node box, wire and status chip from an element tree. */
function measure(element) {
  const boxes = [];
  const paths = [];
  const wires = [];
  // One entry per node box, with the status chips rendered inside it.
  const nodes = [];
  const walk = (node, depth = 0) => {
    if (node === null || typeof node !== 'object') return;
    // A function component has to be CALLED to reach the DOM it describes; the stub
    // stores them unresolved.
    if (typeof node.type === 'function' && depth < 12) {
      walk(node.type(node.props), depth + 1);
      return;
    }
    const className = typeof node.props?.className === 'string' ? node.props.className : '';
    // Token-boundary match: `dshmo-node-head`, `dshmo-node-label` and friends all
    // contain the substring, and counting them as boxes split every node into four.
    if (/(?:^|\s)dshmo-node(?:\s|$)/.test(className)) {
      const style = node.props.style ?? {};
      nodes.push({
        kind: (/(?:^|\s)dshmo-node-kind-([a-z]+)/.exec(className) ?? [])[1],
        statuses: [],
      });
      const box = {
        left: Number.parseFloat(style.left),
        top: Number.parseFloat(style.top),
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
      };
      // Only a box that states all four coordinates can be measured against; anything
      // else carrying the class is not a positioned box.
      if ([box.left, box.top, box.width, box.height].every((value) => Number.isFinite(value))) {
        boxes.push(box);
      }
    }
    if (className.includes('dshmo-wires')) {
      // Each wire is a <g> holding a visible path, a 16px hit copy of it, and
      // optionally a label; the <g>'s key is the edge id, which is how the test knows
      // WHICH two boxes a wire claims to connect.
      const collect = (child, key) => {
        if (child === null || typeof child !== 'object') return;
        const keyHere = typeof child.props?.key === 'string' ? child.props.key : key;
        if (typeof child.props?.d === 'string') {
          paths.push(child.props.d);
          if (wires.every((wire) => wire.key !== keyHere)) wires.push({ key: keyHere, d: child.props.d });
        }
        for (const grandchild of child.children ?? []) collect(grandchild, keyHere);
      };
      for (const child of node.children ?? []) collect(child, undefined);
    }
    if (className.includes('dshmo-status-') && nodes.length > 0) {
      nodes[nodes.length - 1].statuses.push(className);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(element);
  return { boxes, paths, wires, nodes };
}

/** Every coordinate pair in an SVG path, in order. */
function pointsOf(d) {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const points = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push({ x: numbers[index], y: numbers[index + 1] });
  }
  return points;
}

/** The distance from a point to the nearest point on a box's perimeter. */
function perimeterDistance(box, point) {
  const dx = Math.max(box.left - point.x, 0, point.x - (box.left + box.width));
  const dy = Math.max(box.top - point.y, 0, point.y - (box.top + box.height));
  return Math.hypot(dx, dy);
}

/** How far a wire's endpoint is from the nearest box perimeter. */
function detachment(boxes, point) {
  return Math.min(...boxes.map((box) => perimeterDistance(box, point)));
}


/**
 * Render the board to a settled state against one `/tree` document.
 *
 * Timers are stubbed because the board polls on an interval, and a real interval would
 * keep this process alive for the whole suite.
 */
async function renderBoard(react, board, props, tree) {
  const previousFetch = globalThis.fetch;
  const previousInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/tree') ? tree : FIXTURE_STATE),
  });
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  try {
    let element = null;
    // An unconditional handful of passes: the first read resolves on a later macrotask
    // than the pass that scheduled it, so "nothing changed this pass" is not proof of
    // a settled state.
    for (let pass = 0; pass < 8; pass += 1) {
      const state = react.__beginRender();
      element = board(props);
      for (const factory of state.effects) factory();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return measure(element);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setInterval = previousInterval;
    globalThis.clearInterval = previousClearInterval;
  }
}

// ---- the fixture ------------------------------------------------------------

/** Three units, one dependency, one reviewer, one question, and a native delegation. */
function fixtureUnits(count) {
  const units = [];
  for (let index = 0; index < count; index += 1) {
    units.push({
      id: `u${index + 1}`,
      childId: `child-${index + 1}`,
      capabilityId: 'software.implementation',
      capabilityLabel: `Unit ${index + 1}`,
      route: 'commandcode/deepseek/deepseek-v4.1-flash',
      dependsOn: [],
      reviews: [],
      waitingOn: [],
      status: 'completed',
      startedAt: 1,
      elapsedMs: 1000,
      rounds: 0,
      questionsAsked: [],
      questionsAnswered: [],
    });
  }
  return units;
}

function fixtureEdges(units) {
  const edges = [];
  for (const unit of units) {
    edges.push({ kind: 'task', from: 'task', to: unit.id, status: 'completed' });
    edges.push({ kind: 'dispatch', from: 'captain', to: unit.id, status: 'completed' });
    edges.push({ kind: 'output', from: unit.id, to: 'output', status: 'completed' });
  }
  return edges;
}

const FIXTURE_STATE = {
  ok: true,
  mode: 'auto',
  pool: { size: 2, providers: ['commandcode'], problems: [] },
  capabilities: [],
  assignments: { count: 0, entries: [], unresolved: [], unassigned: [] },
  health: { missingDependencies: [], subsystems: [], degraded: [], disabled: [] },
  plugin: { name: 'dsh-model-orchestrator', version: '0.3.0' },
  compatibility: { declaredRange: '0.1.5-rc.1', runningVersion: '0.1.5-rc.1', optionalMissing: [] },
  storage: {},
  sync: { status: 'idle' },
};

function fixtureTree(unitCount) {
  const units = fixtureUnits(unitCount);
  const nodes = [
    {
      id: 'captain', mode: 'continuable', activity: 'inactive', depth: 1,
      hasChildren: true, children: units.map((unit) => ({
        id: unit.childId, mode: 'one-shot', activity: 'completed', depth: 2,
        hasChildren: false, children: [],
      })),
    },
  ];
  return {
    ok: true,
    root: 'session-1',
    nodes,
    rows: [],
    diagnostics: [],
    truncated: false,
    counts: { total: unitCount, running: 0, continuable: 1, completed: unitCount, failed: 0, unknown: 0, roots: 1 },
    journal: {
      runs: [
        {
          runId: 'r1',
          sessionId: 'session-1',
          task: 'A task with a wide fan',
          tier: 'multi-agent',
          status: 'done',
          startedAt: 1,
          finishedAt: 2,
          elapsedMs: 2000,
          counts: { delegations: unitCount, running: 0, completed: unitCount, failed: 0, questions: 0, reviews: 0 },
          output: { status: 'done', at: 2, summary: `${unitCount} unit(s) answered` },
          units,
          edges: fixtureEdges(units),
          questions: [],
          reviews: [],
        },
      ],
    },
  };
}

const FIXTURE_TREE = fixtureTree(4);

test('every wire starts and ends on a box', async () => {
  // A small fan first: the ordinary case, and the one where a regression would be
  // easiest to miss.
  const { board, react } = await loadBoard();
  const { boxes, paths } = await renderBoard(react, board, { sessionId: 'session-1' }, FIXTURE_TREE);
  assert.ok(boxes.length >= 5, `expected boxes, rendered ${boxes.length}`);
  assert.ok(paths.length >= 8, `expected wires, rendered ${paths.length}`);

  const loose = [];
  for (const [index, path] of paths.entries()) {
    const points = pointsOf(path);
    assert.ok(points.length >= 2, `wire ${index} has no endpoints`);
    for (const [which, point] of [['start', points[0]], ['end', points[points.length - 1]]]) {
      const distance = detachment(boxes, point);
      if (distance > 1.5) loose.push({ index, which, distance: Number(distance.toFixed(1)) });
    }
  }
  assert.deepEqual(loose, [], 'a wire does not meet its box');
});

test('after a restart the board is drawn from the harness tree, and says so', async () => {
  // The state this test reproduces is the one a person sees right after restarting dsh:
  // the run journal is in-memory and therefore gone, while the harness session tree
  // still lists every delegation. Three things were wrong there, and all three came
  // from the same place — the graph was derived from the missing run record instead of
  // from what is actually on the page.
  const { board, react } = await loadBoard();
  const children = [1, 2, 3].map((index) => ({
    id: `child-${index}`,
    mode: 'one-shot',
    // A finished one-shot child reports "no longer active"; the harness keeps no
    // outcome for it, so "unknown" is the honest reading and the test pins it.
    activity: index === 1 ? 'inactive' : 'completed',
    depth: 2,
    hasChildren: false,
    children: [],
  }));
  const tree = {
    ok: true,
    root: 'session-1',
    nodes: [{ id: 'captain', mode: 'continuable', activity: 'inactive', depth: 1, hasChildren: true, children }],
    rows: children.map((child, index) => ({ ...child, ordinal: index + 1 })),
    diagnostics: [],
    truncated: false,
    counts: { total: 3, running: 0, continuable: 1, completed: 2, failed: 0, unknown: 1, roots: 1 },
    journal: { runs: [] },
  };

  const { boxes, paths, wires, nodes: nodeBoxes } = await renderBoard(react, board, { sessionId: 'session-1' }, tree);
  assert.ok(boxes.length >= 5, `expected task, captain, sessions and output, got ${boxes.length}`);

  // The captain is the session this page belongs to: it cannot be "unknown".
  const captain = nodeBoxes.filter((entry) => entry.kind === 'captain');
  assert.equal(captain.length, 1);
  assert.match(captain[0].statuses.join(' '), /dshmo-status-running/);
  assert.doesNotMatch(captain[0].statuses.join(' '), /dshmo-status-unknown/);

  // And with no run recorded, the task says unknown rather than "not started" while
  // its delegations are standing right there.
  const task = nodeBoxes.filter((entry) => entry.kind === 'task');
  assert.match(task[0].statuses.join(' '), /dshmo-status-unknown/);

  // The output is fed by the settled delegations, not by a single whole-graph wire.
  const outputWires = wires.filter((wire) => wire.key.startsWith('output:'));
  assert.deepEqual(
    outputWires.map((wire) => wire.key).sort(),
    ['output:session:child-2->output', 'output:session:child-3->output'],
    'only a settled delegation feeds the output once the run record is gone',
  );

  // The geometry holds on this shape too.
  const loose = [];
  for (const path of paths) {
    const points = pointsOf(path);
    for (const point of [points[0], points[points.length - 1]]) {
      const distance = detachment(boxes, point);
      if (distance > 1.5) loose.push(Number(distance.toFixed(1)));
    }
  }
  assert.deepEqual(loose, [], 'a wire does not meet its box');
});

test('a run feeds the output from its units, not from a captain detour', async () => {
  const { board, react } = await loadBoard();
  const { wires } = await renderBoard(react, board, { sessionId: 'session-1' }, FIXTURE_TREE);
  const outputWires = wires.filter((wire) => wire.key.startsWith('output:'));
  assert.deepEqual(
    outputWires.map((wire) => wire.key).sort(),
    ['output:unit:u1->output', 'output:unit:u2->output', 'output:unit:u3->output', 'output:unit:u4->output'],
  );
  assert.equal(
    wires.some((wire) => wire.key === 'output:captain->output'),
    false,
    'the captain reaches the output through everything it dispatched',
  );
});

test('a wide fan stays anchored too', async () => {
  // A run with many units is exactly where a fan's outer wires can leave the box: the
  // lane offset spreads a fan's anchors, and once it is wider than the box is tall the
  // outermost wires start in mid-air above and below it.
  const { board, react } = await loadBoard();
  const { boxes, paths } = await renderBoard(react, board, { sessionId: 'session-1' }, fixtureTree(20));
  assert.ok(boxes.length >= 20, `expected the wide fan's boxes, got ${boxes.length}`);
  const loose = [];
  for (const [index, path] of paths.entries()) {
    const points = pointsOf(path);
    for (const [which, point] of [['start', points[0]], ['end', points[points.length - 1]]]) {
      const distance = detachment(boxes, point);
      if (distance > 1.5) loose.push({ index, which, distance: Number(distance.toFixed(1)) });
    }
  }
  assert.deepEqual(loose, [], 'an outer wire leaves its box');
});
