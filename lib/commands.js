/**
 * The `/model-orchestrator` human command.
 *
 * Why a command exists at all: the routing policy in the system prompt tells the
 * calling model to route work rather than spawn subagents itself, but nothing
 * forces it — and a live session was observed delegating four heterogeneous
 * research units through the native `subagent` tool, so every child inherited the
 * deployment's single default model. The command is the explicit switch: when the
 * user says "this one goes through the orchestrator", that intent arrives as an
 * ordinary user message, which a model follows far more reliably than a standing
 * policy section.
 *
 * Two verified host contracts shape this file:
 *
 *  1. A command handler runs **without sending the command line to the model**
 *     (`CommandDefinition.handler`, `@deepseek-ai/dsh-commands`), so
 *     `/model-orchestrator <task>` is not a prompt prefix. The handler must
 *     deliver the task itself, and does so with `agent.followup(message)` — "queue
 *     an ordinary follow-up turn and wake the driver", the same mechanism the
 *     shipped `/goal` command uses for its objective attachments.
 *  2. `commands` is an OPTIONAL host service. It is resolved through `ctx.inject`,
 *     never by reading `ctx.commands` — a Cordis plugin context throws on a name
 *     it does not inject, and `a ?? ctx.get(x)` is not a safe probe either because
 *     `??` evaluates its right side even when the left threw. Its absence must
 *     leave every other part of the plugin working.
 *
 * This module imports nothing from the host at load time: the message factory is
 * injected, and falls back to a lazy import only inside a running harness. That
 * keeps it loadable — and therefore testable — without a DSH installation.
 *
 * @module dsh-model-orchestrator/commands
 */
import { truncate } from './util.js';

/** Registered command name, without the leading slash. */
export const COMMAND_NAME = 'model-orchestrator';

/** The one sub-command. Anything else is a task. */
export const STATUS_WORD = 'status';

/** Shown when the command is invoked with no task and no sub-command. */
export const USAGE =
  'Usage: /model-orchestrator <task> — route one task through the orchestrator.\n' +
  '/model-orchestrator status — show the current routing state.';

/**
 * Split the text following the command name.
 *
 * The name itself is already parsed by the host (`parseCommand` lower-cases it and
 * leaves `rawInput` verbatim). Only `status` is treated specially, and only when it
 * stands alone, so a task whose first word happens to be "status" is still a task as
 * long as it continues.
 *
 * @param rawInput - verbatim text following the command name.
 * @returns `{kind:'empty'}` | `{kind:'status'}` | `{kind:'task', task}`.
 */
export function parseCommandInput(rawInput) {
  const text = String(rawInput ?? '').trim();
  if (text === '') return { kind: 'empty' };
  if (text.toLowerCase() === STATUS_WORD) return { kind: 'status' };
  return { kind: 'task', task: text };
}

/**
 * The instruction delivered with the task.
 *
 * Model-facing on purpose: the repository keeps strings a model reads in English,
 * and the captain — not the user — reads this one.
 *
 * @param task - the user's task, verbatim.
 * @returns the message text.
 */
export function directiveText(task) {
  return [
    'Route this task through the Model Orchestrator.',
    '',
    'Call `orchestrate_run` with the task below. Do not delegate it with the native',
    "`subagent` tool: a child spawned without an explicit route inherits the deployment's",
    'single default model, so units that differ in kind would all run on one model.',
    '',
    'When the units differ in the kind of work they need, name the routes you judge best',
    'per unit in `analysis.unitModelPreference` (read the live routes with',
    '`orchestrate_models` first). You own the final answer: synthesize the specialist',
    'results yourself rather than forwarding them.',
    '',
    'Task:',
    String(task ?? ''),
  ].join('\n');
}

/**
 * One line of live routing state, for `/model-orchestrator status`.
 *
 * Routing capacity only — never task or progress state, which belongs to DSH.
 *
 * @param state - `{ mode, poolSize, capabilityCount, inFlight }`.
 * @returns the rendered line.
 */
export function statusText(state) {
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return [
    `Model Orchestrator — mode ${String(state?.mode ?? 'auto')}`,
    `${count(state?.poolSize)} model(s)`,
    `${count(state?.capabilityCount)} capabilit(ies)`,
    `${count(state?.inFlight)} delegation(s) in flight`,
  ].join(' · ');
}

/**
 * Register the command once the harness publishes its command registry.
 *
 * Mirrors `installControlRoutesDeferred`: resolution is deferred because the
 * registry is frequently mounted after this plugin activates, and the returned
 * disposer removes both the registration and the pending service wait.
 *
 * @param ctx - the Cordis plugin context.
 * @param deps - `{ state, createUserMessage?, logger }`.
 * @returns a disposer that unregisters the command.
 */
export function installCommandDeferred(ctx, deps) {
  let dispose = () => {};

  const injected = ctx.inject(['commands'], (commandCtx) => {
    dispose = installCommandOn(commandCtx.commands, deps) ?? (() => {});
    deps?.logger?.info?.(`/${COMMAND_NAME} registered.`);
    return undefined;
  });

  return () => {
    try {
      injected?.();
    } catch {
      // Injection teardown is owned by the Fiber.
    }
    dispose();
  };
}

/**
 * Register the command on one resolved registry.
 *
 * @param commands - the resolved `commands` service.
 * @param deps - the orchestrator dependencies.
 * @returns the registry's own disposer, or a no-op when the service is unusable.
 */
function installCommandOn(commands, deps) {
  if (commands === undefined || typeof commands.register !== 'function') return () => {};

  return commands.register({
    name: COMMAND_NAME,
    description: 'route one task through the Model Orchestrator instead of delegating it yourself',
    input: { hint: '[<task> | status]' },
    // The follow-up message carries the task verbatim and is the authoritative
    // copy of it, so recording `rawInput` as well would duplicate it in the log.
    recordInput: false,
    handler: (invocation) => runCommand(invocation, deps),
  });
}

/**
 * Execute one invocation.
 *
 * @param invocation - the host's invocation record.
 * @param deps - the orchestrator dependencies.
 * @returns the command outcome the dispatching UI renders.
 */
async function runCommand(invocation, deps) {
  const parsed = parseCommandInput(invocation?.rawInput);
  if (parsed.kind === 'empty') return { kind: 'error', text: USAGE };
  if (parsed.kind === 'status') return { kind: 'success', text: statusText(deps?.state?.()) };

  const agent = invocation?.agent;
  if (agent === undefined || typeof agent.followup !== 'function') {
    return {
      kind: 'error',
      text: 'No live agent is attached to this session, so the task cannot be routed.',
    };
  }

  let message;
  try {
    message = await userMessage(deps, directiveText(parsed.task));
  } catch (error) {
    // A command failure must be reported, not thrown: the registry settles a
    // thrown handler as an error anyway, but with the raw exception as its text.
    return { kind: 'error', text: `Could not build the routing message: ${String(error)}` };
  }

  agent.followup(message);
  return {
    kind: 'success',
    text: `Routing through the orchestrator: ${truncate(parsed.task, 80)}`,
  };
}

/**
 * Build the user message that carries the task into the next turn.
 *
 * The factory is resolved through `deps` so this module stays host-free; inside a
 * real harness it comes from the lazy import, which is the only place this file
 * touches the host at all.
 *
 * A missing factory is left to throw rather than invented: a message the host has
 * not identified is not a valid `UserMessage`.
 *
 * @param deps - the orchestrator dependencies.
 * @param text - the message text.
 * @returns the identified user message.
 */
async function userMessage(deps, text) {
  const factory =
    typeof deps?.createUserMessage === 'function'
      ? deps.createUserMessage
      : (await import('@deepseek-ai/dsh-llm')).createUserMessage;
  if (typeof factory !== 'function') throw new Error('createUserMessage is unavailable');
  return factory({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}
