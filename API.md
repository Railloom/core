
## Public API surface

This is the complete public API of `@railloom/core` v0.1. Everything not listed here is internal.

### Imports

```ts
import {
  // factories
  agent,
  tool,
  workflow,

  // suspend helpers
  suspendForApproval,
  ApprovalDecisionSchema,

  // eval
  createScorer,
  attachScorer,

  // memory namespace
  memory,

  // providers (built-in adapters)
  anthropicProvider,
  codexCliProvider,
  claudeCliProvider,
  type LLMProvider,
  type ProviderMessage,
  type ProviderContentBlock,
  type ProviderTool,
  type ProviderResponse,

  // setup
  configureRailloom,
  startServer,
  startWorker,

  // context
  type RunContext,

  // types
  type Agent,
  type Tool,
  type Workflow,
  type WorkflowRun,
  type ApprovalRequestSpec,
  type ApprovalSuspendPayload,
  type ApprovalDecision,
  type Scorer,
  type MemoryHandle,

  // errors
  RailloomError,
  InputValidationError,
  OutputValidationError,
  ToolOutputValidationError,
  ApprovalRejectedError,
  ConfigError,
  WorkflowStepError,
  ProviderError,
  CostCapExceededError,
} from '@railloom/core';
```

### `configureRailloom(config)`

Called once at app startup. Initializes the SQLite database (running migrations if needed), validates configuration, and stores the global config object.

```ts
configureRailloom({
  // database
  dbPath: string,                        // e.g. './data/railloom.db'

  // LLM provider — required, no default. Pick the adapter that matches your environment.
  // Common pattern: anthropicProvider in production, codexCliProvider/claudeCliProvider
  // during development, switched via the PROVIDER env var.
  provider: LLMProvider,

  // optional default model passed to agents that don't specify one. If absent, agent()
  // requires an explicit model. Model ids are provider-specific.
  defaultModel?: string,

  // embeddings (only required if using corpus memory)
  openaiApiKey?: string,
  embeddingsModel?: string,              // default 'text-embedding-3-small'

  // Slack (only required if using Slack approval channel)
  slack?: {
    botToken: string,                    // xoxb-...
    signingSecret: string,
    defaultApprovalChannel?: string,     // e.g. '#approvals'
  },

  // server
  server?: {
    port?: number,                       // default 3000
    publicUrl: string,                   // e.g. 'https://railloom-slate.example.com'
  },

  // worker
  worker?: {
    pollIntervalMs?: number,             // default 100
    concurrency?: number,                // default 4 — max concurrent step executions
  },

  // trigger endpoint bearer auth (production cron POSTs hit /triggers/:workflowId)
  triggers?: {
    secret: string,                      // bearer token; required if any cron-triggered workflow exists
  },

  // scheduler — embedded only in dev, system cron (systemd timer / supervisord) in prod
  scheduler?: {
    mode?: 'embedded' | 'disabled',      // default 'disabled'
                                         // 'embedded' is allowed only when RAILLOOM_DEV=1.
                                         // configureRailloom() throws ConfigError at startup if
                                         // mode='embedded' AND NODE_ENV='production' AND
                                         // RAILLOOM_DEV is unset or '0'. The combination is a
                                         // common config-paste-from-dev mistake that would
                                         // double-fire workflows (embedded scheduler + systemd
                                         // timer both hitting /triggers/:id), so we hard-fail
                                         // rather than warn.
  },

  // cost cap — daily budget enforcement at the agent.run boundary
  costCap?: {
    dailyUsdHard?: number,               // throw CostCapExceededError on agent.run if today's
                                         // spend (UTC midnight to now) >= this. Workflows fail
                                         // with the error; in-flight runs complete normally
                                         // (the check is BEFORE agent.run, not during).
                                         // Resets at next UTC midnight.
    dailyUsdWarn?: number,               // log warn + post to slack.defaultApprovalChannel
                                         // (or costCap.alertChannel) once per UTC day on first
                                         // crossing. Does NOT block runs.
    alertChannel?: string,               // override; default = slack.defaultApprovalChannel
  },

  // observability
  log?: {
    level?: 'debug' | 'info' | 'warn' | 'error',
    output?: 'stdout' | (line: string) => void,
  },
});
```

**Cost-cap semantics in detail.** The check is `SELECT COALESCE(SUM(cost_usd), 0) FROM _railloom_runs WHERE started_at >= ?` where `?` = today's UTC midnight in ms epoch. The query runs at the start of every `agent.run()` call (before any provider request). If the running total ≥ `dailyUsdHard`, `agent.run()` throws `CostCapExceededError` immediately; the workflow step that called it fails per its retry policy, and the workflow run transitions to `error` once retries are exhausted. The cap is **per-deployment**, not global — each `configureRailloom()` instance has its own `_railloom_runs` table and its own budget. In-flight runs are not aborted: they finish, and their cost is recorded normally (so a single run that crosses the cap is allowed to complete; only subsequent runs are blocked). The warn tier (`dailyUsdWarn`) follows the same query but posts a one-time Slack alert per UTC day; the framework persists "warn fired today" state in `_railloom_costcap_alerts` (see schema in ARCHITECTURE.md, with `(date, tier)` keying) so a second crossing within the same day doesn't spam Slack.

### `startServer()` and `startWorker()`

```ts
function startServer(): Promise<{ port: number; url: string }>;
function startWorker(): Promise<{ stop: () => Promise<void> }>;
```

Most deployments call both in `src/server.ts`:

```ts
import { configureRailloom, startServer, startWorker } from '@railloom/core';
import './agents';      // imports register agents
import './workflows';   // imports register workflows

configureRailloom({ ... });

await startServer();
await startWorker();
```

### `agent(config)` → `Agent`

```ts
type AgentConfig<TInput, TOutput> = {
  id: string;
  provider?: LLMProvider;                                 // defaults to config.provider from configureRailloom
  model?: string;                                         // defaults to config.defaultModel; provider-specific id
  instructions: string | ((ctx: RunContext, input: TInput) => string | Promise<string>);
  /**
   * Optional Zod schema for run input. When set, `TInput` is inferred via `z.infer`
   * and `agent.run({ input })` validates the input shape before calling the model.
   * When omitted, `TInput` defaults to `string` and `input` is sent to the model
   * as the user message verbatim.
   */
  inputSchema?: ZodSchema<TInput>;
  tools?: Record<string, Tool>;
  memory?: {
    session?: { id: string };
    corpus?: { collection: string; limit?: number; query?: (input: TInput) => string };
  };
  outputSchema?: ZodSchema<TOutput>;
  retry?: {
    maxAttempts?: number;                                 // default 3
    backoff?: 'exponential' | 'linear';                   // default 'exponential'
    initialDelayMs?: number;                              // default 1000
  };
  maxSteps?: number;                                      // default 5
  metadata?: Record<string, unknown>;
};

interface Agent<TInput, TOutput> {
  readonly id: string;
  run(opts: {
    input: TInput;
    sessionId?: string;
    traceId?: string;
    signal?: AbortSignal;
  }): Promise<{
    output: TOutput;
    messages: ProviderMessage[];                          // provider-neutral message shape
    runId: string;
    cost: { usd: number; inputTokens: number; outputTokens: number };
    durationMs: number;
  }>;
  asTool(opts?: { description?: string }): Tool;
}

/**
 * Two overloads enforce the schema/output-type linkage at compile time:
 * - When `outputSchema` is omitted, `TOutput` is `string` (the model's raw text).
 * - When `outputSchema` is provided, `TOutput` is `z.infer<typeof outputSchema>`.
 *
 * The same pattern applies to `inputSchema`: omitted → `TInput = string`, set → inferred.
 */
function agent<TIn = string>(
  config: AgentConfig<TIn, string> & { outputSchema?: undefined },
): Agent<TIn, string>;
function agent<TIn, TOut>(
  config: AgentConfig<TIn, TOut> & { outputSchema: ZodSchema<TOut> },
): Agent<TIn, TOut>;
```

**How `input` becomes the user message.** `agent.run({ input })` constructs the user-side of the conversation as follows:

1. If `inputSchema` is set, `input` is parsed against the schema first; a validation error throws `InputValidationError` before any model call. (No partial validation, no coercion silently widening types.)
2. If `instructions` is a function `(ctx, input) => string`, the framework calls it and uses the return value as the `system` prompt. `instructions` never populates the user message.
3. The user message text is computed: if `input` is a string, it's used verbatim; otherwise it's `JSON.stringify(input)` (with a stable key order for determinism). Session memory, when configured, is prepended as prior messages before this user turn.

This keeps `input → user message` deterministic and inspectable. If a consumer needs a custom user-message format (e.g., XML-tagged sections), they should pre-format the string in their own code and pass `input: formatted` rather than relying on framework heuristics.

### `LLMProvider` interface and built-in providers

The agent talks to LLMs only through `LLMProvider`. The interface is intentionally small: complete a chat, optionally with tools, return a normalized response with content blocks, stop reason, and usage. Tool-call translation, retries, and provider-specific quirks live inside the adapter, not in agent code.

The full canonical definition of `LLMProvider`, `ProviderMessage`, `ProviderContentBlock`, `ProviderTool`, and `ProviderResponse` lives in the **Provider** subsection further down (search `### Provider`). The agent layer consumes those types through the `LLMProvider` interface only — it never touches an SDK directly. Provider adapters convert user-facing `Tool` objects into provider-shape `ProviderTool` (JSON-Schema input) before invoking `complete()`; the agent never passes `Tool` across the provider boundary.

#### `anthropicProvider(opts)`

```ts
function anthropicProvider(opts: {
  apiKey: string;
  baseUrl?: string;                           // for Vercel AI Gateway and other Anthropic-Messages-compatible gateways
  defaultMaxTokens?: number;                  // default 4096
  timeout?: number | string;                  // default '5min'
}): LLMProvider;
```

Wraps `@anthropic-ai/sdk` (an optional peer dependency — install it if you use this provider). Native tool API. Computes cost from a built-in price table per model. Accepts `baseUrl` so commercial Anthropic-Messages gateways work without code changes.

**Throws `ProviderError`** when the underlying SDK call returns a non-2xx response that isn't auto-retried by the SDK (e.g., 401 invalid API key, 403 organization disabled, 400 malformed request after our serialization, 5xx after retry budget), when the request times out per `timeout`, or when the response body fails JSON parsing. Rate-limit (429) and transient 5xx are handled by the agent's retry policy before reaching `ProviderError`.

#### `codexCliProvider(opts)`

```ts
function codexCliProvider(opts: {
  binary?: string;                            // default 'codex'; full path if not in PATH
  model: string;                              // e.g. 'gpt-5.4-mini', 'gpt-5'
  workdir?: string;                           // optional cwd for the subprocess
  authMode?: 'subscription' | 'apiKey';       // default 'subscription'
  timeout?: number | string;                  // default '5min'
  env?: Record<string, string>;               // extra env vars passed to the subprocess
}): LLMProvider;
```

Spawns `codex exec` via `Bun.spawn` per request. System prompt is passed via temp file (`--config model_instructions_file=...`); user message via stdin; stream-json NDJSON output is parsed back into `ProviderContentBlock`. Tool calls route through the internal MCP loopback (see below) so user code remains identical to other providers.

In `subscription` mode, the CLI uses the developer's logged-in Codex subscription (no extra spend). In `apiKey` mode, it uses the configured API key and reports cost normally.

**When to use:** development. The CLI is free via existing subscription, ergonomic for iteration, fast for short prompts. In production, prefer the corresponding API-based provider for predictable rate limits and proper cost tracking.

**Throws `ProviderError`** when the `codex` binary is missing from PATH (or `binary` opt), when the subprocess exits with non-zero status, when stream-json output fails to parse (malformed NDJSON or unexpected schema version), when `timeout` fires, or when the MCP loopback returns an error for a tool call. Subscription auth failures (logged-out Codex CLI) surface as non-zero exit and are wrapped as `ProviderError` with the CLI's stderr in the cause.

#### `claudeCliProvider(opts)`

```ts
function claudeCliProvider(opts: {
  binary?: string;                            // default 'claude'
  model?: string;                             // e.g. 'claude-sonnet-4-6'; falls back to CLI default
  permissionMode?: 'bypassPermissions' | 'acceptEdits';  // default 'bypassPermissions'
  sessionDir?: string;                        // for --session tracking; default ~/.railloom/sessions
  timeout?: number | string;                  // default '5min'
  env?: Record<string, string>;
}): LLMProvider;
```

Spawns `claude -p --output-format stream-json --append-system-prompt "..."` via `Bun.spawn` per request. Multi-turn (tool loops) uses `--session <id>` for state continuity. Tool calls route through the internal MCP loopback.

Like `codexCliProvider`, this is intended primarily for development. Subscription-billed; cost tracking returns zero.

**Throws `ProviderError`** for the same surface as `codexCliProvider`: missing binary, non-zero subprocess exit (including subscription logged-out), stream-json parse failure, timeout, or MCP loopback errors during tool calls. Session-state corruption (a stale `--session` file) surfaces as a parse failure on the first turn and is wrapped as `ProviderError` with a hint to delete the session file.

#### Internal MCP loopback

CLI providers cannot send tool definitions through their native API the way `anthropicProvider` does. Instead, both CLI providers spin up a minimal MCP server (over stdio, ~150 LOC, hand-written — no `@modelcontextprotocol/sdk` dependency) that exposes the agent's `tool()` definitions to the CLI subprocess via the `--mcp` flag (Codex) or equivalent (Claude).

When the LLM emits a tool call inside the CLI, the CLI sends a JSON-RPC request over stdio back to our process, our MCP loopback handler routes it to `tool.execute()`, and the result is serialized back to the CLI. This keeps user code provider-transparent: the same `tool()` definition works on every provider.

**Zod → JSON Schema conversion lives in `_mcp-loopback.ts`.** When the loopback advertises tools to the CLI subprocess via MCP's `tools/list` response, it converts each tool's Zod `input` schema to JSON Schema. We use a hand-written ~50 LOC converter (no `zod-to-json-schema` dependency) that supports: `z.object`, `z.string`, `z.number`, `z.boolean`, `z.literal`, `z.enum`, `z.array`, `z.optional`, `z.nullable`, `z.union`, `z.discriminatedUnion`, `z.record`. This covers every shape we use in tools across the framework's examples and consumers; if a consumer uses a Zod feature outside this set (e.g., `z.lazy`, `z.intersection`), the converter throws `ProviderError` with code `mcp_unsupported_zod_feature` so the failure is loud and immediate, not silently malformed JSON Schema. The same converter is also used by `anthropicProvider` to produce Anthropic tool input schemas — one converter, two consumers, no drift.

The MCP loopback is an internal implementation detail. The framework does not expose tools as an MCP server to **external** consumers (e.g. a client's Claude Code instance) in v0.1. That capability is reserved for v0.2+ if a real client engagement requires it.

#### Provider-driven cost tracking

`agent.run()` records `cost.usd` from the provider's response. API-based providers compute cost from per-model price tables maintained inside the provider adapter. Subscription-billed CLI providers return `cost.usd = 0` because the spend is flat-rate against the subscription. Both cases write to `_railloom_runs` consistently; queries that aggregate spend (`SELECT SUM(cost_usd) FROM _railloom_runs WHERE ...`) work the same regardless of provider mix.

### `tool(config)` → `Tool`

```ts
type ToolConfig<TInput, TOutput> = {
  description: string;
  input: ZodSchema<TInput>;
  output?: ZodSchema<TOutput>;
  idempotencyKey?: (input: TInput) => string;
  timeout?: number | string;                              // default '60s'
  /**
   * Per-tool retry on execute() throw. Default: no retry — the throw surfaces
   * to the agent's tool loop as a `tool_result` with `is_error: true`, and the
   * model decides what to do (often a refusal). Set explicitly when transient
   * failures (OpenAI 503 inside a corpus.search wrapper, network blips) should
   * be hidden from the model.
   */
  retry?: {
    maxAttempts?: number;                                 // default 1 (no retry)
    backoff?: 'exponential' | 'linear';                   // default 'exponential'
    initialDelayMs?: number;                              // default 200
  };
  execute: (args: { input: TInput; ctx: RunContext }) => Promise<TOutput>;
};

interface Tool<TInput = unknown, TOutput = unknown> {
  readonly description: string;
  // direct invocation, mostly used inside workflow steps
  execute(args: { input: TInput; ctx: RunContext }): Promise<TOutput>;
  // internal: used by agent's tool loop
  readonly _config: ToolConfig<TInput, TOutput>;
}

function tool<TInput, TOutput>(config: ToolConfig<TInput, TOutput>): Tool<TInput, TOutput>;
```

Note: tools have no `approval` flag. Approval is a workflow-level concern handled via `suspendForApproval()` inside step execute. See `suspendForApproval()` below.

**Tool error semantics in detail.** When `execute()` throws (after retry exhaustion if `retry` is set):

- **Inside an agent tool loop**: the error is serialized as a `tool_result` content block with `is_error: true` and a short message (`error.name + error.message`, truncated to 1KB). The agent loop continues; the model sees the error and either retries the tool with different input, calls a different tool, or produces a final refusal text. The loop is bounded by `maxSteps`. The error is also recorded in `_railloom_tool_calls` with `status='error'` and the full stack/cause.
- **Inside a workflow step calling `tool.execute()` directly**: the error propagates normally and the step's own `retry` policy decides whether to retry the whole step. No tool-level retry-around-step layer.
- **Always**: the error is logged at `error` level. Silent swallow is forbidden; tools that legitimately want to convert "no result" into a non-error output (e.g., "no voice exemplars yet") return a sentinel value, not catch-and-ignore.

The default `retry: { maxAttempts: 1 }` is intentional: hiding transient failures from the model can produce confidently-wrong outputs (the model thinks the tool worked and proceeds). Surfacing the error to the model lets it react. Set `retry: { maxAttempts: 2 }` when the underlying call is genuinely transient *and* the model has nothing useful to do with the error (e.g., embeddings API 503 inside a search tool — one silent retry, then surface).

### `workflow(config)` → `Workflow`

```ts
type WorkflowConfig<TInput> = {
  id: string;
  trigger: { event: string } | { cron: string } | { manual: true };
  input: ZodSchema<TInput>;
  concurrency?: { limit: number; key?: (input: TInput) => string };
  retries?: number;                                       // default 3, applied per-step unless step overrides
};

type Step<TInput, TOutput, TSuspend = never, TResume = never> = {
  id: string;
  inputSchema?: ZodSchema<TInput>;
  outputSchema?: ZodSchema<TOutput>;
  suspendSchema?: ZodSchema<TSuspend>;                    // shape persisted on suspend
  resumeSchema?: ZodSchema<TResume>;                      // shape received on resume
  retries?: number;
  timeout?: number | string;
  execute: (args: {
    inputData: TInput;
    resumeData?: TResume;
    suspend: (payload: TSuspend) => Promise<never>;
    ctx: RunContext;
  }) => Promise<TOutput>;
};

interface WorkflowChain<TInput, TPrev> {
  then<TNext, TSuspend = never, TResume = never>(
    step: Step<TPrev, TNext, TSuspend, TResume>,
  ): WorkflowChain<TInput, TNext>;
  parallel<TNexts extends readonly unknown[]>(
    steps: { [K in keyof TNexts]: Step<TPrev, TNexts[K]> }
  ): WorkflowChain<TInput, TNexts>;
  branch<TThen, TOtherwise = TPrev>(opts: {
    when: (args: { input: TInput; previous: TPrev; ctx: RunContext }) => boolean | Promise<boolean>;
    then: Step<TPrev, TThen>;
    otherwise?: Step<TPrev, TOtherwise>;
  }): WorkflowChain<TInput, TThen | TOtherwise>;
  /**
   * Fan a single workflow run into N parallel sub-runs, one per item.
   * See ARCHITECTURE.md § Suspend inside foreach for the eager-materialization
   * model and aggregation semantics.
   *
   * **Returns `Array<ForeachItemResult<TResult>>`, NOT `TResult[]`.** Each entry
   * carries the per-item terminal status. Consumers that want all-or-nothing
   * semantics filter for `status === 'error'` in the next `.then()` step and
   * throw explicitly.
   *
   * **WARNING: bound your input array.** Eager materialization creates one
   * `_railloom_queue` row per item — passing an unbounded user-supplied array
   * is a DoS vector. If items come from an external API, cap the array length
   * (e.g., `posts.slice(0, 200)`) before the previous step returns it.
   */
  foreach<TItem, TResult, TSuspend = never, TResume = never>(
    step: Step<TItem, TResult, TSuspend, TResume>,
    opts?: { concurrency?: number }
  ): WorkflowChain<TInput, Array<ForeachItemResult<TResult>>>;
  map<TNext>(fn: (prev: TPrev, ctx: RunContext) => TNext | Promise<TNext>): WorkflowChain<TInput, TNext>;
  sleep(ms: number | string): WorkflowChain<TInput, TPrev>;
  sleepUntil(date: Date | string): WorkflowChain<TInput, TPrev>;
  commit(): Workflow<TInput>;
}

type ForeachItemResult<T> =
  | { status: 'success'; output: T; itemIndex: number }
  | { status: 'error'; error: SerializedError; itemIndex: number }
  | { status: 'cancelled'; itemIndex: number };

type SerializedError = { name: string; message: string; code?: string; cause?: unknown };

interface Workflow<TInput> {
  readonly id: string;
  /**
   * Enqueue a new run. Returns a `WorkflowRun` handle that can be used to
   * resume or cancel the run. The handle's `runId` is also returned for
   * persistence (e.g., logging).
   */
  trigger(opts: { input: TInput }): Promise<WorkflowRun>;
  /**
   * Look up an existing run by id. Used by Slack webhook handlers to resume
   * suspended runs without holding the original `WorkflowRun` reference.
   * Returns null if no row in `_railloom_queue` matches.
   */
  getRun(runId: string): Promise<WorkflowRun | null>;
}

interface WorkflowRun {
  readonly runId: string;
  /**
   * Resume a suspended run with the given resumeData. Implemented as an atomic
   * CAS: the underlying UPDATE includes `WHERE status='suspended'`, and the
   * call returns no-op if the row was already resumed (duplicate webhook,
   * race with sweep, admin cancel). See ARCHITECTURE.md § Approval flow
   * atomicity, Invariant 2.
   */
  resume(opts: { stepId: string; resumeData: unknown }): Promise<void>;
  cancel(): Promise<void>;
}

function workflow<TInput>(config: WorkflowConfig<TInput>): WorkflowChain<TInput, TInput>;
```

Note: there is no `.approval()` chain method. Approval is handled inside any regular `.then()` step via `suspendForApproval()`. See below.

### `suspendForApproval(suspend, request)` → `Promise<never>`

Helper that wraps the suspend pattern for the human-approval use case. Called inside a step's `execute` function on first execution. Persists an approval request, posts to Slack, and calls `suspend()` with a payload that links the workflow run to the approval. The function never returns (suspend throws an internal sentinel that the workflow runner catches).

```ts
/**
 * Payload-typed approval request. The `TPayload` generic is opt-in: when omitted,
 * `payload` is the loose `Record<string, unknown>` shape (compatible with v0.1
 * call sites that don't yet specify payload types). When provided, `editable`
 * narrows to keys of the payload, eliminating string-typo bugs.
 *
 * **Limitation: `editable` is top-level keys only.** `keyof TPayload` does not
 * recurse, so `editable: ['post.title']` for a nested payload like
 * `{ post: { title, body } }` is not type-safe. If you need nested editable
 * fields, flatten the payload (`{ postTitle, postBody }`) so each editable
 * field is a top-level key. The Slack edit modal renders one input per editable
 * key, so flat payloads are also the natural UI shape.
 */
type ApprovalRequestSpec<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  kind: string;                                           // categorization
  summary: string;                                        // shown in approval UI, max 200 chars
  payload: TPayload;
  editable?: (keyof TPayload & string)[];                 // payload keys that approver can edit
  timeout?: number | string;                              // default '24h'
  channel?: string;                                       // override default; format 'slack:#name'
};

type ApprovalSuspendPayload<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  approvalId: string;
  request: ApprovalRequestSpec<TPayload>;
};

type ApprovalDecision<TPayload extends Record<string, unknown> = Record<string, unknown>> =
  | { action: 'approved'; payload: TPayload; decidedBy: string; decidedAt: Date }
  | { action: 'edited'; payload: TPayload; decidedBy: string; decidedAt: Date }
  | { action: 'rejected'; reason?: string; decidedBy: string; decidedAt: Date }
  | { action: 'timed_out'; decidedAt: Date };

/**
 * Canonical Zod schema for `ApprovalDecision<Record<string, unknown>>`.
 * Exported so consumers can reference it as `resumeSchema: ApprovalDecisionSchema`.
 * For payload-typed approvals, build a narrower schema with `z.discriminatedUnion`
 * and the consumer's payload schema; see the reddit-agent example.
 */
declare const ApprovalDecisionSchema: ZodSchema<ApprovalDecision>;

function suspendForApproval<TPayload extends Record<string, unknown> = Record<string, unknown>>(
  suspend: (payload: ApprovalSuspendPayload<TPayload>) => Promise<never>,
  request: ApprovalRequestSpec<TPayload>,
): Promise<never>;
```

The corresponding step's `resumeSchema` should match `ApprovalDecision`:

```ts
.then({
  id: 'review-draft',
  resumeSchema: ApprovalDecisionSchema,                   // exported from @railloom/core
  execute: async ({ inputData, resumeData, suspend, ctx }) => {
    if (!resumeData) {
      return await suspendForApproval(suspend, { ... });
    }
    if (resumeData.action === 'rejected') return { ok: false };
    return { ok: true, finalText: resumeData.payload.draftText };
  },
})
```

When Slack sends an interactivity webhook, the framework's webhook handler resolves the approvalId to its `workflow_run_id`, parses the action, and calls `run.resume({ stepId, resumeData: ApprovalDecision })`. The step's execute is invoked again with `resumeData` populated.

### `createScorer(config)` and `attachScorer()`

Minimal eval primitives. A scorer evaluates an agent run's output (or a workflow step's output) and produces a score plus an optional reason. Scores are persisted to `_railloom_scores`. Scorers run in the background after the target completes; they do not block the main run.

```ts
type ScorerConfig<TInput, TOutput> = {
  id: string;
  description: string;
  type: 'agent' | 'workflow_step';
  scoreFn: (args: {
    input: TInput;
    output: TOutput;
    metadata?: Record<string, unknown>;
    ctx: RunContext;
  }) => Promise<{ score: number; reason?: string; metadata?: Record<string, unknown> }>;
};

interface Scorer<TInput, TOutput> {
  readonly id: string;
  score(args: { input: TInput; output: TOutput; targetId: string }): Promise<void>;
}

function createScorer<TInput, TOutput>(config: ScorerConfig<TInput, TOutput>): Scorer<TInput, TOutput>;

function attachScorer<TInput, TOutput>(
  target: Agent<TInput, TOutput> | { workflowId: string; stepId: string },
  scorer: Scorer<TInput, TOutput>,
): void;
```

Scorers are designed to be cheap to start and grow into a larger eval system. The API is deliberately minimal: a single `scoreFn` with full freedom to use deterministic logic, an LLM judge, regex checks, or any combination. There is no four-step pipeline (preprocess → analyze → generateScore → generateReason) like Mastra's Scorers; if you want that structure, compose it inside your `scoreFn`. We can add a richer pipeline in v0.2 if real use cases demand it.

**How attached scorers fire.** When `attachScorer(agent, scorer)` is called, the framework registers the (agentId → scorer) pair in an in-process registry. After every successful `agent.run()` completion (i.e., when the run row in `_railloom_runs` transitions to `status='success'`), the framework enqueues a scoring job into `_railloom_queue` with:

- `kind = 'step'`
- `step_id = 'scorer:<scorerId>'`
- `snapshot.inputData = { agentRunId, agentInput, agentOutput }` — the scorer reads these in its `scoreFn`
- `scheduled_at = now()` (no delay; runs as soon as worker picks it up)

The scoring job runs through the standard worker loop, independently of the agent run that produced it. On success, one row is written to `_railloom_scores`:

- `target_kind = 'agent_run'`
- `target_id = agentRunId` (the `_railloom_runs.id` of the run being scored)
- `score`, `reason`, `metadata` from the `scoreFn` return value

For `attachScorer({ workflowId, stepId }, scorer)`, the same pattern applies but `target_kind = 'workflow_step'` and `target_id` is the step's per-run id (a sub-row id from `_railloom_queue`). Failed agent runs (`status='error'`) do not trigger scorers — there's no output to score. Sampling (run scorer on N% of runs) is not in v0.1; if a consumer needs it, they implement it in `scoreFn` by returning a sentinel score for skipped runs.

A future `@railloom/eval` package may add: dataset declarations, regression detection across deploys, A/B testing infrastructure, a CLI that runs a suite and emits a markdown report. None of that is in v0.1.

### `approval` (deprecated, removed in v3)

The previous `approval(request)` factory and `.approval()` chain method have been removed. Migrate to `suspendForApproval()` inside a regular step.

### `memory` namespace

```ts
namespace memory {
  function ephemeral<T = unknown>(opts?: { maxSize?: number }): EphemeralHandle<T>;
  function session(sessionId: string): SessionHandle;
  function corpus(collection: string): CorpusHandle;
}

interface EphemeralHandle<T> {
  set(key: string, value: T): void;
  get(key: string): T | undefined;
  delete(key: string): void;
  clear(): void;
}

type SessionMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

interface SessionHandle {
  add(message: { role: SessionMessage['role']; content: unknown; metadata?: object }): Promise<void>;
  list(opts?: { limit?: number; before?: Date }): Promise<SessionMessage[]>;
  clear(): Promise<void>;
}

type CorpusEntry = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  score?: number;                                         // present in search results
  createdAt: Date;
};

interface CorpusHandle {
  add(entry: { content: string; metadata?: object }): Promise<{ id: string }>;
  search(opts: {
    query: string;                                        // text → embedded → cosine
    limit?: number;                                       // default 5
    filter?: (entry: CorpusEntry) => boolean;             // applied before similarity ranking
  }): Promise<CorpusEntry[]>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}
```

### `RunContext`

```ts
type RunContext = {
  runId: string;
  traceId: string;
  agentId?: string;
  workflowRunId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  log: {
    debug(event: string, data?: object): void;
    info(event: string, data?: object): void;
    warn(event: string, data?: object): void;
    error(event: string, data?: object): void;
  };
  audit(event: { action: string; resource?: object; payload?: object }): Promise<void>;
};
```

### Provider

This is the **canonical** `LLMProvider` definition. The earlier subsection in this document (`### LLMProvider interface and built-in providers`) is descriptive prose; this is the contract.

```ts
type LLMProvider = {
  /** Stable identifier for logs/audit, e.g. 'anthropic' or 'openai-compat' */
  readonly name: string;

  /**
   * One round-trip with the model.
   *
   * @throws {ProviderError} when the underlying transport fails (network failure,
   *   non-2xx HTTP status without a recoverable structure, malformed CLI subprocess
   *   output, JSON-RPC error from MCP loopback, etc.). User code that calls
   *   agent.run() rarely sees ProviderError directly because the agent's retry
   *   policy wraps it; tools and workflow steps that call complete() directly
   *   should expect it.
   */
  complete(opts: {
    model: string;
    system?: string;
    messages: ProviderMessage[];
    tools?: ProviderTool[];           // JSON-Schema-shaped; agent.ts converts user Tool → ProviderTool
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<ProviderResponse>;

  /** Optional: report cost for an exchange. Hardcoded price tables live in the provider. */
  estimateCost?(model: string, inputTokens: number, outputTokens: number): number;
};

type ProviderMessage =
  | { role: 'user' | 'assistant'; content: string | ProviderContentBlock[] };

type ProviderContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

type ProviderTool = {
  name: string;
  description: string;
  input_schema: object;             // JSON Schema (converted from Zod by agent.ts before reaching the provider)
};

type ProviderResponse = {
  content: ProviderContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: { inputTokens: number; outputTokens: number };
  cost?: { usd: number };           // populated when computable; zero for subscription-billed providers
};

function anthropicProvider(opts: {
  apiKey: string;
  baseUrl?: string;                 // for routing through Vercel AI Gateway, LiteLLM, or any Anthropic-Messages-compatible endpoint
  defaultHeaders?: Record<string, string>;
}): LLMProvider;
```

**Note on session/tool roles.** `ProviderMessage` carries only `'user' | 'assistant'` because providers handle `system` (separate parameter) and `tool_result` (as content blocks inside an assistant turn) outside the role enum. The four-role `_railloom_session_memory.role` ('user' | 'assistant' | 'system' | 'tool') is the storage shape; `agent.ts` translates between the two when loading session memory into a provider call.

The `agent({ provider: ... })` parameter is optional. If omitted, the framework uses the provider passed to `configureRailloom({ provider: ... })`. The most common pattern is to set the provider once at startup and never specify it on individual agents.

**Gateway routing example:**

```ts
const a = agent({
  id: 'reddit-classifier',
  provider: anthropicProvider({
    apiKey: process.env.GATEWAY_KEY!,
    baseUrl: 'https://ai-gateway.vercel.sh/v1/anthropic',
  }),
  model: 'claude-haiku-4-5',
  instructions: '...',
});
```

In v0.2 we plan to add `openaiCompatibleProvider` which will cover OpenRouter, LiteLLM, Cloudflare AI Gateway, and any OpenAI-Chat-Completions-compatible endpoint with a single adapter.

### Error classes

```ts
class RailloomError extends Error {
  readonly code: string;
  readonly cause?: unknown;
  toJSON(): object;
}

class ConfigError extends RailloomError { code = 'config_invalid' }
class InputValidationError extends RailloomError { code = 'input_validation' }
class OutputValidationError extends RailloomError { code = 'output_validation' }
class ToolOutputValidationError extends RailloomError { code = 'tool_output_invalid' }
class ApprovalRejectedError extends RailloomError { code = 'approval_rejected' }
class WorkflowStepError extends RailloomError { code = 'workflow_step_error' }
class ProviderError extends RailloomError { code = 'provider_error' }
class CostCapExceededError extends RailloomError { code = 'cost_cap_exceeded' }
```

Note: there is no `ApprovalTimeoutError`. A timeout is a normal `Decision` with `action: 'timed_out'` — the workflow resumes with that and the user code branches on it. Throwing on timeout would force every approval call site to wrap in try/catch, which is the wrong default for a workflow control-flow signal.

### Output validation failure path (agent.run with `outputSchema`)

When `outputSchema` is set and the model returns a final text that fails to parse against the schema, the framework follows this path **exactly** — no other branches:

1. **First failure**: append the validation error to the conversation as a `tool_result` with `is_error: true` (or as a synthesized user message for providers without tool-result semantics on text outputs). The error message is **human-readable, not a raw ZodError JSON dump** — the framework formats the first failure path into a sentence like `Your previous response was missing required field "draftText". Expected string, received undefined.` (built from `z.flattenError()` or equivalent, taking the first issue). LLMs respond noticeably better to natural-language feedback than to JSON; raw `ZodError.format()` output reads as machine debug output and the model often produces another malformed reply. Re-prompt the model. **This counts as one step against `maxSteps`.**
2. **Second failure**: throw `OutputValidationError` with the most recent invalid output preserved in `error.cause` for debugging. Do not retry further. Do not return string-as-fallback.

The contract: at most one in-loop reprompt on schema mismatch; a deterministic typed throw thereafter. There is no path where `agent.run` returns malformed output silently. There is no path where validation failures consume more than one extra step. Consumers that want different behavior (e.g., "always throw on first failure" or "retry 3 times") must implement it themselves outside `agent.run`.

This is intentionally narrower than the agent's `retry.maxAttempts` (which covers transient provider errors like 5xx). Validation failures are not transient — the model produced a confident but wrong output. Re-running the same prompt three times wastes budget; one re-prompt with explicit error feedback is enough to either fix the output or confirm the model can't produce the schema.

---

