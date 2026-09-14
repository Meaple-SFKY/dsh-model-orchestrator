/**
 * Orchestration-board contract tests.
 *
 * The board is a self-contained browser bundle: no imports, no build step, no DOM in
 * this test runner. What CAN be asserted — and what regressed most often — is its
 * vocabulary and wiring: that every node kind, lifecycle status and edge kind the
 * renderer draws has a localized name in BOTH dictionaries, that the legend is built
 * from the same lists the renderer uses, and that the mechanisms the requirements name
 * (a wide edge hit area, flowing wires, pointer drag, label containment, an honest
 * `unknown`) are actually present.
 *
 * This is the same source-contract technique `test/plugin-shape.test.js` uses for the
 * client bundle, and it catches the failure that matters: a vocabulary word that is
 * drawn but cannot be named, or a list that the legend and the renderer disagree about.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
const locales = readFileSync(join(ROOT, 'lib', 'locales.js'), 'utf8');

/** Read one `const NAME = [ 'a', 'b' ]` list out of the client bundle. */
function listOf(name) {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(client);
  assert.ok(match, `the client bundle must declare ${name}`);
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter((entry) => entry !== '');
}

/** Read one dictionary's keys out of a file, between two section boundaries. */
function keysBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start !== -1, `missing section ${startMarker}`);
  const end = text.indexOf(endMarker, start);
  const body = text.slice(start, end === -1 ? undefined : end);
  return new Set([...body.matchAll(/'([^']+)':/g)].map((match) => match[1]));
}

const NODE_KINDS = listOf('NODE_KINDS');
const EDGE_KINDS = listOf('EDGE_KINDS');
const LIFECYCLE = listOf('LIFECYCLE');

test('the board vocabulary is the one the requirement names', () => {
  assert.deepEqual(NODE_KINDS, ['task', 'captain', 'unit', 'session', 'output']);
  assert.deepEqual(EDGE_KINDS, ['task', 'dispatch', 'dependency', 'question', 'review', 'output']);
  assert.deepEqual(LIFECYCLE, ['waiting', 'notStarted', 'running', 'completed', 'failed', 'unknown']);
});

test('every drawn vocabulary word can be named in both languages', () => {
  // The two dictionaries live in one file; the panel's embedded copy is asserted
  // identical by `test/locale.test.js`, so checking the source dictionary here is
  // enough — and it is what makes a missing translation a test failure rather than a
  // raw key rendered into a node box.
  const en = keysBetween(locales, 'export const en = {', 'export const zh = {');
  const zh = keysBetween(locales, 'export const zh = {', 'export const DICTIONARIES');
  const required = [
    ...NODE_KINDS.map((kind) => `board.node.${kind}`),
    ...LIFECYCLE.map((status) => `board.status.${status}`),
    ...EDGE_KINDS.map((kind) => `board.edge.${kind}`),
  ];
  for (const key of required) {
    assert.ok(en.has(key), `en is missing ${key}`);
    assert.ok(zh.has(key), `zh is missing ${key}`);
  }
});

test('the legend is built from the same lists the renderer draws', () => {
  // A legend written by hand drifts from the renderer. Both must read the constants.
  assert.match(client, /NODE_KINDS\.map\(nodeItem\)/);
  assert.match(client, /LIFECYCLE\.map\(statusItem\)/);
  assert.match(client, /EDGE_KINDS\.map\(edgeItem\)/);
  for (const group of ['board.legendNodes', 'board.legendStatus', 'board.legendEdges']) {
    assert.ok(client.includes(group), `the legend must group by ${group}`);
  }
});

test('the indented list it replaced is gone', () => {
  // The old board was one CSS spine with per-row elbows, which rendered every depth on
  // a single vertical line. Leaving any of it behind would draw two boards.
  assert.equal(client.includes('dshmo-spine'), false, 'the spine must be gone');
  assert.equal(client.includes('function DelegationNode'), false, 'the row renderer must be gone');
  assert.equal(client.includes('dshmo-nodecard'), false, 'the row card must be gone');
});

test('edges are routed, hit-testable, and animate while running', () => {
  // A wide transparent companion path is what makes a 2px wire clickable at all.
  assert.match(client, /dshmo-edge-hit[^}]*stroke-width:16/);
  assert.match(client, /className: 'dshmo-edge-hit'/);
  assert.match(client, /is-flow/);
  assert.match(client, /@keyframes dshmo-flow/);
  // Reduced-motion users get the same information without the animation.
  assert.match(client, /prefers-reduced-motion: reduce/);
});

test('nodes drag, and the edges follow the dragged position', () => {
  assert.match(client, /setPointerCapture/);
  // The offsets must be an input to the layout, not decoration on top of it.
  assert.match(client, /layoutGraph\(graph, offsets\)/);
});

test('a label cannot escape its node box', () => {
  assert.match(client, /overflow-wrap:\s*anywhere/);
  assert.match(client, /-webkit-line-clamp/);
});

test('waiting is distinct from not started, and names what it waits for', () => {
  assert.match(client, /waitingOn\.length > 0\) return \{ status: 'waiting', waitingOn \}/);
  assert.match(client, /board\.waitingFor/);
});

test('an unknown node is drawn as unknown, never as running', () => {
  assert.match(client, /'unknown'/);
  assert.match(client, /board\.status\.unknown/);
  assert.match(client, /board\.reasonUnknown/);
});

test('the output node waits until its inputs are settled', () => {
  assert.match(client, /outputStatus = 'waiting'/);
  assert.match(client, /board\.outputWaiting/);
});

test('the top bar reports the run numbers', () => {
  for (const key of [
    'board.statDelegated',
    'board.statCompleted',
    'board.statFailed',
    'board.statQuestions',
    'board.statReviews',
    'board.runElapsed',
  ]) {
    assert.ok(client.includes(key), `the top bar must report ${key}`);
  }
});

test('the panel lists every degraded and disabled subsystem, and the missing services', () => {
  // "The panel did not appear" and "the slash command is not registered" were log
  // lines only, so a whole missing surface looked like a plugin that did nothing.
  assert.match(client, /function HealthList\(/);
  assert.match(client, /health\.degradedOne/);
  assert.match(client, /health\.disabledOne/);
  assert.match(client, /health\.missingDeps/);
  // Rendered from the state document the host serves, not from a local guess.
  assert.match(client, /h\(HealthList, \{ health: state\.health, t \}\)/);
});

test('the slash command is described in the panel in its own language', () => {
  // The harness renders a third-party command's copy verbatim, so the plugin's own
  // localized statement of it is what actually follows a language change.
  assert.match(client, /function CommandCard\(/);
  assert.match(client, /h\(CommandCard, \{ t \}\)/);
  assert.match(client, /t\('command\.usage'\)/);
});

test('the board draws the run the VISIBLE session started, not a nested one', () => {
  // A unit that orchestrates its own sub-run begins after the run it belongs to, so
  // picking the newest journal entry outright would draw the sub-run's units and none
  // of the outer graph.
  assert.match(client, /const own = runs\.filter\(\(entry\) => entry\.sessionId !== undefined && entry\.sessionId === rootSession\)/);
  assert.match(client, /const run = own\.length > 0 \? own\[own\.length - 1\]/);
});

test('the panel reports the language it is rendering to the host', () => {
  // The last link in the language chain, and the one the host cannot reach any other
  // way: the harness resolves "explicit setting -> browser detection -> en" and never
  // writes the browser-derived value back. Asserted here because the wiring in the
  // bundle is what no host-side test can see.
  assert.match(client, /locale: '\/plugins\/dsh-model-orchestrator\/locale'/);
  assert.match(client, /function reportLocale\(/);
  assert.match(client, /locale\?\.getLocale\?\.\(\)\?\.active/);
  // Reported at mount, and again on every switch.
  assert.match(client, /reportLocale\(ctx\.locale\)/);
  assert.match(client, /ctx\.on\('locale\/change', \(\) => reportLocale\(ctx\.locale\)\)/);
});
