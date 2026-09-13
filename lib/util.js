/**
 * Small, dependency-free helpers shared by the orchestrator modules.
 *
 * Everything here operates on plain values only. The orchestrator never
 * serializes, clones, or enumerates host objects (Cordis contexts, Agents,
 * Services); it reads leaf fields and builds its own plain data.
 *
 * @module dsh-model-orchestrator/util
 */

/** Whether `value` is a non-null, non-array object. */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A trimmed string, or `undefined` when the input is not a usable string. */
export function str(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * A non-negative safe integer, or `undefined`.
 *
 * Zero is a valid value, so the check is `>= 0` rather than truthiness. A
 * negative or non-integer input yields `undefined`, which lets a caller
 * distinguish "not supplied" from "supplied as zero" — and lets a validator
 * clamp a negative rather than silently substituting a default.
 */
export function uint(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Clamp `value` into `[min, max]`. */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** A unique, order-preserving dedupe of a string array. */
export function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = str(value);
    if (text === undefined || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Tokenize free text into lowercase word stems for keyword evidence.
 *
 * Deliberately ASCII-plus-CJK-safe: CJK runs become individual single-character
 * tokens so a Chinese-language task still matches descriptors whose keywords
 * carry CJK terms, while Latin words are split on non-alphanumerics.
 *
 * @param text - arbitrary text.
 * @returns lowercase tokens.
 */
export function tokenize(text) {
  const tokens = [];
  let latin = '';
  const flush = () => {
    if (latin.length >= 2) tokens.push(latin);
    latin = '';
  };
  for (const char of String(text ?? '').toLowerCase()) {
    if (char >= 'a' && char <= 'z') {
      latin += char;
      continue;
    }
    if (char >= '0' && char <= '9') {
      latin += char;
      continue;
    }
    flush();
    if (char.charCodeAt(0) > 0x2e80) tokens.push(char);
  }
  flush();
  return tokens;
}

/** A stable, short, collision-resistant hash of a string (FNV-1a, base36). */
export function stableHash(text) {
  let hash = 0x811c9dc5;
  const input = String(text ?? '');
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** A lowercase `provider/model` route key, or `undefined` when incomplete. */
export function routeKey(provider, model) {
  const p = str(provider);
  const m = str(model);
  return p === undefined || m === undefined ? undefined : `${p}/${m}`;
}

/** Compact a route label to its model segment (`a/b/c` → `b/c`). */
export function compactRoute(route) {
  const text = String(route ?? '');
  const slash = text.indexOf('/');
  return slash === -1 ? text : text.slice(slash + 1);
}

/** Flatten one content-block array into its text, ignoring non-text blocks. */
export function contentToText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** Truncate `text` to `max` characters with an ellipsis marker. */
export function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Separator between a delegation's human name and the route it ran on.
 *
 * A child's label is the *only* durable record of its route: the host's
 * descendant listing (`ctx.subagents.listDescendants`) reports a child's `mode`
 * and `label` and nothing at all about its provider or model. Every delegation
 * path must therefore write the same shape, and the client board recovers the
 * route by splitting on this exact marker.
 */
export const DELEGATION_LABEL_MARKER = ' via ';

/** Longest child label the harness-facing spawn path accepts. */
const DELEGATION_LABEL_LIMIT = 120;

/**
 * Build the durable label for one delegation.
 *
 * The name is bounded *before* the route is appended, because the spawn path
 * truncates the tail: a cut there would erase exactly the fact the board needs
 * in order to show which model a delegation went to.
 *
 * @param base - human name for the unit; a compact route is used when absent.
 * @param route - the exact `provider/model` route the child runs on.
 * @returns the label to hand to `ctx.subagents.start`.
 */
export function delegationLabel(base, route) {
  const name = str(base) ?? compactRoute(route);
  // The ROUTE is bounded too, and before the name is measured. Leaving it
  // unbounded meant a route of the limit's own length left no room for the name,
  // the composed label exceeded the limit, and the spawn path's own truncation cut
  // the tail — destroying exactly the fact the label exists to carry. The reserve
  // keeps the marker plus whichever of the two is shorter.
  const bounded = truncate(String(route ?? ''), DELEGATION_LABEL_LIMIT - 20);
  const suffix = `${DELEGATION_LABEL_MARKER}${bounded}`;
  const room = Math.max(1, DELEGATION_LABEL_LIMIT - suffix.length);
  return `${truncate(name, room)}${suffix}`;
}

/** Wrap `[type:'text']` content around a plain string. */
export function textContent(text) {
  return [{ type: 'text', text: String(text ?? '') }];
}

/**
 * Project a value onto plain, lossless JSON.
 *
 * The host validates a tool's canonical output with a strict lossless-JSON
 * check: an `undefined` property, a function, a symbol, or a non-finite number
 * rejects the whole call. Values this plugin builds are plain data, but an
 * optional field that is simply absent at runtime can still arrive as
 * `undefined`, so every tool result is passed through here at the boundary.
 *
 * Rules: `undefined` and functions are dropped from objects and become `null`
 * inside arrays; non-finite numbers become `null`; everything else is copied.
 * Cycles are broken by dropping the repeated reference, so a malformed value can
 * never hang the projection.
 *
 * @param value - the value to project.
 * @param seen - internal cycle guard.
 * @returns a lossless-JSON value.
 */
export function toJsonSafe(value, seen = new WeakSet()) {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return value;
  if (kind === 'number') return Number.isFinite(value) ? value : null;
  if (kind === 'bigint') return Number.isFinite(Number(value)) ? Number(value) : null;
  if (kind === 'undefined' || kind === 'function' || kind === 'symbol') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => {
        const projected = toJsonSafe(entry, seen);
        return projected === undefined ? null : projected;
      });
    }
    if (value instanceof Date) return value.toISOString();
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const projected = toJsonSafe(entry, seen);
      // A dropped key is exactly what "absent" means to the host validator.
      if (projected !== undefined) out[key] = projected;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** The shared JSON output definition every orchestrator tool uses. */
export function jsonOutput() {
  return Object.freeze({
    schema: { type: 'json' },
    render: (_args, value) => textContent(JSON.stringify(value, null, 2)),
  });
}
