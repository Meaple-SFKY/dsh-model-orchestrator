/**
 * Which live route a stored intent means.
 *
 * The pool churns: models are added, renamed, moved behind another provider, and
 * bumped to a new version. A capability→model assignment therefore cannot be
 * stored against a route — it would rot silently — so it is stored against a
 * model **identity** and resolved against the live pool every time.
 *
 * Identity is deliberately mechanical. It has to answer exactly one question —
 * "is this still the same model" — and never "what is this model good at".
 * Expertise stays a declaration, because a model's strengths are public knowledge
 * that changes, and a table built into the plugin would be wrong within a
 * release. Collapsing spellings is the part that IS stable: `gpt5.6sol`,
 * `GPT 5.6 Sol`, `GPT-5.6 Sol (CC)` and `commandcode/gpt-5.6-sol` are one model
 * by any reasonable reading.
 *
 * Three properties earn their place here, each because the live pool actually
 * exercises it:
 *
 *  1. **Separators, case, and parenthetical vendor tags collapse.** A route id
 *     commonly carries a redundant vendor path segment its declared name does
 *     not (`commandcode` + id `deepseek/deepseek-v4.1-flash`, name
 *     `DeepSeek V4.1 Flash (CC)`), so a route answers to SEVERAL keys and any of
 *     them may be typed.
 *  2. **A version-less family key** lets one assignment survive a version bump
 *     (`gpt-5.6-sol` → `gpt-5.7-sol`), opt-in per assignment, because following
 *     a family is a judgement the user makes and not one to assume.
 *  3. **Every failure is reported.** An assignment that matches nothing is
 *     returned as unresolved, never dropped and never silently downgraded to the
 *     measured ranking without saying so.
 *
 * @module dsh-model-orchestrator/model-identity
 */

/**
 * Normalise one spelling of a model name to its identity key.
 *
 * @param text - a route, a model id, or a declared name.
 * @returns the key, or `''` when nothing usable remains.
 */
export function identityKey(text) {
  return String(text ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * The version-less family key: what two versions of one model share.
 *
 * `gpt-5.6-sol` and `gpt-5.7-sol` both reduce to `gptsol`. Digits are what a
 * model bumps when it ships a new version, so dropping them is what makes an
 * assignment survive one — at the cost of also matching a different model that
 * merely shares the word, which is why following a family is opt-in.
 *
 * @param text - a route, a model id, or a declared name.
 * @returns the family key.
 */
export function familyKey(text) {
  return identityKey(text).replace(/[0-9]+/g, '');
}

/**
 * Every key one live route answers to.
 *
 * A route is addressed by its own id, by that id with each leading vendor
 * segment dropped, and by its declared name — because the live pool's ids carry
 * vendor segments their names do not, so keying only the whole id would fail to
 * connect `deepseek/deepseek-v4.1-flash` with `DeepSeek V4.1 Flash (CC)`.
 *
 * @param model - `{ id?, model?, route?, name? }` as the pool reports it.
 * @returns a de-duplicated list of identity keys.
 */
export function candidateKeys(model) {
  const keys = new Set();
  const add = (value) => {
    const key = identityKey(value);
    if (key !== '') keys.add(key);
  };

  // `id` is the pool's own field; `model` is the same thing on a raw registry row.
  const id = String(model?.id ?? model?.model ?? '');
  add(id);
  const segments = id.split('/').filter((segment) => segment !== '');
  for (let drop = 1; drop < segments.length; drop += 1) {
    add(segments.slice(drop).join('/'));
  }

  // The declared name is the other half of the bridge, and it is also what a
  // person reads off the settings page when they type an assignment.
  add(model?.name);

  // A typed route must still match if it is spelled with different case.
  const route = String(model?.route ?? '');
  add(route);
  const routeSegments = route.split('/').filter((segment) => segment !== '');
  for (let drop = 1; drop < routeSegments.length; drop += 1) {
    add(routeSegments.slice(drop).join('/'));
  }

  return [...keys];
}

/** The family keys one route answers to; see {@link candidateKeys} for the why. */
export function candidateFamilies(model) {
  return [...new Set(candidateKeys(model).map((key) => key.replace(/[0-9]+/g, '')))];
}

/**
 * Resolve one assignment target against the live pool.
 *
 * Rungs, most precise first: an exact route, then a model identity, then — only
 * when the caller asked for it — a family. The first rung that matches decides,
 * and the rung is reported so a caller can show WHY a target resolved, which is
 * what makes a stale assignment diagnosable rather than mysterious.
 *
 * @param target - what the user wrote: a route, a model id, or a model name.
 * @param models - the live pool rows.
 * @param options - `{ family }` to allow the version-less rung.
 * @returns `{ kind, routes }`, or `undefined` when nothing matched.
 */
export function resolveAssignment(target, models, options = {}) {
  const wanted = String(target ?? '').trim();
  if (wanted === '') return undefined;
  const pool = Array.isArray(models) ? models : [];

  const exact = pool.find((model) => String(model?.route ?? '') === wanted);
  if (exact !== undefined) return { kind: 'route', routes: [String(exact.route)] };

  const key = identityKey(wanted);
  if (key !== '') {
    const byIdentity = pool.filter((model) => candidateKeys(model).includes(key));
    if (byIdentity.length > 0) {
      return { kind: 'identity', routes: byIdentity.map((model) => String(model.route)) };
    }
  }

  if (options.family === true) {
    const family = familyKey(wanted);
    if (family !== '') {
      const byFamily = pool.filter((model) => candidateFamilies(model).includes(family));
      if (byFamily.length > 0) {
        return { kind: 'family', routes: byFamily.map((model) => String(model.route)) };
      }
    }
  }

  return undefined;
}

/**
 * Resolve an ordered assignment list into an ordered route preference.
 *
 * The order is the user's: the first target that resolves is the first preferred
 * route. Several routes can come from one target (the same model behind two
 * providers) and all of them are kept, in pool order, because collapsing them
 * would discard a legitimate route — the deployments measured here differ in
 * output budget and billing between two providers of one model.
 *
 * @param targets - assignment targets, most preferred first.
 * @param models - the live pool rows.
 * @param options - `{ family }` to allow the version-less rung.
 * @returns `{ routes, resolved, unresolved }`.
 */
export function resolveAssignments(targets, models, options = {}) {
  const routes = [];
  const resolved = [];
  const unresolved = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    const text = String(target ?? '').trim();
    if (text === '') continue;
    const match = resolveAssignment(text, models, options);
    if (match === undefined) {
      unresolved.push(text);
      continue;
    }
    resolved.push({ target: text, kind: match.kind, routes: match.routes });
    for (const route of match.routes) if (!routes.includes(route)) routes.push(route);
  }
  return { routes, resolved, unresolved };
}
