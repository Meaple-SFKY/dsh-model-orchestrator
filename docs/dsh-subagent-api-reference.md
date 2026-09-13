# DSH Subagent / Workflow API Reference — verified against v0.1.5-rc.2

Install root: the harness installation, resolvable with
`node -e "console.log(require.resolve('@deepseek-ai/dsh/package.json'))"`.
Packages: `.../node_modules/@deepseek-ai/<pkg>/`

Every claim below is VERIFIED by reading the shipped compiled output and `.d.ts`.
`lib/*.js` is the actual runtime; `lib/types/*.d.ts` is the published contract.
Nothing here is guessed. Items I could not find are marked NOT FOUND.

Note on versions: the CLI is `0.1.5-rc.1`, but every subagent/workflow package
`package.json` reports `"version": "0.1.5-rc.2"` (VERIFIED: each
`package.json` `version` field).

---

## 1. Service name — `ctx.subagents`  ✅ VERIFIED

`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:2853`

```js
constructor(ctx) {
    super(ctx, "subagents");
```

Declaration-augmentation of the Cordis `Context`:
`dsh-subagent/lib/types/index.d.ts:58-61`

```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        subagents: SubagentRuntime;
    }
```

Cordis `inject` key used by consumers (VERIFIED):
- `dsh-subagent-spawn-in-process/lib/index.js:12` → `const inject = ["subagents"];`
- `dsh-subagent-fork-in-process/lib/index.js:13` → `const inject = ["subagents"];`
- `dsh-tool-subagent/lib/index.js:246-251` → `const inject = ["tools","subagents","systemPrompt","sessionProjections"];`
- `dsh-tool-subagent-control/lib/index.js:16` → `const inject = ["tools","subagents"];`
- `dsh-tool-ralph/lib/index.js:11-16` → `["tools","workflowEngine","subagents","systemPrompt"]`
- `dsh-workflow-worker-thread` engine: `static inject = ["subagents"];` (`lib/index.js:848`)

---

## 2. Public methods of `ctx.subagents` (`SubagentRuntime`)

Class: `dsh-subagent/lib/types/index.d.ts:98-314`; implementation
`dsh-subagent/lib/index.js:2793+`. The class extends `TypertRemoteService`.

### 2.1 Registry management (list / get / register)

`dsh-subagent/lib/index.js:3106-3132`

```js
registerProvider(provider) {
    const name = provider.name;
    return this.ctx.effect(function* () {
        if (this.providers.has(name)) throw new SubagentError(`a subagent provider named "${name}" is already registered`, "DUPLICATE_PROVIDER");
        this.providers.set(name, provider);
        yield () => {
            this.providers.delete(name);
            this.emitLifecycle("subagent/provider-removed", name);
        };
        this.ctx.emit("subagent/provider-added", provider);
    }.bind(this), "subagents.registerProvider()");
}
getProvider(name) {
    return this.providers.get(name);
}
list() {
    return [...this.providers.keys()];
}
```

Signatures (`index.d.ts`):
- `registerProvider(provider: SubagentProvider): () => void` — line 272. Returns the
  **exact Cordis effect disposer**. Registration is effect-scoped/HMR-safe.
- `getProvider(name: string): SubagentProvider | undefined` — line 278.
- `list(): string[]` — line 283. **Provider names**, in insertion order.

### 2.2 Start a one-shot run programmatically (no tool)

`dsh-subagent/lib/index.js:3145-3173`

```js
async start(name, request) {
    const provider = this.expectProvider(name);
    this.assertCapabilities(provider, request);
    assertSubagentMaxDepth(request.maxDepth);
    if (request.outputSchema !== void 0) assertObjectJsonSchema(request.outputSchema);
    const descriptor = snapshotSubagentDescriptor({
        mode: "one-shot",
        provider: name,
        ...request.label !== void 0 ? { label: request.label } : {}
    });
    const resolved = {
        ...request,
        descriptor
    };
    const run = await provider.start(resolved);
    const child = run.localAgent?.session;
    if (child !== void 0) try {
        establishCatalogChild(request.parent.session, child.header, descriptor);
    } catch (error) {
        run.result.catch(() => void 0);
        try {
            await run.dispose();
        } catch (cleanupError) {
            this.ctx.logger.warn(`subagent: disposal after catalog append failure also failed: ${String(cleanupError)}`);
        }
        throw error;
    }
    return observeRun(this.emitLifecycle, name, request.parent, run);
}
```

Signature: `start(name: string, request: SubagentStartRequest): Promise<SubagentRun>` (index.d.ts:296).

`SubagentStartRequest` — `dsh-subagent/lib/types/types.d.ts:136-192`:

```ts
export interface SubagentStartRequest {
    readonly label?: string;
    readonly prompt: ContentBlock[];
    readonly parent: Agent;
    readonly signal: AbortSignal;
    readonly agentOptions?: AgentOptions;   // provider / model / reasoningEffort / maxTokens
    readonly outputSchema?: ObjectJsonSchema;
    readonly maxDepth?: number;
    readonly toolFilter?: ToolRestriction;
    readonly persona?: string;
}
```

`signal` is **required**. `expectProvider` throws `SubagentError("no subagent provider registered for \"<name>\"", "NO_PROVIDER")` (index.js:3185-3188).
Capability mismatch throws `UNSUPPORTED_CAPABILITY` (index.js:3203-3227).

Minimal programmatic call (composed from the verified types):

```js
const run = await ctx.subagents.start('spawn', {
  label: 'demo',
  prompt: [{ type: 'text', text: 'hello' }],
  parent: ctx.agents.requireInitiator(),      // exact live Agent
  signal: exec.signal,
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
});
const result = await run.result;              // SubagentResult — never rejects on child failure
await run.dispose();                          // idempotent, required
```

### 2.3 Get the result — `SubagentRun` / `SubagentResult`

`dsh-subagent/lib/types/types.d.ts:256-318`

```ts
export interface SubagentResult {
    readonly output: ContentBlock[];
    readonly structured?: unknown;
    readonly diagnostic?: string;
    readonly stopReason: SubagentStopReason;
}
export interface SubagentRun {
    readonly id: SessionId;
    readonly localAgent: Agent | undefined;
    readonly result: Promise<SubagentResult>;
    dispose(): Promise<void>;
}
```

`SubagentStopReasonMap` (types.d.ts:239-252): `'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'`.
`result` **does not reject** on a child-level failure; it rejects only on an infrastructure fault the seam cannot represent.

Output selection rule (`dsh-subagent/lib/types/assistant-output.d.ts:1-9`): the last
non-empty assistant message; else the accumulated assistant text; else `[]`.

### 2.4 Continuable children

- `startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>` — index.d.ts:117;
  impl index.js:2881-2883. Returns `{ childId: SessionId, messageId: MessageId }`.
- `sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions): Promise<MessageId>` — index.d.ts:132; impl index.js:2898-2900. `options` is `{ signal: AbortSignal }`.
- `interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void` — index.d.ts:161; impl index.js:2931-2933, synchronous fire-and-return.
- `drainContinuableDescendants(parents: readonly Agent[]): Promise<void>` — index.d.ts:172.
- `drainContinuableChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void>` — index.d.ts:183.

`ContinuableStartSpec` (types.d.ts:26-44): `{ provider: string; label: string; childId?: SessionId; request: Omit<SubagentStartRequest,'label'|'signal'|'outputSchema'>; signal: AbortSignal }`.
`SubagentInterruptAuthority` (types.d.ts:57-63): `{kind:'user', parentSessionId} | {kind:'ancestor', agent}`.

### 2.5 Query running/known subagents

- `listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>` — index.d.ts:201; impl index.js:2980-2982 delegates to `listChildren(this.ctx, ...)`.
- `listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]>` — index.d.ts:217; impl index.js:3000-3002.
- `remoteExportList(parentSessionId: SessionId, signal: AbortSignal): Promise<SubagentCatalog>` — index.d.ts:231 (browser face).
- `prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt>` — index.d.ts:249 (browser face).
- `interruptByParent(childSessionId, parentSessionId, mode: 'continuable'): SubagentInterruptReceipt` — index.d.ts:264.

`SubagentListEntry` — `dsh-subagent/lib/types/control-types.d.ts:30-70`:

```ts
export type SubagentListEntry = {
    readonly kind: 'child';
    readonly id: SessionId;
    readonly activity: 'running' | 'inactive';
    readonly hasChildren: boolean;
} & ({ readonly mode: 'one-shot'; readonly label?: string; }
   | { readonly mode: 'continuable'; readonly label: string; })
  | { readonly kind: 'diagnostic'; readonly id: SessionId;
      readonly reason: 'corrupt' | 'unsupported' | 'unavailable'; };
```

`SubagentDescendantListEntry = SubagentListEntry & { parentId: SessionId; depth: number }`
(`list-children.d.ts:28-33`).

For a **live** child's runtime status, read the Agent registry:
`ctx.agents.get(id)?.status` → `'idle' | 'running'` (this is exactly what the
`list_agents` tool does — see `dsh-tool-subagent-control/lib/types/list-agents.js:24-29`).

### 2.6 Private members (NOT public API)

`index.d.ts` declares these private: `prepareContinuable`, `expectProvider`,
`requireContinuations`, `observeActivation`, `assertCapabilities`, and the
symbol-keyed `[deliverSubagentPrompt]`. Do not call them.

---

## 3. What a "provider" is; registering one at runtime  ✅ VERIFIED

A **provider** is one registered transport/backend that can establish child
agents. The service is a **named-provider registry**; a request selects a
provider by name.

### 3.1 `SubagentProvider` — exact shape

`dsh-subagent/lib/types/types.d.ts:327-376`

```ts
export interface SubagentProvider {
    /** Unique registry name (e.g. `spawn`, `fork`, `acp`). */
    readonly name: string;
    /** The start-time features this provider supports (see {@link SubagentCapabilities}). */
    readonly capabilities: SubagentCapabilities;
    /**
     * Whether the child sees the parent's completed-turn prefix. ...
     */
    readonly inheritsParentContext: boolean;
    readonly agentRouteDefaults?: Readonly<{
        provider: string;
        model: string;
    }>;
    start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;
    prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>;
}
```

`SubagentCapabilities` (types.d.ts:122-128):

```ts
export interface SubagentCapabilities {
    readonly agentOptions: boolean;
    readonly outputSchema: boolean;
    readonly depthLimit: boolean;
    readonly toolFilter: boolean;
    readonly persona: boolean;
}
```

Capability ↔ request-option mapping is enforced in
`assertCapabilities` (index.js:3203-3227): `agentOptions`, `outputSchema`,
`maxDepth`→`depthLimit`, `toolFilter`, `persona`. Presence of
`prepareContinuable` **is** the continuable capability (index.js:3179-3183).

`ResolvedSubagentStartRequest = SubagentStartRequest & { descriptor: SubagentDescriptorData }`
(types.d.ts:197-200).

### 3.2 Reference implementation — spawn provider (VERIFIED, verbatim)

`dsh-subagent-spawn-in-process/lib/index.js:11-45`

```js
const name = "subagent-spawn-in-process";
const inject = ["subagents"];
const Config = z.object({ providerName: z.string().default("spawn") });
var SpawnInProcessProvider = class {
	name;
	capabilities = {
		agentOptions: true,
		outputSchema: true,
		depthLimit: true,
		toolFilter: true,
		persona: true
	};
	inheritsParentContext = false;
	constructor(name) {
		this.name = name;
	}
	start(request) {
		return startInProcessRun(request, {});
	}
	prepareContinuable() {
		return Promise.resolve({});
	}
};
function apply(ctx, config) {
	ctx.subagents.registerProvider(new SpawnInProcessProvider(config.providerName));
}
export { Config, apply, inject, name };
```

Fork provider (same shape, `inheritsParentContext = true`, seeds the child with
the parent's completed-turn prefix) —
`dsh-subagent-fork-in-process/lib/index.js:14-59`:

```js
const Config = z.object({ providerName: z.string().default("fork") });
...
function completedTurnPrefix(parent) {
	const events = parent.session.snapshotEvents();
	const lastEnd = events.findLast((e) => e.type === "turn/end");
	if (lastEnd === void 0) return [];
	return events.slice(0, lastEnd.seq + 1);
}
var ForkInProcessProvider = class {
	capabilities = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true };
	inheritsParentContext = true;
	start(request) {
		const seed = completedTurnPrefix(request.parent);
		return startInProcessRun(request, { ...seed.length > 0 ? { seed } : {} });
	}
	prepareContinuable(request) {
		const seed = completedTurnPrefix(request.parent);
		return Promise.resolve(seed.length > 0 ? { seed } : {});
	}
};
function apply(ctx, config) {
	ctx.subagents.registerProvider(new ForkInProcessProvider(config.providerName));
}
```

**These are the only two subagent provider packages installed** (VERIFIED:
`ls -d dsh-subagent*` → `dsh-subagent`, `dsh-subagent-fork-in-process`,
`dsh-subagent-in-process-driver`, `dsh-subagent-spawn-in-process`). No ACP/Codex/
Claude-Code provider is shipped in this install, even though the README mentions
them.

### 3.3 Registering a provider from a plugin

Exactly the `apply()` shape above: the plugin declares `inject = ['subagents']`
and calls `ctx.subagents.registerProvider(provider)` inside `apply`. The returned
disposer is effect-scoped — Cordis removes the provider (emitting
`subagent/provider-removed`) when the fiber unloads. Mapping is name → provider;
duplicate names throw `SubagentError(..., "DUPLICATE_PROVIDER")`.

A **plugin-visible** nuance for dynamic Cordis plugins: `registerProvider` uses
`ctx.effect(...)` internally, so it is safe to call from a dynamic plugin `apply`.

### 3.4 Shared in-process driver (what a real provider reuses)

`dsh-subagent-in-process-driver/lib/index.js:161-190` — `startInProcessRun`:

```js
async function startInProcessRun(request, options) {
	assertSubagentMaxDepth(request.maxDepth);
	if (request.signal.aborted) throw prePublicationAbort();
	const parent = request.parent;
	const childDepth = resolveChildDepth(parent, request.maxDepth);
	const childId = brandString(randomUUID());
	const seed = options.seed;
	const activationBoundary = SessionLogOffset(seed?.length ?? 0);
	const inherited = captureDelegatedPolicyOverrides(parent);
	let structured;
	const setup = (childCtx, child) => {
		appendDelegatedPolicyOverrides(child.session, inherited);
		applyChildComposition(childCtx, parent, {
			persona: request.persona,
			toolFilter: request.toolFilter
		});
		if (request.outputSchema !== void 0) structured = attachStructuredRuntime(childCtx, request.outputSchema);
		attachDescriptorAppend(childCtx, request.descriptor);
	};
	return drivePublishedRun(await parent.ctx.agents.create({
		sessionId: childId,
		parentAgent: parent,
		meta: childSessionMeta(parent, childDepth, seed !== void 0),
		...seed !== void 0 ? { seed } : {},
		...seed === void 0 ? {} : { inheritedEventCount: activationBoundary },
		agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
		signal: request.signal,
		setup
	}), request.signal, request.prompt, childId, activationBoundary, structured);
}
```

This is the canonical "how to spawn a real child agent from a provider":
`parent.ctx.agents.create({...})` → `AgentHandle` → drive it → wrap in a
`SubagentRun`. `drivePublishedRun` (index.js:195-229) returns:

```js
return {
    id: childId,
    localAgent: child,
    result,
    async dispose() {
        signal.removeEventListener("abort", onAbort);
        flags.cancelled = true;
        const disposal = (await Promise.allSettled([handle.dispose(), result]))[0];
        if (disposal.status === "rejected") throw disposal.reason;
    }
};
```

Structured output: the driver registers a child-scoped `structured_output` tool,
injects an instruction prompt section, and captures only after the authoritative
`tools/result` (`dsh-subagent-in-process-driver/lib/index.js:21-109`). Constant
`STRUCTURED_OUTPUT_TOOL = "structured_output"` (line 21).

---

## 4. `dsh-tool-subagent` — config keys, model selection  ✅ VERIFIED

`dsh-tool-subagent/lib/index.js:245-251`

```js
const name = "tool-subagent";
const inject = [
	"tools",
	"subagents",
	"systemPrompt",
	"sessionProjections"
];
```

### 4.1 Exact config schema (VERIFIED)

`dsh-tool-subagent/lib/index.js:252-270`

```js
const Config = z.object({
	provider: z.string().required(),
	toolName: z.string().default("subagent"),
	modelSelectionSettings: z.boolean().default(false),
	enableRunInBackground: z.boolean().default(true),
	backgroundMode: z.union(["one-shot", "continuable"]).default("one-shot"),
	agentOptions: z.object({
		provider: z.string(),
		model: z.string(),
		reasoningEffort: z.string().min(1),
		maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
	}).default(void 0),
	persona: z.string(),
	toolFilter: z.object({
		allow: z.array(z.string()).default(void 0),
		deny: z.array(z.string()).default(void 0)
	}).default(void 0),
	maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const("provider-managed")]).default(3)
});
```

So: `provider` (required), `toolName`, `modelSelectionSettings`,
`enableRunInBackground`, `backgroundMode` (`one-shot` default |
`continuable`), `agentOptions{provider,model,reasoningEffort,maxTokens}`,
`persona`, `toolFilter{allow,deny}`, `maxDepth` (number default **3**, or
`"provider-managed"`).

Note: there is **no** `maxDepth: "provider-managed"` passthrough bug — `apply`
explicitly skips `assertSubagentMaxDepth` for it (index.js:369) and passes
`maxDepth: undefined` to the request (index.js:508).

Configuration guards (index.js:369-386):
```js
if (config.maxDepth !== "provider-managed") assertSubagentMaxDepth(config.maxDepth);
if (config.toolFilter !== void 0 && config.toolFilter.allow === void 0 && config.toolFilter.deny === void 0) throw new Error("tool-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter");
...
ctx.on("subagent/provider-added", (subagentProvider) => {
    if (subagentProvider.name === config.provider) assertSubagentProviderConfiguration(subagentProvider);
});
```

Provider-configuration assertions (index.js:376-381):
```js
if (typeof config.maxDepth === "number" && !subagentProvider.capabilities.depthLimit) throw new Error(`tool-subagent: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`);
if (config.agentOptions !== void 0 && !subagentProvider.capabilities.agentOptions) throw new Error(`tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`);
if (modelSelectionCapable && !subagentProvider.capabilities.agentOptions) throw new Error(`tool-subagent: provider "${subagentProvider.name}" does not support child model selection`);
if (continuable && subagentProvider.prepareContinuable === void 0) throw new Error(`tool-subagent: provider "${subagentProvider.name}" does not support \`backgroundMode: continuable\``);
```

### 4.2 The tool's model-facing parameters (VERIFIED)

`index.js:401-430`. Always: `description` (required), `prompt` (required).
**Only when `modelSelectionSettings === true`** (index.js:412-425) add:
`provider`, `model`, `reasoning_effort`. Only when
`enableRunInBackground` add `run_in_background`.

Tool name default `"subagent"`; description wording is chosen from
`provider.inheritsParentContext` (`providerWording`, index.js:344-353).

### 4.3 How a caller selects a different child model

Two layers, merged in `requestedAgentOptions` (index.js:62-81):

```js
function requestedAgentOptions(parentOptions, configured, request, enabled) {
	if (!hasDelegationModelRequest(request)) return configured;
	if (!enabled) throw new Error("child model selection is disabled for this tool instance");
	assertNonEmpty(request.provider, "provider");
	assertNonEmpty(request.model, "model");
	assertNonEmpty(request.reasoning_effort, "reasoning_effort");
	if (request.provider === void 0 !== (request.model === void 0)) throw new Error("child LLM `provider` and `model` must be supplied together");
	const baselineProvider = configured?.provider ?? parentOptions.provider;
	const baselineModel = configured?.model ?? parentOptions.model;
	const routeChanged = request.provider !== void 0 && (request.provider !== baselineProvider || request.model !== baselineModel);
	const { reasoningEffort: _configuredReasoningEffort, ...configuredWithoutReasoning } = configured ?? {};
	return {
		...routeChanged && request.reasoning_effort === void 0 ? configuredWithoutReasoning : configured,
		...request.provider === void 0 ? {} : { provider: request.provider, model: request.model },
		...request.reasoning_effort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(request.reasoning_effort) }
	};
}
```

Rules (VERIFIED from that code):
- `provider` and `model` **must be supplied together**.
- Changing the route without naming `reasoning_effort` **clears** the
  configured route-owned effort, so the new model resolves its own default.
- Model-facing selection is rejected unless `modelSelectionSettings: true`.
- Tool-instance `config.agentOptions` is the fallback "configured" layer.

The execute path (index.js:490-561, abbreviated to the verified lines):

```js
async execute(args, exec) {
    const parent = exec.agent;
    if (!parent) throw new Error("subagent tool requires a calling agent (exec.agent was undefined)");
    const modelRequest = args;
    const parentOptions = parentAgentOptionsForDelegation(parent);
    const requiresRoutePreflight = hasDelegationModelRequest(modelRequest) || hasConfiguredLlmSelection(config.agentOptions);
    const requestedChildAgentOptions = requestedAgentOptions(parentOptions, requiresRoutePreflight && providerRouteDefaults !== void 0 ? {
        ...providerRouteDefaults,
        ...config.agentOptions
    } : config.agentOptions, modelRequest, modelSelectionEnabled);
    assertAllowedModelSelection(modelSelectionPolicy, parentOptions, requestedChildAgentOptions, modelRequest);
    if (requiresRoutePreflight) {
        const llm = runtimeCtx.get("llm");
        if (llm === void 0) throw new Error("cannot resolve the selected child LLM route because the `llm` service is unavailable");
        await preflightChildLlmRoute(llm, parentOptions, requestedChildAgentOptions, exec.signal, providerRouteDefaults === void 0);
        ...
    }
    ...
    const request = {
        label: args.description,
        prompt: [{ type: "text", text: args.prompt }],
        parent,
        ...requestedChildAgentOptions !== void 0 ? { agentOptions: requestedChildAgentOptions } : {},
        ...config.persona !== void 0 ? { persona: config.persona } : {},
        ...config.toolFilter !== void 0 ? { toolFilter: config.toolFilter } : {},
        ...maxDepth !== void 0 ? { maxDepth } : {}
    };
```

Route preflight (index.js:117-128) resolves through the live LLM adapter:

```js
async function preflightChildLlmRoute(llm, parentOptions, requested, signal, inheritParentReasoningEffort = true) {
	const provider = requested?.provider ?? parentOptions.provider;
	const model = requested?.model ?? parentOptions.model;
	if (provider === void 0 || model === void 0) throw new Error("cannot select child LLM values without an effective provider and model");
	const routeChanged = provider !== parentOptions.provider || model !== parentOptions.model;
	const reasoningEffort = requested?.reasoningEffort ?? (inheritParentReasoningEffort && !routeChanged ? parentOptions.reasoningEffort : void 0);
	await llm.resolveCallConfig({ provider, model, ...reasoningEffort === void 0 ? {} : { reasoningEffort } }, signal);
}
```

Parent option inheritance — `dsh-subagent/lib/types/child-agent.js:50-63, 75-93`
(VERIFIED): parent route comes from `parent.session.requestHeader()?.config`,
falling back to `parent.options`; `resolveChildAgentOptions` spreads parent
values then `...requested` then stamps `subagentDepth`.

### 4.4 `list_subagent_models` — how it is registered and what it reads

Registered **only** when `config.modelSelectionSettings === true` and a policy
exists — `install()` at index.js:387-389:

```js
const install = (runtimeCtx, modelSelectionPolicy) => {
    const modelSelectionEnabled = modelSelectionPolicy !== void 0;
    if (modelSelectionPolicy !== void 0) registerListSubagentModels(runtimeCtx, modelSelectionPolicy);
```

It is NOT a standalone plugin; it is a tool registered by the same
`dsh-tool-subagent` instance. Tool definition — index.js:172-197:

```js
function registerListSubagentModels(ctx, policy) {
	ctx.tools.register(defineTool({
		name: "list_subagent_models",
		description: "Discover LLM routes for subagents without changing the current Agent. Call with no arguments to list registered providers, with `provider` to list its advertised models, or with `provider` and `model` to inspect that exact model and its reasoning efforts. ...",
		parameters: {
			provider: { type: "string", description: "Registered LLM provider id. Omit to list providers." },
			model: { type: "string", description: "Exact model id to inspect. Requires provider; omit to list that provider's advertised models." }
		},
		output: { schema: { type: "string" }, render: (_args, result) => [{ type: "text", text: result }] },
		execute(args, exec) {
			return listSubagentModels(ctx, policy, args, exec.signal);
		}
	}));
}
```

Catalog source (index.js:145-166): `llm.listProviders()`, `llm.listModels(id)`,
`llm.resolveModelInfo(id, model, signal)`; output is filtered by
`policy.routes` (**allow-list**). Unlisted-but-allowed models are still usable
("Catalog membership is advisory").

### 4.5 The settings service that enables it

`dsh-tool-subagent/model-selection-settings.js` registers Cordis service
`"subagentModelSelection"` (line 56: `super(ctx, "subagentModelSelection")`),
settings namespace `"subagent-model-selection"` (line 42), schema
`{ enabled: boolean = false, allowedModels: [{provider, model}] = [] }`
(lines 44-47). The tool throws if the setting service is absent
(index.js:586-587):

```js
const settings = ctx.get("subagentModelSelection");
if (settings === void 0) throw new Error("tool-subagent: `modelSelectionSettings` requires @deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope");
```

The per-session durable policy is appended as the session event
`subagent/model-selection-policy` (index.js:232) and folded by projection key
`subagentModelSelectionPolicy` (index.js:199-214). `assertAllowedModelSelection`
(index.js:91-98) enforces it: any explicit route/effort must match an allowed
route, else `child LLM route "<p>/<m>" is not allowed for this Session`.

---

## 5. How a child's result returns to the parent  ✅ VERIFIED

Three channels:

**(a) The awaited run result.** `SubagentRun.result: Promise<SubagentResult>`
(types.d.ts:312). The tool's foreground path returns
`{ kind:'foreground', runId, output }` (index.js:314-331) and renders it with
`outputValueText` (index.js:272-274) — text blocks joined. `run.dispose()` is
always called.

**(b) Tool output schema** (index.js:431-488) — a `oneOf`:
```
{kind:'background', jobId} | {kind:'continuable', subagentId} | {kind:'foreground', runId, output}
```

**(c) Lifecycle events** — `subagent/start` and `subagent/end`.

`dsh-subagent/lib/types/index.d.ts:62-95` (declared payloads):

```ts
'subagent/provider-added'(provider: SubagentProvider): void;
'subagent/provider-removed'(name: string): void;
'subagent/start'(this: Scoped<SubagentRuntime>, info: SubagentRunInfo): void;
'subagent/end'(this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo): void;
```

`SubagentRunInfo` (types.d.ts:74-88): `{ runId: SubagentRunId; provider: string; id: SessionId; local: boolean }`.
`SubagentRunEndInfo` (types.d.ts:93-110): `{ runId; provider; id; local; stopReason: SubagentResult['stopReason']; lastAssistantMessage?: ContentBlock[] }`.

Emission — `dsh-subagent/lib/index.js:293-314` (verbatim):

```js
function observeRun(emit, provider, parent, run) {
	const identity = {
		runId: SubagentRunId(randomUUID()),
		provider,
		id: run.id,
		local: run.localAgent !== void 0
	};
	run.result.then((result) => {
		emit("subagent/end", {
			...identity,
			stopReason: result.stopReason,
			...result.output.length === 0 ? {} : { lastAssistantMessage: result.output }
		}, parent);
	}, () => {
		emit("subagent/end", {
			...identity,
			stopReason: "error"
		}, parent);
	});
	emit("subagent/start", identity, parent);
	return run;
}
```

Scoped dispatch: `createLifecycleEmitter` (index.js:268-283) passes the parent
carrier — `ctx.events.dispatch("emit", [carrier(parent), name, info])` — so a
parent-scoped listener sees only its own delegations. Listeners are individually
contained (a throw/rejection is logged, never breaks the run).

Child-side stop reason mapping — `dsh-subagent-in-process-driver/lib/index.js:125-133`:

```js
function toStopReason(reason) {
	switch (reason?.kind) {
		case "completed": return "completed";
		case "max-tokens": return "max-tokens";
		case "aborted": return "aborted";
		case "blocked": return "refusal";
		default: return "error";
	}
}
```

Background one-shot results are delivered via `ctx.jobs`
(`jobs.start({kind:'subagent', label, owner: parent, run})`, index.js:534-555)
and settled by `settleRun(run)` → `Promise<JobOutcome>`
(`dsh-subagent/lib/types/run-settlement.d.ts`). `ctx.jobs` is optional
(`runtimeCtx.get("jobs")`; throws a helpful error when absent).

---

## 6. Workflow system  ✅ VERIFIED

### 6.1 The seam

`dsh-workflow` is types + the abstract service. Service name is
**`workflowEngine`** — `dsh-workflow/lib/index.js:59-62`:

```js
var WorkflowEngine = class extends Service {
	constructor(ctx) {
		super(ctx, "workflowEngine");
	}
```

Context augmentation: `dsh-workflow/lib/types/index.d.ts:14-16`.
Abstract API: `start(request: WorkflowStartRequest): WorkflowRun` (index.d.ts:119).

`WorkflowStartRequest` — `runtime-types.d.ts:15-30`:

```ts
export interface WorkflowStartRequest {
    script: string;
    meta: WorkflowMeta;
    args?: unknown;
    subagentProvider?: string;
    maxTotalAgents?: number;
    parent: Agent;
    signal?: AbortSignal;
}
```

`WorkflowRun` — `runtime-types.d.ts:35-44`: `{ id, meta, result: Promise<WorkflowResult>, cancel(reason?), dispose() }`.
`WorkflowResult` — `types.d.ts:63-78`: `{ value, stopReason: 'completed'|'cancelled'|'error', error?, agentsStarted }`.

### 6.2 Who implements it

The shipped engine is **`@deepseek-ai/dsh-workflow-worker-thread`**
(`WorkerThreadWorkflowEngine extends WorkflowEngine`, `lib/index.js:847`), not
`dsh-workflow` itself. `dsh-tool-workflow` only forwards to
`ctx.workflowEngine` (`dsh-tool-workflow/lib/index.js:234-240`).

Engine config — `dsh-workflow-worker-thread/lib/index.js:848-856`:

```js
static inject = ["subagents"];
static Config = z.object({
    provider: z.string().default("spawn"),
    maxConcurrentAgents: z.natural().default(0),
    maxTotalAgents: z.natural().min(1).default(1e3),
    maxItemsPerCall: z.natural().min(1).default(4096),
    syncTimeoutMs: z.natural().min(1).default(5e3),
    disposeGraceMs: z.natural().default(5e3)
});
```

`maxConcurrentAgents: 0` auto-resolves: `Math.min(16, Math.max(1, availableParallelism() - 2))`
(index.js:883).

### 6.3 The `agent()` hook — exact contract

Script body execution with the hook globals —
`dsh-workflow-worker-thread/lib/worker.cjs:271-283`:

```js
const globals = {
	agent: (prompt, opts) => this.contain(this.agent(prompt, opts)),
	parallel: (thunks) => this.contain(this.parallel(thunks)),
	pipeline: (items, ...stages) => this.contain(this.pipeline(items, stages)),
	phase: (title) => { this.phase(title); },
	log: (message) => { this.log(message); },
	args
};
for (const [key, value] of Object.entries(globals)) this.context[key] = typeof value === "function" ? Object.freeze(value) : value;
```

Allowed options — `worker.cjs:215-228`:

```js
const SUPPORTED_AGENT_OPTIONS = new Set([
	"label",
	"phase",
	"schema",
	"provider",
	"model"
]);
const DEFERRED_AGENT_OPTIONS = new Set([
	"effort",
	"isolation",
	"agentType"
]);
```

Option validation — `worker.cjs:498-537` (verbatim):

```js
readAgentOptions(rawOpts) {
	if (rawOpts === void 0) return {};
	let opts;
	try {
		opts = materializeFromRealm(rawOpts, "agent() options");
	} catch (error) {
		if (!(error instanceof MaterializeError)) throw error;
		throw new _deepseek_ai_dsh_workflow.WorkflowError(`agent() options must be plain JSON data — ${error.message}`, "INVALID_ARGUMENT", { cause: error });
	}
	if (typeof opts !== "object" || opts === null || Array.isArray(opts)) throw new _deepseek_ai_dsh_workflow.WorkflowError("agent() options must be an object", "INVALID_ARGUMENT");
	const record = opts;
	for (const key of Object.keys(record)) {
		if (SUPPORTED_AGENT_OPTIONS.has(key)) continue;
		if (DEFERRED_AGENT_OPTIONS.has(key)) throw new _deepseek_ai_dsh_workflow.WorkflowError(`agent() option "${key}" is deferred and not supported by this engine (supported: label, phase, schema, provider, model)`, "UNSUPPORTED_OPTION");
		throw new _deepseek_ai_dsh_workflow.WorkflowError(`agent() option "${key}" is not recognized (supported: label, phase, schema, provider, model)`, "UNSUPPORTED_OPTION");
	}
	for (const key of ["label","phase","provider","model"]) if (record[key] !== void 0 && typeof record[key] !== "string") throw new _deepseek_ai_dsh_workflow.WorkflowError(`agent() option "${key}" must be a string`, "INVALID_ARGUMENT");
	let schema;
	if (record.schema !== void 0) try {
		(0, _deepseek_ai_dsh_tools.assertObjectJsonSchema)(record.schema);
		schema = record.schema;
	} catch (error) {
		if (!(error instanceof _deepseek_ai_dsh_tools.JsonSchemaError)) throw error;
		throw new _deepseek_ai_dsh_workflow.WorkflowError(`agent() schema is outside the supported subset — ${error.message}`, "UNSUPPORTED_SCHEMA", { cause: error });
	}
	return {
		...record.label !== void 0 ? { label: record.label } : {},
		...record.phase !== void 0 ? { phase: record.phase } : {},
		...record.provider !== void 0 ? { provider: record.provider } : {},
		...record.model !== void 0 ? { model: record.model } : {},
		...schema !== void 0 ? { schema } : {}
	};
}
```

**Schema validation** is `assertObjectJsonSchema` from `@deepseek-ai/dsh-tools`
(same validator the subagent seam uses). Supported subset per the tool
description (`dsh-tool-workflow/lib/index.js:99`): "an object-rooted JSON Schema
using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf
— no pattern/format/numeric bounds".

The hook itself — `worker.cjs:403-496` (key lines verbatim):

```js
async agent(rawPrompt, rawOpts) {
	this.throwIfCancelled();
	if (typeof rawPrompt !== "string" || rawPrompt.length === 0) throw new _deepseek_ai_dsh_workflow.WorkflowError("agent() requires a non-empty prompt string", "INVALID_ARGUMENT");
	const opts = this.readAgentOptions(rawOpts);
	if (this.started >= this.limits.maxTotalAgents) throw new _deepseek_ai_dsh_workflow.WorkflowError(`this run reached its total agent cap (${this.limits.maxTotalAgents}) — a runaway-loop backstop; raise the applicable maxTotalAgents limit if the scale is intentional`, "AGENT_CAP");
	this.started += 1;
	const seq = this.started;
	const label = opts.label ?? defaultLabel(rawPrompt);
	const phase = opts.phase ?? this.currentPhase;
	await this.acquireSlot();
	...
	run = await this.children.startAgent({
		prompt: rawPrompt,
		...opts.schema !== void 0 ? { schema: opts.schema } : {},
		...opts.provider !== void 0 ? { provider: opts.provider } : {},
		...opts.model !== void 0 ? { model: opts.model } : {}
	});
	...
	const info = { seq, label, ...phase !== void 0 ? { phase } : {}, childId: brandString(run.id) };
	this.observer.agentStart(info);
	try {
		let result;
		try { result = await run.result; } catch (error) { ... }
		if (result.stopReason === "completed") {
			if (opts.schema !== void 0) {
				if (result.structured === void 0) { this.observer.agentEnd({...info, outcome: "failed"}); return null; }
				this.observer.agentEnd({...info, outcome: "completed"});
				return result.structured;
			}
			this.observer.agentEnd({...info, outcome: "completed"});
			return outputText(result.output);
		}
		...
		return null;
	} finally { await run.dispose(); }
```

So: **no `schema` → child's final text (`outputText` = text blocks joined);
`schema` → the validated `result.structured` object, or `null` if absent;
child failure → `null`.** `agent()` returns `null` rather than throwing for a
failed child; bad arguments/caps throw fatal `WorkflowError`s that kill the script.

Host-side bridge to the subagent seam —
`dsh-workflow-worker-thread/lib/index.js:482-497`:

```js
async startChild(callId, request) {
	let run;
	try {
		run = await this.subagents.start(this.provider, {
			prompt: [{ type: "text", text: request.prompt }],
			parent: this.parent,
			signal: this.controller.signal,
			...request.schema !== void 0 ? { outputSchema: request.schema } : {},
			...request.provider !== void 0 || request.model !== void 0 ? { agentOptions: {
				...request.provider !== void 0 ? { provider: request.provider } : {},
				...request.model !== void 0 ? { model: request.model } : {}
			} } : {}
		});
```

**Provider/model overrides:** `agent(prompt, { provider, model })` → per-child
`agentOptions` on `ctx.subagents.start(...)`. Either may be provided alone
(unlike the tool layer, which requires them together). There is **no**
`reasoning_effort`/`effort` override in a workflow — `effort` is explicitly
rejected as deferred.

**`phase`** opts is informational grouping; `phase(title)` sets the current
phase for subsequent `agent()` calls (worker.cjs:580-586). `log(message)` narrates.
`args` is the tool call's `args` value, cloned into the realm.

### 6.4 Composition hooks

`parallel(thunks)` — `worker.cjs:538-555`: each thunk caught → `null`; a fatal
`WorkflowError` is re-thrown. `pipeline(items, ...stages)` — `worker.cjs:556-576`:
per-item stage chain, **no barrier between stages**, stage signature
`(prev, item, index)`, ordinary throw drops only that item to `null`.
Caps: `assertItemCap` → `ITEM_CAP` at `maxItemsPerCall` (default 4096).

### 6.5 `dsh-tool-workflow`

`dsh-tool-workflow/lib/index.js:15-24`:

```js
const name = "tool-workflow";
const inject = ["tools","workflowEngine","systemPrompt"];
const Config = z.object({
	toolName: z.string().default("workflow"),
	maxResultChars: z.natural().min(1).default(5e4)
});
```

Parameters: `script` (required), `meta` (required, `{name, description,
whenToUse?, phases?}`), `args?`. Output
`{runId, agentsStarted, result}` (index.js:207-225). Execution awaits
`run.result`, always disposes, and maps non-`completed` to an error
(index.js:231-270). It also records durable session events
`tool-workflow/run-start|agent-start|agent-end|run-end`
(index.js:52-83).

Meta is validated host-side by `validateMeta`/`validateMetaShape`
(`dsh-workflow-worker-thread/lib/index.js:733-796`): unknown fields rejected;
`name`/`description` non-empty; `phases[].{title,detail,provider,model}`.
A body beginning with `export const meta` gets a pointed `SCRIPT_PARSE` error
(index.js:816-825).

### 6.6 `dsh-tool-ralph`

`dsh-tool-ralph/lib/index.js:10-23`:

```js
const name = "tool-ralph";
const inject = ["tools","workflowEngine","subagents","systemPrompt"];
const Config = z.object({
	subagentProvider: z.string().default("spawn"),
	maxRounds: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(256),
	maxHandoffChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16384),
	maxResultChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16384)
});
```

Ralph is a fixed deployment-owned script (`RALPH_SCRIPT`, index.js:36-123) run
through `ctx.workflowEngine.start({script, meta, args, subagentProvider,
maxTotalAgents: maxRounds, parent, signal})` (index.js:332-344). It requires a
provider whose `outputSchema` capability is true and whose
`inheritsParentContext` is false (index.js:150-156):

```js
function requireFreshProvider(ctx, name) {
	const provider = ctx.subagents.getProvider(name);
	if (provider === void 0) throw new Error(`Ralph subagent provider "${name}" is not registered`);
	if (!provider.capabilities.outputSchema) throw new Error(`Ralph subagent provider "${name}" does not support structured output`);
	if (provider.inheritsParentContext) throw new Error(`Ralph subagent provider "${name}" inherits parent context; Ralph requires a fresh provider`);
	return provider;
}
```

Ralph passes **no** provider/model override to `agent()`; the variable is the
workflow engine's `subagentProvider`, not a model route. Its tool params are only
`objective` and `maxRounds`.

---

## 7. Events emitted by these systems  ✅ VERIFIED

### 7.1 `dsh-subagent` (`lib/index.js` / `lib/types/index.d.ts:62-95`)

| Event | Payload | Mode | Emitted at |
|---|---|---|---|
| `subagent/provider-added` | `SubagentProvider` | emit | index.js:3115 |
| `subagent/provider-removed` | `name: string` | emit | index.js:3113 |
| `subagent/start` | `SubagentRunInfo` | emit, **scope-filtered by parent carrier** | index.js:312, 339 |
| `subagent/end` | `SubagentRunEndInfo` | emit, scope-filtered | index.js:301, 307, 352 |

### 7.2 `dsh-workflow`

Declared at `dsh-workflow/lib/types/index.d.ts:17-71`; dispatched through
`WorkflowEngine.emitWorkflowEvent` (`lib/index.js:68-77`):

| Event | Payload | Emitted at |
|---|---|---|
| `workflow/start` | `(info: WorkflowRunInfo)` | worker-thread `lib/index.js:910` |
| `workflow/phase` | `(info, title: string)` | :898 |
| `workflow/log` | `(info, message: string)` | :901 |
| `workflow/agent-start` | `(info, agent: WorkflowAgentInfo)` | :904 |
| `workflow/agent-end` | `(info, agent: WorkflowAgentEndInfo)` | :907 |
| `workflow/end` | `(info, result: WorkflowResultInfo)` | :912 |

`WorkflowAgentInfo` = `{seq, label, phase?, childId}`; `WorkflowAgentEndInfo`
adds `outcome: 'completed'|'failed'|'cancelled'` (`dsh-workflow/lib/types/types.d.ts:87-103`).
Consumer example: `dsh-tool-workflow/lib/index.js:49-68` listens to
`workflow/agent-start` / `workflow/agent-end`.

### 7.3 `dsh-agent` / `dsh-agent-loop` (`dsh-agent/lib/types/runtime-types.d.ts:212-417`)

`agent/created {agent}` (emit) · `agent/disposed {agent}` (emit) ·
`agent/status {agent,status}` (emit) · `agent/inbox/inserted {agent,message}` ·
`agent/inbox/claimed {agent,message,turn}` · `agent/inbox/discarded` ·
`agent/session-start {agent,source}` · **`agent/pre-step {...}, next`** (waterfall,
`Promise<PreStepDecision>`) · **`agent/request {...}, next`** (waterfall,
`Promise<LlmCallConfig>`) · **`agent/request-error {...}, next`** (waterfall) ·
`agent/assistant-stream {agent,frame}` · `agent/turn-stopping` (**serial**) ·
`agent/error {agent,turn,step,error}`.

Also `agent/inbox/spliced` is a durable **session** event
(`dsh-agent/lib/types/types.d.ts:80-87`).

Emitted from `dsh-agent-loop/lib/index.js`: `agent/inbox/claimed` (:107),
`agent/inbox/discarded` (:207), `agent/inbox/inserted` (:208),
`agent/status` (:781), `agent/error` (:863), `agent/assistant-stream` (:1032).

Subagent-driver listeners (examples of the waterfall contract):
`dsh-subagent-in-process-driver/lib/index.js:141` —
`childCtx.on("agent/pre-step", async ({ agent }, next) => {...})`;
`:86` — `childCtx.on("tools/result", function(exec, result) {...})`.

No use of `ctx.parallel(` / `ctx.waterfall(` was found in these packages
(NOT FOUND); waterfall-style events are consumed with `ctx.on(name, (payload, next) => ...)`.
`ctx.on` is used everywhere as listed above.

---

## 8. Agent factory / creating agents programmatically  ✅ VERIFIED

### 8.1 The registry

`dsh-agent` registers service **`agents`** —
`declare module '@deepseek-ai/cordis' { interface Context { agents: AgentRegistry } }`
(`dsh-agent/lib/types/index.d.ts:18-22`). It does **not** implement creation;
it delegates to a factory.

`dsh-agent/lib/types/index.d.ts:154-186`:

```ts
export interface AgentFactory {
    createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>;
    resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>;
}
```

`AgentRegistry` public API (index.d.ts:199-362): `currentInitiator()`,
`requireInitiator()`, `withInitiator(agent, op)`, `withoutInitiator(op)`,
`setFactory(factory): () => void`, `create(options): Promise<AgentHandle>`,
`resume(options): Promise<AgentHandle>`, `register(agent)`,
`enter(agent, owner)`, `announce(agent)`, `get(id)`, `isOwnedBy(id, owner)`,
`list()`, `roots()`. `private requireFactory`.

`CreateAgentOptions` (index.d.ts:48-105): `{ sessionId, parentAgent?, meta?
{cwd?, parentSession?, isSeeded?, origin?: 'subagent', delegationDepth?,
agentPreset?}, inheritedEventCount?, seed?, agentOptions?, signal?, setup? }`.
`AgentHandle` = `{ agent: Agent; dispose(): Promise<void> }` (index.d.ts:144-147).

### 8.2 How agent-loop registers the factory

`dsh-agent-loop/lib/index.js:1480-1533` (verbatim excerpt):

```js
var AgentLoop = class extends Service {
	static inject = [
		"agents",
		"sessions",
		"llm",
		"tools",
		"systemPrompt",
		"sessionProjections"
	];
	static Config = z.object({
		maxParallelToolCalls: z.number().step(1).min(1).default(10),
		agents: z.array(z.object({
			id: z.string().required(),
			sessionId: z.string().min(1),
			provider: z.string(),
			model: z.string(),
			reasoningEffort: z.string().min(1),
			maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
			cwd: z.string(),
			resumeSessionId: z.string()
		})).default([])
	});
	...
	constructor(ctx, config) {
		super(ctx, "agentLoop");
		...
		ctx.effect(() => ctx.agents.setFactory(this), "agentLoop.setFactory()");
```

`AgentLoop.createAgent` — index.js:1818-1838:

```js
async createAgent(ownerCtx, options) {
	const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
		...options.seed === void 0 ? {} : { seed: options.seed },
		...options.meta === void 0 ? {} : { meta: options.meta },
		...options.inheritedEventCount === void 0 ? {} : { inheritedEventCount: options.inheritedEventCount }
	}));
	const published = (async () => {
		let stored;
		try {
			stored = options.signal === void 0 ? await this.createStoredSession(preparation.session) : await raceAbortCall(...);
		} catch (error) {
			preparation[Symbol.dispose]();
			throw error;
		}
		return this.setupAndPublish(ownerCtx, options.sessionId, preparation, options.agentOptions ?? {}, options.setup, options.signal, "startup", stored, options.parentAgent);
	})();
	this.ownership.trackWrapper(published);
	return published;
}
```

### 8.3 Can a plugin create agents/sessions programmatically? YES

VERIFIED by contract and by the shipped provider:
`ctx.agents.create(options)` / `ctx.agents.resume(options)` return an
`AgentHandle`. The README states this directly
(`dsh-agent-loop/README.md:61-72`):

> Plugins and hosts create agents through `ctx.agents.create()` and resume persisted sessions through `ctx.agents.resume()`; both return an `AgentHandle` whose `dispose()` owns exact teardown.

and the subagent driver itself does exactly this
(`dsh-subagent-in-process-driver/lib/index.js:180`):
`await parent.ctx.agents.create({...})`.

Required preconditions (VERIFIED):
- The `dsh-agent-loop` row must be mounted, otherwise `requireFactory` rejects.
- `ctx.agents.resume(...)` additionally requires `ctx.sessionPersistence`
  (agent-loop `lib/index.js:1877-1878`).
- `options.sessionId` is caller-supplied and must be unique.

The live `Agent` interface (agent-scoped, `dsh-agent/lib/types/runtime-types.d.ts:138-210`)
gives a plugin: `options`, `session`, `inbox`, `status`, `ctx`,
`cancel(cause, options?)`, `whenIdle()`, `runMaintenance(task)`,
`send(message, target, wakeup)`, `followup(message)`, `steer(message)`,
`inject(message)`.

---

## 9. `dsh-tool-subagent-control` (send_message / interrupt_agent / list_agents)

`lib/index.js:15-16`: `const name = "tool-subagent-control"; const inject = ["tools","subagents"];`

- `send_message({agent_id, message})` → `{messageId}` — index.js:22-60; calls
  `ctx.subagents.sendMessage(sender, brandString(args.agent_id), [{type:'text',text}], { signal: exec.signal })`.
  The tool definition is wrapped in `markAdjacentAgentSendMessageTool(...)`
  (`@deepseek-ai/dsh-subagent/internal`, index.js:3) so the continuation layer
  recognizes the standard tool.
- `interrupt_agent({agent_id})` → `{accepted: true}` — index.js:61-92; calls
  `ctx.subagents.interrupt(id, { kind: "ancestor", agent: caller })`.
- `list_agents({scope: 'children'|'descendants'})` lives in a **separate entry
  point** `dsh-tool-subagent-control/list-agents` with
  `inject = ['tools','subagents','agents']` (`lib/types/list-agents.js:11-12`).
  It maps `ctx.subagents.listChildren/listDescendants` rows through
  `project()` (skipping non-continuable children) and derives `status` from
  `ctx.agents.get(id)?.status` (lines 24-47).

---

## 10. Gaps / NOT FOUND

- No subagent provider other than `spawn` and `fork` is installed (no ACP/
  Codex/Claude-Code backend package). The README references them; they are not
  present in this installation.
- `ctx.parallel(` and `ctx.waterfall(` calls: NOT FOUND in any of the packages
  inspected. Cordis waterfall semantics appear as `ctx.on(name, (payload, next) => ...)`
  for `agent/pre-step`, `agent/request`, `agent/request-error`.
- A public API to enumerate **live runs** (as opposed to provider names or
  durable children) is NOT FOUND. Use `ctx.agents.list()` /
  `ctx.agents.get(id)?.status` for liveness and `listChildren`/`listDescendants`
  for durable discovery.
- No public "spawn without a parent Agent" path: `SubagentStartRequest.parent`
  is required and `dsh-subagent-in-process-driver` derives workspace and lineage
  from it.
