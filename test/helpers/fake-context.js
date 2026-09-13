/**
 * Test doubles for the control-route installer.
 *
 * These reproduce the two host contracts the installer must satisfy, because a
 * lenient fake already hid a real boot failure once:
 *
 *  1. A plugin context is a Cordis proxy. Reading a name the composing plugin
 *     does not inject THROWS (`cannot get property "X" without inject`) rather
 *     than returning `undefined`. `strict: true` models that.
 *  2. The web server may not exist yet. `injectable: false` models a service that
 *     is still absent, so the inject callback must not run.
 *
 * @module test/helpers/fake-context
 */

/** A web-server stand-in recording its registrations. */
export function fakeServer() {
  const routes = new Map();
  const disposed = [];
  return {
    routes,
    disposed,
    register(route) {
      routes.set(route.path, route);
      return () => disposed.push(route.path);
    },
  };
}

/**
 * Build a context whose service resolution follows the host's rules.
 *
 * @param server - the web server to hand to an injected callback.
 * @param options - `{ injectable, services, strict }`.
 * @returns `{ ctx, injections }`.
 */
export function fakeContext(server, options = {}) {
  const injectable = options.injectable !== false;
  const services = options.services ?? {};
  const strict = options.strict === true;
  const injections = [];

  const build = (own) => {
    // The granted services must be readable as CONTEXT PROPERTIES, not only
    // through `get`: the host exposes an injected service as `ctx.webServer`, and
    // the installer reads it that way.
    const ctx = {
      ...own,
      get(name) {
        if (name in own) return own[name];
        if (name in services) return services[name];
        // The host throws for a name the composing plugin does not inject.
        if (strict) throw new Error(`cannot get property "${name}" without inject`);
        return undefined;
      },
      inject(names, callback) {
        injections.push([...names]);
        if (!injectable) return () => {};
        const granted = { ...own };
        for (const name of names) {
          if (name === 'webServer') granted.webServer = server;
          else if (name in services) granted[name] = services[name];
        }
        callback(build(granted));
        return () => {};
      },
      effect: (factory) => factory(),
    };
    return ctx;
  };

  return { ctx: build({ webServer: server }), injections };
}

/**
 * A request/response pair capturing the handler's decision.
 *
 * @param options - `{ method, headers, body, url }`.
 * @returns `{ req, res, captured }` where `captured` holds status, headers, body.
 */
export function exchange(options = {}) {
  const method = options.method ?? 'GET';
  const headers = options.headers ?? { host: '127.0.0.1:3080' };
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))];
  const req = {
    method,
    url: options.url ?? '/',
    headers,
    on(event, handler) {
      if (event === 'data') for (const chunk of chunks) handler(chunk);
      if (event === 'end') handler();
      return req;
    },
    off() {},
    once() {},
  };
  const captured = { status: undefined, headers: undefined, body: undefined };
  const res = {
    writeHead(status, responseHeaders) {
      captured.status = status;
      captured.headers = responseHeaders;
    },
    end(payload) {
      if (payload === undefined) return;
      try {
        captured.body = JSON.parse(payload);
      } catch {
        captured.body = payload;
      }
    },
  };
  return { req, res, captured };
}
