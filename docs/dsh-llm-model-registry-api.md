# DSH LLM / Model Registry — Runtime API Reference (v0.1.5-rc.1)

Scope: how a plugin (including a dynamic Cordis Plugin and an installed third-party plugin) reaches LLM
providers and models at **runtime** in the live harness process.

Installation root (all paths below are relative to it unless absolute):

```
# The harness installation root. Yours will differ; resolve it with
#   node -e "console.log(require.resolve('@deepseek-ai/dsh/package.json'))"
DSH_ROOT=<your dsh installation>
PKGS=$DSH_ROOT/node_modules/@deepseek-ai
```

Every claim is marked **VERIFIED (file:line)** or **NOT FOUND**. Package `package.json` versions are
`0.1.5-rc.2` for the LLM packages while the CLI itself is `0.1.5-rc.1` (`DSH_ROOT/package.json`).

Two independent sources of truth were used, and both agree:

1. **Compiled library source** — `PKGS/<pkg>/lib/**/*.js` and the shipped `lib/types/**/*.d.ts`.
2. **The live process itself** — `cordis_inspect_query(platform:"host", provider:"Service"|"Event")`,
   which reads the *running* Cordis registry (service keys, exact method signatures, registered event
   names and modes).

---

## 0. Executive summary (the 12 facts that matter)

| # | Fact | Status |
|---|---|---|
| 1 | The injection key is exactly `llm`; the class is `LlmRuntime`. Optional read is `ctx.get('llm')`; hard dependency is `inject: ['llm']` + `ctx.llm`. | VERIFIED |
| 2 | Enumerate providers: `ctx.llm.listProviders(): LlmProviderInfo[]` → `{id, name}`. | VERIFIED |
| 3 | Enumerate models: `await ctx.llm.listModels(provider): Promise<LlmModelInfo[]>` → `{provider, id, name, description?, inputModalities?}`. **The catalog is advisory only.** | VERIFIED |
| 4 | Exact model capabilities: `await ctx.llm.resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>` → adds `context.contextWindow`, `defaultMaxTokens`, `reasoning.efforts[]/defaultEffort`, `systemPromptUpdate`. | VERIFIED |
| 5 | Validate an intended call before dispatch: `await ctx.llm.resolveCallConfig({provider, model, reasoningEffort}, signal?)`. | VERIFIED |
| 6 | Full per-model capability set is **small**: context window, default max output tokens, input modalities (`text`/`image`), reasoning efforts, system-prompt-update mode. There is **no** pricing field, **no** tool-calling flag, **no** `isThinking` boolean. | VERIFIED |
| 7 | Catalogs are **hybrid**: `dsh-llm-deepseek` ships a hardcoded `DEFAULT_MODELS` array; `dsh-llm-pi-ai` uses the installed `@earendil-works/pi-ai` builtin catalog **plus** a real HTTP `GET {baseURL}/models` discovery path. Third-party adapters do live HTTP themselves. | VERIFIED |
| 8 | A plugin reads the current session model from `agent.session.requestHeader()?.config` (an `EpochHeader` whose `config` is an `LlmCallConfig`). | VERIFIED |
| 9 | A plugin switches the model for a child agent by either (a) `ctx.subagents.start(name, {agentOptions:{provider,model,reasoningEffort}})` or (b) `installModelSelection(childCtx, {current, assembled})` from `@deepseek-ai/dsh-agent`. | VERIFIED |
| 10 | **No capability-matching router / model orchestrator exists anywhere** in the shipped packages or in the live service registry. The only existing "selection" logic is an exact-route **allowlist** for subagents and a fixed fallback priority chain for auxiliary calls. | VERIFIED (absence) |
| 11 | The LLM layer emits exactly **two** Cordis events: `llm/adapters-updated` (emit, **payload-free**) and `llm/stream` (waterfall). There is **no** request/response completion event. | VERIFIED (live registry) |
| 12 | `list_subagent_models` lives in `dsh-tool-subagent`, not `dsh-subagent`. It returns a **plain string**, not structured JSON, and it is filtered by a durable per-session route allowlist. | VERIFIED |

---

## 1. The `llm` service and its full public method surface

### 1.1 Service name and access

**VERIFIED** — `PKGS/dsh-llm/lib/types/index.d.ts:28-31`:

```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        llm: LlmRuntime;
    }
```

**VERIFIED** — `PKGS/dsh-llm/lib/index.js:1748` (service key registration):

```js
constructor(ctx) {
    super(ctx, "llm");
}
```

Live confirmation (**VERIFIED**, `cordis_inspect_query` host `Service.listService` with
`{"service":"llm"}`) — the live registry reports the key `"llm"` with this access contract:

```json
"access": {
  "optional": { "expression": "ctx.get(\"llm\")", "requiresUndefinedCheck": true },
  "hardDependency": { "inject": ["llm"], "expression": "ctx.llm" }
}
```

**Cross-checked by a real third-party plugin** — `~/.dsh/profiles/web/node_modules/@furongjun1999/dsh-memory/lib/llm_adapter.js:206-208`:

```js
// 注意：不能直接读 ctx.llm——Cordis 未声明 inject 的属性访问会抛
// "cannot get property without inject"；ctx.get('llm') 安全返回 undefined。
const llm = ctx.get('llm');
```

→ **Rule for the Model Orchestrator:** declare `inject: ['llm']` on the plugin row, or use
`ctx.get('llm')` + undefined check for an optional dependency.

### 1.2 Complete public method surface

All of the following are **VERIFIED** from `PKGS/dsh-llm/lib/types/index.d.ts` (declaration lines given)
and confirmed live by `Service.listService` (the live catalog shows the `@Remote` decorations too).

| Method | Declaration | Line |
|---|---|---|
| `registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle` | d.ts | 248 |
| `listProviders(): LlmProviderInfo[]` — `@Remote` | d.ts | 267 |
| `registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle` | d.ts | 276 |
| `listConfigurableProviders(): LlmConfigurableProvider[]` — `@Remote` | d.ts | 281 |
| `registerModelDiscovery(settingsNs, discover): () => void` | d.ts | 292 |
| `discoverModels(settingsNs, request, signal?): Promise<LlmDiscoveredModel[]>` | d.ts | 303 |
| `remoteDiscoverModels(settingsNs, request, signal)` — `@Remote('discoverModels')` | d.ts | 312 |
| `providerRetryPolicy(provider: string): ResolvedRetryPolicy` | d.ts | 318 |
| `imageRequestPricing(provider, model): LlmImageRequestPricing \| undefined` | d.ts | 328 |
| `fileRequestText(ref: FileAttachmentRef): string` | d.ts | 335 |
| `listModels(provider: string): Promise<LlmModelInfo[]>` | d.ts | 344 |
| `resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>` | d.ts | 354 |
| `resolveCallConfig(config: LlmCallConfig, signal?): Promise<LlmCallConfig>` | d.ts | 368 |
| `prepareCall(config: LlmCallConfig, signal?): Promise<PreparedLlmCall>` | d.ts | 380 |
| `stream(options: GenerateOptions): AsyncIterable<StreamChunk>` | d.ts | 406 |

Verbatim signatures (**VERIFIED**, `PKGS/dsh-llm/lib/types/index.d.ts:267`, `:344`, `:354`):

```ts
    /**
     * Describe provider routes with a registered adapter.
     * @returns detached provider metadata in registration order.
     */
    listProviders(): LlmProviderInfo[];
```

```ts
    /**
     * Discover models advertised by one registered provider. Catalog membership
     * is advisory and never changes routing or request validation.
     * @param provider - registered provider route to inspect.
     * @returns detached model metadata in adapter-preferred order.
     */
    listModels(provider: string): Promise<LlmModelInfo[]>;
```

```ts
    /**
     * Resolve and validate all metadata from the adapter that owns one exact
     * route. The result is detached from adapter-owned objects; catalog
     * membership remains advisory and does not control request routing.
     * @param provider - registered provider route to inspect.
     * @param model - exact model id passed to the adapter.
     * @param signal - optional cancellation for adapter-owned asynchronous lookup.
     * @returns exact model identity plus available context and reasoning metadata.
     */
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
```

Only three methods cross the Remote (browser) boundary — **VERIFIED**,
`PKGS/dsh-llm/lib/index.js:1701-1703`:

```js
			_listProviders_decorators = [Remote];
			_listConfigurableProviders_decorators = [Remote];
			_remoteDiscoverModels_decorators = [Remote("discoverModels")];
```

and `PKGS/dsh-llm/lib/typert.remote-client.d.ts` declares exactly:

```ts
  interface TypertRemoteMap {
    'llm/discoverModels': (settingsNs: string, request: LlmModelDiscoveryRequest, signal?: AbortSignal) => Promise<RemoteResult<LlmDiscoveredModel[]>>
    'llm/listConfigurableProviders': () => Promise<RemoteResult<LlmConfigurableProvider[]>>
    'llm/listProviders': () => Promise<RemoteResult<LlmProviderInfo[]>>
  }
```

→ **Consequence for a Model Orchestrator:** enumeration is available to *both* halves — a Host plugin
calls `ctx.llm.*` directly; a **Client** (browser) half can only call `listProviders`,
`listConfigurableProviders`, and `discoverModels` through the generated remote namespace. Everything
else (`listModels`, `resolveModelInfo`, `resolveCallConfig`, `prepareCall`, `stream`) is **Host-only**.

### 1.3 Runtime behaviour of the enumerators (compiled source)

**VERIFIED** — `PKGS/dsh-llm/lib/index.js:1846-1848`:

```js
		listProviders() {
			return [...this.adapters.values()].map(({ provider }) => ({ ...provider }));
		}
```

**VERIFIED** — `PKGS/dsh-llm/lib/index.js:2018-2033` (`listModels`; note the strict validation, and that
`provider` is forced to the queried route):

```js
		async listModels(provider) {
			const models = await this.registration(provider).adapter.listModels(provider);
			const seen = /* @__PURE__ */ new Set();
			return models.map((model) => {
				if (typeof model.provider !== "string" || model.provider !== provider || typeof model.id !== "string" || model.id.length === 0 || typeof model.name !== "string" || model.name.length === 0 || model.description !== void 0 && typeof model.description !== "string" || seen.has(model.id)) throw new LlmError(`adapter returned invalid or duplicate model metadata for provider "${provider}"`, "INVALID_CATALOG");
				seen.add(model.id);
				const inputModalities = this.detachedModalities(model.inputModalities);
				return {
					provider: model.provider,
					id: model.id,
					name: model.name,
					...model.description === void 0 ? {} : { description: model.description },
					...inputModalities === void 0 ? {} : { inputModalities }
				};
			});
		}
```

**VERIFIED** — `PKGS/dsh-llm/lib/index.js:2043-2048`:

```js
		async resolveModelInfo(provider, model, signal) {
			return this.resolveModelInfoFor(this.registration(provider), model, signal);
		}
		async resolveModelInfoFor(registration, model, signal) {
			const resolved = await registration.adapter.resolveModel(registration.provider.id, model, signal);
			return this.normalizeModelInfo(registration, model, resolved);
		}
```

**VERIFIED** — unknown provider fails loud: `PKGS/dsh-llm/lib/index.js:2174-2179`:

```js
		registration(provider) {
			const registration = this.adapters.get(provider);
			if (!registration) throw new LlmError(`no adapter registered for provider "${provider}"`, "NO_ADAPTER");
			return registration;
		}
```

### 1.4 The adapter contract a provider plugin must satisfy

**VERIFIED** — `PKGS/dsh-llm/lib/index.js:1618-1687` (base class defaults; only `stream` is abstract):

```js
var LlmAdapter = class {
	providerInfo(provider) {
		return {
			id: provider,
			name: provider
		};
	}
	providerRetryPolicy(_provider) {}
	imageRequestPricing(_provider, _model) {}
	listModels(_provider) {
		return Promise.resolve([]);
	}
	resolveModel(provider, model, _signal) {
		return Promise.resolve({
			provider,
			id: model,
			name: model
		});
	}
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream(options)
		};
	}
};
```

**VERIFIED** — the adapter's `providerInfo().id` must equal the registered route, and duplicate routes
fail (`PKGS/dsh-llm/lib/index.js:1805-1825`):

```js
				if (unique.has(provider) || this.adapters.has(provider) && !owned.has(provider)) throw new LlmError(`an adapter for provider "${provider}" is already registered`, "DUPLICATE_ADAPTER");
				const info = adapter.providerInfo(provider);
				if (typeof info.id !== "string" || info.id !== provider || typeof info.name !== "string" || info.name.length === 0) throw new LlmError(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`, "INVALID_ADAPTER");
```

→ Subclassing `LlmAdapter` is **not required**: a real shipped third-party plugin registers a plain
duck-typed object. **VERIFIED** —
`~/.dsh/profiles/web/node_modules/@furongjun1999/dsh-memory/lib/llm_adapter.js:105` (`export class WhiteboxLlmAdapter {`) and `:243` (`llm.registerAdapter([WHITEBOX_PROVIDER], adapter)`).

---

## 2. Model descriptor metadata — every field

There are **three** descriptor types plus supporting types. There is no single "model" type carrying
pricing or tool support.

### 2.1 `LlmModelInfo` (the catalog entry)

**VERIFIED** — `PKGS/dsh-llm/lib/types/types.d.ts:276-288`:

```ts
/** One adapter-discovered model; catalog membership is advisory, not request validation. */
export interface LlmModelInfo {
    /** Provider route that owns this model entry. */
    provider: string;
    /** Model id passed to {@link GenerateOptions.model}. */
    id: string;
    /** Human-readable model name for selectors. */
    name: string;
    /** Optional user-facing distinction from otherwise similar models. */
    description?: string;
    /** Accepted request modalities; absent means unknown, while an explicit omission is negative capability. */
    inputModalities?: readonly ModelModality[];
}
```

### 2.2 `LlmResolvedModelInfo` (the capability record — **this is what a router should use**)

**VERIFIED** — `PKGS/dsh-llm/lib/types/types.d.ts:320-330`:

```ts
/** Exact-route model metadata resolved by its owning adapter. */
export interface LlmResolvedModelInfo extends LlmModelInfo {
    /** Provider-owned context capacity when known. */
    context?: LlmModelContext;
    /** Adapter-configured per-request output cap materialized when callers omit one. */
    defaultMaxTokens?: number;
    /** Adapter-owned selectable reasoning levels when exposed. */
    reasoning?: LlmModelReasoningInfo;
    /** Declared mid-conversation system prompt handling; absent means only a leading system message is read. */
    systemPromptUpdate?: SystemPromptUpdate;
}
```

Supporting types (**VERIFIED**, same file):

```ts
/** Provider-owned context capacity for one exact provider/model route. */
export interface LlmModelContext {
    /** Maximum combined request and response context in tokens. */
    contextWindow: number;
}
```
(lines 289-293)

```ts
/** Display metadata for one adapter-owned reasoning effort. */
export interface LlmReasoningEffortInfo {
    /** Opaque stable value accepted by {@link GenerateOptions.reasoningEffort}. */
    id: ReasoningEffortId;
    /** Human-readable effort name for selectors and diagnostics. */
    name: string;
    /** Optional user-facing distinction from otherwise similar efforts. */
    description?: string;
}
/** Selectable reasoning efforts for one exact provider/model route. */
export interface LlmModelReasoningInfo {
    /** Supported efforts in adapter-preferred display order. */
    efforts: readonly LlmReasoningEffortInfo[];
    /**
     * Adapter-configured default materialized into requests when callers omit
     * an effort. Absence preserves the provider's own default.
     */
    defaultEffort?: ReasoningEffortId;
}
```
(lines 294-312)

```ts
export type SystemPromptUpdate = 'in-history';
```
(line 319)

```ts
/** Merge-extensible provider model modality vocabulary. */
export interface ModelModalityMap {
    text: 'text';
    image: 'image';
}
/** Any declared provider model modality. */
export type ModelModality = ModelModalityMap[keyof ModelModalityMap];
```
(lines 186-192)

### 2.3 `LlmProviderInfo` / `LlmDiscoveredModel` / `LlmConfigurableProvider`

**VERIFIED** — `PKGS/dsh-llm/lib/types/types.d.ts:179-185`:

```ts
/** Display metadata for one registered provider route. */
export interface LlmProviderInfo {
    /** Provider route key used by {@link GenerateOptions.provider}. */
    id: string;
    /** Human-readable provider name for selectors and diagnostics. */
    name: string;
}
```

**VERIFIED** — `PKGS/dsh-llm/lib/types/types.d.ts:261-275` (the shape returned by endpoint discovery —
note it is **not** an `LlmModelInfo`: no `provider`, no modalities):

```ts
export interface LlmDiscoveredModel {
    /** Model id the endpoint accepts. */
    id: string;
    /** Human-readable name when the endpoint supplies one. */
    name?: string;
    /** Maximum combined request and response context, when disclosed. */
    contextWindow?: number;
    /** Maximum output tokens, when disclosed. */
    maxTokens?: number;
}
```

**VERIFIED** — `PKGS/dsh-llm/lib/types/types.d.ts:199-222` (`LlmConfigurableProvider`, the
"what could be mounted" directory — crucial for a router that must also show dormant providers):

```ts
export interface LlmConfigurableProvider {
    /** Provider route key this entry activates when configured. */
    provider: string;
    /** Human-readable provider name for configuration surfaces. */
    displayName: string;
    /** User-settings namespace whose section configures this provider. */
    settingsNs: string;
    settingsPath: readonly string[];
    declared?: boolean;
    /** Configuration diagnostic for repair; unaffected models may remain serviceable. */
    error?: string;
}
```

**VERIFIED** — `LlmModelDiscoveryRequest` (`PKGS/dsh-llm/lib/types/types.d.ts:229-246`):

```ts
export interface LlmModelDiscoveryRequest {
    provider?: string;
    baseURL?: string;
    api?: string;
    apiKey?: string;
}
```

### 2.4 What is deliberately **absent** from the runtime descriptor

| Capability asked about | Availability |
|---|---|
| context window | **YES** — `LlmResolvedModelInfo.context.contextWindow` |
| max output tokens | **YES, as a *default cap*, not a ceiling** — `defaultMaxTokens`. The docs are explicit that it is a cap the deployment chose to send, not the model's capability. **VERIFIED** — `PKGS/dsh-llm-pi-ai/lib/types/catalog.d.ts`, `RouteCatalog.configuredMaxTokens` doc: *"pi-ai requires `maxTokens` as the model's output *capability*, while the harness seam's `defaultMaxTokens` is a cap the deployment chose to send on requests that name none."* |
| multimodal / vision input | **YES** — `inputModalities` contains `'image'`. Absent means *unknown*; explicit `['text']` is negative capability (**VERIFIED** types.d.ts:286) |
| tool calling support | **NOT FOUND** — no field anywhere. Tools are passed in `GenerateOptions.tools` and it is the adapter's problem. |
| reasoning support | **INFERRED ONLY** — `reasoning === undefined` means "not offered"; `reasoning.efforts.length > 0` means offered. There is no boolean. **VERIFIED** — `PKGS/dsh-llm/lib/index.js:2071-2073`: `const reasoning = resolved.reasoning; if (reasoning === void 0) return info; if (reasoning.efforts.length === 0) throw ... "INVALID_MODEL_REASONING"` |
| "is a thinking model" | **NOT FOUND** as a field. The DeepSeek adapter expresses it via the `thinking: enabled\|disabled` *deployment config* and maps it to the offered effort set. **VERIFIED** — `PKGS/dsh-llm-deepseek/lib/index.js:1591-1597` |
| pricing (USD) | **NOT FOUND.** The only pricing surface is *provider-side request-image visual tokens*: `LlmImageRequestPricing.priceImages()` (**VERIFIED** `PKGS/dsh-llm/lib/types/types.d.ts:165-178`) resolved by `ctx.llm.imageRequestPricing(provider, model)`. Token *cost* is not modelled anywhere. |
| temperature / top_p / stop | `GenerateOptions` has `temperature`, `maxTokens`, `stop?` — **VERIFIED** `PKGS/dsh-llm/lib/types/types.d.ts:389-438` |
| system-prompt update mode | **YES** — `systemPromptUpdate?: 'in-history'` |
| image pixel budget / max bytes per route | **Adapter-config only, not in `LlmResolvedModelInfo`.** DeepSeek's catalog entries carry `imagePixelBudget` / `imageMaxBytes` (**VERIFIED** `PKGS/dsh-llm-deepseek/lib/index.js:1873-1883`) |

### 2.5 Request/response types a router will touch

**VERIFIED** — `PKGS/dsh-llm/lib/types/types.d.ts:396-438` (`GenerateOptions`) and
`PKGS/dsh-llm/lib/types/call-config.d.ts`:

```ts
export interface LlmCallConfig {
    provider: string;
    model: string;
    reasoningEffort?: ReasoningEffortId;
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
}
```

`StreamChunk` (**VERIFIED** `PKGS/dsh-llm/lib/types/types.d.ts:358-386`) is the per-attempt protocol:
`block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish`; `usage`
carries `TokenUsage` and every stream ends in exactly one `finish` with
`FinishReasonMap = 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'`.

---

## 3. How models are registered — static catalog vs. dynamic discovery

**Both exist, per adapter.** There is no single central catalog.

### 3.1 `dsh-llm-deepseek` — **static, hardcoded catalog** (configurable by settings)

**VERIFIED** — `PKGS/dsh-llm-deepseek/lib/index.js:1838-1871`:

```js
const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";
/** The single provider route this plugin owns. */
const PROVIDER = "deepseek-official";
const DEFAULT_MODELS = [
	{
		id: "deepseek-flash",
		name: "DeepSeek-V41-Flash",
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		inputModalities: ["text", "image"],
		imagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
		imageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
		systemPromptUpdate: "in-history"
	},
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek-V4-Flash",
		description: "Fast, efficient, and economical; suited to focused, routine, or parallel tasks.",
		contextWindow: DEFAULT_CONTEXT_WINDOW
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek-V4-Pro",
		description: "Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.",
		contextWindow: DEFAULT_CONTEXT_WINDOW
	},
	{
		id: "deepseek-v4-flash-vision-exp",
		name: "DeepSeek-V4-Flash-Vision-Exp",
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		inputModalities: ["text", "image"],
		imagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
		imageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES
	}
];
```

`DEFAULT_CONTEXT_WINDOW = 1e6` and `DEFAULT_MAX_TOKENS = 256e3` (**VERIFIED** same file, lines 1392-1394).

The entire catalog is exposed by mapping that array (**VERIFIED** `PKGS/dsh-llm-deepseek/lib/index.js:1572-1573`
and the mapper at `:1498-1506`):

```js
	listModels(provider) {
		return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)));
	}
```

```js
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: model.inputModalities ?? ["text"]
	};
}
```

Exact-model resolution adds context, output cap and reasoning effort set
(**VERIFIED** `PKGS/dsh-llm-deepseek/lib/index.js:1575-1599`):

```js
	resolveModel(provider, model, _signal) {
		return Promise.resolve(this.modelInfoFor(this.config.options(), provider, model));
	}
	modelInfoFor(connection, provider, model) {
		const configured = connection.models.find((entry) => entry.id === model);
		const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
		return {
			...configured === void 0 ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text"]
			} : modelInfo(provider, configured),
			context: { contextWindow },
			defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
			...configured?.systemPromptUpdate === void 0 ? {} : { systemPromptUpdate: configured.systemPromptUpdate },
			...connection.defaults.thinking === "disabled" ? { reasoning: {
				efforts: OFF_ONLY_REASONING_EFFORTS,
				defaultEffort: OFF_REASONING_EFFORT
			} } : { reasoning: {
				efforts: REASONING_EFFORTS,
				defaultEffort: connection.defaults.reasoningEffort === "off" ? OFF_REASONING_EFFORT : connection.defaults.reasoningEffort === "low" ? LOW_REASONING_EFFORT : connection.defaults.reasoningEffort === "max" ? MAX_REASONING_EFFORT : HIGH_REASONING_EFFORT
			} }
		};
	}
```

The reasoning effort vocabulary is a hardcoded, adapter-owned opaque string set
(**VERIFIED** `PKGS/dsh-llm-deepseek/lib/index.js:1413-1443`):

```js
const OFF_REASONING_EFFORT = ReasoningEffortId("off");
const LOW_REASONING_EFFORT = ReasoningEffortId("low");
const HIGH_REASONING_EFFORT = ReasoningEffortId("high");
const MAX_REASONING_EFFORT = ReasoningEffortId("max");
const REASONING_EFFORTS = [
	{ id: OFF_REASONING_EFFORT, name: "Off",  description: "Use for simple tasks that do not need reasoning." },
	{ id: LOW_REASONING_EFFORT, name: "Low",  description: "Prefer for routine or latency-sensitive tasks." },
	{ id: HIGH_REASONING_EFFORT, name: "High", description: "The default balance for most tasks." },
	{ id: MAX_REASONING_EFFORT, name: "Max",  description: "Reserve for the hardest quality-first tasks." }
];
```

Catalog entry schema (what a deployment may override via settings) — **VERIFIED**
`PKGS/dsh-llm-deepseek/lib/index.js:1872-1883`:

```js
const MODEL_MODALITIES = ["text", "image"];
const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text"]),
	imagePixelBudget: z.union([z.number().step(1).min(1), "low"]),
	imageMaxBytes: z.number().step(1).min(1),
	systemPromptUpdate: z.const("in-history")
});
```

Registration — **VERIFIED** `PKGS/dsh-llm-deepseek/lib/index.js:2065-2071`:

```js
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "DeepSeek",
		settingsNs: NS,
		settingsPath: []
	}]);
	const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
```

Model ids **pass through**: an unlisted id is still accepted and treated as text-only
(**VERIFIED** `PKGS/dsh-llm-deepseek/lib/index.js:1582-1587`, the `configured === void 0` branch).
README confirms: *"the model id passes through to the wire, so new DeepSeek models need no
re-registration"* (`PKGS/dsh-llm-deepseek/README.md`).

### 3.2 `dsh-llm-pi-ai` — **installed library catalog + real HTTP discovery**

Catalog source (**VERIFIED** `PKGS/dsh-llm-pi-ai/lib/index.js:1-12` imports and `:345-373`):

```js
import { createModels, createProvider, getSupportedThinkingLevels, isContextOverflow } from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
```

```js
function catalogProviders() {
	providerIndex ??= new Map(builtinProviders().map((provider) => [provider.id, provider]));
	return providerIndex;
}
function catalogProvider(provider) {
	return catalogProviders().get(provider);
}
function catalogProviderIds() {
	return getBuiltinProviders();
}
function catalogModels(provider) {
	if (!catalogProviders().has(provider)) return /* @__PURE__ */ new Map();
	const models = getBuiltinModels(provider);
	return new Map(models.map((model) => [model.id, model]));
}
```

The adapter enumerates that merged catalog (**VERIFIED** `PKGS/dsh-llm-pi-ai/lib/index.js:1784-1816`):

```js
	listModels(provider) {
		return Promise.resolve().then(() => {
			const snapshot = this.current();
			this.profileOf(snapshot, provider);
			return snapshot.models.getModels(provider).map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				inputModalities: [...model.input]
			}));
		});
	}
	resolveModel(provider, model, _signal) {
		return Promise.resolve().then(() => {
			const snapshot = this.current();
			return this.modelInfo(snapshot, provider, model);
		});
	}
	modelInfo(snapshot, provider, model) {
		const profile = this.profileOf(snapshot, provider);
		const resolvedModel = this.modelOf(snapshot, provider, model);
		const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning);
		const configuredMaxTokens = profile.configuredMaxTokens.get(model);
		return {
			provider,
			id: model,
			name: resolvedModel.name,
			inputModalities: [...resolvedModel.input],
			context: { contextWindow: resolvedModel.contextWindow },
			...configuredMaxTokens === void 0 ? {} : { defaultMaxTokens: configuredMaxTokens },
			...reasoningInfo(resolvedModel, defaultLevel)
		};
	}
```

Reasoning efforts come from pi-ai's own level enumeration (**VERIFIED**
`PKGS/dsh-llm-pi-ai/lib/index.js:1712-1721`):

```js
function reasoningInfo(model, defaultLevel) {
	if (!model.reasoning) return {};
	return { reasoning: {
		efforts: getSupportedThinkingLevels(model).map((level) => ({
			id: ReasoningEffortId(level),
			name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`
		})),
		...defaultLevel === void 0 ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) }
	} };
}
```

**Dynamic endpoint discovery exists and is registered by the adapter itself** — **VERIFIED**
`PKGS/dsh-llm-pi-ai/lib/index.js:2639-2642`:

```js
	ctx.llm.registerModelDiscovery(NS, (request, signal) => discoverModels({
		...request,
		...signal === void 0 ? {} : { signal }
	}, () => storedDiscoveryProfile(request.provider)));
```

`NS = "llm-pi-ai"` (**VERIFIED** `:2533`). The discovery implementation does a real HTTP GET
(**VERIFIED** `PKGS/dsh-llm-pi-ai/lib/index.js:2126-2130` and `:2162-2166`):

```js
const LISTABLE_PROTOCOLS = new Set([
	"anthropic-messages",
	"openai-completions",
	"openai-responses"
]);
```

```js
function listingUrl(baseURL, api) {
	const base = baseURL.replace(/\/+$/, "");
	if (api !== "anthropic-messages") return `${base}/models`;
	return `${base.endsWith("/v1") ? base.slice(0, -3) : base}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`;
}
```

and `discoverModels` (**VERIFIED** `PKGS/dsh-llm-pi-ai/lib/index.js:2272-2322`), key lines:

```js
async function discoverModels(request, storedProfile) {
	if (request.provider !== void 0) {
		const installed = catalogModels(request.provider);
		if (installed.size > 0) return [...installed.values()].map((model) => ({
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens
		}));
	}
	if (request.baseURL === void 0 || request.baseURL.length === 0) throw new LlmError(`pi-ai ships no catalog for provider "${request.provider ?? ""}", so its models can only come from its endpoint; set a baseURL, or enter this provider's models by hand`, "DISCOVERY_FAILED");
	const api = request.api ?? "openai-completions";
	if (!LISTABLE_PROTOCOLS.has(api)) throw new LlmError(`pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`, "DISCOVERY_UNSUPPORTED");
	const url = listingUrl(request.baseURL, api);
	...
		response = await fetch(url, { method: "GET", headers, ... });
	...
	return readListing(body);
}
```

Note the **precedence**: if the adapter already knows the route from the installed catalog, it answers
**without any network call** — which is exactly what `LlmModelDiscoveryRequest.provider` documents
(**VERIFIED** `PKGS/dsh-llm/lib/types/types.d.ts:230-236`).

The reply parser accepts an OpenAI-shaped `data` array **or** an enriched `models` map
(**VERIFIED** `PKGS/dsh-llm-pi-ai/lib/index.js:2232-2247`) and sniffs many capacity spellings:

```js
		const contextWindow = capacity(entry?.contextWindow, entry?.context_window, entry?.context_length, entry?.max_input_tokens, entry?.limit?.context);
		const maxTokens = capacity(entry?.maxOutputTokens, entry?.max_output_tokens, entry?.maxTokens, entry?.max_tokens, entry?.limit?.output, entry?.top_provider?.max_completion_tokens);
```

### 3.3 Real shipped third-party adapter (the closest model for a new plugin)

`~/.dsh/profiles/web/node_modules/@mars-sea/dsh-commandcode-provider/` registers the route
`commandcode` and does **live HTTP catalog discovery with a disk-cache fallback** — this is the live
provider actually in use in this harness (`~/.dsh/settings.yaml` sets
`agent-default-model: {provider: commandcode, model: deepseek/deepseek-v4.1-flash}`).

**VERIFIED** — `.../dsh-commandcode-provider/lib/index.js:1989-2010`:

```js
	/** Refresh the catalog (live fetch, cache fallback) and return it. */
	async loadCatalog(signal) {
		const { apiBase, modelsCachePath } = this.deps.options();
		try {
			const response = await this.fetchImpl(`${apiBase}/provider/v1/models`, {
				headers: {
					accept: "application/json",
					...attributionHeaders()
				},
				signal: signal ?? AbortSignal.timeout(1e4)
			});
			if (!response.ok) throw new Error(`models endpoint returned ${response.status}`);
			this.catalog = parseCatalogResponse(await response.json());
			await writeModelsCache(modelsCachePath, this.catalog).catch(() => void 0);
		} catch (error) {
			if (signal?.aborted) throw error;
			this.catalog = await readModelsCache(modelsCachePath).catch(() => this.catalog);
		}
		return this.catalog;
	}
```

**VERIFIED** — `.../lib/index.js:2013-2035` (note it **widens** the base signature with an `opts`
argument — legal in JS, and `dsh-llm` never passes it, so this is a private extra surface):

```js
	async listModels(provider, opts) {
		const catalog = await this.loadCatalog();
		const toInfo = (model) => {
			const vision = KNOWN_IMAGE_MODELS.has(model.id);
			return {
				provider,
				id: model.id,
				name: `${model.name} (CC)`,
				description: capabilityDescription(model.id, model.contextWindow),
				inputModalities: vision ? ["text", "image"] : ["text"]
			};
		};
		if (opts?.unfiltered === true) return catalog.map(toInfo).sort(compareByPlan);
		const access = this.deps.options().filterModelsByPlan === false ? void 0 : await this.loadBillingAccess();
		const visible = this.deps.options().visibleModels;
		const allow = Array.isArray(visible) && visible.length > 0 ? new Set(visible.filter((id) => typeof id === "string" && id !== "")) : void 0;
		const overrides = this.deps.options().modelVisibility;
		return catalog.filter((model) => modelVisibleInPlan(model.id, access)).filter((model) => { ... }).map(toInfo).sort(compareByPlan);
	}
```

**Important consequence for the Model Orchestrator:** `listModels()` for this live route is
**plan- and allowlist-filtered**, so a "discover everything available" implementation must either call
`resolveModelInfo` for a known id or accept the filtered list as the user's intent.

**VERIFIED** — `.../lib/index.js:4448-4452` (registration, the exact shape to copy):

```js
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "Command Code",
		settingsNs: NS,
		settingsPath: []
	}]);
	ctx.llm.registerAdapter([PROVIDER], adapter);
```

with `const PROVIDER = "commandcode";` (**VERIFIED** `:4305`).

### 3.4 The discovery registry contract

**VERIFIED** — `PKGS/dsh-llm/lib/index.js:1921-1931`, `:1942-1960`:

```js
		registerModelDiscovery(settingsNs, discover) {
			const dispose = this.ctx.effect(function* () {
				if (settingsNs.length === 0) throw new LlmError("model discovery needs a non-empty settings namespace", "INVALID_DISCOVERY");
				if (this.discoveries.has(settingsNs)) throw new LlmError(`model discovery for "${settingsNs}" is already registered`, "DUPLICATE_DISCOVERY");
				this.discoveries.set(settingsNs, discover);
				yield () => {
					this.discoveries.delete(settingsNs);
				};
			}.bind(this), "llm.registerModelDiscovery()");
			return () => void dispose();
		}
```

```js
		async discoverModels(settingsNs, request, signal) {
			const discover = this.discoveries.get(settingsNs);
			if (discover === void 0) throw new LlmError(`no model discovery is registered for "${settingsNs}"`, "NO_DISCOVERY");
			if ((request.provider ?? "").length === 0 && (request.baseURL ?? "").length === 0) throw new LlmError("model discovery needs a provider route or a baseURL", "INVALID_DISCOVERY");
			const discovered = signal === void 0 ? await discover(request) : await discover(request, signal);
			const seen = /* @__PURE__ */ new Set();
			const models = [];
			for (const model of discovered) {
				if (typeof model.id !== "string" || model.id.length === 0 || seen.has(model.id)) continue;
				seen.add(model.id);
				models.push({ id: model.id, ...name, ...contextWindow, ...maxTokens });
			}
			return models;
		}
```

→ Discovery is **keyed by settings namespace**, not by provider, and dedupes by `id` in endpoint order.

### 3.5 Concrete live topology of *this* harness

**VERIFIED** (files on disk):

- `~/.dsh/profiles/web/package.json` → `dsh.profile.bundles` = `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-better-sidebar", "dsh-flowglass", "@mars-sea/dsh-commandcode-provider", "dsh-ssh-tunnel", "dshmarket", "@furongjun1999/dsh-memory", "@nanmicoder/dsh-agent-teams"]`
- `~/.dsh/settings.yaml` → `agent-default-model: {provider: commandcode, model: deepseek/deepseek-v4.1-flash}`; `llm-pi-ai: {providers: {}}`; `subagent-model-selection` with 7 allowed `commandcode` routes.
- `~/.dsh/profiles/web/cordis.yml` is `[]`; the tree is composed from bundles + `cordis.patch.yml` (also `[]`).

→ The **only** live provider route is `commandcode`. `deepseek-official` and pi-ai routes are **not
mounted** in this profile. Any orchestrator must therefore never hardcode route names.

---

## 4. Reading the current model, and switching/overriding it

### 4.1 Read the model the current session/agent is using

**Primary mechanism — the durable request header.**

**VERIFIED** — `PKGS/dsh-session/lib/types/types.d.ts:208-215`:

```ts
export interface EpochHeader {
    /** The conversation's call configuration (provider, model, reasoning effort, and sampling scalars). */
    config: LlmCallConfig;
    /** Effective config fields materialized from the exact adapter rather than proposed by a caller. */
    adapterDefaults?: LlmCallConfigAdapterDefaults;
    /** Assembled tool schemas; absent for a tool-less request. */
    tools?: ToolSchema[];
}
```

**VERIFIED** — `PKGS/dsh-session/lib/types/index.d.ts:244-251`:

```ts
    /**
     * The {@link EpochHeader} in force after the log's last header event — the
     * ...
     */
    requestHeader(): EpochHeader | undefined;
```

The canonical inheritance helper (**VERIFIED** `PKGS/dsh-subagent/lib/index.js:446-456`):

```js
function parentAgentOptionsForDelegation(parent) {
	const requestConfig = parent.session.requestHeader()?.config;
	if (requestConfig === void 0) return { ...parent.options };
	const { provider: _createdProvider, model: _createdModel, reasoningEffort: _createdReasoningEffort, ...createdOptions } = parent.options;
	return {
		...createdOptions,
		provider: requestConfig.provider,
		model: requestConfig.model,
		...requestConfig.reasoningEffort === void 0 ? {} : { reasoningEffort: requestConfig.reasoningEffort }
	};
}
```

with the documented precedence (**VERIFIED** `PKGS/dsh-subagent/lib/index.js:438-442`):
*"The latest request header owns provider, model, and reasoning effort after request-time selection;
creation options remain the fallback before the first request."*

Other read paths:

- `agent.options` → `AgentOptions = { provider?, model?, reasoningEffort?, maxTokens? }` (**VERIFIED**
  `PKGS/dsh-agent/lib/types/runtime-types.d.ts:22-31`).
- Deployment default for **new** agents: `ctx.agentDefaultModel.currentSelection()` (**VERIFIED**
  `PKGS/dsh-agent-default-model/lib/index.js:57-59`).
- Service key `agentDefaultModel`, live signature `currentSelection(): ModelSelection` — **VERIFIED**
  by live `Service.listService`.
- Host-side catalog projection for the UI (**VERIFIED** `PKGS/dsh-api-session-controller/lib/types/catalog.js:8-56`).

### 4.2 Switch the model — four distinct mechanisms

**(a) Per-call, direct — `ctx.llm.stream()` / `prepareCall`.**
The provider/model are plain request fields (**VERIFIED** `PKGS/dsh-llm/lib/types/types.d.ts:396-401`):

```ts
export interface GenerateOptions {
    /** Registered provider route selecting the adapter instance. */
    provider: string;
    model: string;
    /** Adapter-owned reasoning effort selected for this exact model. */
    reasoningEffort?: ReasoningEffortId;
```

This is what auxiliary callers do, and it is the mechanism a third-party plugin used to implement a
provider **fallback** (**VERIFIED** `.../dsh-memory/lib/llm_adapter.js:213-221`):

```js
    const fallback = llm.stream
        ? {
            stream(options) {
                return llm.stream({ ...options, provider: fallbackProvider });
            },
        }
        : undefined;
```

**(b) Agent-scoped live override — `installModelSelection`.**
This is the *supported* mechanism for switching a live agent's model (including a child agent).

**VERIFIED** — `PKGS/dsh-agent/lib/types/model-selection.d.ts:42`:

```ts
export declare function installModelSelection(agentCtx: Context, selection: ModelSelectionRef): () => void;
```

with (**VERIFIED** `PKGS/dsh-agent/lib/types/model-selection.d.ts:6-22`):

```ts
export interface ModelSelection {
    /** Registered provider route. */
    provider: string;
    /** Provider-owned model id. */
    model: string;
    /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
    reasoningEffort?: ReasoningEffortId;
}
/** Mutable model selection plus the value captured for the current step. */
export interface ModelSelectionRef {
    /** Model selected for the next step that enters prompt assembly. */
    current: ModelSelection | undefined;
    /** Selection captured when the current step entered prompt assembly. */
    assembled: ModelSelection | undefined;
}
```

Implementation (**VERIFIED** `PKGS/dsh-agent/lib/types/model-selection.js:46-95`) — the two waterfalls
that actually perform the switch:

```js
export function installModelSelection(agentCtx, selection) {
    const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selected = selection.current;
        const assembled = await next();
        selection.assembled = selected;
        if (selected === undefined)
            return assembled;
        return {
            ...assembled,
            variables: {
                ...assembled.variables,
                provider: selected.provider,
                model: selected.model,
            },
        };
    });
    const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
        const resolved = await next();
        const selected = selection.assembled;
        if (selected === undefined)
            return resolved;
        const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved;
        return {
            ...withoutInheritedEffort,
            provider: selected.provider,
            model: selected.model,
            ...selected.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: selected.reasoningEffort },
        };
    });
    const disposeNotice = agentCtx.on('agent/pre-step', async ({ agent, messages, signal, step }, next) => { /* appends a model-switch notice */ }, { prepend: true });
    return () => { disposeAssembly(); disposeRequest(); disposeNotice(); };
}
```

The notice text is a real model-visible message (**VERIFIED** `PKGS/dsh-agent/lib/types/model-selection.js:12-27`):

```js
function modelSwitchNotice(previous, selected) {
    const from = routeLabel(previous, selected);
    const to = routeLabel(selected, previous);
    return createUserMessage({
        content: [{
                type: 'text',
                text: `[model changed: assistant turns above this point were generated by ${from}; the session continues with ${to}]`,
            }],
        source: { kind: 'plugin', plugin: 'model-selection', form: 'notice', summary: boundContextSummary(`${from} → ${to}`) },
    });
}
```

**(c) Override the model for a child agent/subagent — two paths.**

Path 1 — pass `agentOptions` into the subagent start request. **VERIFIED**
`PKGS/dsh-subagent/lib/types/types.d.ts:153-164`:

```ts
    /**
     * Optional host-Agent provider, model, reasoning-effort, and output-token
     * overrides. Requires {@link SubagentCapabilities.agentOptions}; in-process
     * providers merge them over the parent Agent's options when they create the
     * child, while the DSH SDK provider merges them over its instance defaults
     * before initializing the separate child runtime.
     */
    readonly agentOptions?: AgentOptions;
```

and the service entry point (**VERIFIED** `PKGS/dsh-subagent/lib/types/index.d.ts:296`):

```ts
    start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
```

The child-option merge and the effort-clearing rule (**VERIFIED** `PKGS/dsh-subagent/lib/index.js:468-483`):

```js
function resolveChildAgentOptions(parent, requested, childDepth) {
	const parentOptions = parentAgentOptionsForDelegation(parent);
	...
	const resolved = {
		...parentProvider !== void 0 ? { provider: parentProvider } : {},
		...parentModel !== void 0 ? { model: parentModel } : {},
		...parentReasoningEffort !== void 0 ? { reasoningEffort: parentReasoningEffort } : {},
		...parentMaxTokens !== void 0 ? { maxTokens: parentMaxTokens } : {},
		...requested,
		subagentDepth: childDepth
	};
	if ((resolved.provider !== parentProvider || resolved.model !== parentModel) && requested?.reasoningEffort === void 0) delete resolved.reasoningEffort;
	return resolved;
}
```

Preflight validation before the child is created (**VERIFIED** `PKGS/dsh-tool-subagent/lib/index.js:117-128`):

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

Path 2 — **install a live selection on the child's own context**. This is what the shipped
`@nanmicoder/dsh-agent-teams` plugin does, and it is the most directly reusable pattern for a Model
Orchestrator. **VERIFIED** — `~/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/lib/members.js:14, 346-376`:

```js
import { installModelSelection } from '@deepseek-ai/dsh-agent';
```
```js
        const selectionRef = { current: modelSelection(selection), assembled: undefined };
        const disposeSelection = installModelSelection(childCtx, selectionRef);
        const fallback = selection.fallback;
        let switched = false;
        const disposeFallback = childCtx.on('agent/request-error', async (payload, next) => {
            if (payload.agent.id !== child.id || payload.signal.aborted)
                return next();
            const transition = selectFallbackRoute(selectionRef.current ?? { provider: selection.provider, model: selection.model }, fallback, payload.failure.code, switched);
            if (fallback !== undefined && transition.retry) {
                switched = transition.switched;
                selectionRef.current = transition.selection;
                // Request recovery repeats buildRequest inside the current step; it
                // does not re-run prompt assembly. Override that captured route too,
                // otherwise the authorized retry would hit the failed primary again.
                selectionRef.assembled = transition.selection;
                ...
                return { kind: 'retry' };
            }
            return next();
        });
```

Note the critical detail in the comment: **`assembled` must be updated too**, because retry recovery
re-enters `buildRequest` inside the same step without re-running prompt assembly.

**(d) Session-level selection (durable, user-facing).**
`selectModel` validates through `resolveCallConfig`, appends a durable `model/selection` event, and
saves the deployment default. **VERIFIED** — `PKGS/dsh-api-session-controller/lib/index.js:605-634`:

```js
	async selectModel(request) {
		const agent = await this.resolveAgent(request.sessionId);
		return this.agents.serializeImageAdmission(agent, async () => {
			try {
				const resolved = await this.ctx.llm.resolveCallConfig({
					provider: request.provider,
					model: request.model,
					...request.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }
				});
				const selected = {
					provider: resolved.provider,
					model: resolved.model,
					...resolved.reasoningEffort === void 0 ? {} : { reasoningEffort: resolved.reasoningEffort }
				};
				this.agents.selectForNextRequest(agent, selected);
				try {
					await this.ctx.agentDefaultModel.saveSelection(selected);
				} catch (error) {
					this.ctx.logger.warn(`session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`);
				}
				return { selected: { ...selected } };
			} catch (error) { /* throws RemoteError "session/model-unavailable" */ }
		});
	}
```

Request type (**VERIFIED** `PKGS/dsh-api-session-controller/lib/types/types.d.ts:264-270`):
`SessionSelectModelRequest extends ModelSelection { readonly sessionId: SessionId }` returning
`{ readonly selected: ModelSelection }`. Declared `@Remote` at
`PKGS/dsh-api-session-controller/lib/types/index.d.ts:92`. This is a Client-facing RPC, not a
Host plugin API.

### 4.3 Validation gate every switch must pass

**VERIFIED** — `PKGS/dsh-llm/lib/index.js:2111-2135`:

```js
		resolveCallWithInfo(config, info) {
			const defaulted = config.maxTokens === void 0 && info.defaultMaxTokens !== void 0 ? {
				...config,
				maxTokens: info.defaultMaxTokens
			} : config;
			const reasoning = info.reasoning;
			const requested = defaulted.reasoningEffort;
			let resolvedConfig = defaulted;
			if (reasoning === void 0) {
				if (requested !== void 0) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`, "UNSUPPORTED_REASONING_EFFORT");
			} else {
				const effective = requested ?? reasoning.defaultEffort;
				if (effective !== void 0) {
					if (!reasoning.efforts.some((effort) => effort.id === effective)) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`, "UNSUPPORTED_REASONING_EFFORT");
					if (requested !== effective) resolvedConfig = { ...defaulted, reasoningEffort: effective };
				}
			}
			return { config: resolvedConfig, ...info.context === void 0 ? {} : { context: info.context }, modelInfo: info };
		}
```

→ **An orchestrator must call `resolveCallConfig()` (or `resolveModelInfo()`) before dispatching a
switched route**, because an effort id is valid only for the exact model that advertised it.

---

## 5. Existing capability-matching / routing / model-selection logic

**There is no automatic model router, capability matcher, or orchestrator in DSH.** This was checked
two ways.

### 5.1 Absence evidence

- Live service registry (**VERIFIED**, `Service.listService` full catalog) contains **no** service key
  matching `llm*router*`, `*orchestrat*`, `*modelSelect*` (other than `agentDefaultModel` and
  `subagentModelSelection`), `*capabilit*`, or `*route*`. The complete LLM-related set is:
  `llm`, `agentDefaultModel`, `subagentModelSelection`, `tokenMeter`, `deepseekLlmApiExtensions`, `agentTeams`.
- Source grep across `PKGS/*` for `capabilit`, `pick model`, `choose model`, `best model`,
  `orchestrat` returns only: prose in doc comments, `SubagentCapabilities` (a *feature-support* flag
  set, unrelated to models), and image-capability gating. **VERIFIED** — no code matches a
  capability→model function.
- The `LlmRuntime` README states the design intent plainly (**VERIFIED** `PKGS/dsh-llm/README.md`,
  Dev Note): *"Reasoning-effort identifiers are adapter-owned opaque strings resolved only against
  each adapter's advertised set; a shared cross-adapter effort vocabulary is not decided."*

### 5.2 What *does* exist (four adjacent mechanisms)

**(a) A per-Session exact-route allowlist for subagents** — the closest thing to routing policy.
**VERIFIED** — `PKGS/dsh-tool-subagent/lib/index.js:91-98`:

```js
function assertAllowedModelSelection(policy, parentOptions, requested, request) {
	if (policy === void 0 || !hasDelegationModelRequest(request)) return;
	const provider = requested?.provider ?? parentOptions.provider;
	const model = requested?.model ?? parentOptions.model;
	if (provider === void 0 || model === void 0) throw new Error("cannot select child LLM values without an effective provider and model");
	if (policy.routes.some((route) => route.provider === provider && route.model === model)) return;
	throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`);
}
```

The policy is **durable, per session**, and stored as a `SessionProjection` + a session event
(**VERIFIED** `PKGS/dsh-tool-subagent/lib/index.js:199-233`):

```js
const subagentModelSelectionProjectionDefinition = {
	key: "subagentModelSelectionPolicy",
	stateVersion: 1,
	stateSchema: z$1.array(z$1.object({ provider: z$1.string().min(1), model: z$1.string().min(1) }).strict()).min(1).nullable(),
	init: () => null,
	apply: (policy, event) => {
		if (policy !== null || event.type !== "subagent/model-selection-policy") return policy;
		const { allowedModels } = event.data;
		assertAllowedModelRoutes(allowedModels);
		if (allowedModels.length === 0) throw new Error("subagent/model-selection-policy requires at least one route");
		return allowedModels;
	}
};
```

It is user-controlled via settings (**VERIFIED** `PKGS/dsh-tool-subagent/lib/types/model-selection-settings.d.ts`):
namespace `"subagent-model-selection"`, `SubagentModelSelectionSettings = { enabled: boolean; allowedModels: AllowedModelRoute[] }`,
service key `subagentModelSelection` with `current()`. Live settings for this harness are in
`~/.dsh/settings.yaml` (7 `commandcode` routes).

**Important structural constraint for an orchestrator that wants child model choice:** an invariant
forces route fields, the discovery tool, and a durable policy to appear together
(**VERIFIED** `PKGS/dsh-tool-subagent/lib/invariant.js:32-45`):

```js
		const schemas = ctx.tools.schemas(agent);
		const selectable = schemas.some((schema) => {
			const properties = schema.parameters.properties;
			return properties?.["provider"] !== void 0 && properties["model"] !== void 0 && properties["reasoning_effort"] !== void 0;
		});
		const discoverable = schemas.some((schema) => schema.name === "list_subagent_models");
		if ((selectable || discoverable) && (subagentModelSelectionPolicy(ctx.sessionProjections, agent.session) === void 0 || !selectable || !discoverable)) fail("model-selectable subagent definitions require a durable policy, route fields, and list_subagent_models");
```

→ If a plugin exposes `provider`/`model`/`reasoning_effort` tool parameters, the harness **will fail**
unless a durable route policy and `list_subagent_models` are also present.

**(b) A fixed fallback chain for auxiliary calls** (compaction). **VERIFIED** —
`PKGS/dsh-compaction-basic/lib/index.js:269-281`:

```js
	const latest = agent.session.requestHeader()?.config;
	const configured = config.summarizationProvider.length === 0 ? void 0 : {
		provider: config.summarizationProvider,
		model: config.summarizationModel
	};
	const agentTarget = agent.options.provider !== void 0 && agent.options.provider.length > 0 && agent.options.model !== void 0 && agent.options.model.length > 0 ? {
		provider: agent.options.provider,
		model: agent.options.model
	} : void 0;
	const target = configured ?? latest ?? agentTarget;
	if (target === void 0) throw new Error("no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields");
```

It also supports **per-route policy overrides** keyed by exact `provider`/`model`
(**VERIFIED** `PKGS/dsh-compaction-basic/lib/index.js:85-86`):

```js
	const override = config.modelPolicies.find((policy) => policy.provider === target.provider && policy.model === target.model);
```

**(c) A static route for session titles.** **VERIFIED** —
`PKGS/dsh-session-title-llm/lib/index.js:140-146`:

```js
function resolveRoute(config, request) {
	if (config.provider !== void 0 && config.model !== void 0) return {
		provider: config.provider,
		model: config.model
	};
	if (request.route === void 0) throw new Error("session-title-llm: no logged request route is available; configure provider and model together");
	return request.route;
}
```

**(d) A UI catalog projection** (enumeration only, no selection). **VERIFIED** —
`PKGS/dsh-api-session-controller/lib/types/catalog.js:8-56`; it calls `listProviders()`, then per
provider `listModels()` + `resolveModelInfo()` per model, isolates per-provider failures, and returns
`{ default, routableProviders, groups, failures }` (**VERIFIED** types
`ModelCatalog` / `ModelProviderGroup` / `ModelCatalogFailure` /
`ModelCatalogModel = { id, name, description?, reasoning? }` in
`PKGS/dsh-api-session-controller/lib/types/types.d.ts`).

**(e) A real fallback-route implementation** in the live third-party `dsh-agent-teams` plugin.
**VERIFIED** — `~/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/lib/members.js:47-71`:

```js
export async function validateMemberLlmSelections(ctx, selections, signal) {
    const catalogs = new Map();
    for (const selection of selections) {
        ...
        let catalog = catalogs.get(selection.provider);
        if (catalog === undefined) {
            catalog = await ctx.llm.listModels(selection.provider);
            catalogs.set(selection.provider, catalog);
        }
        if (catalog.length === 0 || catalog.some((model) => model.id === selection.model))
            continue;
        const available = catalog.slice(0, 8).map((model) => model.id).join(', ');
        throw new Error(`unknown member model "${selection.model}" for provider "${selection.provider}"...`);
    }
}
const FALLBACK_FAILURE_CODES = new Set(['QUOTA', 'RATE_LIMIT', 'AUTH', 'MISSING_CREDENTIAL', 'NO_ADAPTER']);
```

and its member route resolution reads the captain's live route and re-validates it
(**VERIFIED** `.../members.js:221-252`):

```js
    const current = captain.session.requestHeader()?.config;
    ...
    const resolved = await ctx.llm.resolveCallConfig({ provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }, signal);
```

Note the design comment precedent: *"Catalogs are advisory when empty (some adapters accept dynamic
model ids), but a non-empty catalog is authoritative enough to catch a typo."* — the correct
interpretation of DSH's advisory-catalog rule.

**Bottom line for §5:** a Model Orchestrator must be written from scratch. Everything it needs is
present (`listProviders`, `listModels`, `resolveModelInfo`, `resolveCallConfig`, `installModelSelection`,
`agent/request`, `subagents.start`), but no capability-matching or scoring logic exists to reuse.

---

## 6. Events emitted by the LLM layer

### 6.1 Cordis events — exactly two (live-registry verified)

**VERIFIED** — live `Event.listEvents` returns for the LLM namespace:

```json
{ "name": "llm/adapters-updated",
  "description": "The provider topology changed: an adapter registered or unregistered routes, or the configurable-provider directory gained or lost entries.",
  "mode": "emit",
  "signature": "'llm/adapters-updated'(): void" }
```

```json
{ "name": "llm/stream",
  "description": "Waterfall around every streaming model call (retry, replay, routing).",
  "mode": "waterfall",
  "signature": "'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>" }
```

Declarations: `PKGS/dsh-llm/lib/types/types.d.ts:21` and `PKGS/dsh-llm/lib/types/index.d.ts:45`.

**`llm/adapters-updated` is deliberately payload-free** — **VERIFIED**
`PKGS/dsh-llm/lib/index.js:1751-1766`:

```js
		emitAdaptersUpdated() {
			let invariantFailure;
			for (const listener of this.ctx.events.dispatch("emit", ["llm/adapters-updated"])) try {
				const returned = listener();
				if (returned != null && typeof returned.then === "function") Promise.resolve(returned).then(void 0, (error) => {
					this.warnAdaptersListenerFailure(error);
				});
			} catch (error) {
				if (error?.code === "INVARIANT") {
					invariantFailure ??= error;
					continue;
				}
				this.warnAdaptersListenerFailure(error);
			}
			if (invariantFailure !== void 0) throw invariantFailure;
		}
```

and the README Dev Note states it explicitly: *"The `llm/adapters-updated` event is payload-free by
design; consumers re-read the registries instead of receiving the new topology in the event."*
(**VERIFIED** `PKGS/dsh-llm/README.md`).

It fires from exactly the three topology mutation points:
`registerAdapter`'s disposer (`:1790`), `commitRoutes` (`:1840`, which covers first registration *and*
`handle.replace`), and both `registerConfigurableProviders` commit/dispose paths (`:1882`, `:1891`).

**`llm/stream` is the only interception point around a model call** — **VERIFIED**
`PKGS/dsh-llm/lib/index.js:2306-2307`:

```js
		streamWithRegistration(options, prepared) {
			return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
		}
```

It is bound to the `LlmRuntime` instance (`this`), receives the **deep-frozen** request, and may
short-circuit by yielding its own chunks. This is the seam for a router/fallback layer at the LLM
level (the doc comment literally names `routing`: *"Waterfall around every streaming model call
(retry, replay, routing)"*). **Caution** — the request is deep-frozen and loop-built requests are
marked (`markAgentLoopRequest`); a listener must **read, not rewrite** (**VERIFIED**
`PKGS/dsh-llm/lib/types/index.d.ts:36-45`): *"A LOOP-built request carries the process-local
`markAgentLoopRequest` identity and arrives deep-frozen (mutation throws) ... so listeners read it,
never rewrite it."*

### 6.2 There is **no** request/response completion event

**NOT FOUND.** Neither the live event registry nor any `Events` interface declares a
"llm/request-finished", "llm/response", or usage event. The only per-request signals are:

- the `StreamChunk` sequence yielded by `stream()` (terminal `finish` with `usage` before it), and
- the agent-scoped `agent/assistant-stream` emit event (**VERIFIED** live registry):
  `'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent: Agent; frame: AssistantStreamFrame }): void`.

### 6.3 Durable **Session** events (not Cordis events)

These are declared on `SessionEventMap` and land in the session log.

**`model/selection`** — **VERIFIED** `PKGS/dsh-api-session-controller/lib/types/types.d.ts:29-38`:

```ts
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * Complete validated model selection requested for subsequent prompt
         * assembly. Log-only: it never enters derived model history.
         */
        'model/selection': ModelSelection;
    }
}
```

**`llm/retry` and `llm/retry-started`** — **VERIFIED** `PKGS/dsh-llm-retry/lib/types/types.d.ts`:

```ts
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /** Durable, non-surface record of one provider-routed retry scheduled after a failed request attempt. */
        'llm/retry': LlmRetryEventData;
        /** Durable transition written after a retry wait succeeds and before the next request attempt starts. */
        'llm/retry-started': LlmRetryStartedEventData;
    }
}
/** Durable payload recorded before one provider-routed model-request retry wait. */
export type LlmRetryEventData = {
    retryId: RetryId; turn: number; step: number;
    provider: string; mode: 'normal'; policyKey: string;
    retry: number; maxRetries: number; delayMs: number; failure: LlmFailure;
} | {
    retryId: RetryId; turn: number; step: number;
    provider: string; mode: 'always'; policyKey: string;
    retry: number; delayMs: number; failure: LlmFailure;
};
/** Durable transition recorded after one retry delay completes. */
export interface LlmRetryStartedEventData {
    retryId: RetryId;
    turn: number;
    step: number;
    retry: number;
}
```

These are **not** Cordis events (they do not appear in the live `Event.listEvents` catalog) — they are
session-log records. `dsh-llm-retry` has no configuration of its own; the policy lives per provider
route and is captured at `registerAdapter` time (**VERIFIED** `PKGS/dsh-llm-retry/README.md`).

### 6.4 Agent-scoped events that matter for model switching

**VERIFIED** from the live registry (full verbatim signatures):

```json
{ "name": "agent/request", "mode": "waterfall",
  "signature": "'agent/request'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; signal: AbortSignal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>" }

{ "name": "agent/request-error", "mode": "waterfall",
  "signature": "'agent/request-error'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; provider: string; failure: LlmFailure; retryPolicy: ResolvedRetryPolicy | undefined; signal: AbortSignal }, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>" }

{ "name": "agent/pre-step", "mode": "waterfall",
  "signature": "'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>" }

{ "name": "system-prompt/assemble", "mode": "waterfall",
  "signature": "'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>" }
```

`agent/request` doc (**VERIFIED** `PKGS/dsh-agent/lib/types/runtime-types.d.ts:320-341`):
*"Replace the frozen call configuration. `await next()` yields the config the machine would use (agent
options on the first request, the logged header afterwards); return a replacement to switch."*

`agent/request-error` doc (**VERIFIED** `PKGS/dsh-agent/lib/types/runtime-types.d.ts:342-365`):
*"A listener returns `{ kind: 'retry' }` without calling `next()` when it owns recovery ... The default
`undefined` leaves the failure terminal."* — this is the sanctioned failover seam.

Also available: `settings/updated(ns, next, prev, source)` and
`credentials/reference-updated(ref)` (**VERIFIED** live registry) for reacting to configuration change.

---

## 7. `list_subagent_models` — exact implementation and schema

**Location: `PKGS/dsh-tool-subagent`, NOT `dsh-subagent`.** Confirmed by grep across all packages:
only `dsh-tool-subagent/lib/index.js`, `lib/invariant.js`, and `lib/types/list-models.d.ts` mention it.

### 7.1 Tool registration and schema

**VERIFIED** — `PKGS/dsh-tool-subagent/lib/index.js:172-197`:

```js
function registerListSubagentModels(ctx, policy) {
	ctx.tools.register(defineTool({
		name: "list_subagent_models",
		description: "Discover LLM routes for subagents without changing the current Agent. Call with no arguments to list registered providers, with `provider` to list its advertised models, or with `provider` and `model` to inspect that exact model and its reasoning efforts. Catalog membership is advisory: an adapter may accept an unlisted model id. Use the returned ids with a delegation tool's `provider`, `model`, and `reasoning_effort` fields.",
		parameters: {
			provider: {
				type: "string",
				description: "Registered LLM provider id. Omit to list providers."
			},
			model: {
				type: "string",
				description: "Exact model id to inspect. Requires provider; omit to list that provider's advertised models."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, result) => [{
				type: "text",
				text: result
			}]
		},
		execute(args, exec) {
			return listSubagentModels(ctx, policy, args, exec.signal);
		}
	}));
}
```

**Output schema is `{ type: "string" }`** — the tool returns human-readable text, **not** structured
JSON. A plugin must not expect parseable data from it.

### 7.2 The enumeration body (this is where routes are enumerated)

**VERIFIED** — `PKGS/dsh-tool-subagent/lib/index.js:145-166`:

```js
async function listSubagentModels(ctx, policy, request, signal) {
	const llm = ctx.get("llm");
	if (llm === void 0) throw new Error("cannot discover child LLM routes because the `llm` service is unavailable");
	if (request.model !== void 0 && request.provider === void 0) throw new Error("`model` requires `provider`");
	if (request.provider === void 0) {
		const providers = llm.listProviders().filter((provider) => policy.routes.some((route) => route.provider === provider.id));
		return providers.length === 0 ? "(no LLM providers)" : providers.map((provider) => `${provider.id} — ${provider.name}`).join("\n");
	}
	if (request.provider.length === 0) throw new Error("`provider` must be non-empty");
	const allowedRoutes = policy.routes.filter((route) => route.provider === request.provider);
	if (allowedRoutes.length === 0) throw new Error(`LLM provider "${request.provider}" is not allowed for this Session`);
	const provider = registeredProvider(llm, policy, request.provider);
	if (request.model === void 0) {
		const models = (await llm.listModels(provider.id)).filter((model) => allowedRoutes.some((route) => route.model === model.id));
		return models.length === 0 ? `(no advertised models for ${provider.id})` : models.map((model) => modelLine(provider.id, model)).join("\n");
	}
	if (request.model.length === 0) throw new Error("`model` must be non-empty");
	if (!allowedRoutes.some((route) => route.model === request.model)) throw new Error(`child LLM route "${provider.id}/${request.model}" is not allowed for this Session`);
	const model = await llm.resolveModelInfo(provider.id, request.model, signal);
	const efforts = model.reasoning?.efforts.map((effort) => `${effort.id}${model.reasoning?.defaultEffort === effort.id ? " (default)" : ""} — ${effort.name}` + (effort.description === void 0 ? "" : `: ${effort.description}`)).join("\n") || "(no advertised reasoning efforts)";
	return `${modelLine(provider.id, model)}\nReasoning efforts:\n${efforts}`;
}
```

with (**VERIFIED** `:133-143`):

```js
function registeredProvider(llm, policy, providerId) {
	const providers = llm.listProviders();
	const provider = providers.find((candidate) => candidate.id === providerId);
	if (provider !== void 0) return provider;
	const available = providers.filter((candidate) => policy.routes.some((route) => route.provider === candidate.id)).map((candidate) => candidate.id).join(", ") || "(none)";
	throw new Error(`LLM provider "${providerId}" is not registered; available providers: ${available}`);
}
/** Render one advertised or resolved model. */
function modelLine(provider, model) {
	return `${provider}/${model.id} — ${model.name}${model.description === void 0 ? "" : `: ${model.description}`}`;
}
```

### 7.3 What fields it actually returns (derived from the code above)

| Level | Returned text | Backed by |
|---|---|---|
| no args | one line per **allowed** provider: `"{id} — {name}"` | `llm.listProviders()` → `LlmProviderInfo.id`, `.name` |
| `provider` | one line per **allowed & advertised** model: `"{provider}/{id} — {name}"` (+ `": {description}"`) | `llm.listModels()` → `LlmModelInfo.id/.name/.description` |
| `provider` + `model` | the model line, then `"Reasoning efforts:"` and one line per effort: `"{id}[ (default)] — {name}"` (+ `": {description}"`) | `llm.resolveModelInfo()` → `LlmResolvedModelInfo.reasoning.efforts[].id/.name/.description` and `.reasoning.defaultEffort` |

**Two hard filters are applied:** provider must be in the durable policy routes; model must too.
`contextWindow`, `defaultMaxTokens`, `inputModalities`, and `systemPromptUpdate` are resolved but
**not** printed — so `list_subagent_models` is *not* a capability-discovery tool.

### 7.4 Where the delegation tool's route fields come from

They are registered **conditionally**, only when a durable model-selection policy exists.
**VERIFIED** — `PKGS/dsh-tool-subagent/lib/index.js:387-425`:

```js
	const install = (runtimeCtx, modelSelectionPolicy) => {
		const modelSelectionEnabled = modelSelectionPolicy !== void 0;
		if (modelSelectionPolicy !== void 0) registerListSubagentModels(runtimeCtx, modelSelectionPolicy);
		...
						...modelSelectionEnabled ? {
							provider: {
								type: "string",
								description: providerRouteDefaults !== void 0 ? "LLM provider route for the child. Supply together with model; omit both to use configured child defaults or this provider's route defaults." : "LLM provider route for the child. Supply together with model; omit both to use configured child defaults or inherit the parent route."
							},
							model: {
								type: "string",
								description: providerRouteDefaults !== void 0 ? "Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or this provider's route defaults." : "Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or inherit the parent route."
							},
							reasoning_effort: {
								type: "string",
								description: providerRouteDefaults !== void 0 ? "Adapter-owned reasoning effort for the effective child route. Omit to use a compatible configured effort or the selected model's default." : "Adapter-owned reasoning effort for the effective child route. Omit to inherit a compatible configured/parent effort or use a newly selected model's default."
							}
						} : {},
```

The provider identity filter and tool name (**VERIFIED** `PKGS/dsh-tool-subagent/lib/index.js:245-263`):

```js
const name = "tool-subagent";
const inject = ["tools", "subagents", "systemPrompt", "sessionProjections"];
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
	...
```

`modelSelectionSettings: true` requires `@deepseek-ai/dsh-tool-subagent/model-selection-settings`, else
the plugin throws at load (**VERIFIED** `:586-587`).

### 7.5 `dsh-subagent`'s role (distinct from the tool)

`dsh-subagent` owns the `ctx.subagents` **service**. It enumerates **providers**, not models:

- `registerProvider(provider: SubagentProvider): () => void` — `PKGS/dsh-subagent/lib/types/index.d.ts:272`
- `getProvider(name: string): SubagentProvider | undefined` — `:278`
- `list(): string[]` — `:283`
- `start(name, request): Promise<SubagentRun>` — `:296`
- `startContinuable(spec): Promise<ContinuableStart>` — `:117`

Model routes are **not** listed here; the only model-related data on a provider is the optional static
route (**VERIFIED** `PKGS/dsh-subagent/lib/types/types.d.ts:333-342`):

```ts
    readonly agentRouteDefaults?: Readonly<{
        provider: string;
        model: string;
    }>;
```

---

## 8. Credentials (how a multi-provider orchestrator authenticates a newly discovered route)

**VERIFIED** — `PKGS/dsh-credentials/lib/types/index.d.ts`, service key `credentials` (live registry
confirms), abstract `CredentialProvider`:

```ts
    abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;
    abstract describe(ref: CredentialRef): Promise<CredentialInfo>;
    abstract set(ref: CredentialRef, value: string): Promise<void>;
    abstract unset(ref: CredentialRef): Promise<void>;
    abstract readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>;
    abstract describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>;
    abstract listRecords(): Promise<readonly CredentialRecordEntry[]>;
    abstract modifyRecord(key, mutate): Promise<CredentialRecord | undefined>;
    abstract deleteRecord(key: CredentialKey): Promise<void>;
```

`ResolvedCredential = { value: string; source: string }`. Resolution is **per call** and must not be
cached: *"consumers re-resolve at each operation and must not cache across operations."*

**VERIFIED** — `PKGS/dsh-credentials-local/lib/index.js:423` (`super(ctx)`) registers the concrete
`LocalCredentialProvider`; the store is a private file under the harness home
(`~/.dsh/.credentials.yaml`, mode `0600` — confirmed on disk). Precedence per
`PKGS/dsh-credentials-local/README.md`: *"the launch environment wins, followed by the stored file, the
project's `.env`, and the harness-home `.env`."* Events:
`credentials/reference-updated(ref)` and `credentials/record-updated(key)` (both `emit`, live-registry
verified).

Adapters never read the key themselves in the recommended shape: `llm-deepseek`/`llm-pi-ai` treat
`apiKeyEnv` as a `CredentialRef` and call `credentials.resolve(ref)`, falling back to
`launchEnvironmentOf(ctx).get(ref)` (**VERIFIED** `PKGS/dsh-llm-deepseek/lib/index.js:2038-2049`,
`PKGS/dsh-llm-pi-ai/lib/index.js:2594-2601`), then pass through `assertUsableApiKey` and throw
`MISSING_CREDENTIAL` / `INVALID_CREDENTIAL`.

---

## 9. Practical recipe for the Model Orchestrator (all mechanisms verified above)

Everything below is built only from verified primitives.

1. **Mount** with `inject: ['llm']` (or `ctx.get('llm')` for optional). **Host half only** — model
   enumeration beyond `listProviders` is not Remote-exposed.
2. **Enumerate** live routes: `ctx.llm.listProviders()`. Merge with
   `ctx.llm.listConfigurableProviders()` to also see dormant/configurable routes, joining on
   `provider` ↔ `id` (this is exactly what the shipped README prescribes: *"Configuration surfaces
   merge this directory with `listProviders()`"*).
3. **Enumerate models** per route with `await ctx.llm.listModels(provider.id)`, treating the result as
   **advisory** — never as a validation gate. Handle per-provider throws (`INVALID_CATALOG`,
   `NO_ADAPTER`, and for the live `commandcode` route, plan/permission failures) by isolating failures
   the way `buildModelCatalog` does.
4. **Build capabilities** with `await ctx.llm.resolveModelInfo(provider, model, signal)` — this is the
   only source of `contextWindow`, `defaultMaxTokens`, `inputModalities`, `reasoning.efforts`, and
   `systemPromptUpdate`. Resolve lazily/concurrently; there is no batch API.
5. **Re-read on topology change**: `ctx.on('llm/adapters-updated', () => { /* re-read registries */ })`
   — the event carries **no payload**.
6. **Select**, then always `await ctx.llm.resolveCallConfig({provider, model, reasoningEffort}, signal)`
   before dispatch; it throws `UNSUPPORTED_REASONING_EFFORT` for an effort the target model did not
   advertise and materializes the adapter's `defaultMaxTokens`.
7. **Apply the choice**:
   - direct auxiliary call → `ctx.llm.stream({provider, model, reasoningEffort, messages, ...})`,
   - live agent → `installModelSelection(agent.ctx, { current, assembled })` from `@deepseek-ai/dsh-agent`,
   - child agent → `ctx.subagents.start(name, { agentOptions: { provider, model, reasoningEffort } })`,
     and/or `installModelSelection` on the child ctx captured at `agent/created`,
   - failover → `ctx.on('agent/request-error', ...)` returning `{ kind: 'retry' }`, remembering to set
     **both** `current` and `assembled`.
8. **Do not** expose `provider`/`model`/`reasoning_effort` tool parameters without also providing a
   durable route policy and a `list_subagent_models`-equivalent discovery tool, or the
   `dsh-tool-subagent` invariant (`PKGS/dsh-tool-subagent/lib/invariant.js:38-41`) will fail the step.
9. **Do not** expect pricing, tool-calling flags, or a "thinking" boolean from the registry.

---

## 10. Verified reference index

| Topic | File |
|---|---|
| `llm` service + all types | `PKGS/dsh-llm/lib/types/index.d.ts`, `PKGS/dsh-llm/lib/types/types.d.ts`, `PKGS/dsh-llm/lib/types/call-config.d.ts` |
| `llm` runtime | `PKGS/dsh-llm/lib/index.js` (2326 lines) |
| README (design + limits) | `PKGS/dsh-llm/README.md` |
| Remote surface | `PKGS/dsh-llm/lib/typert.remote-client.d.ts` |
| DeepSeek static catalog | `PKGS/dsh-llm-deepseek/lib/index.js:1392-1443, 1498-1506, 1558-1606, 1838-1949, 2017-2087` |
| pi-ai catalog + HTTP discovery | `PKGS/dsh-llm-pi-ai/lib/index.js:340-373, 1712-1721, 1775-1826, 2126-2322, 2531-2688`; `PKGS/dsh-llm-pi-ai/lib/types/catalog.d.ts`; `PKGS/dsh-llm-pi-ai/lib/types/config.d.ts` |
| Retry policy + events | `PKGS/dsh-llm-retry/lib/types/types.d.ts`; `PKGS/dsh-llm-retry/README.md` |
| Default model service | `PKGS/dsh-agent-default-model/lib/index.js`; `README.md` |
| Credentials seam | `PKGS/dsh-credentials/lib/types/index.d.ts`; `PKGS/dsh-credentials-local/README.md`, `lib/index.js:423` |
| Agent-scoped model selection | `PKGS/dsh-agent/lib/types/model-selection.d.ts`; `PKGS/dsh-agent/lib/types/model-selection.js:46-95` |
| Agent events | `PKGS/dsh-agent/lib/types/runtime-types.d.ts:213-419` |
| Session header | `PKGS/dsh-session/lib/types/types.d.ts:208-226`; `PKGS/dsh-session/lib/types/index.d.ts:251` |
| Session model-selection RPC | `PKGS/dsh-api-session-controller/lib/index.js:277-329, 605-634`; `lib/types/catalog.js` |
| Subagent seam | `PKGS/dsh-subagent/lib/types/types.d.ts`, `lib/types/index.d.ts`, `lib/index.js:438-484` |
| Subagent tool + `list_subagent_models` | `PKGS/dsh-tool-subagent/lib/index.js:45-233, 368-659`; `lib/types/model-selection.d.ts`; `lib/types/model-selection-settings.d.ts`; `lib/invariant.js:32-45` |
| Subagent model-selection settings owner | `PKGS/dsh-tool-subagent/lib/model-selection-settings.js` (service key `subagentModelSelection`) |
| Client model selection (browser) | `PKGS/dsh-client-ui-model-selection/lib/types/client/{service,directory,catalog}.d.ts` |
| Models settings plugin (host half is inert) | `PKGS/dsh-client-ui-settings-models/lib/index.js` (`function apply() {}`) |
| Auxiliary-call route policy (examples of real selection logic) | `PKGS/dsh-compaction-basic/lib/index.js:87-88, 272-300`; `PKGS/dsh-session-title-llm/lib/index.js:140-146` |
| Live third-party adapter example | `~/.dsh/profiles/web/node_modules/@mars-sea/dsh-commandcode-provider/lib/index.js:1989-2060, 4305, 4448-4452` |
| Live third-party fallback + child override example | `~/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/lib/members.js:14, 47-71, 215-252, 346-376` |
| Live third-party minimal adapter registration | `~/.dsh/profiles/web/node_modules/@furongjun1999/dsh-memory/lib/llm_adapter.js:105-263` |
| Live topology of this harness | `~/.dsh/profiles/web/package.json`, `~/.dsh/profiles/web/cordis.yml`, `~/.dsh/settings.yaml` |

**Explicit NOT FOUND list** (searched compiled JS + `.d.ts` across all 240 `@deepseek-ai/*` packages
and the 9 live profile plugins):

- No model pricing / cost field, and no cost estimation service.
- No tool-calling capability flag on a model descriptor.
- No `isThinking` / `thinking` boolean on a model descriptor (only the `reasoning` effort set).
- No capability-matching, model-scoring, or automatic model-selection/router/orchestrator code.
- No LLM request/response completion Cordis event.
- No batch "resolve all models" API.
- No Remote (browser) access to `listModels` / `resolveModelInfo` / `resolveCallConfig` / `stream`.
