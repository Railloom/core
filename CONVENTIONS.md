
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

