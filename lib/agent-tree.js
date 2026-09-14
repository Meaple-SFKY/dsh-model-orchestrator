/**
 * Subagent relationship tree for the Orchestrator board.
 *
 * The board answers "which parts of this task did the orchestrator delegate,
 * and how are they related" — using only harness-native sources. The topology
 * comes from `ctx.subagents.listDescendants(rootSessionId)`, which enumerates
 * the durable session tree; this module turns that flat, pre-ordered list into a
 * parent/child tree and derives the display facts.
 *
 * It owns no state, reads no session log text, and invents no relationship: an
 * edge exists only where the harness reports a durable `parentId`.
 *
 * @module dsh-model-orchestrator/agent-tree
 */
import { str, uint } from './util.js';

/** Upper bound on nodes returned, so a pathological tree cannot flood the panel. */
export const MAX_TREE_NODES = 200;

/**
 * How long a durable record may keep claiming `running` before the board says it does
 * not know.
 *
 * The harness's listing reports whether a session's record is RESIDENT, which is not
 * the same as an agent running it: a child whose driver is gone can leave a resident
 * record behind, and the board then showed "running" for it forever. A run this plugin
 * still owns is tracked in the journal and reports its real terminal state from there;
 * for everything else (a native delegation, a session from an earlier host), a
 * continuously observed `running` beyond this window becomes `unknown` — which is the
 * honest answer, and is visibly different from "still working".
 */
export const STALE_RUNNING_MS = 30 * 60 * 1000;

/**
 * Build the tree one root session produced.
 *
 * @param rootSessionId - the session whose descendants to include.
 * @param entries - the flat listing from `listDescendants`.
 * @returns `{ root, nodes, truncated, counts }` as plain data.
 */
export function buildAgentTree(rootSessionId, entries, options = {}) {
  const root = str(rootSessionId) ?? '';
  const list = Array.isArray(entries) ? entries : [];
  // The plugin's own knowledge of what it ran: `childId -> 'running'|'completed'|'failed'`.
  // It outranks the durable record, which can outlive the work it describes.
  const known = options.knownStatuses instanceof Map ? options.knownStatuses : new Map();
  const now = Number.isSafeInteger(options.now) ? options.now : Date.now();
  const staleAfterMs = Number.isSafeInteger(options.staleAfterMs) ? options.staleAfterMs : STALE_RUNNING_MS;
  // First observation of a `running` claim, per session. Held by the caller so it
  // survives across polls; without it there is no way to tell a fresh run from a
  // record that has been claiming to run since before the board was opened.
  const seenRunning = options.seenRunning instanceof Map ? options.seenRunning : new Map();

  // Only well-formed child rows participate; a diagnostic row carries no
  // topology and is surfaced separately rather than dropped silently.
  const children = [];
  const diagnostics = [];
  const seen = new Set();
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.kind !== 'child') {
      diagnostics.push({
        id: String(entry.id ?? ''),
        reason: str(entry.reason) ?? 'unsupported',
      });
      continue;
    }
    const id = str(entry.id);
    const parentId = str(entry.parentId);
    if (id === undefined || parentId === undefined) continue;
    // A duplicated identity would otherwise produce a second node and a
    // duplicate subtree; the harness orders by creation, so keep the first.
    if (seen.has(id)) continue;
    seen.add(id);
    const reported = entry.activity === 'running' ? 'running' : 'inactive';
    let activity = reported;
    let activityReason;
    const settled = known.get(id);
    if (settled === 'completed' || settled === 'failed') {
      // The plugin ran this unit and knows how it ended. The durable record lagging
      // behind is exactly how a finished child kept showing as running.
      activity = settled;
      activityReason = 'the orchestrator finished this unit';
    } else if (settled === 'running') {
      activity = 'running';
      activityReason = 'an orchestration run of this process is executing it';
    } else if (reported === 'running') {
      const firstSeen = seenRunning.get(id);
      if (firstSeen === undefined) {
        seenRunning.set(id, now);
      } else if (now - firstSeen > staleAfterMs) {
        activity = 'unknown';
        activityReason = 'the harness reports a resident record, not a live agent';
      }
    } else {
      seenRunning.delete(id);
    }
    children.push({
      id,
      parentId,
      depth: uint(entry.depth) ?? 0,
      mode: entry.mode === 'continuable' ? 'continuable' : 'one-shot',
      activity,
      ...(activityReason === undefined ? {} : { activityReason }),
      hasChildren: entry.hasChildren === true,
      label: str(entry.label),
    });
  }

  // An entry whose parent is outside the listing would be orphaned; re-attach it
  // to the root so it is still visible instead of disappearing from the board.
  const byParent = new Map();
  for (const child of children) {
    const known = child.parentId === root || seen.has(child.parentId);
    const parentId = known ? child.parentId : root;
    const bucket = byParent.get(parentId);
    if (bucket === undefined) byParent.set(parentId, [child]);
    else bucket.push(child);
  }

  let truncated = false;
  let emitted = 0;

  /**
   * Depth-first assembly with an explicit visited set, so a malformed cycle in
   * the listing can never recurse forever.
   */
  const build = (parentId, depth, visited) => {
    const bucket = byParent.get(parentId) ?? [];
    const out = [];
    for (const child of bucket) {
      if (emitted >= MAX_TREE_NODES) {
        truncated = true;
        break;
      }
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      emitted += 1;
      const descendants = build(child.id, depth + 1, visited);
      out.push({
        id: child.id,
        label: child.label,
        mode: child.mode,
        activity: child.activity,
        ...(child.activityReason === undefined ? {} : { activityReason: child.activityReason }),
        // `depth` is recomputed from the assembled topology rather than trusted
        // from the listing, so a repaired orphan still reports a sane depth.
        depth,
        hasChildren: child.hasChildren || descendants.length > 0,
        children: descendants,
      });
    }
    return out;
  };

  const tree = build(root, 1, new Set());

  let running = 0;
  let continuable = 0;
  let completed = 0;
  let failed = 0;
  let unknown = 0;
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.activity === 'running') running += 1;
      else if (node.activity === 'completed') completed += 1;
      else if (node.activity === 'failed') failed += 1;
      else if (node.activity === 'unknown') unknown += 1;
      if (node.mode === 'continuable') continuable += 1;
      walk(node.children);
    }
  };
  walk(tree);

  return {
    root,
    nodes: tree,
    diagnostics,
    truncated,
    counts: { total: emitted, running, continuable, completed, failed, unknown, roots: tree.length },
  };
}

/**
 * Flatten a tree back to display rows in visual order.
 *
 * The client draws a simple vertical graph, so it needs pre-order rows with an
 * explicit depth rather than a nested structure.
 *
 * @param nodes - nodes from {@link buildAgentTree}.
 * @returns rows of `{ id, label, mode, activity, depth, isLast, hasChildren }`.
 */
export function flattenAgentTree(nodes) {
  const rows = [];
  let ordinal = 0;
  const walk = (list, depth, parentIsLast) => {
    list.forEach((node, index) => {
      const isLast = index === list.length - 1;
      ordinal += 1;
      rows.push({
        id: node.id,
        label: node.label,
        mode: node.mode,
        activity: node.activity,
        ...(node.activityReason === undefined ? {} : { activityReason: node.activityReason }),
        depth,
        isLast,
        hasChildren: node.hasChildren,
        parentIsLast,
        // Position in the creation-ordered listing, so the board can number the
        // delegations and draw a spine without inventing timestamps the harness
        // does not report.
        ordinal,
      });
      if (node.children.length > 0) walk(node.children, depth + 1, [...parentIsLast, isLast]);
    });
  };
  walk(Array.isArray(nodes) ? nodes : [], 1, []);
  return rows;
}
