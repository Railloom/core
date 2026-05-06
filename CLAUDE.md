
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

