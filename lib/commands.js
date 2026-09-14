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
import { translate } from './locales.js';

/** Registered command name, without the leading slash. */
export const COMMAND_NAME = 'model-orchestrator';

/** The one sub-command. Anything else is a task. */
export const STATUS_WORD = 'status';

/**
 * A locale table with no language resolution — the harness default.
 *
 * `installCommandDeferred` is handed the real one by the plugin; this keeps the module
 * usable (and testable) without one, and keeps every string going through the same
 * lookup so nothing is hardcoded back in.
 */
const DEFAULT_LOCALE = {
  translate: (key, params) => translate('en', key, params),
};

/**
 * The reply shown when the command is invoked with no task and no sub-command.
 *
 * @param locale - `{ translate }`.
 * @returns the usage text.
 */
export function usageText(locale = DEFAULT_LOCALE) {
  return locale.translate('command.usage');
}

/**
 * @deprecated Kept as a named export because the README and older tests reference it.
 * English usage text; prefer {@link usageText} so the reply follows the UI language.
 */
export const USAGE = translate('en', 'command.usage');

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
 * Routing capacity only — never task or progress state, which belongs to DSH. Every
 * fragment comes from the locale table, because a Chinese UI received this line in
 * English.
 *
 * @param state - `{ mode, poolSize, capabilityCount, inFlight }`.
 * @param locale - `{ translate }`.
 * @returns the rendered line.
 */
export function statusText(state, locale = DEFAULT_LOCALE) {
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const mode = state?.mode === 'guided' ? 'guided' : 'auto';
  const lines = locale.translate('command.status', {
    // The mode name is itself a translated term, so the line does not mix languages.
    mode: locale.translate(`mode.${mode}`),
    models: count(state?.poolSize),
    capabilities: count(state?.capabilityCount),
    inFlight: count(state?.inFlight),
  });

  // The division of labour and the researched facts are the two things that change
  // what routing does, so a status that omits them cannot answer "why is it
  // choosing that model". Both are reported only once they exist: an empty table is
  // not news, and a deployment without Sync should not read as broken.
  const assignments = state?.assignments ?? {};
  const assignmentCount = count(assignments.count);
  const unresolved = Array.isArray(assignments.unresolved) ? assignments.unresolved.length : 0;
  const unassigned = Array.isArray(assignments.unassigned) ? assignments.unassigned.length : 0;
  const extra = [];
  if (assignmentCount > 0) {
    let line = locale.translate('command.statusAssignments', { count: assignmentCount });
    if (unresolved > 0) {
      line += `, ${locale.translate('command.statusAssignmentsUnresolved', { count: unresolved })}`;
    }
    if (unassigned > 0) {
      line += `, ${locale.translate('command.statusAssignmentsUnassigned', { count: unassigned })}`;
    }
    extra.push(line);
  }
  if (state?.researchedCount !== undefined) {
    let line = locale.translate('command.statusResearched', { count: count(state.researchedCount) });
    const unconfirmed = count(state.researchUnmatched);
    if (unconfirmed > 0) {
      line += `, ${locale.translate('command.statusResearchUnconfirmed', { count: unconfirmed })}`;
    }
    extra.push(line);
  }
  return extra.length === 0 ? lines : `${lines}\n${extra.join(' · ')}`;
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
  let registeredLanguage;

  const inject = () => {
    // Re-registering is the ONLY way the palette entry can follow a language change:
    // the harness renders a third-party command's description and hint verbatim, so a
    // translation registered once is a translation frozen at activation.
    dispose();
    dispose = installCommandOn(deps?.commandContext?.commands, deps) ?? (() => {});
    registeredLanguage = deps?.locale?.language;
  };

  const injected = ctx.inject(['commands'], (commandCtx) => {
    // `commandCtx`, not `ctx`: inside the injection this is the context that owns the
    // service. The helpers below read it through the closure.
    deps.commandContext = commandCtx;
    if (commandCtx?.commands === undefined || typeof commandCtx.commands.register !== 'function') {
      // Reported as state, not just a log line: a missing slash command was invisible.
      deps?.health?.disable('command', 'this deployment provides no commands registry');
    } else {
      deps?.health?.enabled('command');
    }
    inject();
    deps?.logger?.info?.(`/${COMMAND_NAME} registered.`);
    return undefined;
  });

  // The locale may be resolved (or changed) after the command is registered, so the
  // entry is refreshed whenever it moves.
  const unsubscribe =
    typeof deps?.locale?.subscribe === 'function'
      ? deps.locale.subscribe(() => {
          if (deps?.commandContext === undefined) return;
          if (deps.locale.language === registeredLanguage) return;
          try {
            inject();
          } catch (error) {
            deps?.logger?.warn?.(`orchestrator: could not re-register /${COMMAND_NAME}: ${String(error)}`);
          }
        })
      : undefined;

  return () => {
    try {
      unsubscribe?.();
    } catch {
      // A listener that is already gone is not an error.
    }
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
  const locale = deps?.locale ?? DEFAULT_LOCALE;

  return commands.register({
    name: COMMAND_NAME,
    description: locale.translate('command.summary'),
    input: { hint: locale.translate('command.hint') },
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
  const locale = deps?.locale ?? DEFAULT_LOCALE;
  const parsed = parseCommandInput(invocation?.rawInput);
  if (parsed.kind === 'empty') return { kind: 'error', text: usageText(locale) };
  if (parsed.kind === 'status') {
    return { kind: 'success', text: statusText(deps?.state?.(), locale) };
  }

  const agent = invocation?.agent;
  if (agent === undefined || typeof agent.followup !== 'function') {
    return { kind: 'error', text: locale.translate('command.noAgent') };
  }

  let message;
  try {
    message = await userMessage(deps, directiveText(parsed.task));
  } catch (error) {
    // A command failure must be reported, not thrown: the registry settles a
    // thrown handler as an error anyway, but with the raw exception as its text.
    return {
      kind: 'error',
      text: locale.translate('command.messageFailed', { message: String(error) }),
    };
  }

  agent.followup(message);
  return {
    kind: 'success',
    text: locale.translate('command.routing', { task: truncate(parsed.task, 80) }),
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
