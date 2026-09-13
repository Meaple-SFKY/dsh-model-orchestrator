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
  // Rediscover on activation and whenever the adapter topology changes. The pool
  // is never persisted, so a restart always re-reads reality.
  try {
    const result = await engine.refresh({});
    logger?.info?.(
      `${name}: discovered ${result.models.length} model(s) across ${
        pool.providers().length
      } provider(s)${result.problems.length === 0 ? '' : ` (${result.problems.length} provider problem(s))`}.`,
    );
  } catch (error) {
    // A discovery failure is not fatal: the tools report it and retry on demand.
    logger?.warn?.(`${name}: initial model discovery failed: ${String(error)}`);
  }

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
    },
    `${name}: abort in-flight delegation on teardown`,
  );
}
