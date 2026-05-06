
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

