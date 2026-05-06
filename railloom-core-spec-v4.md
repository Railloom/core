# @railloom/core — Framework Specification (v0.1, Bun-only, single-tenant deployable)

**Version:** 0.1.0
**Status:** Final, ready for implementation
**Audience:** Claude Code (primary), human reviewers (secondary)
**License:** MIT

> This document is the specification for `@railloom/core`. It is written to be consumed by Claude Code as the source of truth during implementation. The document is structured as a set of files (denoted by `# === FILE: path ===` markers) that should ultimately live in the framework repository.
>
> The framework is **single-tenant, deployable-artifact**: each Railloom client engagement is its own deployment — its own SQLite database, its own Bun process, its own configuration. No multi-tenancy in core, no `tenantId` parameter anywhere. The framework optimizes for the boutique studio model: 5–20 clients, each with a dedicated install. Rationale and decision history live in the **Resolved decisions** section at the end.

---

# === FILE: README.md ===

# @railloom/core

> Production AI agents in TypeScript. One runtime. Two dependencies. Ship a single binary.

`@railloom/core` is a TypeScript framework for building agents that use tools, talk to LLMs, run on a durable in-process queue, and require human approval before they touch the world. It is built by [Railloom](https://railloom.com) — the studio that turns AI prototypes into production software — and powers the agents we ship to clients.

```bash
bun add @railloom/core
# Plus the SDK for the provider you choose. For Anthropic:
bun add @anthropic-ai/sdk
# For CLI-based providers (codex, claude), no extra SDK is needed —
# the CLI binary itself is the runtime dependency.
```

**Minimal (try-it-out):**

```ts
import { agent, tool, configureRailloom, anthropicProvider } from '@railloom/core';
import { z } from 'zod';

configureRailloom({
  dbPath: './data/railloom.db',
  provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
});

const triage = agent({
  id: 'reddit-triage',
  model: 'claude-haiku-4-5',  // model id is provider-specific
  instructions: 'Classify a Reddit thread for relevance to our app.',
  tools: {
    fetchThread: tool({
      description: 'Fetch full thread text from Reddit',
      input: z.object({ url: z.string().url() }),
      execute: async ({ input }) => fetchRedditThread(input.url),
    }),
  },
});

const result = await triage.run({
  input: { url: 'https://reddit.com/r/portugalexpats/...' },
});
```

**Production (env-driven provider switch):**

```ts
import { anthropicProvider, codexCliProvider, claudeCliProvider, type LLMProvider } from '@railloom/core';

function pickProvider(): LLMProvider {
  switch (process.env.PROVIDER ?? 'anthropic') {
    case 'codex-cli':  return codexCliProvider({ model: process.env.CODEX_MODEL ?? 'gpt-5.4-mini' });
    case 'claude-cli': return claudeCliProvider({ model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6' });
    default:           return anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
}

configureRailloom({ dbPath: './data/railloom.db', provider: pickProvider() });
```

`.env.development` sets `PROVIDER=codex-cli`; `.env.production` sets `PROVIDER=anthropic`. Same agent and workflow code on both. See `CONVENTIONS.md` § Environment-driven provider selection.

## What this is

A small, owned, MIT-licensed TypeScript framework with five primitives:

1. **`agent()`** — typed wrapper around an `LLMProvider` (any: API-based or CLI-based) with retry, cost tracking, structured output via Zod, and tool-loop handling.
2. **`tool()`** — typed wrapper with input/output schemas and idempotency. Provider-transparent: the same tool definition works through any provider.
3. **`workflow()`** — durable, multi-step orchestration on a SQLite-backed in-process queue, with `.then`, `.parallel`, `.branch`, `.foreach`, `.map`, `.sleep`, `.sleepUntil` chain methods, and snapshot-based suspend/resume for human-in-the-loop.
4. **`memory`** — three memory kinds: ephemeral (run-scoped, in-process), session (conversation-scoped, SQLite), and corpus (semantic memory, SQLite + brute-force cosine).
5. **`suspendForApproval`** — first-class human-in-the-loop helper. Called inside any regular workflow step's `execute`. Pauses execution via snapshot, posts to Slack (or any registered channel), resumes the step (with `resumeData` populated) when a human clicks Approve / Edit / Reject.

## What this is not

- Not a chat UI framework.
- Not a multi-tenant SaaS framework. (Each deployment is single-tenant.)
- Not a managed service. (You deploy it; you run it.)
- Not a model gateway. (One provider per `agent`. Currently Anthropic.)
- Not a sandbox. (Use Bun's built-in process isolation, or external sandbox if your tool runs untrusted code.)
- Not an eval framework. (See `@railloom/eval`, separate package.)
- Not LangChain or Mastra. (We deliberately avoid the abstraction tax.)

## Stack lock

| Layer | Tool | Notes |
|---|---|---|
| Runtime | **Bun 1.3+** exclusively | No Node fallback. See `VISION.md` § Why Bun-only. |
| Database | `bun:sqlite` (built-in) | One file per deployment. WAL mode. |
| HTTP server | `Bun.serve()` (built-in) | For Slack webhooks, trigger endpoints, healthz. |
| LLM provider | Pluggable via `LLMProvider` interface | Built-in adapters: `anthropicProvider`, `codexCliProvider`, `claudeCliProvider` in v0.1; `openaiCompatibleProvider` in v0.2. The framework has no privileged provider. |
| Embeddings | OpenAI text-embedding-3-small (default) | Via direct `fetch()`. No SDK. Pluggable. |
| Validation | `zod` | Schemas for input, output, tool args, structured outputs. |
| HITL channel | Slack via direct `fetch` + HMAC verify | No `@slack/bolt`. ~120 LOC of channel code. |
| Bundler / packager / test runner / TS compiler | Bun (built-in) | No `tsx`, no `vitest`, no `esbuild`. |
| Deployment artifact | Single self-contained binary | `bun build --compile`. |

**Production dependencies: 1.** `zod`. That's the entire `dependencies` list.

**Optional peer dependencies** (declared in `peerDependenciesMeta` as optional): `@anthropic-ai/sdk` (used only by `anthropicProvider`); future `@openai/openai` (only by `openaiCompatibleProvider`). Users install the SDK for the provider they actually use. A deployment that uses only `codexCliProvider` or `claudeCliProvider` installs zero extra SDKs — the CLI binaries are the runtime dependency, not npm packages.

## Deployment model

Each Railloom client engagement is a separate repo (or directory) that:

1. `bun add @railloom/core`
2. Configures `configureRailloom({...})` with their Anthropic key, Slack credentials, OpenAI key
3. Defines their own agents, tools, and workflows
4. Runs `bun run src/server.ts` for development
5. Runs `bun build --compile --target=bun-linux-x64 --outfile=railloom-<client>-server src/server.ts` to produce a single binary
6. Generates systemd timer units from declared cron triggers via `bun run generate:systemd` (or a docker-compose stack via `bun run generate:docker-compose`)
7. Ships that binary plus the generated unit files to the client's VPS (or Railloom-managed VPS) as a `systemd` service, or wraps in `oven/bun:1.3-alpine` Docker image with supervisord if the client prefers containers

There is no central Railloom server. There is no shared infrastructure. Each engagement is its own isolated deployment.

## Hosting recommendations

| Target | Status | Notes |
|---|---|---|
| **VPS + systemd** (Hetzner, DigitalOcean, Vultr) | Default | Single binary, systemd unit per Bun process, systemd `.timer` units for cron triggers, Tailscale on the VPS for admin access. Cheapest and simplest. |
| **Docker + supervisord** | Supported | For clients who require containerized deployment. Single container runs Bun process plus cron daemon under supervisord. `bun run generate:docker-compose` produces a starter stack. |
| **Fly.io / Railway** | Supported | When the operator wants Vercel-like git-push DX without giving up persistent SQLite or long-running processes. Single-binary deploy, persistent volumes for the SQLite file, regions worldwide. |
| **Vercel, Netlify, Cloudflare Workers** | **Out of scope** | These platforms have ephemeral filesystems and short function-execution windows that are incompatible with this framework's SQLite-first, long-suspend-friendly architecture. If a client requires Vercel, that is a different framework, not this one. |

The framework itself is an opinionated artifact for VPS and container deployments. We do not ship serverless adapters by design; see `VISION.md` § Why Bun-only and the deployment anti-principles.

## Status

`v0.1` is the initial public spec. Breaking changes are expected through `v0.x`. The first stable contract is `v1.0`.

## License

MIT.

---

# === FILE: VISION.md ===

## What we are building

`@railloom/core` exists because Railloom needs to ship production AI agents to a small set of clients (5–20 over 2–3 years) on a boutique-studio business model. Each client engagement is its own deployment, its own data, its own configuration. We need a framework that:

- Is small enough to read in one sitting and audit in one weekend
- Has zero supply-chain surface beyond what is strictly necessary
- Ships as a single binary that runs on any Linux VPS
- Costs us as close to zero ops time as possible per client

We are not building Mastra. We are not building LangChain. We are not building a SaaS platform. We are building plumbing for a specific shape of work.

## Three principles

### 1. Thin abstractions, owned code

Every primitive in this framework is a thin layer. If we cannot explain what `agent()` does in five sentences and 50 lines of internal code, we have built it wrong. Wrappers add type safety and conventions, never hide behavior.

We do not depend on framework-shaped libraries (Mastra, LangChain, Inngest, Drizzle, Slack Bolt). We borrow concepts from them where useful, and write the implementation ourselves. The cost is reinventing things that exist; the benefit is that nothing breaks because Mastra v2 changed an internal API or because Inngest changed their pricing.

### 2. Single-tenant, deployable artifact

Each Railloom client gets their own deployment. One SQLite file. One Bun process (or two — server + worker). One Slack workspace. One set of secrets. Isolation is physical, not enforced by code.

There is no `tenantId` in the API. There is no row-level security. There is no shared infrastructure. If a client wants to leave, you `tar czf railloom-<client>.tar.gz data/ src/ .env` and hand them the archive.

This is a deliberate trade. We give up scale (we cannot serve 1000 clients on one server). We gain three things: simpler code, zero data-leak risk, and a security story that any CTO can verify in 10 minutes.

### 3. Approval is a primitive, not a pattern

Every agent system that operates on real customer data needs a human gate before irreversible actions. Most frameworks treat this as something you bolt on with a custom queue and a Slack tool. We disagree. **Snapshot-based suspend/resume is a first-class primitive in this framework**, and `suspendForApproval()` is the canonical helper for the human-gate use case.

This single decision shapes much of the API. Workflow steps can `await suspend(payload)` and resume cleanly when external code calls `run.resume({ stepId, resumeData })`. The `suspendForApproval()` helper wraps the Slack posting and approvalId persistence around that mechanic. There is a typed `ApprovalDecision` shape. Posting to Slack and listening for the button click is one line of user code inside a regular `.then()` step.

The choice **not** to model approval as `await approval()` (a function returning a Promise that resolves on Slack click) was deliberate. That shape forces the workflow runtime to stay in memory for the entire wait, leaks process state, and is incompatible with CLI providers (Codex CLI, Claude CLI) where tool-loop runtime lives in a child process. Snapshot-based suspend lets `execute` complete cleanly both times — a normal function exit on suspend, a normal function call on resume.

## Why Bun-only

This is the most opinionated decision in the framework, and it deserves explanation.

Bun gives us:

- **Single-file executables.** `bun build --compile` produces a self-contained binary. No "ensure Bun installed on client server" step. One file, one process. This matches the boutique deployment model (one engagement = one deployable artifact) better than any Node + nvm + pm2 setup.
- **Built-in SQLite, HTTP server, password hashing, file IO, fetch, TypeScript, test runner, bundler.** Removes ~6 dependencies that a Node-equivalent stack would need. Each removed dep is one less supply-chain vector and one less version-incompatibility risk over the multi-year support window we promise clients.
- **Cross-compile from Mac to Linux.** A developer's MacBook produces Linux binaries directly. No CI required for simple deployments.
- **~65MB Docker images** vs 200MB for `node:slim`. Faster cold starts, faster CI, smaller surface for security scanning.
- **Native Web APIs** (`fetch`, `Response`, `URL`, `WebSocket`). Same code patterns as serverless edge runtimes; testing against the real APIs without polyfills.

A relevant note for context: Anthropic acquired Bun in December 2025, and Claude Code ships as a Bun executable. This means Bun's stewardship is now backed by a well-funded organization with strong incentives to keep it excellent. That's a positive signal, but it isn't the reason the framework chose Bun — the technical properties above are. The framework is provider-agnostic; Bun's runtime alignment with one provider's tooling is incidental.

What we give up:

- Some npm packages with native bindings still have edge cases on Bun (similar to Deno). We mitigate this by depending on almost nothing.
- Some clients' DevOps may resist a "non-Node" runtime. For those clients we offer a Docker image wrapped around `oven/bun:1.3-alpine`; the client sees a standard container and what runs inside is our concern. If a client refuses Docker and refuses Bun, that client is not for us at this stage.

## Anti-principles

- **No multi-tenant.** Period. If you need multi-tenant, fork the project, do not request it upstream.
- **Multiple provider implementations in v0.1.** The framework defines a small `LLMProvider` interface and v0.1 ships three built-in adapters: `anthropicProvider` (HTTP API), `codexCliProvider` (subprocess to Codex CLI, subscription-billed), and `claudeCliProvider` (subprocess to Claude CLI, subscription-billed). v0.2 adds `openaiCompatibleProvider` (one adapter covers OpenRouter, LiteLLM, Cloudflare AI Gateway, and any OpenAI Chat Completions-compatible endpoint). Provider-specific features (Anthropic prompt caching, OpenAI structured outputs, etc.) live as optional capabilities on the provider; they are not lost to a lowest-common-denominator interface. Each API-based provider accepts a `baseUrl` parameter, so commercial gateways (Vercel AI Gateway, etc.) work in v0.1 with one config change.
- **No magic context.** No `AsyncLocalStorage`. No proxies. No globals. Configuration goes through `configureRailloom()` once at startup and is held in a single frozen object.
- **No DSL.** Workflows are TypeScript. Tools are TypeScript. Memory is TypeScript.
- **No premature multi-agent.** Single-agent with tools is the default. The framework supports `agent.asTool()` for nested calls but does not encourage agent networks. Mastra (one of the more thoughtful TypeScript agent frameworks) iterated through three multi-agent designs — `AgentNetwork`, `NewAgentNetwork`, and finally `agent.network()` integrated into the Agent primitive — and their community still reports edge cases when multi-agent meets human-in-the-loop (subagents calling parent's tools, memory duplication, message ordering). For a boutique deployable that needs to be reliable from day one, agent networks are not the place to spend complexity budget. When a workflow legitimately needs multiple specialized agents, compose them at the **workflow** level (one step calls one agent) rather than at the **agent** level (one agent embeds another).
- **No persistence abstraction.** SQLite via `bun:sqlite`. Direct SQL where it matters. No ORM.
- **No client-side runtime.** Server framework only. Slack approval UI runs on Slack. The dashboard, when we build one, will be a separate Next.js app.

## What success looks like

Six months from v0.1, Diogo (or another experienced TypeScript developer) can:

- Stand up a new Railloom client engagement in under one day: clone `railloom-engagement-template`, configure secrets, define one agent + one tool + one workflow, deploy as systemd service.
- Build the second agent for that client in under three hours.
- Read the entire `@railloom/core` source in one sitting (~1500 LOC) and understand every primitive.
- Audit the framework's security in one weekend.
- Roll forward through breaking changes by following a one-page migration guide.

The non-goal is community ubiquity. The goal is Railloom velocity.

---

# === FILE: ARCHITECTURE.md ===

## The five primitives

```
                      ┌─────────────────────────┐
                      │    Single deployment    │
                      │   (one SQLite file,     │
                      │    one Bun process)     │
                      └─────────────────────────┘
                                  │
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
   ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
   │     Agent       │   │      Tool       │   │     Memory      │
   │                 │◄──┤                 │   │                 │
   │ • model         │   │ • input schema  │   │ • ephemeral     │
   │ • instructions  │   │ • output schema │   │ • session       │
   │ • tools[]       │   │ • execute()     │   │ • corpus        │
   │ • input schema  │   │ • idempotency   │   └─────────────────┘
   │ • output schema │   │ • timeout       │            ▲
   │ • retry         │   └─────────────────┘            │
   └─────────────────┘            │                     │
            │                     │                     │
            ▼                     ▼                     │
   ┌──────────────────────────────────────────────────────┘
   │                    Workflow
   │   chain: .then() .parallel() .branch() .foreach()
   │   .map() .sleep() .sleepUntil() .commit()
   │   durable: SQLite-backed queue, snapshot suspend/resume,
   │   polling worker
   └──────────────────────────────────────────────────────┐
                                                          │
                                  ▼                       │
                       ┌──────────────────────┐           │
                       │ suspendForApproval() │           │
                       │ (helper, not a       │           │
                       │  primitive — wraps   │           │
                       │  suspend() + Slack)  │           │
                       │ • request shape      │           │
                       │ • payload + editable │           │
                       │ • timeout            │           │
                       │ • resume on decision │           │
                       └──────────────────────┘           │
                                  │                       │
                                  ▼                       │
                       ┌─────────────────┐                │
                       │     Slack       │◄───────────────┘
                       │ (HTTP webhook   │
                       │  + chat API)    │
                       └─────────────────┘
```

### 1. Agent

Wraps an `LLMProvider`. There is no privileged provider — the agent works identically against any implementation of the `LLMProvider` interface. Built-in adapters in v0.1: `anthropicProvider` (HTTP API via `@anthropic-ai/sdk`), `codexCliProvider` (Codex CLI subprocess, subscription-billed), `claudeCliProvider` (Claude CLI subprocess, subscription-billed). Planned in v0.2: `openaiCompatibleProvider` (covers OpenRouter, LiteLLM, Cloudflare AI Gateway, and any OpenAI Chat Completions-compatible endpoint).

The agent adds:

- **Retry policy.** Configurable; sensible defaults (3 attempts, exponential backoff starting 1s).
- **Cost & token tracking.** Every run records `input_tokens`, `output_tokens`, `cost_usd` to the `_railloom_runs` table. Cost is reported by the provider (zero for subscription-billed CLI providers, computed from a price table for API providers).
- **Structured output.** Optional `outputSchema` (Zod). When set, the framework instructs the model to return JSON matching the schema and validates the response.
- **Tool loop.** When the model calls a tool, the framework executes it, validates output, appends result to messages, continues the loop until the model returns a final answer or `maxSteps` is hit. Tool calls through CLI providers route via an internal MCP loopback so user code remains provider-transparent.
- **Memory binding.** Optional `memory` config tells the agent which session and corpus to consult; the framework auto-loads relevant context before the LLM call.

```ts
const a = agent({
  id: string,                       // stable identifier, used as run.agent_id
  provider?: LLMProvider,           // defaults to config.provider (set in configureRailloom)
  model: string,                    // model id is provider-specific (e.g. 'claude-sonnet-4-6', 'gpt-5.4-mini')
  instructions: string | (ctx) => string | Promise<string>,
  tools?: Record<string, Tool>,
  memory?: {
    session?: { id: string };
    corpus?: { collection: string; limit?: number; query?: (input) => string };
  },
  outputSchema?: ZodSchema,
  retry?: { maxAttempts: number; backoff?: 'exponential' | 'linear' },
  maxSteps?: number,                // default 5
  metadata?: Record<string, unknown>,
});
```

### 2. Tool

Wraps a function with type-safe input/output. Tools are atomic operations executed inside the agent's tool-use loop. They do **not** carry an `approval` flag — approval is a workflow-level concern via `suspend` (see § 5). If a tool's effect requires human review, gate it at the workflow step that invokes the tool, not inside the tool itself.

- **Input/output schemas.** Zod. Input is sent to the model as the tool's JSON schema. Output is validated before being returned to the model.
- **Idempotency.** Optional `idempotencyKey: (input) => string` tells the framework to dedupe calls within a configurable window (default 60s). Useful when the model retries a tool call after a timeout.
- **Output validation.** If `output` schema is set, invalid output throws `ToolOutputValidationError` rather than silently returning malformed data.
- **Timeout.** Optional `timeout: number | string` (default `'60s'`). AbortSignal is forwarded through `ctx.signal`.

```ts
const t = tool({
  description: string,
  input: ZodSchema,
  output?: ZodSchema,
  idempotencyKey?: (input) => string,
  timeout?: number | string,        // default '60s'
  execute: ({ input, ctx }) => Promise<unknown>,
});
```

### 3. Workflow

Durable, multi-step orchestration. Concept-borrowed from Mastra; implementation owned.

The framework includes its own queue (`src/queue.ts`, ~150 LOC) backed by SQLite. A polling worker picks up due jobs and runs them. Each step's result is persisted; if the process restarts, the workflow resumes from the last completed step.

Chain methods:

- `.then(step)` — sequential
- `.parallel([steps])` — concurrent fan-out, joins on completion
- `.branch({ when, then, otherwise })` — conditional path
- `.foreach(step, { concurrency })` — fan-out over array input, bounded concurrency
- `.map(transform)` — pure data shape change between steps
- `.sleep(ms)` — suspend the run for a duration, then resume with `inputData` unchanged
- `.sleepUntil(date)` — suspend until a calendar time
- `.commit()` — finalize the chain

There is **no** `.approval()` chain method. Approval is handled inside any regular `.then()` step via `suspendForApproval()` (see § 5). This keeps the chain methods focused on control flow and pushes domain-specific patterns into step bodies where they belong.

Each step gets `{ inputData, resumeData, suspend, ctx }` where `ctx` provides `runId`, `traceId`, `audit()`, and `signal` (for cancellation). `resumeData` is undefined on first execution and populated by `run.resume()` on subsequent invocations.

```ts
const wf = workflow({
  id: string,
  trigger: { event: string } | { cron: string } | { manual: true },
  input: ZodSchema,
  concurrency?: { limit: number; key?: (event) => string },
})
  .then(step1)
  .parallel([step2a, step2b])
  .branch({
    when: ({ previous }) => previous.score > 0.7,
    then: actStep,
    otherwise: skipStep,
  })
  .commit();
```

For approval-gated steps, see § 5. The pattern is a regular `.then()` step whose `execute` calls `suspendForApproval()` on first run and reads `resumeData` on second run.

### 4. Memory

Three memory kinds, deliberately distinct:

**Ephemeral** — lives only for the duration of one agent run. Stored in a `Map`, garbage-collected when the run ends. Used for "scratchpad" reasoning.

**Session** — lives for the duration of a conversation or workflow run. Stored in `_railloom_session_memory` table, partitioned by `session_id`. Used for chat history, multi-turn context.

**Corpus** — long-lived semantic memory. Stored in `_railloom_corpus` with a vector column (FLOAT array, dimension 1536 for `text-embedding-3-small`). Search uses brute-force cosine similarity in JavaScript. This is fast enough for up to ~10K entries per collection (which covers all realistic Railloom use cases). Above that, we will add `sqlite-vec` extension as opt-in.

> **Design note.** Our corpus is a **generic semantic store** keyed by collection name, decoupled from any conversation, thread, or user. This differs from frameworks like Mastra where semantic recall is bound to a `threadId` (and optionally `resourceId`). The Reddit-agent voice exemplars use case is exactly the case our shape was built for: a corpus about *the founder's writing voice*, not about any particular conversation. If a future use case needs thread-scoped semantic recall, layer it on top by storing `threadId` in entry metadata and filtering at search time.

The framework provides:

```ts
namespace memory {
  function ephemeral<T>(): EphemeralHandle<T>;
  function session(sessionId: string): SessionHandle;
  function corpus(collection: string): CorpusHandle;
}
```

Embeddings are generated via OpenAI's `text-embedding-3-small` (1536 dimensions) called through direct `fetch()`. The framework owns ~30 LOC of OpenAI HTTP wrapper in `src/embeddings.ts`. There is no `openai` SDK dependency.

### 5. Suspend / resume + Approval

**Concept borrowed from Mastra.** A workflow step's `execute` function receives a `suspend` callable in addition to `inputData` and `ctx`. When `execute` calls `await suspend(payload)`, the framework persists a snapshot of the workflow run (input, accumulated state, current step id, and the suspend payload) to the queue table, and the execute function returns. The Bun process is now free; the run is dormant.

The same `execute` function is invoked **a second time** when external code calls `run.resume({ stepId, resumeData })`. On resume the function receives `resumeData` set to the value passed to `resume()`, while `inputData` is restored from the snapshot. The function inspects `resumeData` and branches:

```ts
.then({
  id: 'review-draft',
  inputSchema: z.object({ post: z.any(), draft: z.string() }),
  resumeSchema: z.object({
    action: z.enum(['approved', 'edited', 'rejected', 'timed_out']),
    payload: z.record(z.unknown()).optional(),
    decidedBy: z.string().optional(),
  }),
  execute: async ({ inputData, resumeData, suspend, ctx }) => {
    if (!resumeData) {
      // first execution: post to Slack, suspend
      return await suspendForApproval(suspend, {
        kind: 'reddit_reply_draft',
        summary: `r/${inputData.post.subreddit}: ${inputData.post.title.slice(0, 80)}`,
        payload: { draftText: inputData.draft, postUrl: inputData.post.permalink },
        editable: ['draftText'],
        timeout: '24h',
      });
    }
    // second execution (resumed): act on the decision
    if (resumeData.action === 'rejected' || resumeData.action === 'timed_out') {
      return { drafted: true, posted: false };
    }
    return { drafted: true, finalText: resumeData.payload!.draftText };
  },
})
```

**Why this shape rather than the previous `await approval()` design:**

The previous spec versions modelled approval as `const decision = await approval({...})` inside the step. That design implicitly required the agent loop or workflow runtime to remain in memory for the entire wait. For 24-hour Slack approval windows that meant either a leaking process or a complex "suspend the awaited Promise" mechanism that fights JavaScript semantics. It also broke MCP and CLI provider compatibility, because tool-loop runtime lives inside the provider (Codex CLI, Claude CLI), and we cannot freeze a Promise that lives inside a child process.

The Mastra-borrowed shape sidesteps all of this. `execute` runs to completion both times. Suspend is a clean function exit. The Bun process is free during the wait. CLI providers complete their tool roundtrips before suspend is ever called. The framework's only job is to (a) snapshot state on suspend, (b) wake the run on resume, (c) call `execute` again with `resumeData` populated.

**Constraint this imposes:**

`execute` must be a **pure function of (inputData, resumeData)**. Closures over external state are forbidden — they will not survive process restarts. Any state needed across the suspend boundary must go into the snapshot via the explicit suspend payload or the workflow run's accumulator.

**This is a code-review discipline, not a type-system invariant.** TypeScript cannot detect closure capture. `inputSchema`/`resumeSchema`/`outputSchema` give you compile-time shape checks on the data crossing the suspend boundary, but they cannot prove that `execute` doesn't read from a module-level cache, an open file handle, or a class instance whose state will be gone after restart. Module-level singletons that are re-initialized at process start (the configured `db` SQLite handle, the configured Slack client, the framework logger) are safe to close over because they are reconstructed deterministically; everything else is not. CONVENTIONS.md spells out the carve-out and the audit checklist.

**`suspendForApproval()` helper:**

Approval is the dominant suspend use case. The framework provides a thin wrapper that:
1. Generates an `approvalId`
2. Persists an `_railloom_approvals` row with the request payload, editable fields, timeout
3. Posts to Slack via `chat.postMessage` with Approve/Edit/Reject buttons (each button payload includes `approvalId`)
4. Calls `suspend()` with a payload that includes the `approvalId` so the resume path can correlate

```ts
export async function suspendForApproval(
  suspend: (payload: ApprovalSuspendPayload) => Promise<never>,
  request: ApprovalRequestSpec,
): Promise<never>;
```

**The Slack webhook handler:**

When Slack POSTs to `/webhooks/slack/interactivity` the framework:
1. Verifies HMAC signature
2. Parses action and approvalId from button payload
3. Updates `_railloom_approvals` row with status, decision_payload, decided_by, decided_at
4. Calls `run.resume({ stepId: 'review-draft', resumeData: { action, payload, decidedBy } })` on the suspended run identified by the approval row's `workflow_run_id`

**Edit modal:**

Clicking Edit opens a Slack modal with editable payload fields as textareas. Modal submission posts `view_submission` to `/webhooks/slack/view-submission`, framework writes edited payload, resumes with `action: 'edited'`.

**Timeout sweep:**

A periodic sweep query (run by the same worker that polls the queue, every 30 seconds) finds approvals where `status = 'pending' AND timeout_at < now()`, marks them `timed_out`, and resumes the corresponding run with `action: 'timed_out'`.

**Other suspend use cases (not approval):**

The `suspend` primitive is general. Beyond approvals, workflows can suspend for: external webhook arrival (e.g. waiting for a payment provider callback), polling completion of a long-running external job, sleep until a calendar time. The `.sleep(ms)` and `.sleepUntil(date)` chain methods are sugar over suspend with a timer-driven resume.

## Data flow: a single agent run

```
1. agent.run({ input })
    │
    ├─ open RunContext { runId, traceId }
    ├─ load session memory if configured
    ├─ load corpus context via embedding query if configured
    │
    ▼
2. anthropic.messages.create({ model, system, messages, tools })
    │
    ├─ if response is text: return as final
    ├─ if response is tool_use:
    │   ├─ run tool.execute({ input, ctx })
    │   ├─ validate output against tool.output schema
    │   ├─ append tool_result to messages
    │   └─ goto step 2
    │
    ├─ continues until final text or maxSteps hit
    │
    ▼
3. close RunContext
    ├─ persist to _railloom_runs: tokens, cost, duration, error
    ├─ append session memory (if configured)
    └─ return RunResult { output, messages, runId, cost, durationMs }
```

## Data flow: a workflow with HITL

```
External trigger arrives
  (cron from systemd → POST /triggers/:workflowId, manual call,
   or other workflow's emit-event step)
    │
    ▼
queue.enqueue({ workflowId, input, runId })
    │
    ▼
queue worker (polling, every 100ms by default)
    │
    ├─ pick up next due job
    ├─ load snapshot (input, accumulator, current step id)
    ├─ execute current step's execute(inputData, resumeData?, suspend, ctx)
    │   │
    │   ├─ step returns normally:
    │   │   └─ persist result, advance step pointer, re-enqueue
    │   │
    │   ├─ step calls suspend(payload):
    │   │   ├─ persist snapshot to _railloom_queue (status='suspended')
    │   │   ├─ if it's an approval suspend:
    │   │   │   ├─ persist _railloom_approvals row with payload, timeout_at
    │   │   │   └─ post Slack message with approvalId in button payload
    │   │   ├─ execute returns (the suspend throws an internal sentinel)
    │   │   └─ worker moves on to other jobs; this run is dormant
    │   │
    │   └─ step throws:
    │       └─ retry per step.retries; on exhaustion, mark run 'error'
    │
    └─ loop

Resume path:
    │
    ├─ Slack interactivity webhook hits /webhooks/slack/interactivity
    │   ├─ verify HMAC
    │   ├─ parse approvalId, action, payload
    │   ├─ update _railloom_approvals row
    │   └─ load suspended run, call run.resume({ stepId, resumeData: Decision })
    │
    ├─ OR timeout sweep (every 30s in worker):
    │   ├─ SELECT pending approvals with timeout_at < now()
    │   ├─ mark each 'timed_out'
    │   └─ resume the corresponding run with action: 'timed_out'
    │
    └─ run.resume() flips queue status back to 'pending', sets step's resumeData,
       worker picks it up, executes step again with resumeData populated.
       Step branches on resumeData and returns normally.
```

## Suspend inside foreach: fan-out semantics

`.foreach({ step }, { concurrency })` is the only chain method that fans a single workflow run into N parallel sub-runs. Because each sub-run can independently `suspend()` for approval, `.foreach` cannot be modeled as one queue row with per-item state in the snapshot — the snapshot would be rewritten by every concurrent sub-run, races would corrupt it, and a single failed item would force re-running the whole foreach. Railloom uses **eager sub-run materialization** instead.

### Eager sub-run model

When the workflow runner reaches a `.foreach` step:

1. The runner reads the previous step's output (an array of items).
2. **One `_railloom_queue` row is inserted per item** with:
   - `id` = fresh sub-run UUID
   - `parent_run_id` = the workflow run id of the step's parent
   - `kind = 'step'` (the sub-row executes the foreach step body)
   - `item_index` = 0..N-1 (position in the original array)
   - `step_id` = the foreach step's id
   - `status = 'pending'`
   - `snapshot = { inputData: items[i], ... }` — input is the single item, not the array
3. **One additional `_railloom_queue` row is inserted as the aggregator** with:
   - `id` = fresh aggregator UUID
   - `parent_run_id` = the parent workflow run id
   - `kind = 'fanout_parent'`
   - `step_id` = the foreach step's id
   - `step_index` = current step ordinal in chain
   - `status = 'pending'` (aggregator rows are flipped to `success` only when all children are terminal)

Sub-rows execute through the normal worker loop. The worker's `idx_queue_due` partial index excludes `kind = 'fanout_parent'`, so aggregator rows never have `execute()` called on them. Concurrency is enforced by the worker's `LIMIT N` query against pending sub-rows for a given parent — no in-memory semaphore is needed.

### Aggregation rule

A `kind='fanout_parent'` row is swept on every worker tick. The sweep query:

```sql
SELECT p.id AS parent_id,
       COUNT(*) AS total,
       SUM(CASE WHEN c.status IN ('success','error','cancelled') THEN 1 ELSE 0 END) AS terminal
FROM _railloom_queue p
JOIN _railloom_queue c ON c.parent_run_id = p.id
WHERE p.kind = 'fanout_parent' AND p.status = 'pending'
GROUP BY p.id
HAVING terminal = total;
```

For each row returned, the worker materializes the aggregated output and flips the parent's status:

- The aggregated output is `Array<ForeachItemResult<TResult>>` where each entry carries `{ status, output? | error?, itemIndex }`. Order is preserved by `item_index`.
- The parent row transitions to `'success'` **regardless of whether any child item failed**. Partial failures are visible in the aggregated output, not by throwing — see "Why partial-success" below.
- The parent's `snapshot` accumulator is updated with the aggregated array, and the workflow advances to the next step in the chain.

### Why partial-success (and the breaking type change it implies)

Earlier draft type for foreach was `WorkflowChain<TInput, TResult[]>`. We are changing this to `WorkflowChain<TInput, Array<ForeachItemResult<TResult>>>` because:

1. **All-or-nothing is the wrong default for the boutique deployment shape.** A Reddit cycle that fetches 30 posts and fails classification on 1 should still draft replies for the other 29. Throwing on first failure forces the operator to either retry the whole batch (wasteful) or write a try/catch around every step body (defensive). Surfacing `{ status, output | error }` per item lets downstream code decide what to do with failures explicitly.
2. **Operability.** `SELECT * FROM _railloom_queue WHERE parent_run_id = ?` shows exactly which items succeeded and which failed, with their errors. Debugging is concrete.
3. **Type honesty.** The previous type pretended foreach was atomic. It never was — items execute concurrently and independently. The new type matches reality.

```ts
type ForeachItemResult<T> =
  | { status: 'success'; output: T; itemIndex: number }
  | { status: 'error'; error: SerializedError; itemIndex: number }
  | { status: 'cancelled'; itemIndex: number };

type SerializedError = { name: string; message: string; code?: string; cause?: unknown };
```

Consumers that want all-or-nothing semantics write an explicit guard in the next step:

```ts
.foreach({ ... }, { concurrency: 3 })
.then({
  id: 'reject-on-any-failure',
  execute: async ({ inputData: items }) => {
    const failed = items.filter(i => i.status === 'error');
    if (failed.length > 0) throw new WorkflowStepError(`${failed.length} items failed`, { cause: failed });
    return items.map(i => i.output!);  // narrowed; .find proved no errors
  },
})
```

### Suspend inside foreach: independence

A foreach sub-row can call `suspend()` from inside its `execute`. The sub-row transitions to `status='suspended'` exactly like a top-level run. Resumption (Slack webhook → `run.resume(subRunId, ...)`) flips the sub-row back to `'pending'` and the worker picks it up. The aggregator row stays `'pending'` until **every** sub-row reaches terminal state — meaning a foreach with 30 items, 5 of which suspend for 24h approval, will keep the parent pending for up to 24h while the other 25 items complete. This is the intended behavior: the workflow does not advance past `.foreach` until every item has been decided one way or another.

The 24h approval timeout sweep (see § Approval flow atomicity below) operates per-approval, not per-foreach: an item that times out resumes its sub-row with `{ action: 'timed_out' }` exactly as a top-level approval would.

## Approval flow atomicity guarantees

The framework's central promise — "resume is explicit and idempotent" — is enforced by three concrete invariants:

### Invariant 1 — Approval status mutations are guarded

Every UPDATE on `_railloom_approvals` MUST include `WHERE status = 'pending'`:

```sql
-- webhook handler
UPDATE _railloom_approvals
SET status = ?, decision_payload = ?, decided_by = ?, decided_at = ?
WHERE id = ? AND status = 'pending';

-- timeout sweep
UPDATE _railloom_approvals
SET status = 'timed_out', decided_at = ?
WHERE id = ? AND status = 'pending' AND timeout_at <= ?;
```

After the UPDATE, the caller MUST check `db.changes()`. If `changes() == 0`, the approval was already decided (by a prior webhook delivery, by the sweep beating the webhook, or by an admin override) and the call must NOT proceed to `run.resume()`. Log `approval.race.no_op` at info level with the approvalId; respond 200 to Slack so it stops retrying; return without error.

### Invariant 2 — Queue resume is an atomic CAS

`run.resume({ stepId, resumeData })` resolves to a single guarded UPDATE:

```sql
UPDATE _railloom_queue
SET status = 'pending',
    snapshot = json_set(snapshot, '$.resumeData', ?),
    scheduled_at = ?
WHERE id = ? AND status = 'suspended';
```

If `changes() == 0`, the run was either (a) already resumed, (b) cancelled by an admin, or (c) reached terminal state through some other path. `run.resume()` returns without error in all three cases — it is **idempotent by construction**. The webhook handler logs `run.resume.no_op` and returns 200.

### Invariant 3 — Sweep + resume are paired in one transaction

The timeout sweep performs both the approval status flip and the queue resume in **one SQLite transaction**:

```sql
BEGIN;
UPDATE _railloom_approvals SET status='timed_out', decided_at=? WHERE id=? AND status='pending';
-- if changes() == 0, ROLLBACK and skip — webhook beat us
UPDATE _railloom_queue SET status='pending', snapshot=json_set(...), scheduled_at=?
  WHERE id=? AND status='suspended';
-- if changes() == 0, ROLLBACK — run was already terminal
COMMIT;
```

This eliminates the "approval marked timed_out but workflow stuck suspended" failure mode that an unguarded sequential pair would produce. SQLite's single-writer model and WAL mode make this transaction safe under concurrent webhook delivery.

### Webhook handler edge cases (mandatory behavior)

- **HMAC valid + approvalId not in DB**: respond 200 (so Slack stops retrying), log `approval.unknown_id` at error level. Do not respond 4xx — Slack treats 4xx as transient and may retry up to 3 times, generating spurious error logs.
- **HMAC invalid**: respond 401, log `approval.hmac_invalid` at warn level.
- **HMAC valid + run already terminal (`error`/`cancelled`)**: the guarded resume in Invariant 2 returns no-op. Webhook handler also persists the (now no-op) decision into `_railloom_approvals.decision_payload` for audit trail, then responds 200.
- **Slack delivers the same webhook twice within 1s**: both arrive in the webhook handler concurrently. Both call the guarded UPDATE in Invariant 1; only one wins (`changes() == 1`); the other no-ops and returns 200. Slack stops retrying after the first 200.

These behaviors are testable: see CONVENTIONS.md § Three concrete testing patterns for the resume/race test pattern.

## File layout

```
@railloom/core/
├── src/
│   ├── runtime.ts          # Bun-specific helpers (hash, fmt, signal)
│   ├── config.ts           # configureRailloom() and global config object
│   ├── db.ts               # SQLite schema + bare query helpers
│   ├── queue.ts            # SQLite-backed queue + polling worker
│   ├── server.ts           # Bun.serve() routes
│   ├── embeddings.ts       # OpenAI embeddings via fetch
│   ├── slack.ts            # Slack HMAC verify + chat.postMessage
│   ├── providers/
│   │   ├── types.ts        # LLMProvider interface + supporting types
│   │   ├── anthropic.ts    # anthropicProvider (the only file importing @anthropic-ai/sdk)
│   │   ├── codex-cli.ts    # codexCliProvider (subprocess; uses _mcp-loopback for tools)
│   │   ├── claude-cli.ts   # claudeCliProvider (subprocess; uses _mcp-loopback for tools)
│   │   └── _mcp-loopback.ts # internal: minimal MCP server over stdio, used by CLI providers
│   ├── agent.ts            # agent() factory
│   ├── tool.ts             # tool() factory
│   ├── workflow.ts         # workflow() factory + chain + suspend/resume runner
│   ├── memory.ts           # ephemeral + session + corpus
│   ├── suspend-helpers.ts  # suspendForApproval() and other suspend convenience helpers
│   ├── eval.ts             # createScorer() + attachScorer() + score persistence
│   ├── observability.ts    # structured JSON logs + audit log
│   ├── errors.ts           # RailloomError and subclasses
│   └── index.ts            # public API barrel
├── examples/
│   ├── reddit-agent/       # standalone repo: bun add @railloom/core
│   └── morning-briefing/   # standalone repo: bun add @railloom/core
├── tests/
│   ├── agent.test.ts
│   ├── tool.test.ts
│   ├── workflow.test.ts
│   ├── memory.test.ts
│   └── approval.test.ts
├── package.json
├── tsconfig.json           # minimal; Bun runs .ts directly
├── bunfig.toml
├── README.md
├── VISION.md
├── ARCHITECTURE.md
├── API.md
├── CONVENTIONS.md
├── CLAUDE.md
├── LICENSE                  # MIT
└── CHANGELOG.md
```

## Database schema

Single SQLite file per deployment. The framework owns tables prefixed `_railloom_`. User code can add its own tables freely.

```sql
-- Agent runs
CREATE TABLE _railloom_runs (
  id TEXT PRIMARY KEY,                       -- UUID
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,                      -- 'running' | 'success' | 'error' | 'cancelled'
  input TEXT NOT NULL,                       -- JSON
  output TEXT,                               -- JSON
  error TEXT,                                -- JSON
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  trace_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,               -- ms epoch
  ended_at INTEGER
);
CREATE INDEX idx_runs_started ON _railloom_runs (started_at DESC);
CREATE INDEX idx_runs_agent ON _railloom_runs (agent_id, status);

-- Tool calls
CREATE TABLE _railloom_tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES _railloom_runs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  error TEXT,
  approval_id TEXT,                          -- nullable
  duration_ms INTEGER,
  status TEXT NOT NULL,                      -- 'running' | 'success' | 'error' | 'rejected'
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

-- Approval requests
CREATE TABLE _railloom_approvals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,                     -- JSON
  editable_fields TEXT NOT NULL DEFAULT '[]', -- JSON array
  status TEXT NOT NULL,                      -- 'pending' | 'approved' | 'edited' | 'rejected' | 'timed_out'
  decision_payload TEXT,                     -- JSON, populated on decision
  decided_by TEXT,                           -- Slack user ID
  channel TEXT NOT NULL,
  channel_message_ref TEXT,                  -- Slack ts
  timeout_at INTEGER NOT NULL,
  run_id TEXT REFERENCES _railloom_runs(id),
  workflow_run_id TEXT,                      -- queue job ID
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX idx_approvals_status ON _railloom_approvals (status);
CREATE INDEX idx_approvals_pending ON _railloom_approvals (status, timeout_at)
  WHERE status = 'pending';

-- Session memory
CREATE TABLE _railloom_session_memory (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,                        -- 'user' | 'assistant' | 'system' | 'tool'
  content TEXT NOT NULL,                     -- JSON
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_session ON _railloom_session_memory (session_id, created_at);

-- Corpus memory (vector)
CREATE TABLE _railloom_corpus (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  embedding BLOB NOT NULL,                   -- packed float32 array, 1536 * 4 = 6144 bytes
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_corpus_collection ON _railloom_corpus (collection);
-- Note: no vector index. Brute-force cosine in JS for < 10K entries.
-- For larger corpora, add sqlite-vec extension as an opt-in.

-- Queue (workflow durability + suspend/resume snapshots)
CREATE TABLE _railloom_queue (
  id TEXT PRIMARY KEY,                       -- workflow run id (or sub-run id for foreach items)
  workflow_id TEXT NOT NULL,
  parent_run_id TEXT REFERENCES _railloom_queue(id),  -- null for top-level runs; set for foreach sub-rows
  kind TEXT NOT NULL DEFAULT 'step',         -- 'step' | 'fanout_parent'
                                             -- 'fanout_parent' rows aggregate child sub-rows; the worker does NOT
                                             -- call execute() on them, only checks terminal aggregation.
  item_index INTEGER,                        -- null for non-foreach rows; 0..N-1 for foreach sub-rows (preserves order)
  step_id TEXT NOT NULL,                     -- current step id (for resume targeting)
  step_index INTEGER NOT NULL,               -- ordinal in chain
  snapshot TEXT NOT NULL,                    -- JSON: { inputData, accumulator, stepResults, suspendPayload? }
  status TEXT NOT NULL,                      -- 'pending' | 'running' | 'suspended' | 'success' | 'error' | 'cancelled'
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_queue_due ON _railloom_queue (status, scheduled_at)
  WHERE status = 'pending' AND kind = 'step';        -- worker only picks up 'step' rows
CREATE INDEX idx_queue_suspended ON _railloom_queue (status)
  WHERE status = 'suspended';
CREATE INDEX idx_queue_parent ON _railloom_queue (parent_run_id)
  WHERE parent_run_id IS NOT NULL;                   -- aggregation queries on fanout children
-- Suspended runs sit here until external code calls run.resume(). The status
-- transitions to 'pending' on resume, the worker picks it up, calls execute
-- with resumeData populated. Resume MUST be implemented as an atomic CAS:
--   UPDATE _railloom_queue SET status='pending', snapshot=json_patch(snapshot, ?)
--   WHERE id=? AND status='suspended'
-- and check `changes() == 1`. If 0, the row was already resumed (duplicate
-- webhook, race with sweep) and the resume call returns no-op without error.
-- This is what "explicit and idempotent" means concretely; see § Suspend
-- inside foreach and § Approval flow atomicity below.

-- Scorer results (eval primitives)
CREATE TABLE _railloom_scores (
  id TEXT PRIMARY KEY,
  scorer_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,                 -- 'agent_run' | 'workflow_step'
  target_id TEXT NOT NULL,                   -- run id or step run id
  score REAL NOT NULL,                       -- typically 0..1, scorer-defined range allowed
  reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_scores_target ON _railloom_scores (target_id);
CREATE INDEX idx_scores_recent ON _railloom_scores (scorer_id, created_at DESC);

-- Audit log (immutable, append-only)
CREATE TABLE _railloom_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,                       -- JSON: { kind: 'agent'|'human'|'system', id }
  action TEXT NOT NULL,                      -- e.g. 'tool.executed', 'approval.granted'
  resource TEXT,                             -- JSON: { kind, id }
  payload TEXT,                              -- JSON
  trace_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON _railloom_audit (created_at DESC);
CREATE INDEX idx_audit_action ON _railloom_audit (action, created_at DESC);

-- Cost-cap alert dedup (so dailyUsdWarn / dailyUsdHard each fire at most once per UTC day)
CREATE TABLE _railloom_costcap_alerts (
  date TEXT NOT NULL,                        -- 'YYYY-MM-DD' UTC
  tier TEXT NOT NULL,                        -- 'warn' | 'hard'
  fired_at INTEGER NOT NULL,                 -- ms epoch when first crossing happened
  spend_at_fire REAL NOT NULL,               -- daily total at the moment the alert fired
  PRIMARY KEY (date, tier)                   -- one row per (day, tier); both can coexist same day
);
```

WAL mode is enabled at startup (`PRAGMA journal_mode = WAL`) for concurrent reads with one writer. `PRAGMA synchronous = NORMAL` for performance; `synchronous = FULL` for paranoid deployments.

## Process model

A deployment has one or two Bun processes:

**Mode 1: Single process (default for boutique deployments).**
One Bun process runs `Bun.serve()` for HTTP routes (Slack webhooks, health check, manual trigger endpoints) and the queue polling worker as a `setInterval` in the same process. (CLAUDE.md's prohibition on `setInterval` covers **time-based workflow triggers** like cron — those are delegated to systemd timers. The queue poll loop is a different category: it's a process-internal heartbeat to drain a durable queue, restarted whenever the process restarts, and not load-bearing for "fire workflow X every 30 minutes" semantics. The carve-out is documented in CLAUDE.md § What to never do.)

**Mode 2: Two processes (for higher load).**
- Web process: `Bun.serve()` only, no worker.
- Worker process: queue worker only, no HTTP.

Both processes share the same SQLite file. SQLite WAL mode handles concurrent reads safely; one writer at a time is enforced by SQLite itself. For the deployment sizes Railloom targets (a handful of agents per client, < 10K runs/day), Mode 1 is sufficient. Mode 2 is documented for clients who want isolation.

### Network exposure

Deployments are designed to be **mesh-VPN-friendly**. Only the Slack webhook endpoint must be publicly reachable (Slack initiates the inbound webhook); admin endpoints, health checks, future dashboard, and direct database access for debugging all bind to a private interface by convention.

The recommended pattern is Tailscale or any WireGuard-based mesh VPN. `Bun.serve({ hostname, port })` accepts an interface name, so the framework's server can bind public routes to `0.0.0.0` and admin routes to a tailnet interface. Across multiple Railloom deployments (Wolff, Slate, Abidera), one tailnet gives the operator unified ssh-config, one `tailscale status` view of the entire fleet, and revocation that goes through the client's tailnet ACL rather than `authorized_keys` rotation.

This is convention, not framework-enforced — but the code is structured so that splitting public and private routes is a config change, not a refactor.

---

# === FILE: API.md ===

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

# === FILE: CONVENTIONS.md ===

## Code conventions

### File naming

- Files: `kebab-case.ts`.
- Test files colocated with `.test.ts` suffix: `agent.ts` → `agent.test.ts`.
- Public exports go in `src/index.ts`. Internal modules are not re-exported.

### Module boundaries

- `src/agent.ts` may import from `tool`, `memory`, `observability`, `db`, `errors`, `runtime`, `config`, `providers/types`. **It must NOT import any provider SDK directly** — agent code consumes the model only through the `LLMProvider` interface.
- `src/providers/types.ts` is a leaf. It defines the `LLMProvider` interface and supporting types. It may not import from any primitive.
- `src/providers/anthropic.ts` may import from `providers/types`, `errors`, `runtime`, plus `@anthropic-ai/sdk`. This is the only file in the framework that imports the Anthropic SDK.
- `src/providers/codex-cli.ts` may import from `providers/types`, `providers/_mcp-loopback`, `tool` (type only), `errors`, `runtime`. Uses `Bun.spawn` directly, no SDK.
- `src/providers/claude-cli.ts` mirrors codex-cli.ts.
- `src/providers/_mcp-loopback.ts` may import from `tool` (type only), `errors`, `runtime`. It is internal — not re-exported from the public barrel.
- `src/tool.ts` may import from `observability`, `db`, `errors`, `runtime`.
- `src/workflow.ts` may import from `agent`, `tool`, `queue`, `observability`, `db`, `errors`, `runtime`. The workflow runner lives here and orchestrates suspend/resume.
- `src/memory.ts` may import from `db`, `embeddings`, `errors`, `runtime`.
- `src/suspend-helpers.ts` may import from `db`, `slack`, `errors`, `runtime`, `config`. Holds `suspendForApproval()` and similar convenience helpers — not a primitive itself.
- `src/eval.ts` may import from `db`, `errors`, `runtime`, `agent` (for type-only import of Agent).
- `src/queue.ts` may import from `db`, `errors`, `runtime`.
- `src/db.ts`, `src/runtime.ts`, `src/config.ts`, `src/errors.ts`, `src/observability.ts` are leaf modules. They may not import from any primitive.
- `src/server.ts`, `src/embeddings.ts`, `src/slack.ts` are leaf integrations. They may not import from any primitive.

### Naming

- Types: `PascalCase`. `RunContext`, `ApprovalRequest`.
- Factory functions: lowercase. `agent()`, `tool()`, `workflow()`, `createScorer()`.
- Constants: `SCREAMING_SNAKE_CASE`. `DEFAULT_TIMEOUT_MS`.
- Internal (non-exported) helpers: prefix with `_`. `_validateInput`, `_serializeError`.

### Error handling

Every public function declares thrown errors at the top of its file:

```ts
/**
 * @throws {ToolOutputValidationError} if execute() returns shape mismatching output schema
 * @throws {WorkflowStepError} if a step fails and exhausts its retry budget
 */
```

All framework errors extend `RailloomError`. User code can extend it for domain errors.

### Logging

The framework uses structured JSON logs to stdout by default. There is no `console.log` in framework code. Log lines are JSON objects:

```json
{"ts":"2026-05-04T10:30:15.123Z","level":"info","event":"agent.run.started","agent_id":"reddit-classifier","run_id":"...","trace_id":"..."}
```

User code logs through `ctx.log` (inside steps and tools). Framework code logs through a module-local `log` instance imported from `observability`.

The OpenTelemetry export is opt-in (`log.output: customWriter`). Default deployments do not need OTel.

### Async patterns

- Always `async`/`await`. No `.then()` chains.
- Use `AbortSignal` for cancellation. Every long-running operation accepts an optional `signal`.
- Never swallow errors silently. A `catch` without rethrow or logged reason is a bug.

### Testing

- `bun test`. No vitest, no jest.
- Unit tests use `bun:test` API.
- Integration tests run against an in-memory SQLite (`:memory:`) and a mock Slack server.
- Every public API has at least a happy-path test and a primary failure-mode test.
- We mock external HTTP at the `fetch` boundary using `mock` from `bun:test`. We do not mock internal modules.

#### Three concrete testing patterns

**Pattern 1: Agent test with mock provider.**

```ts
import { mock, test, expect } from 'bun:test';
import { agent } from '@/lib/agent';
import { z } from 'zod';

test('classifier returns structured output', async () => {
  const mockProvider = {
    name: 'mock',
    complete: mock(async () => ({
      content: [{ type: 'text', text: '{"intent":"app-recommendation","fitScore":0.8,"draftRecommended":true,"reasoning":"asks about EP apps"}' }],
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 100, outputTokens: 50 },
    })),
  };

  const classifier = agent({
    id: 'test-classifier',
    provider: mockProvider,
    model: 'claude-haiku-4-5',
    instructions: 'classify',
    outputSchema: z.object({
      intent: z.string(),
      fitScore: z.number(),
      draftRecommended: z.boolean(),
      reasoning: z.string(),
    }),
    maxSteps: 1,
  });

  const result = await classifier.run({ input: { post: 'best app for European Portuguese' } });

  expect(mockProvider.complete).toHaveBeenCalledTimes(1);
  expect(result.output.draftRecommended).toBe(true);
  expect(result.output.fitScore).toBe(0.8);
});
```

**Pattern 2: Tool test with mock fetch.**

```ts
import { mock, test, expect } from 'bun:test';
import { fetchSubredditNew } from '@/tools/reddit';

test('fetchSubredditNew parses Reddit response', async () => {
  globalThis.fetch = mock(async () => new Response(JSON.stringify({
    data: { children: [{ data: { id: 'abc', title: 'test', selftext: 'body', permalink: '/r/test/abc', author: 'u', created_utc: 1700000000 } }] },
  })));

  mock.module('@/domain/reddit-auth', () => ({ getRedditToken: async () => 'tkn' }));

  const result = await fetchSubredditNew.execute({
    input: { subreddit: 'test', limit: 25 },
    ctx: makeMockCtx(),
  });

  expect(result).toHaveLength(1);
  expect(result[0].id).toBe('abc');
  expect(result[0].permalink).toBe('https://reddit.com/r/test/abc');
});
```

**Pattern 3: Workflow test with in-memory SQLite and resume.**

```ts
import { test, expect } from 'bun:test';
import { configureRailloom, startWorker } from '@/lib/index';
import { monitor } from '@/workflows/monitor';

test('workflow suspends on approval and resumes correctly', async () => {
  configureRailloom({ dbPath: ':memory:', provider: mockProvider });
  const worker = await startWorker();

  const { runId } = await monitor.trigger({ input: { /* ... */ } });

  // poll until suspended
  await waitForStatus(runId, 'suspended');

  // simulate Slack approval webhook
  await monitor.resume({
    runId,
    stepId: 'review-draft',
    resumeData: {
      action: 'approved',
      payload: { draftText: 'edited text' },
      decidedBy: 'U123',
      decidedAt: new Date(),
    },
  });

  await waitForStatus(runId, 'success');

  const drafts = db.query('SELECT * FROM abidera_drafts WHERE status = ?').all('approved');
  expect(drafts).toHaveLength(1);

  await worker.stop();
});
```

The integration test pattern exercises the full snapshot/resume cycle without a real Slack workspace. For cron-triggered workflows the test triggers manually via `workflow.trigger({ input })` — system cron is not exercised in tests.

### Environment-driven provider selection

The standard deployment pattern uses an environment variable to pick the provider, so the same code runs against a CLI provider during development (free via subscription) and an API provider in production. Code never changes between environments.

```ts
// src/lib/provider.ts
import { anthropicProvider, codexCliProvider, claudeCliProvider, type LLMProvider } from '@railloom/core';

export function pickProvider(): LLMProvider {
  switch (process.env.PROVIDER ?? 'anthropic') {
    case 'codex-cli':
      return codexCliProvider({
        model: process.env.CODEX_MODEL ?? 'gpt-5.4-mini',
        authMode: 'subscription',
      });
    case 'claude-cli':
      return claudeCliProvider({
        model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
      });
    case 'anthropic':
    default:
      return anthropicProvider({
        apiKey: process.env.ANTHROPIC_API_KEY!,
      });
  }
}

// src/server.ts
configureRailloom({
  dbPath: process.env.RAILLOOM_DB ?? './data/railloom.db',
  provider: pickProvider(),
  // ...
});
```

`.env.development` sets `PROVIDER=codex-cli` (or `claude-cli`). `.env.production` sets `PROVIDER=anthropic` and `ANTHROPIC_API_KEY=...`. The same agent and workflow code runs in both. Tool calls work identically — CLI providers route through the internal MCP loopback so user code stays provider-transparent.

### Documentation

- Every exported function has a JSDoc with one-line description, `@param`, `@returns`, `@throws`, and an `@example`.
- `README.md`, `VISION.md`, `ARCHITECTURE.md`, `API.md`, `CONVENTIONS.md`, `CLAUDE.md` are the canonical docs. Update them with every breaking change.

### Versioning

- Pre-1.0: minor versions may include breaking changes; document in `CHANGELOG.md`.
- Post-1.0: strict semver.

### Dependencies

- Production dependencies (`dependencies` in `package.json`): `zod`. **That is the entire list.** Provider SDKs (`@anthropic-ai/sdk`, future `@openai/openai`) live in `peerDependencies` with `peerDependenciesMeta: { ..., optional: true }`. Each user installs only the SDK for the provider they actually use; users who only use CLI providers install nothing extra. Adding any other production dependency is a separate, user-approved decision.
- Dev dependencies: `@types/bun`. (We do not need `typescript`, `tsx`, `vitest`, `prettier`, `eslint` — Bun ships them.)
- Built-in (do not declare): `bun:sqlite`, `bun:test`, `Bun.serve`, `Bun.file`, `Bun.password`, `Bun.hash`, `fetch`, `crypto.subtle`.

### Database migrations

- Migrations live in `src/db.ts` as a list of SQL strings keyed by version number.
- Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- Migrations never delete data. Renames go add-new + backfill + drop-old in three releases.
- On startup, the framework reads `PRAGMA user_version`, runs all migrations with version > current, sets `PRAGMA user_version` to latest.

### Single-file deployment build

The build command for examples is:
```bash
bun build --compile --target=bun-linux-x64 --outfile=server src/server.ts
```

The framework itself does not produce a binary — it is a library consumed by client engagement repos. But the framework must be `bun build --compile` compatible. Things to avoid in framework code:
- Dynamic imports based on runtime state (Bun's compile bundles statically).
- File-system reads at module load (use lazy reads if needed).
- Embedded large binary blobs.

---

# === FILE: CLAUDE.md ===

> **This file is the primary operational guide for Claude Code working on `@railloom/core`. Read it in full before making any change.**

## How to use this document

When you start a new session, read in order:
1. `README.md` (overview)
2. `VISION.md` (philosophy — especially Why Bun-only and Anti-principles)
3. `ARCHITECTURE.md` (system shape and database schema)
4. `API.md` (concrete contracts)
5. `CONVENTIONS.md` (rules)
6. **`CLAUDE.md` (this file — operational rules)**
7. The relevant source file for the change you are making.

Do not skip steps 1 through 5 even if you "remember" them. Re-reading takes five minutes and prevents rework.

## Core principles for code generation

1. **Thin abstractions.** If a wrapper function is more than 50 lines, you are probably hiding behavior. Stop and explain why.
2. **No magic.** Every dependency is explicit. No globals (other than `configureRailloom`'s frozen config object). No proxies. No `AsyncLocalStorage`.
3. **No multi-tenancy.** This is a single-tenant deployable. There is no `tenantId` parameter anywhere. If you find yourself wanting to add one, stop. Each client engagement is its own deployment.
4. **Errors are typed.** Every error thrown extends `RailloomError`. Every public function documents what it throws.
5. **Bun-only.** Use `bun:sqlite`, `Bun.serve`, `Bun.password`, `Bun.file`. Do not write Node compat shims. Do not import `node:fs`, `node:http`, `node:crypto`. Use `crypto.subtle` for hashing where Bun does not provide a helper.
6. **One production dep.** Only `zod`. Provider SDKs are optional peers — install only the one your chosen provider needs. Adding any other prod dep is a separate, user-approved decision.
7. **Tests are not optional.** Every exported function gets a happy-path test and a failure-mode test.

## When to ask for clarification, not guess

Stop and ask the user before proceeding if:

- The request implies a public API change not documented in `API.md`.
- The request would require a new direct dependency.
- The request would change a database table schema (any new table, dropped column, type change).
- The request involves replacing or removing a primitive (agent, tool, workflow, memory, approval).
- The request involves a security-relevant change (Slack signature verification, secret handling, approval timeout default).
- The request involves multi-tenancy in any form.
- You find an existing function that does almost what is needed but with a subtle difference. Ask whether to extend it or create a new one.
- The user's instruction conflicts with `CONVENTIONS.md` or `VISION.md`.

Default to asking. The cost of a clarification message is 30 seconds; the cost of a wrong implementation is hours.

## What to never do

- **Never call `console.log`, `console.error`** in framework code. Use the module's `log` instance or `ctx.log`.
- **Never use `as any`.** If TypeScript is fighting you, the design is wrong. Stop and rethink.
- **Never use mutable module-level state** (top-level `let`). Configuration goes through `configureRailloom()`.
- **Never silently swallow errors.** A `catch` without rethrow or a logged reason is a bug.
- **Never add a dependency** without checking with the user.
- **Never cross primitive boundaries** in violation of `CONVENTIONS.md` § Module boundaries.
- **Never modify `CLAUDE.md`, `VISION.md`, or `CONVENTIONS.md`** without explicit user instruction.
- **Never add Node compat code.** No `if (typeof Bun !== 'undefined')` checks. We are Bun-only.
- **Never add `tenantId`, `tenant_id`, "tenant" anywhere.** This is a single-tenant framework.
- **The framework is provider-agnostic. Do not add provider-specific code paths outside `src/providers/<provider>.ts`.** No "if Anthropic do X, if OpenAI do Y" branches in `agent.ts`, `tool.ts`, or workflow code. Provider-specific quirks (Anthropic prompt caching, OpenAI structured-output formats, Codex CLI subprocess management) live entirely inside their adapter file.
- **Never import a provider SDK outside its adapter.** `@anthropic-ai/sdk` may only be imported in `src/providers/anthropic.ts`. Future SDKs (`@openai/openai` etc.) follow the same rule.
- **Default to neutral language in examples and configuration.** When a code example needs a provider, choose explicitly with a comment that the framework supports any provider. Do not write "the model" when you mean "Claude" — use the actual provider/model id when it matters, generic phrasing when it doesn't.
- **CLI providers are first-class development providers, not experimental.** The standard pattern is: dev → CLI provider (free via existing subscription), prod → API provider. Switching is environment-driven via the `PROVIDER` env var, never via code changes. Treat `codexCliProvider` and `claudeCliProvider` with the same care and documentation polish as `anthropicProvider`.
- **Never add an `approval` flag to `tool()`.** Approval is a workflow-level concern. The previous design where tools could carry `approval: true` was removed in v3 because it conflicts with snapshot-based suspend semantics and breaks compatibility with CLI providers (Codex CLI, Claude CLI). If a user asks for it, redirect them to `suspendForApproval()` inside a workflow step.
- **Never use `setInterval` for time-based workflow triggers in production code.** In-memory timers do not survive process restarts. Production cron is delegated to system cron / systemd timers / Docker supervisord; the framework only exposes a `/triggers/:workflowId` endpoint with bearer auth. **Two narrow carve-outs, both explicit:**
  - **(1) Queue polling worker** uses `setInterval` to poll `_railloom_queue` for rows where `status='pending' AND scheduled_at <= now()`. This is process-internal scheduling **over durable storage**, not a time-based trigger: when the process restarts, the queue rows are still there and the new worker picks them up. Missed cycles cannot exist because the schedule lives in the table, not in memory. This is the only place in framework code where `setInterval` is allowed for scheduling-shaped behavior.
  - **(2) Dev-mode embedded scheduler** is active only when `RAILLOOM_DEV=1` and it explicitly logs that it is dev-only at startup. It is not a production scheduler — production must use systemd timers or Docker supervisord.

  Outside of these two, `setInterval` for scheduling is a bug. In particular: a workflow that wants "fire every 30 minutes" never uses `setInterval`; it declares `trigger: { cron: '*/30 * * * *' }` and lets `bun run generate:systemd` produce the timer unit.
- **Never close over external state inside a step's `execute`.** The function may run twice (first execution and resume). Anything needed across the suspend boundary must be persisted via the suspend payload or the workflow accumulator. Closures over local variables, file handles, network connections, or class instances will not survive process restart.
- **Never define `.approval()` as a chain method.** It was removed in v3. Approval is handled inside any regular `.then()` step via `suspendForApproval()`.

## Code generation patterns

### Implementing a new factory function

1. Define the config type in the same file.
2. Define the return type interface in the same file.
3. Implement the factory as a pure function returning a frozen object.
4. Add a happy-path test and a failure test.
5. Add JSDoc with `@example`.

```ts
/**
 * Creates an agent with the given configuration.
 *
 * @example
 * const a = agent({
 *   id: 'classifier',
 *   model: 'claude-haiku-4-5',
 *   instructions: 'Classify the input',
 *   outputSchema: z.object({ label: z.string() }),
 * });
 * const result = await a.run({ input: 'Hello' });
 */
export function agent<TInput, TOutput>(
  config: AgentConfig<TInput, TOutput>,
): Agent<TInput, TOutput> {
  // validate config
  // return frozen object
}
```

### Implementing a new tool

1. Define `input` and `output` Zod schemas.
2. Decide whether the calling workflow step needs `suspendForApproval()` after this tool runs (any write or irreversible external action). Approval is a workflow-level concern — never add an `approval` flag to `tool()`; that design was removed in v3.
3. Implement `execute` to be idempotent if possible. Add `idempotencyKey` if not.
4. Always destructure `{ input, ctx }` in execute.
5. Use `ctx.audit()` for any meaningful state change.

### Implementing a new workflow

1. Trigger first: event, cron, or manual.
2. Input schema with Zod.
3. Each step gets a stable `id` (used for replay).
4. `.parallel()` only when steps are independent.
5. `suspendForApproval()` for any irreversible action.

### Adding a database table

1. Stop. Ask the user. Database schema is a careful change.
2. If approved: add migration in `src/db.ts` migrations list.
3. Add table description to `ARCHITECTURE.md` § Database schema.
4. Add tests covering the new queries.

### When the user says "use Mastra's pattern for X"

We borrow concepts. We do not depend.

- Read the relevant Mastra docs to understand the concept.
- Implement it from scratch, on top of our `LLMProvider` interface and our own queue. Never bind the borrowed pattern to a specific provider's API.
- Cite the inspiration: `// concept borrowed from Mastra createWorkflow().branch()`.
- Verify via tests.

### When the user says "make this more like LangChain"

Push back. We deliberately avoid that abstraction style. Ask the user to articulate what concrete property they want; usually it is "easier to mock" or "easier to compose", which we solve in our idiom.

## Common Claude Code mistakes to avoid

These are things you (Claude) tend to do that we do not want:

1. **Adding "just in case" parameters.** If a parameter has no immediate use case, leave it out.
2. **Generating overly clever generics.** Type signatures should be readable. Three-deep generic chains are a smell.
3. **Inventing tools to fix hypothetical problems.** Implement what is asked. If you see an actual problem, raise it as a separate concern in your response.
4. **Defensive programming everywhere.** Trust your types. Zod validates at boundaries; do not also `if (input == null)` in functions whose signature excludes null.
5. **Comments that describe what.** Comments describe why. Code already says what.
6. **`any` to escape a type problem.** Use `unknown` and narrow, or fix the design.
7. **Massive PRs.** One concept per PR. Splitting is free.
8. **Adding compatibility layers.** No "in case we want to support Node". We are Bun-only.
9. **Adding multi-tenancy "just to be safe".** No. Single-tenant. Do not add `tenantId`.

## Pull request checklist

Before announcing a change is done:

- [ ] All public types match `API.md`. If not, update `API.md` (intentional) or fix code.
- [ ] No new dependencies, or new dependencies have been approved.
- [ ] `bun test` passes.
- [ ] `bun build src/index.ts` produces no errors.
- [ ] No `console.log`, no `as any`, no `// @ts-ignore`, no `node:` imports.
- [ ] Every new exported function has JSDoc with `@example`.
- [ ] If schema changed: migration added, `ARCHITECTURE.md` updated.
- [ ] If a public API changed: `API.md` and `CHANGELOG.md` updated.
- [ ] Commit message: `<scope>: <imperative summary>` (e.g. `agent: add retry policy`).

## When in doubt, do less

The best contribution is a small, focused, well-tested change that does exactly what was asked. The worst contribution is a sprawling refactor. If you notice an unrelated improvement opportunity, write it down as a follow-up suggestion in your response, but do not include it in the same change.

---

# === FILE: examples/reddit-agent/README.md ===

## Reddit semi-auto agent (Abidera)

Standalone client engagement repo. `bun add @railloom/core`. This example demonstrates: workflow with cron trigger, agent with structured output, tool with approval, corpus memory for voice exemplars, Slack approval channel, single-binary deployment.

### What it does

1. Every 30 minutes, fetch new posts from a curated list of subreddits.
2. Classify each post for relevance to Abidera using Haiku.
3. For relevant posts, draft a reply using Sonnet, retrieving similar past replies from corpus memory.
4. Post the draft to Slack with Approve / Edit / Reject buttons.
5. On approval, save the draft (the founder copies and posts to Reddit manually — Reddit API has self-promo restrictions that make full automation unwise).
6. Track outcomes (upvotes, replies) over the next 7 days, append to corpus for future voice consistency.

### Project structure

```
abidera-reddit-agent/
├── src/
│   ├── server.ts               # entry: configureRailloom + startServer + startWorker
│   ├── agents/
│   │   ├── classifier.ts
│   │   └── drafter.ts
│   ├── tools/
│   │   └── reddit.ts
│   ├── workflows/
│   │   └── monitor.ts
│   └── lib/
│       ├── reddit-auth.ts
│       └── ratio-check.ts
├── data/                       # SQLite file lives here (gitignored)
├── .env                         # secrets (gitignored)
├── package.json
└── README.md
```

### Setup (`src/server.ts`)

> **Note on provider choice.** This example uses `anthropicProvider` because the Abidera project picked Claude for its classifier and drafter. The framework itself is provider-agnostic — switching to Codex CLI for development, or to OpenAI in production via a future `openaiCompatibleProvider`, requires changing only the `provider:` line below. See § Environment-driven provider selection in CONVENTIONS.md.

```ts
import { configureRailloom, startServer, startWorker, anthropicProvider } from '@railloom/core';

import './agents/classifier';
import './agents/drafter';
import './workflows/monitor';

configureRailloom({
  dbPath: './data/abidera.db',
  provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  defaultModel: 'claude-sonnet-4-6',
  openaiApiKey: process.env.OPENAI_API_KEY!,
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    defaultApprovalChannel: '#abidera-approvals',
  },
  server: {
    port: 3000,
    publicUrl: process.env.PUBLIC_URL!,
  },
});

await startServer();
await startWorker();

// Use the framework's module-level logger (imported from @/lib/observability),
// not console.log. Consumer code follows the same convention so all lines land
// in the same structured-JSON stream readable by journalctl/Loki/Datadog.
log.info('abidera.boot', { ready: true });
```

### Tool

```ts
// src/tools/reddit.ts
import { tool } from '@railloom/core';
import { z } from 'zod';
import { getRedditToken } from '@/lib/reddit-auth';

// Validate at the trust boundary: one typed throw on schema drift, no `as any`.
const RedditListing = z.object({
  data: z.object({
    children: z.array(z.object({
      data: z.object({
        id: z.string(),
        title: z.string(),
        selftext: z.string().nullable().optional(),
        permalink: z.string(),
        author: z.string().nullable().optional(),
        created_utc: z.number(),
      }),
    })),
  }),
});

export const fetchSubredditNew = tool({
  description: 'Fetch the newest posts from a subreddit',
  input: z.object({
    subreddit: z.string(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.array(z.object({
    id: z.string(),
    title: z.string(),
    body: z.string().nullable(),
    permalink: z.string(),
    author: z.string().nullable(),
    createdAt: z.coerce.date(),
  })),
  execute: async ({ input, ctx }) => {
    const token = await getRedditToken();
    const res = await fetch(
      `https://oauth.reddit.com/r/${input.subreddit}/new?limit=${input.limit}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'abidera-monitor/1.0 by /u/<alex>',
        },
      },
    );
    if (res.status === 401) throw new Error(`Reddit auth failed (401)`);
    if (res.status === 429) throw new Error(`Reddit rate-limited (429)`);
    if (!res.ok) throw new Error(`Reddit fetch failed: ${res.status}`);
    const json = RedditListing.parse(await res.json());
    return json.data.children.map((c) => ({
      id: c.data.id,
      title: c.data.title,
      body: c.data.selftext ?? null,
      permalink: `https://reddit.com${c.data.permalink}`,
      author: c.data.author ?? null,
      createdAt: new Date(c.data.created_utc * 1000),
    }));
  },
});
```

### Agents

```ts
// src/agents/classifier.ts
import { agent } from '@railloom/core';
import { z } from 'zod';

export const classifier = agent({
  id: 'reddit-classifier',
  model: 'claude-haiku-4-5',
  instructions: `Classify the Reddit post for relevance to Abidera, a European Portuguese audio-first iOS learning app.

Output JSON only. Be precise. Do not draft replies.

A post is "draftRecommended: true" only if all of:
- intent is one of: app-recommendation, duolingo-complaint, moving-to-portugal, ciple-exam, pronunciation-help
- fitScore >= 0.7
- the original post is asking a question or expressing a need Abidera could help with`,
  outputSchema: z.object({
    intent: z.enum([
      'app-recommendation',
      'duolingo-complaint',
      'moving-to-portugal',
      'pronunciation-help',
      'ciple-exam',
      'general-learning',
      'off-topic',
    ]),
    fitScore: z.number().min(0).max(1),
    draftRecommended: z.boolean(),
    reasoning: z.string(),
  }),
  maxSteps: 1,                       // no tools, single LLM call
});
```

```ts
// src/agents/drafter.ts
import { agent, tool, memory } from '@railloom/core';
import { z } from 'zod';
import { computeRatio } from '@/lib/ratio-check';

const searchVoiceExamples = tool({
  description: 'Find past approved replies from this subreddit, ranked by similarity to the new post',
  input: z.object({ query: z.string(), subreddit: z.string() }),
  output: z.array(z.object({ text: z.string(), similarityScore: z.number() })),
  execute: async ({ input }) => {
    const corpus = memory.corpus('voice_exemplars');
    const results = await corpus.search({
      query: input.query,
      limit: 3,
      filter: (e) => e.metadata.subreddit === input.subreddit,
    });
    return results.map((r) => ({ text: r.content, similarityScore: r.score ?? 0 }));
  },
});

const checkRatio = tool({
  description: 'Check the 9:1 self-promotion ratio for the posting account in last 30 days',
  input: z.object({}),
  output: z.object({
    okay: z.boolean(),
    abideraMentions: z.number(),
    generalComments: z.number(),
  }),
  execute: async () => {
    const r = await computeRatio('30d');
    return {
      okay: r.generalComments >= r.abideraMentions * 9,
      abideraMentions: r.abideraMentions,
      generalComments: r.generalComments,
    };
  },
});

export const drafter = agent({
  id: 'reddit-drafter',
  model: 'claude-sonnet-4-6',
  instructions: `You are drafting a Reddit reply on behalf of Alex, a solo developer in Madeira who built Abidera, an audio-first European Portuguese learning iOS app.

Hard rules:
1. Open with disclosure: "I am building Abidera, so biased, but..."
2. Answer the user's actual question first; app mention second.
3. Be specific. Name competing apps fairly (Practice Portuguese, Pimsleur, Memrise).
4. Match the subreddit's register.
5. Maximum 4 short paragraphs.
6. End with a question to invite continued conversation, not a CTA.

Before drafting, call checkRatio to ensure you are not over the 9:1 limit. Output exactly one of:
- { kind: 'draft', draftText } — when you produce a usable reply
- { kind: 'refusal', refusalReason } — when the ratio is broken or the post is not a fit`,
  tools: { searchVoiceExamples, checkRatio },
  outputSchema: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('draft'), draftText: z.string().min(1) }),
    z.object({ kind: z.literal('refusal'), refusalReason: z.string().min(1) }),
  ]),
});
```

### Workflow

```ts
// src/workflows/monitor.ts
import { workflow, suspendForApproval } from '@railloom/core';
import { z } from 'zod';
import { fetchSubredditNew } from '@/tools/reddit';
import { classifier } from '@/agents/classifier';
import { drafter } from '@/agents/drafter';

export const monitor = workflow({
  id: 'reddit-monitor',
  trigger: { cron: '*/30 * * * *' },                  // declarative; production cron generated to systemd timer
  input: z.object({}),
})
  .then({
    id: 'fetch-all-subreddits',
    execute: async ({ inputData, ctx }) => {
      const subs = ['portugalexpats', 'europeanportuguese', 'Portuguese', 'duolingo'];
      // Promise.allSettled — one subreddit failing must not kill the whole cycle.
      const settled = await Promise.allSettled(
        subs.map((s) =>
          fetchSubredditNew.execute({
            input: { subreddit: s, limit: 25 },
            ctx,
          }).then((posts) => posts.map((p) => ({ ...p, subreddit: s }))),
        ),
      );
      const successes = settled.flatMap((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        ctx.log.error('reddit.fetch.failed', { subreddit: subs[i], error: String(r.reason) });
        return [];
      });
      return successes;
    },
  })
  .foreach({
    id: 'classify-and-maybe-draft',
    execute: async ({ inputData: post, resumeData, suspend, ctx }) => {
      // First execution: classify, draft, request approval
      if (!resumeData) {
        const cls = await classifier.run({ input: post });
        if (!cls.output.draftRecommended) {
          return { postId: post.id, drafted: false };
        }

        const drf = await drafter.run({
          input: { post, classification: cls.output },
        });

        if (drf.output.kind === 'refusal') {
          return { postId: post.id, drafted: false, refusal: drf.output.refusalReason };
        }

        return await suspendForApproval(suspend, {
          kind: 'reddit_reply_draft',
          summary: `r/${post.subreddit}: ${post.title.slice(0, 80)}`,
          payload: {
            draftText: drf.output.draftText,
            postUrl: post.permalink,
            postTitle: post.title,
          },
          editable: ['draftText'],
          timeout: '24h',
        });
      }

      // Second execution (after Slack decision): act on the result
      if (resumeData.action === 'rejected' || resumeData.action === 'timed_out') {
        return { postId: post.id, drafted: true, posted: false };
      }

      const finalText = resumeData.payload!.draftText as string;
      await ctx.audit({
        action: 'reddit_draft.approved',
        resource: { kind: 'reddit_post', id: post.id },
        payload: { finalText, postUrl: post.permalink },
      });

      return { postId: post.id, drafted: true, approved: true, finalText };
    },
  }, { concurrency: 3 })
  .commit();
```

### Build and deploy

```bash
# development
bun run src/server.ts

# production binary
bun build --compile --target=bun-linux-x64 --outfile=abidera-server src/server.ts

# ship to VPS
scp abidera-server abidera-vps:/usr/local/bin/
ssh abidera-vps 'systemctl restart abidera'
```

systemd unit:

```ini
# /etc/systemd/system/abidera.service
[Unit]
Description=Abidera Reddit Agent
After=network.target

[Service]
Type=simple
User=abidera
WorkingDirectory=/var/abidera
EnvironmentFile=/var/abidera/.env
ExecStart=/usr/local/bin/abidera-server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

# === FILE: examples/morning-briefing/README.md ===

## Morning briefing agent

A different shape: cron without fan-out, multi-source `.parallel()` data fetches, single Slack post (no approval), no corpus memory.

### What it does

Every weekday at 7:00 ET, post a one-paragraph briefing to `#morning`. Combines yesterday's revenue, top traffic source, ad spend, ticket backlog. Compare against 7-day baseline. Flag deviations.

### Workflow

```ts
// src/workflows/briefing.ts
import { workflow } from '@railloom/core';
import { z } from 'zod';
import { briefer } from '@/agents/briefer';
import {
  getRevenue,
  getTopTrafficSource,
  getMetaAdSpend,
  getTicketBacklog,
} from '@/tools/metrics';
import { postToSlack } from '@/lib/slack-post';

const yesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const iso = d.toISOString().slice(0, 10);
  return { start: iso, end: iso };
};

export const briefing = workflow({
  id: 'morning-briefing',
  trigger: { cron: '0 7 * * 1-5' },
  input: z.object({}),
})
  .map(() => yesterday())
  .parallel([
    { id: 'revenue',  execute: async ({ inputData, ctx }) => getRevenue.execute({ input: inputData, ctx }) },
    { id: 'traffic',  execute: async ({ inputData, ctx }) => getTopTrafficSource.execute({ input: inputData, ctx }) },
    { id: 'meta-ads', execute: async ({ inputData, ctx }) => getMetaAdSpend.execute({ input: inputData, ctx }) },
    { id: 'tickets', execute: async ({ ctx }) => getTicketBacklog.execute({ input: {}, ctx }) },
  ])
  .then({
    id: 'compose',
    execute: async ({ inputData: [revenue, traffic, metaAds, tickets] }) => {
      const r = await briefer.run({ input: { revenue, traffic, metaAds, tickets } });
      return r.output;
    },
  })
  .then({
    id: 'post',
    execute: async ({ inputData, ctx }) => {
      await postToSlack({ channel: '#morning', text: inputData.briefing });
      await ctx.audit({
        action: 'briefing.posted',
        payload: { deviations: inputData.deviations },
      });
      return { ok: true };
    },
  })
  .commit();
```

This shape demonstrates: cron trigger, four `.parallel()` data fetches with tuple-typed result, single agent compose step, plain Slack post (no approval gate).

---

# === FILE: ENGAGEMENT_TEMPLATE.md ===

## Railloom Engagement Template

A separate repo, `railloom-engagement-template`, is the starting point for new client engagements. Layout:

```
railloom-engagement-template/
├── src/
│   ├── server.ts                # configureRailloom + startServer + startWorker
│   ├── agents/                  # one file per agent
│   ├── tools/                   # one file per tool
│   ├── workflows/               # one file per workflow
│   └── lib/                     # client-specific helpers
├── data/                        # SQLite (gitignored)
├── .env.example
├── .gitignore
├── package.json                 # bun add @railloom/core
├── tsconfig.json
├── Dockerfile                   # oven/bun:1.3-alpine, ~70MB image
├── deploy/
│   ├── systemd/
│   │   └── railloom.service.template
│   └── build.sh                 # bun build --compile script
├── README.md                    # client onboarding doc
└── docs/
    ├── runbook.md               # ops procedures for this engagement
    └── on-call.md
```

When starting an engagement: `gh repo create railloom-<client> --template railloom-engagement-template`. Edit `package.json` name. Configure `.env`. Define agents. Deploy.

---

# === END OF SPECIFICATION ===

## Implementation order

If you (Claude Code) are implementing this from scratch, follow this order. Each numbered step is a separate PR.

1. **Skeleton.** `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, basic CI on GitHub Actions running `bun test` and `bun build`.
2. **`src/runtime.ts`.** Time helpers, hash via `Bun.hash`, UUID generator (`crypto.randomUUID`), abort signal helpers.
3. **`src/errors.ts`.** `RailloomError` and named subclasses.
4. **`src/db.ts`.** `bun:sqlite` Database wrapper, migrations runner, schema for all `_railloom_*` tables (including `_railloom_scores` and the simplified `_railloom_queue` without `awaiting_event`), basic query helpers.
5. **`src/config.ts`.** `configureRailloom()`, frozen config object, validation, getter accessor. Includes `triggers: { secret }` for the trigger endpoint bearer auth and an explicit `scheduler: { mode: 'embedded' | 'disabled' }` (default `'disabled'`; embedded only when `RAILLOOM_DEV=1`).
6. **`src/observability.ts`.** Module-local `log` factory producing structured JSON to stdout, audit log writer.
7. **`src/tool.ts`.** `tool()` factory. Output schema validation, idempotency, timeout. **No approval flag** (removed in v3).
8. **`src/embeddings.ts`.** `embed(text: string): Promise<Float32Array>` via direct fetch to OpenAI. Pack as Buffer for SQLite storage. Unpack on read.
9. **`src/memory.ts`.** Three handles. Brute-force cosine for corpus search.
10. **`src/eval.ts`.** `createScorer()` and `attachScorer()`. Background scoring via the queue. Persists to `_railloom_scores`. Minimal — single `scoreFn` API, no four-step pipeline.
11. **`src/providers/types.ts` and `src/providers/anthropic.ts`.** `LLMProvider` interface and `anthropicProvider` implementation wrapping `@anthropic-ai/sdk`. Tool-use translation, retry, cost table for Anthropic models. Accepts `baseUrl` for gateway routing.
12. **`src/providers/_mcp-loopback.ts`.** Minimal MCP server (~150 LOC, hand-written, no SDK dep) over stdio. Takes `Tool[]`, exposes them via JSON-RPC, routes incoming tool calls back to `tool.execute()`. Used internally by CLI providers.
13. **`src/providers/codex-cli.ts` and `src/providers/claude-cli.ts`.** `codexCliProvider` and `claudeCliProvider`. Each spawns the CLI via `Bun.spawn`, parses stream-json NDJSON output into `ProviderContentBlock`, and uses the MCP loopback for tool calls. Subscription mode reports `cost.usd = 0`.
14. **`src/agent.ts`.** `agent()` factory consuming an `LLMProvider`. Tool loop. Cost tracking via provider. Structured output via `outputSchema`. Default `maxSteps: 5`.
15. **`src/queue.ts`.** SQLite-backed queue. Polling worker. Snapshot-based suspend/resume support (no `awaiting_event` state machine). Timeout sweep for suspended runs whose attached approvals have expired.
16. **`src/slack.ts`.** Direct `fetch` to `chat.postMessage`. HMAC verification helper. Block Kit composer for approval messages.
17. **`src/server.ts`.** `Bun.serve()` with routes: `/healthz`, `/triggers/:workflowId` (bearer auth, enqueues a workflow run), `/webhooks/slack/interactivity`, `/webhooks/slack/view-submission`. Supports separate public/admin interface binding for Tailscale-friendly deployments.
18. **`src/suspend-helpers.ts`.** `suspendForApproval()` helper. Persists approval row, posts to Slack, calls suspend with linkage payload.
19. **`src/workflow.ts`.** Workflow chain API. `.then()`, `.parallel()`, `.branch()`, `.foreach()`, `.map()`, `.sleep()`, `.sleepUntil()`, `.commit()`. Translates chain to queue jobs. Step `execute` receives `{ inputData, resumeData, suspend, ctx }`. The runner handles snapshot/resume.
20. **Cron generators.** `bun run generate:systemd` and `bun run generate:docker-compose` scripts. Parse declared `trigger: { cron }` from registered workflows, emit `*.timer` units (with `Persistent=true`) or docker-compose service definitions that hit `/triggers/:workflowId` with the configured bearer token.
21. **`src/index.ts`.** Public barrel export.
22. **`examples/reddit-agent/`.** Full standalone repo, end-to-end working. Includes a `voice-match` scorer attached to the drafter agent. Header comment documents that the example uses Anthropic by choice; the framework is provider-agnostic.
23. **`examples/morning-briefing/`.** Second example.

After each step: stop. Verify with the user. Run `bun test`, `bun build src/index.ts`. Open PR with one focused change.

## Resolved decisions (from spec discussion)

These are the decisions that have been finalized through discussion with the user:

- **License:** MIT, open-source from day 1.
- **Multi-tenancy:** None. Single-tenant deployable artifact, one deployment per client.
- **HITL approval:** First-class snapshot-based suspend/resume primitive in core, with `suspendForApproval()` helper for the dominant Slack approval use case. Replaced the earlier `await approval()` design (see Approval mechanism below for details).
- **Evals:** Separate package `@railloom/eval`, not in core.
- **Runtime:** Bun 1.3+ exclusively. No Node compat.
- **Default deployment artifact:** Single binary via `bun build --compile`. Docker image as documented fallback for clients who insist.
- **Embeddings provider:** OpenAI `text-embedding-3-small` via direct `fetch()`, no SDK dependency.
- **OpenAI integration approach:** Direct `fetch()`, ~30 LOC wrapper in `src/embeddings.ts`.
- **Database:** Single SQLite file per deployment (`bun:sqlite`).
- **Queue:** Custom SQLite-backed queue. No Inngest dependency.
- **HTTP server:** `Bun.serve()`. No express/fastify/Bolt dependency.
- **ORM:** None. Direct SQL via `bun:sqlite` prepared statements.
- **Production dependencies:** `zod` only (1 total). `@anthropic-ai/sdk` and any future provider SDKs are optional peer dependencies; users install only what their chosen provider needs.
- **Provider neutrality:** No privileged provider. v0.1 ships `anthropicProvider`, `codexCliProvider`, `claudeCliProvider`. v0.2 adds `openaiCompatibleProvider`. Provider choice is environment-driven (`PROVIDER` env var); the same agent and workflow code runs on any provider.
- **CLI providers as first-class dev providers:** `codexCliProvider` and `claudeCliProvider` are not experimental. They use the developer's existing CLI subscription (free), spawn the CLI via `Bun.spawn` per request, parse stream-json output, and route tool calls through an internal MCP loopback so user code stays provider-transparent.
- **MCP loopback:** Internal mechanism (`src/providers/_mcp-loopback.ts`, ~150 LOC, hand-written, no SDK dep) used by CLI providers to expose `tool()` definitions to the CLI subprocess via stdio JSON-RPC. Not a public API. Tools-as-MCP-server-for-external-consumers is reserved for v0.2+.
- **Provider strategy (v0.1):** `LLMProvider` interface with three built-in implementations — `anthropicProvider` (HTTP API; only file importing `@anthropic-ai/sdk`), `codexCliProvider` (subprocess; subscription-billed), `claudeCliProvider` (subprocess; subscription-billed). API providers accept a `baseUrl` parameter for Anthropic-Messages-compatible gateways (Vercel AI Gateway, etc.). CLI providers route tool calls through the internal MCP loopback so user code stays provider-transparent. `openaiCompatibleProvider` deferred to v0.2 (covers OpenRouter, LiteLLM, Cloudflare AI Gateway with one adapter).
- **Network exposure:** Mesh-VPN-friendly by convention (Tailscale-style). Only Slack webhook port public; admin/debug binds to private interface.
- **Approval mechanism:** Snapshot-based suspend/resume on regular workflow steps (concept borrowed from Mastra). `suspendForApproval()` helper inside step `execute`. **No** `tool({ approval: true })`. **No** `.approval()` chain method.
- **Cron triggers:** Production cron delegated to system cron (systemd timers / Docker supervisord). Framework exposes `/triggers/:workflowId` with bearer auth. `bun run generate:systemd` and `bun run generate:docker-compose` produce schedule artifacts from declared `trigger.cron` in workflow definitions. Dev-only embedded scheduler behind `RAILLOOM_DEV=1` env flag.
- **Default `maxSteps`:** 5 (down from 10).
- **Workflow chain methods:** `.then`, `.parallel`, `.branch`, `.foreach`, `.map`, `.sleep`, `.sleepUntil`, `.commit`. No `.approval`. No `.dountil`/`.dowhile` (use external recursion if needed). No `.waitForEvent` (event arrival = explicit `run.resume()`).
- **Eval primitives:** `createScorer()` and `attachScorer()` in v0.1 core (`src/eval.ts`, ~150 LOC, single `scoreFn` API). `_railloom_scores` table. Background scoring via the queue. Larger eval framework (datasets, regression detection, CLI report) deferred to potential `@railloom/eval` package in v0.2+.
- **Hosting recommendations:** VPS+systemd default; Docker+supervisord and Fly.io/Railway supported; Vercel/Netlify/Cloudflare Workers explicitly out of scope.

## Open questions to revisit later (not blockers for v0.1)

These can be deferred to v0.2 or beyond:

1. **`sqlite-vec` extension.** When does brute-force cosine become too slow? We will instrument and benchmark once we have a real corpus larger than 1K entries. Likely v0.3.
2. **Multi-channel approvals.** Currently Slack only. Email and webhook channels are sketched in the architecture but not built. Add when first client requests it.
3. **`@railloom/dashboard` (read-only).** A separate Next.js or Astro app for non-technical reviewers and the operator to see runs, approvals, scorer trends, daily cost. Read-only by design — no agent-trigger endpoints, no live editing. Reads directly from the deployment's SQLite via `bun:sqlite`. Binds to the Tailscale interface only. v0.2.
4. **OpenTelemetry log adapter.** Optional output mode in `configureRailloom({ log: { otel: { endpoint, serviceName } } })`. Thin wrapper over `@opentelemetry/api`, ~100 LOC. Add when the first client engagement requires distributed tracing or platform integration (Datadog, SigNoz, etc.). v0.2.
5. **Cost tracking accuracy.** Pricing table is hardcoded in the Anthropic provider. Move to a config-driven file in v0.2 so updates do not require framework releases.
6. **Encryption at rest.** SQLite has SEE (paid) and `sqlcipher` (open-source) for encryption. Not in v0.1; add as opt-in if a client requires it.
7. **`@railloom/eval` package (richer).** v0.1 ships minimal scorers in core. The richer package would add datasets, regression detection across deploys, A/B testing infrastructure, and a CLI that runs a suite and emits a markdown report. Build when scorer usage in production demands more structure than the single `scoreFn` API.
8. **`openaiCompatibleProvider`.** Adapter that covers OpenRouter, LiteLLM, Cloudflare AI Gateway, and any OpenAI Chat Completions-compatible endpoint. ~150 LOC. v0.2.
9. **MCP-as-output.** Tools and agents exposed as MCP servers so a client can plug them into their own Claude Code or Cursor. v0.2 if the first client requests it.
10. **Streaming.** `agent.stream()` and `workflow.stream()`. Out of scope for backend-only deployable model. Add only if a chat-UI use case appears.

## Notes on `@railloom/eval`

`@railloom/core` v0.1 includes **minimal eval primitives** in `src/eval.ts`: `createScorer()`, `attachScorer()`, and the `_railloom_scores` table. These cover the 80% case — declare a scorer with a single `scoreFn`, attach it to an agent or workflow step, scores accumulate in SQLite for trending. This is sufficient to detect drift on production agents from day one.

`@railloom/eval` (a separate, future package) is reserved for the richer surface that we may need later: dataset declarations, regression detection across deployments, A/B testing infrastructure, CI integration, a markdown report CLI. None of that is in v0.1. Build when scorer usage in production demands more structure than the single `scoreFn` API. The two packages would share `RunContext` and `RailloomError` types, but neither would import the other at runtime.
