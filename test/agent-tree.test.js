/**
 * Delegation-graph tests.
 *
 * The board must show the topology the harness actually reports, and nothing
 * else. These tests pin that: an edge exists only where the listing gives a
 * durable parent, malformed rows cannot corrupt the tree, and a broken listing
 * cannot make the board hang or recurse forever.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentTree,
  flattenAgentTree,
  MAX_TREE_NODES,
  STALE_RUNNING_MS,
} from '../lib/agent-tree.js';

/** One well-formed child row. */
const child = (id, parentId, extra = {}) => ({
  kind: 'child',
  id,
  parentId,
  depth: extra.depth ?? 1,
  mode: extra.mode ?? 'one-shot',
  activity: extra.activity ?? 'inactive',
  hasChildren: extra.hasChildren ?? false,
  ...(extra.label === undefined ? {} : { label: extra.label }),
});

test('a flat listing becomes a parent/child tree', () => {
  const tree = buildAgentTree('root', [
    child('a', 'root', { label: 'research' }),
    child('b', 'root', { label: 'review' }),
    child('c', 'a', { label: 'sub-research', depth: 2 }),
  ]);
  assert.equal(tree.root, 'root');
  assert.equal(tree.counts.total, 3);
  assert.equal(tree.counts.roots, 2, 'two nodes hang directly off the root');
  assert.deepEqual(
    tree.nodes.map((node) => node.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    tree.nodes[0].children.map((node) => node.id),
    ['c'],
  );
  // Depth is recomputed from the assembled topology.
  assert.equal(tree.nodes[0].depth, 1);
  assert.equal(tree.nodes[0].children[0].depth, 2);
});

test('an entry whose parent is missing is re-attached to the root, not dropped', () => {
  const tree = buildAgentTree('root', [child('orphan', 'gone-session', { label: 'stranded' })]);
  assert.equal(tree.counts.total, 1, 'an orphan must still be visible');
  assert.equal(tree.nodes[0].id, 'orphan');
  assert.equal(tree.nodes[0].depth, 1);
});

test('a duplicate identity is listed once', () => {
  const tree = buildAgentTree('root', [child('a', 'root'), child('a', 'root')]);
  assert.equal(tree.counts.total, 1);
});

test('a cycle in the listing cannot recurse forever', () => {
  // a -> b -> a: malformed, but the builder must terminate.
  const tree = buildAgentTree('root', [
    child('a', 'root'),
    child('b', 'a'),
    child('a', 'b'),
  ]);
  assert.equal(tree.counts.total, 2);
  assert.ok(tree.nodes.length >= 1);
});

test('diagnostic rows are reported rather than silently ignored', () => {
  const tree = buildAgentTree('root', [
    child('a', 'root'),
    { kind: 'diagnostic', id: 'broken', reason: 'corrupt' },
  ]);
  assert.equal(tree.counts.total, 1);
  assert.deepEqual(tree.diagnostics, [{ id: 'broken', reason: 'corrupt' }]);
});

test('a malformed listing is tolerated', () => {
  for (const input of [undefined, null, 'nonsense', 42, [null, 'x', 7, {}]]) {
    const tree = buildAgentTree('root', input);
    assert.equal(tree.counts.total, 0);
    assert.deepEqual(tree.nodes, []);
  }
});

test('activity and mode are surfaced for the board', () => {
  const tree = buildAgentTree('root', [
    child('live', 'root', { activity: 'running', mode: 'continuable' }),
    child('cold', 'root'),
  ]);
  assert.equal(tree.counts.running, 1);
  assert.equal(tree.counts.continuable, 1);
  assert.equal(tree.nodes[0].activity, 'running');
  assert.equal(tree.nodes[0].mode, 'continuable');
  assert.equal(tree.nodes[1].activity, 'inactive');
  assert.equal(tree.nodes[1].mode, 'one-shot');
});

test('a node with children is marked even when the listing disagrees', () => {
  // The listing says `hasChildren: false`, but the assembled tree shows a child:
  // the assembled topology wins, because that is what the board draws.
  const tree = buildAgentTree('root', [
    child('parent', 'root', { hasChildren: false }),
    child('kid', 'parent', { depth: 2 }),
  ]);
  assert.equal(tree.nodes[0].hasChildren, true);
});

test('the node count is bounded', () => {
  const many = [];
  for (let index = 0; index < MAX_TREE_NODES + 50; index += 1) {
    many.push(child(`n${index}`, 'root'));
  }
  const tree = buildAgentTree('root', many);
  assert.equal(tree.counts.total, MAX_TREE_NODES);
  assert.equal(tree.truncated, true);
});

test('flattening yields visual order with an explicit depth and connector state', () => {
  const tree = buildAgentTree('root', [
    child('a', 'root', { label: 'A' }),
    child('a1', 'a', { label: 'A1', depth: 2 }),
    child('a2', 'a', { label: 'A2', depth: 2 }),
    child('b', 'root', { label: 'B' }),
  ]);
  const rows = flattenAgentTree(tree.nodes);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['a', 'a1', 'a2', 'b'],
    'pre-order: a subtree before the next sibling',
  );
  assert.deepEqual(
    rows.map((row) => row.depth),
    [1, 2, 2, 1],
  );
  // Connect-ahead flags: a1 has a following sibling, a2 does not.
  assert.equal(rows[1].isLast, false);
  assert.equal(rows[2].isLast, true);
  assert.equal(rows[0].isLast, false, 'a has a following sibling');
  assert.equal(rows[3].isLast, true);
  assert.deepEqual(rows[2].parentIsLast, [false], 'inherits the parent branch state');
});

test('no label, mode, or vendor name is invented anywhere in the tree', () => {
  const tree = buildAgentTree('root', [child('x', 'root')]);
  const node = tree.nodes[0];
  assert.equal(node.label, undefined, 'a listing without a label must not be given one');
  assert.equal(node.mode, 'one-shot');
  const serialized = JSON.stringify(tree).toLowerCase();
  for (const forbidden of ['deepseek', 'gpt-', 'claude', 'provider']) {
    assert.ok(!serialized.includes(forbidden), `the tree must not carry "${forbidden}"`);
  }
});

// ---- lifecycle truth: a record that outlives its work -----------------------

test('a unit the orchestrator finished reports its real terminal state', () => {
  // The durable listing reports whether a session RECORD is resident, not whether an
  // agent is running it, so a finished child kept showing as running.
  const known = new Map([['finished', 'completed'], ['bad', 'failed']]);
  const tree = buildAgentTree(
    'root',
    [child('finished', 'root', { activity: 'running' }), child('bad', 'root', { activity: 'running' })],
    { knownStatuses: known, now: 1_000 },
  );
  assert.equal(tree.nodes[0].activity, 'completed');
  assert.match(tree.nodes[0].activityReason, /finished this unit/);
  assert.equal(tree.nodes[1].activity, 'failed');
  assert.equal(tree.counts.completed, 1);
  assert.equal(tree.counts.failed, 1);
  assert.equal(tree.counts.running, 0);
});

test('a record that has claimed to be running for too long becomes unknown', () => {
  // The requirement: an old session the host no longer runs must not show "running"
  // forever. A run this plugin still owns is tracked in the journal and reported from
  // there; anything else falls back to "unknown", which is visibly not "working".
  const seenRunning = new Map();
  const entries = [child('stale', 'root', { activity: 'running' })];
  const first = buildAgentTree('root', entries, { seenRunning, now: 0 });
  assert.equal(first.nodes[0].activity, 'running', 'a fresh claim is credible');

  const later = buildAgentTree('root', entries, { seenRunning, now: STALE_RUNNING_MS + 1 });
  assert.equal(later.nodes[0].activity, 'unknown');
  assert.match(later.nodes[0].activityReason, /resident record/);
  assert.equal(later.counts.unknown, 1);
  assert.equal(later.counts.running, 0);
});

test('a session that stops claiming to run is not remembered as stale', () => {
  const seenRunning = new Map();
  buildAgentTree('root', [child('flip', 'root', { activity: 'running' })], { seenRunning, now: 0 });
  // It goes inactive, then runs again much later: the second run is a NEW claim and
  // must not inherit the first one's age.
  buildAgentTree('root', [child('flip', 'root', { activity: 'inactive' })], { seenRunning, now: 10 });
  const again = buildAgentTree('root', [child('flip', 'root', { activity: 'running' })], {
    seenRunning,
    now: 20,
  });
  assert.equal(again.nodes[0].activity, 'running');
});

test('a running orchestration unit is reported as running from the journal', () => {
  const tree = buildAgentTree('root', [child('live', 'root', { activity: 'inactive' })], {
    knownStatuses: new Map([['live', 'running']]),
    now: 0,
  });
  assert.equal(tree.nodes[0].activity, 'running');
  assert.match(tree.nodes[0].activityReason, /orchestration run/);
});
