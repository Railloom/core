# @railloom/core

> Production AI agents in TypeScript. One runtime. One dependency. Ship a single binary.

`@railloom/core` is a small, owned, MIT-licensed TypeScript framework for building agents that use tools, talk to LLMs, run on a durable in-process queue, and require human approval before they touch the world. It is built by [Railloom](https://railloom.com) — a boutique studio that turns AI prototypes into production software.

## Status

**v0.1 is in active development.** The specification is finalized; implementation is in progress. First public release ETA Q3 2026.

This repository currently holds the framework specification and roadmap. Real implementation lands here progressively as primitives are extracted from production use in the studio's first client engagement.

To follow the v0.1 release: watch this repo, open a thread in [Discussions](https://github.com/Railloom/core/discussions), or check back at [railloom.com](https://railloom.com).

## What v0.1 will look like

A short preview of the API. Code subject to change until v0.1 ships — treat this as direction, not contract.

```ts
import { agent, tool, workflow, suspendForApproval, configureRailloom, anthropicProvider } from '@railloom/core';
import { z } from 'zod';

configureRailloom({
  dbPath: './data/railloom.db',
  provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
});

const triage = agent({
  id: 'reddit-triage',
  model: 'claude-haiku-4-5',
  instructions: 'Classify a Reddit thread for relevance.',
  outputSchema: z.object({ relevant: z.boolean(), score: z.number() }),
});

const result = await triage.run({ input: 'https://reddit.com/r/...' });
//    ^? { output: { relevant: boolean; score: number }, runId, cost, ... }
```

## What this will be

A TypeScript framework with six primitives:

1. **`agent()`** — typed wrapper around an `LLMProvider` (any: API-based or CLI-based) with retry, cost tracking, structured output via Zod, and tool-loop handling.
2. **`tool()`** — typed wrapper with input/output schemas, idempotency, and per-tool retry. Provider-transparent: the same tool definition works through any provider.
3. **`workflow()`** — durable, multi-step orchestration on a SQLite-backed in-process queue, with `.then`, `.parallel`, `.branch`, `.foreach`, `.map`, `.sleep`, `.sleepUntil` chain methods, and snapshot-based suspend/resume for human-in-the-loop.
4. **`memory`** — three memory kinds: ephemeral (run-scoped, in-process), session (conversation-scoped, SQLite), and corpus (semantic memory, SQLite + brute-force cosine).
5. **`suspendForApproval`** — first-class human-in-the-loop helper. Pauses workflow execution via snapshot, posts to Slack (or any registered channel), resumes when a human approves / edits / rejects.
6. **`createScorer` / `attachScorer`** — minimal eval primitives for drift detection. Scores accumulate in SQLite; queryable for trend analysis from day one. The richer eval surface (datasets, regression suites, CI reports) is a separate `@railloom/eval` package on the v0.2+ roadmap.

## What this will not be

- Not a chat UI framework.
- Not a multi-tenant SaaS framework. Each deployment is single-tenant by design.
- Not a managed service. You deploy it; you run it.
- Not a model gateway — one provider per agent — but the framework itself is provider-agnostic. v0.1 ships built-in adapters for Anthropic API, Codex CLI (subscription-billed), and Claude CLI (subscription-billed); v0.2 adds an OpenAI-compatible adapter covering OpenRouter, LiteLLM, and Cloudflare AI Gateway.
- Not a full eval framework. (Minimal scorers ship in core; the richer surface is `@railloom/eval`, planned for v0.2.)
- Not LangChain or Mastra. We deliberately avoid the abstraction tax.

## Stack lock

| Layer | Tool | Notes |
|---|---|---|
| Runtime | **Bun 1.3+** exclusively | No Node fallback. Single-file binary via `bun build --compile`. |
| Database | `bun:sqlite` (built-in) | One file per deployment. WAL mode. |
| HTTP server | `Bun.serve()` (built-in) | Slack webhooks, trigger endpoints, healthz. |
| LLM provider | Pluggable via `LLMProvider` interface | Built-in adapters: `anthropicProvider`, `codexCliProvider`, `claudeCliProvider` in v0.1; `openaiCompatibleProvider` in v0.2. |
| Embeddings | OpenAI text-embedding-3-small (default) | Via direct `fetch()`. No SDK. Pluggable. |
| Validation | `zod` | Schemas for input, output, tool args, structured outputs. |
| HITL channel | Slack via direct `fetch` + HMAC verify | No `@slack/bolt`. ~120 LOC of channel code. |
| Bundler / packager / test runner / TS compiler | Bun (built-in) | No `tsx`, no `vitest`, no `esbuild`. |
| Deployment artifact | Single self-contained binary | `bun build --compile`. |

**Production dependencies: 1.** `zod`. That's the entire `dependencies` list. Provider SDKs (e.g. `@anthropic-ai/sdk`) are declared as optional peer dependencies — install only the one your chosen provider needs. CLI providers require no SDK at all; the CLI binary is the runtime dependency.

## Why this exists

The market in 2025–2026 minted prototype-builders. Cursor, Claude Code, v0, Lovable, Replit — any motivated non-engineer can ship a working AI prototype in a weekend. The gap between "it works on my MacBook on a Friday" and "it still works in six months when the founder fires the contractor and hires a junior to maintain it" is widening, not closing.

`@railloom/core` is the framework that takes the prototype and turns it into something that survives the six-month tail: auditable, durable, human-gated where it touches real customer data, deployable as one binary to one VPS. It powers the agents shipped to Railloom's clients.

## Hosting

| Target | Status | Notes |
|---|---|---|
| **VPS + systemd** (Hetzner, DigitalOcean, Vultr) | Default | Single binary, systemd unit per Bun process, `.timer` units for cron, Tailscale for admin access. |
| **Docker + supervisord** | Supported | For clients who require containerized deployment. |
| **Fly.io / Railway** | Supported | Persistent SQLite + long-running process model. |
| **Vercel / Netlify / Cloudflare Workers** | Out of scope | Ephemeral filesystems are incompatible with this framework's SQLite-first, long-suspend-friendly architecture. |

## License

MIT. Open source from day 1.

## Roadmap

- **v0.1** (Q3 2026) — Five primitives, three providers (Anthropic + Codex CLI + Claude CLI), Slack approval channel, single-binary deploy. First public release.
- **v0.2** — `openaiCompatibleProvider` (covers OpenRouter, LiteLLM, Cloudflare AI Gateway), read-only `@railloom/dashboard`, OTel log adapter, richer eval primitives.
- **v0.3+** — `sqlite-vec` for large corpora, encryption at rest, MCP-as-output for external clients.

The detailed specification is being progressively distilled into this repository as implementation lands. For now, treat the README + future CHANGELOG as the canonical surface.
