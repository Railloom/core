
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

