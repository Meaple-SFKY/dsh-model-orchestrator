/**
 * dsh-model-orchestrator — a generic Model Orchestrator for the DeepSeek Harness.
 *
 * What it does: discovers the models the running harness actually has, works out
 * what each one is evidenced to be good at, and routes each unit of work to the
 * best available model — automatically in Auto mode, or against user-selected
 * capability areas in Guided mode. Simple work runs directly, focused work goes
 * to one specialist subagent, and complex multi-domain work is orchestrated
 * across several, with every expert result returned to the calling agent, which
 * remains the owner of the final answer.
 *
 * What it deliberately is not: it names no model, provider, or vendor anywhere in
 * its selection logic, it holds no model→domain table, and it is not specific to
 * any business domain. The capability taxonomy is open and can grow at runtime.
 *
 * Lifecycle: the plugin is host-plane and publishes no service, so it needs no
 * isolate realm. Before anything is registered it proves the host is compatible
 * and refuses to activate otherwise.
 *
 * @module dsh-model-orchestrator
 */
import { assertCompatible } from './compatibility.js';
import { ModelPool } from './discovery.js';
import { Orchestrator } from './engine.js';
import { OrchestratorStore, stateDirectory } from './persistence.js';
import { Taxonomy } from './taxonomy.js';
import { TOOL_NAMES, registerOrchestratorTools, toolNameList } from './tools.js';
import { usageSectionText } from './prompt.js';
import { resolveDshHome } from './home.js';
import { installControlRoutesDeferred } from './routes.js';
import { installCommandDeferred } from './commands.js';
import { createWebResearch } from './web-research.js';
import { createSyncRunner } from './sync.js';
import { chooseRoute } from './matching.js';
import { resolveAssignments } from './assignments.js';
import { researchFor } from './model-research.js';

/** Plugin name, matching the package name. */
export const name = 'dsh-model-orchestrator';

/**
 * Hard service dependencies. Every one is validated at activation by
 * {@link assertCompatible}, which turns a missing service into a clear refusal
 * rather than an obscure runtime error later.
 */
export const inject = ['llm', 'subagents', 'tools', 'systemPrompt'];

/** No configuration schema: every knob is a runtime preference the user can change. */
export const Config = undefined;

/**
 * Prompt section placement. Chosen above the shipped mid-range sections so the
 * orchestrator's routing policy is read before task-specific guidance.
 */
export const PROMPT_SECTION_ORDER = 118;

/**
 * Activate the orchestrator.
 *
 * @param ctx - the Cordis plugin context.
 */
export async function apply(ctx) {
  const logger = ctx.logger;

  // ---- gate ---------------------------------------------------------------
  // Nothing below this line runs against an unsupported host: no tool, no prompt
  // section, no route, no timer.
  const host = await assertCompatible(ctx, logger);

  if (host.optionalMissing.includes('workflowEngine')) {
    logger?.info?.(
      `${name}: the workflow engine is not mounted; wide fan-out runs will use direct specialist dispatch instead.`,
    );
  }

  // ---- state --------------------------------------------------------------
  const directory = stateDirectory(resolveDshHome(ctx));
  const store = new OrchestratorStore(directory);
  if (store.writeError !== undefined) {
    logger?.warn?.(`${name}: ${store.writeError}`);
  }

  const taxonomy = new Taxonomy();
  const persisted = store.snapshot();
  const restored = taxonomy.restore(persisted.taxonomy.custom);
  if (restored > 0) {
    logger?.info?.(`${name}: restored ${restored} learned capability descriptor(s).`);
  }

  const pool = new ModelPool(persisted.profiles);
  const engine = new Orchestrator({ ctx, pool, taxonomy, store, logger });

  // ---- live pool ----------------------------------------------------------
  // Discovery is kicked off but NOT awaited. A provider's model listing can be a
  // real network round trip (the bundled third-party provider refetches its
  // catalog over HTTP on every call, with a 10s timeout and only a failure
  // fallback to disk), so awaiting it here delayed the whole profile boot —
  // measurably slower page load for every plug-in of this deployment.
  //
  // Nothing depends on the pool being warm at activation: the tools refresh on
  // demand, the routes serve what they have, and `llm/adapters-updated` triggers
  // a fresh read. So the work starts now and reports when it lands.
  const warmPool = engine
    .refresh({})
    .then((result) => {
      logger?.info?.(
        `${name}: discovered ${result.models.length} usable model(s) across ${
          pool.providers().length
        } provider(s)${result.problems.length === 0 ? '' : ` (${result.problems.length} problem(s))`}.`,
      );
      return result;
    })
    .catch((error) => {
      // A discovery failure is not fatal: the tools report it and retry on demand.
      logger?.warn?.(`${name}: initial model discovery failed: ${String(error)}`);
      return undefined;
    });

  ctx.effect(
    () =>
      ctx.on('llm/adapters-updated', () => {
        void engine
          .refresh({})
          .then((result) => {
            logger?.info?.(
              `${name}: model pool refreshed after an adapter change: ${result.models.length} model(s).`,
            );
          })
          .catch((error) => {
            logger?.warn?.(`${name}: pool refresh after an adapter change failed: ${String(error)}`);
          });
      }),
    `${name}: model pool follows the adapter topology`,
  );

  // ---- tools --------------------------------------------------------------
  const tools = registerOrchestratorTools(ctx, {
    engine,
    pool,
    taxonomy,
    store,
    logger,
  });
  logger?.info?.(`${name}: registered ${tools.length} tool(s): ${tools.join(', ')}`);

  // ---- prompt -------------------------------------------------------------
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: `${name}:routing-policy`,
        order: PROMPT_SECTION_ORDER,
        text: usageSectionText({
          toolNames: toolNameList(),
          mode: () => store.snapshot().mode,
          poolSize: () => pool.models().length,
        }),
      }),
    `${name}: routing policy prompt section`,
  );

  // ---- optional web research ------------------------------------------------
  // Public prices and public model identities, researched when a person presses
  // Sync. This is the ONE place the plugin reaches the network, and it is
  // deliberately not automatic: activation and polling stay free of it (see the
  // performance rules in the README), and the researcher is a normal subagent that
  // uses the harness's own web tools, so the plugin makes no HTTP requests itself.
  //
  // `resolveResearch` is injected rather than imported so `lib/sync.js` needs no
  // host seam and stays testable, and so the seam can change without touching the
  // pass, the validation or the storage.
  // `web` is resolved through `ctx.inject` like `webServer`: it is optional, it is
  // frequently mounted after this plugin activates, and reading an uninjected name
  // off a Cordis context throws rather than returning undefined.
  let webService;
  const webInjected = ctx.inject(['web'], (webCtx) => {
    webService = webCtx.web;
    return undefined;
  });

  const sync = createSyncRunner({
    pool,
    store,
    logger,
    runResearch: createWebResearch({
      ctx,
      pool,
      taxonomy,
      store,
      logger,
      chooseRoute,
      web: () => webService,
    }),
  });

  // ---- control surface ----------------------------------------------------
  // The browser half cannot enumerate models (the LLM listing surface is
  // host-only), so the panel talks to these host routes. Mounting waits for the
  // web server service, which is frequently registered after this activation;
  // `installControlRoutesDeferred` owns that wait and returns its own disposer,
  // so it is installed directly rather than inside an `ctx.effect` (which would
  // confine the service wait to the effect's scope).
  const disposeRoutes = installControlRoutesDeferred(ctx, {
    engine,
    pool,
    taxonomy,
    store,
    logger,
    host,
    sync,
    // Handed over so `/state` can await the FIRST read instead of painting an empty
    // pool. It was built here and never passed, so the branch that waits for it was
    // dead and the comment above it — and the README — described a wait that never
    // happened.
    firstDiscovery: warmPool,
  });

  // ---- human command --------------------------------------------------------
  // `/model-orchestrator <task>` is the explicit switch for the case the routing
  // policy cannot force: the calling model deciding to delegate on its own. Its
  // handler runs WITHOUT the command line reaching the model, so it delivers the
  // task itself as an ordinary user message (see `lib/commands.js`). The registry
  // is optional and frequently mounted late, which `installCommandDeferred` owns.
  const disposeCommand = installCommandDeferred(ctx, {
    logger,
    state: () => {
      const snapshot = store.snapshot();
      // Resolved here because it is resolved against the LIVE pool: what the table
      // means right now is the useful answer, not what was written.
      const assignments = resolveAssignments(
        snapshot.preferences.capabilityAssignments,
        pool.models(),
      );
      const researched = pool.models().filter((model) => researchFor(snapshot.research, model) !== undefined);
      return {
        mode: snapshot.mode,
        poolSize: pool.models().length,
        capabilityCount: taxonomy.list().length,
        // Routing capacity only. Task and progress reporting belong to DSH.
        inFlight: engine.inFlightCount,
        assignments: {
          count: assignments.count,
          unresolved: assignments.unresolved,
          unassigned: assignments.unassigned,
        },
        ...(researched.length === 0
          ? {}
          : {
              researchedCount: researched.length,
              researchUnmatched: researched.filter(
                (model) => researchFor(snapshot.research, model)?.matched !== true,
              ).length,
            }),
      };
    },
  });

  // ---- teardown -----------------------------------------------------------
  // Abort any delegated child still in flight so a plugin reload cannot orphan
  // one. This is the only piece of live orchestration bookkeeping the plugin
  // keeps, and it is never exposed as task state.
  ctx.effect(
    () => () => {
      const aborted = engine.abortAll(`${name} disposed`);
      if (aborted > 0) {
        logger?.info?.(`${name}: aborted ${aborted} in-flight delegation(s) on teardown.`);
      }
      disposeRoutes();
      disposeCommand();
      sync.cancel();
      try {
        webInjected?.();
      } catch {
        // Injection teardown is owned by the Fiber.
      }
    },
    `${name}: abort in-flight delegation on teardown`,
  );
}
