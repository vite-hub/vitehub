---
title: Invocations
description: Run, stream, and observe one request to an Agent.
navigation.order: 22
navigation.group: Core
icon: i-lucide-play-circle
---

An Agent Invocation is one request to an Agent. ViteHub prepares its input, Actor, Capabilities, Workspace, and Driver, then returns or streams the result.

## What happens during an Invocation

An Agent Definition describes reusable behavior. An Invocation records one execution of that behavior.

| Stage | What happens |
| --- | --- |
| Entry | A route, Channel, schedule, webhook, CLI command, or another caller provides input. |
| Actor | ViteHub resolves the trusted [Agent Actor](/docs/agents/actors). |
| Capabilities | The Definition and invocation context select the abilities for this request. |
| Context | ViteHub prepares tools, policy, context values, and the Workspace Scope. |
| Execution | The Agent Driver runs the prepared request. |
| Result | ViteHub returns or streams the output and records events and usage. |

The Agent can use only the Capabilities selected for that Invocation. A Capability that is not selected adds nothing to the request.

| Term | Describes |
| --- | --- |
| Agent Definition | Reusable Agent behavior. |
| Agent Invocation | One execution for one input. |
| Channel | Message origin and delivery facts around an Invocation. |
| Workflow Run | Durable work that can continue across waits or server restarts. |
| Agent Memory | Persistent context stored outside the Invocation. |

A Channel can start many Invocations, and a Workflow Run can carry an Invocation. Neither one replaces the Invocation record.

Run `vitehub agent info` to inspect the resolved Agent Definition. Run `vitehub agent dev` to talk to the Agent through a running Vite development server. Read [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces) for the records produced during execution.

## Run an Agent

Use `runAgent()` when the caller needs to invoke the Agent directly. Inline runtimes may return a native `Response` when the Agent produces an HTTP-shaped result. Workflow runtimes return a Workflow Run for durable inspection and control. Structured Agent outputs remain typed values, and streaming uses the separate stream contract below.

```ts [server/api/support.post.ts]
import { runAgent } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime/h3'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const { prompt } = await readBody<{ prompt: string }>(event)
  const user = await requireAuthenticatedUser(event)

  const runtime = getRuntimeContext(event)
  try {
    return await runAgent(support, runtime, {
      prompt,
      context: {
        invoker: {
          id: user.id,
          kind: 'customer',
          label: user.email,
        },
      },
    })
  }
  finally {
    await runtime.flushWaitUntil().catch(console.error)
  }
})
```

Authenticate the request before passing trusted identity or access facts. `context.invoker` is the current input field for an [Agent Actor](/docs/agents/actors).

The second argument is [Runtime Context](/docs/concepts/runtime-context); the third is invocation input. The H3 `getRuntimeContext()` adapter supplies `runtime`, a fresh `memo` cache, and tracked `waitUntil` work. The example drains background work before returning and reports background failures separately.

### Run without a host context

For a script or direct invocation, pass the invocation input as the second argument:

```ts
const [error, result] = await runAgent(support, { prompt: 'Summarize the support policy.' })
if (error) throw error
```

This form creates a fresh memo cache and run ID, uses the `unknown` runtime, and returns `[null, result]` or `[Error, null]`. It drains background work registered before the call settles. A background failure returns an error tuple; an invocation failure takes precedence if both fail. Non-Error thrown values become an `Error` with the original value as its `cause`.

Results follow the configured Agent runtime: inline output stays unchanged, and an explicit Workflow binding returns its Workflow Run. Agents that rely on default host Workflow discovery return an error tuple. Set `runtime: false` for inline execution, configure an explicit `workflow("name")` binding, or use the three-argument form with a host context. This form does not supply request metadata, runtime configuration, or a host background lifetime. Use the three-argument form when those are required, including streams that schedule work during later consumption. The tuple covers the call itself; errors from consuming a returned stream or Response body still occur during consumption.

## Stream an Agent

Use `streamAgent()` when a chat UI or internal consumer needs incremental output.

```ts [server/api/support-stream.post.ts]
import { streamAgent } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime/h3'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const { prompt } = await readBody<{ prompt: string }>(event)

  return streamAgent(
    support,
    getRuntimeContext(event),
    { prompt },
    { output: 'ui-message-stream' },
  )
})
```

Use `output: 'ui-message-stream'` for an AI SDK-compatible chat response. Use `output: 'events'` when server code needs ViteHub stream events.

Streaming routes must provide a real host `waitUntil` lifetime through the event or the adapter options. A drain before returning cannot cover work scheduled when the caller consumes or cancels the stream. See [Runtime Context](/docs/concepts/runtime-context#background-work-and-cleanup).

The stream becomes terminal when the caller consumes it, cancels it, or receives an error. A caller that abandons the stream also abandons completion observation.

## Invoke a Trigger

Use `runAgentTrigger()` or `streamAgentTrigger()` when a Capability owns the event shape. This example invokes the Chat Capability's `chat.message` trigger:

```ts [server/api/support-chat.post.ts]
import { streamAgentTrigger } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime/h3'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const { text } = await readBody<{ text: string }>(event)
  const runId = crypto.randomUUID()

  return streamAgentTrigger(
    support,
    getRuntimeContext(event),
    'chat.message',
    {
      messages: [{
        id: runId,
        role: 'user',
        parts: [{ type: 'text', text }],
      }],
      run: {
        channelId: 'support-web',
        messageId: runId,
        origin: 'portal',
        runId,
      },
    },
    { output: 'ui-message-stream' },
  )
})
```

The consumer supplies the product event. The Capability prepares the Agent input and policy before the Driver starts. Read [Triggers](/docs/agents/triggers) for when to use this path instead of direct invocation.

## Validate input

Use an `agent:input` hook for trusted invocation requirements that must be present before the Driver runs.

```ts [server/agents/review.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: { run: () => 'ok' },
  hooks: {
    'agent:input'({ input }) {
      if (!input.context?.pullRequest) {
        throw new Error('Missing context.pullRequest')
      }
    },
  },
})
```

Validate untrusted request data at the route boundary. The hook protects the Agent contract when multiple trusted callers invoke the same Definition.

Set `defineAgent({ data })` when callers pass structured values. ViteHub validates `input.data` with the schema before hooks and the Driver run, and returns an error tuple from `runAgent()` for invalid data. See [Accept structured data](/docs/agents/agent-definitions#accept-structured-data).

## Observe the outcome

Finish hooks receive normalized duration, result kind, and usage. Error hooks receive failed invocations.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  hooks: {
    'agent:finish'(event) {
      const { durationMs, resultKind, usage } = event.invocation
      event.runtime.waitUntil(recordInvocation({ durationMs, resultKind, usage }))
    },
    'agent:error'(event) {
      event.runtime.waitUntil(recordFailure(event.publicError))
    },
  },
})
```

When a Channel started the Invocation, both hooks also receive `event.message`. Use its methods to act on the provider message, such as a reply or a label. Set `dryRun: true` in the Invocation input to record write calls in the trace instead of calling the provider. See [Act on the Channel message in hooks](/docs/agents/channels#act-on-the-channel-message-in-hooks).

Error hooks receive the raw `event.error` for protected server diagnostics and a
sanitized `event.publicError` for logs, HTTP responses, or Channel replies. See
[Agent public errors](/docs/reference/errors-diagnostics#agent-public-errors) for
the stable codes and redaction rules.

Every invocation also has an in-memory metadata trace through `runtime.trace` and `runtime.traceLog`. The default log is process-local and is not persisted across a Workflow boundary.

Finish events set `event.invocation.cancelled` to `true` when output consumption is cancelled. Finish effects can use this field to distinguish cancellation from normal completion.

Capability setup callbacks (`configure`, `prepare`, `bind`, `input`, `resolve`, `output`) and `close` emit one `agent.capability.<phase>` event when the callback settles. These events measure the callback itself with a monotonic clock, excluding before/after hooks and trace persistence. Read `agent.capability.id`, `agent.capability.phase`, `agent.capability.outcome`, and `agent.capability.durationMs` to distinguish slow integration setup from model execution. Outcomes are `success`, `error`, or `cancelled`; cancellation means the callback failed while the effective invocation input's abort signal was set.

Timing events carry the available invocation, run, and trace identifiers. They contain no callback arguments, results, configuration, or thrown error messages, and follow the normal trace and journal retention policy. A missing event means timing is unavailable, not zero. Emission does not await arbitrary trace sinks: pending or rejected persistence cannot change callback results or prevent cleanup. The host still owns its trace sink's flushing and retention policy.

Attach the `otlp()` Capability to send completed invocation traces to any OTLP/HTTP JSON receiver:

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { otlp } from '@vite-hub/agent/capabilities'

export default defineAgent({
  name: 'support',
  capabilities: [
    otlp({
      endpoint: 'https://telemetry.example/otlp',
      headers: { authorization: `Bearer ${process.env.OTLP_TOKEN!}` },
      live: true,
      resource: { 'service.namespace': 'quiver' },
    }),
  ],
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

Pass the OTLP base endpoint; ViteHub appends `/v1/logs` and `/v1/traces`. With `live: true`, new Trace Events are batched as correlated OTLP LogRecords while the invocation runs, then ViteHub exports one completed trace. Without `live`, it exports only the completed trace and retains Trace Events as span events. Invocation content is metadata-only by default. Use `content.inputs`, `content.outputs`, and `content.instructions` to opt a trusted receiver into each content class independently.

Export runs through `runtime.waitUntil()`, so delivery failures do not replace the Agent result. See [`otlp()`](/docs/capabilities/otlp) for batching, deduplication, privacy, and Capability-contribution details.

To persist a queryable invocation journal, attach Agent Invocations to the Agent Definition. Storage durability and recovery guarantees still depend on the selected store and host lifecycle. The SQLite adapter accepts a local SQLite or remote libSQL URL:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { createLibsqlAgentInvocationStore } from 'vite-hub/agent/invocations/sqlite'
import { defineAgentInvocations } from 'vite-hub/agent/server'

const invocations = defineAgentInvocations({
  store: createLibsqlAgentInvocationStore({
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
    maxRecords: 10_000,
    url: 'file:./.data/invocations.db',
  }),
})

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  invocations,
})
```

Use `invocations.getSummary(id)` to read metadata without observation payloads. It returns `undefined` when the Invocation does not exist. Every `AgentInvocationStore` must implement `getSummary(id)`; `get(id)` returns the full record.

Pass `observationNames` to read only the observations needed for an inspection:

```ts
const record = await invocations.get(invocationId, {
  observationNames: ['agent.invocation.finish'],
})
```

Names match exactly, and matching observations keep their journal order. Other record fields remain unchanged. An empty array returns no observations; omitting `observationNames` returns all retained observations. Both forms return `undefined` for a missing Invocation. D1 and libSQL filter observation payloads in storage. Custom stores may ignore the optional read options; the Invocations wrapper still filters the returned record.

The SQLite adapter keeps at most 10,000 terminal records from the last 30 days by default. Pending and running invocations remain available until they reach a terminal state. Set `maxAgeMs` or `maxRecords` to `false` to disable that limit. Retention runs after successful creates and terminal transitions, so a journal without either event may retain an expired record.

Delete or prune terminal records on demand:

```ts
await invocations.delete(invocationId) // 'deleted' | 'not-found' | 'not-terminal'
await invocations.prune({ olderThanMs: 7 * 24 * 60 * 60 * 1000, dryRun: true })
await invocations.prune() // applies the store's maxAgeMs and maxRecords now
```

`delete(id)` keeps a pending or running record and returns `'not-terminal'`. `prune()` deletes completed, failed, and cancelled records last updated before `olderThanMs`. The age must be a non-negative safe integer that produces a cutoff within JavaScript's Date range. Invalid ages fail with `AGENT_R0929`. Without `olderThanMs`, it applies the store's configured retention. Both return the affected IDs, and `dryRun: true` lists them without deleting. The SQLite and D1 adapters and the memory store implement both operations. A custom store must implement `store.delete()` and `store.prune()` to support them. Deletion removes the journal record and its claim. Artifacts that a Capability wrote to Blob storage are not keyed by the journal record, so the application owns their retention.

Read the recorded prompt of a finished record to start it again:

```ts
import { agentInvocationRerunInput } from 'vite-hub/agent'

const record = await invocations.get(invocationId)
const input = record ? agentInvocationRerunInput(record) : undefined
if (input?.available) {
  await runAgent(agent, context, {
    prompt: input.prompt,
    ...(input.invokerProfileId ? { context: { invokerProfileId: input.invokerProfileId } } : {}),
  })
}
```

The result has `available: false` and a `reason` when the record cannot reproduce its input. Pending and running records return `invocation-not-terminal`; terminal records can return: `input-not-captured` for a missing prompt, `replay-metadata-unavailable` for legacy or incomplete replay metadata, `input-has-invoker` for a direct invoker or actor identity, `input-has-data` for structured input, `input-has-options` for call options, `input-has-messages` for singular or prior Messages, `input-redacted` for changed input or Invoker Profile replay metadata, or `input-truncated` for a bounded prompt. Direct invoker identities, structured input, and call options are not replayed. A resolver-derived Invoker without a selected Invoker Profile returns `input-has-invoker`; a selected profile is resolved again when the new Invocation starts. The journal keeps `input.prompt` only when `metadataContent` or `content: 'content'` includes it. When the start observation recorded an Invoker Profile, `invokerProfileId` holds the selected profile ID, even when an invoker resolver changes the identity. Direct invocation context beyond an Invoker Profile selection, runtime run metadata beyond the run ID, and timeouts are unavailable for rerun because Console cannot reproduce them. Calls in dry-run mode are unavailable for rerun and return `input-has-dry-run`. Calls with a caller-provided cancellation signal are unavailable for rerun and return `input-has-abort-signal`. A prompt changed by a Capability or input hook is unavailable for rerun and returns `input-prompt-changed`. These cases return `input-has-context`, `input-has-run-metadata`, and `input-has-timeout`.

Use `configuration: 'content'` to retain resolved instructions and tool descriptions/schemas independently of other trace content. The default is `configuration: 'metadata'`. Console journals enable configuration retention for inspection; existing records cannot recover contracts that were not saved. Recorded configuration still uses the journal's observation limits and marks truncated values.

Invocation journals are metadata-only by default. Set `content: 'content'` only when the application must persist prompts, messages, reasoning, tool inputs and outputs, and result text. That opt-in stores sensitive model content in the configured durable store; apply the same access controls, retention policy, and encryption requirements as the source data.

### Redact stored evidence

Use `redact` to rewrite or drop an observation before the store receives it. Use `redactError` to rewrite the error of a failed record:

```ts [server/agents/support.ts]
const invocations = defineAgentInvocations({
  store,
  redact(observation) {
    if (observation.name === 'agent.tool.result') return undefined
    const { 'tool.input': _input, ...attributes } = observation.attributes ?? {}
    return { ...observation, attributes }
  },
  redactError: error => ({ message: error.message, name: error.name }),
})
```

`redact` runs after the content policy and before the journal bounds the observation. It applies to observations streamed during the run, observations that the journal persists after the run finishes, and `appendObservation()` evidence. The journal calls it once for each observation, also when a write is retried. Return `undefined` to drop the observation; `appendObservation()` then returns the unchanged record. `redactError` receives the bounded error and its return value is stored as is. Return `undefined` to store no error details; the record status stays `failed`. A hook that throws drops the observation or the error details. Both hooks must be synchronous. The journal preserves its internal `vitehub.observation.id` after redaction so retries can identify evidence that was already stored. They do not change the live trace log, hook events, or OTLP export.

`agent:finish` and `agent:error` hook events include `event.invocation.traceId` after journal creation confirms the stored record identity. It equals the `traceId` on that record. Hooks wait at most one second for pending creation, then proceed without this field if creation is still unresolved. This preserves the Agent result or original error:

```ts
hooks: {
  'agent:finish': async (event) => {
    if (event.invocation.traceId === undefined) return
    await audit.insert({ traceId: event.invocation.traceId, text: event.text })
  },
}
```

The journal records pending, running, completed, failed, and cancelled states plus bounded invocation metadata and trace observations. Failed records retain bounded `cause` and `AggregateError.errors` trees, common status and code fields, and public ViteHub error details. Use `invocations.list()` for cursor-based summaries, `invocations.get(id)` for a stored record ID, and `invocations.getByRunId(runId, agentName?)` when starting from the source run ID. Always pass the Agent Definition name for a named Definition; the name is part of its durable invocation identity. When the Console is enabled, a discovered Definition without `name` records its discovered name, such as `labeller` for `server/agents/labeller.ts`, also when server code calls `runAgent()` directly. If the same unnamed Definition is discovered under multiple names, direct calls remain unscoped because the Definition cannot identify the imported alias. Host calls still record their selected Agent name. Journal failures never change the Agent Invocation result.

Use `triggeredBy` to filter persisted summaries by the person label recorded in `annotations.triggeredBy`. It matches the trimmed label exactly and composes with Agent, Capability, status, and text filters:

```ts
const people = await invocations.listTriggeredBy('support')
const page = await invocations.list({
  agentName: 'support',
  triggeredBy: 'Alex',
  limit: 50,
})
const nextPage = page.cursor
  ? await invocations.list({
      agentName: 'support',
      triggeredBy: 'Alex',
      limit: 50,
      cursor: page.cursor,
    })
  : undefined
```

`listTriggeredBy(agentName?)` returns sorted, distinct, non-empty person labels from persisted history, with surrounding whitespace removed. Omit the Agent name to list labels across all Agents. Records without a person label do not match a non-empty `triggeredBy` filter; an empty or whitespace-only filter is ignored. Keep the same filters when following a page cursor. Custom stores can implement `listTriggeredBy()` for a direct lookup; otherwise the Invocations wrapper collects labels by paging through summaries.

Use `observations` to set limits for long traces:

```ts
const invocations = defineAgentInvocations({
  content: 'content',
  observations: {
    maxCount: 512,
    maxStringLength: 256 * 1024,
    maxBytes: 2 * 1024 * 1024,
    flushTimeoutMs: 10_000,
  },
  store: createLibsqlAgentInvocationStore({ url: 'file:./.data/invocations.db' }),
})
```

Defaults are 32,768 observations, 65,536 UTF-16 code units of content strings per observation value budget, 16 MiB of serialized observation data, and a 1-second finish drain. Maximum values are 32,768 observations, 1,048,576 code units, 64 MiB, and 60 seconds. The byte limit counts the UTF-8 encoded observations array after privacy filtering. It does not limit provider output, the live trace log, or total process memory. A record keeps its resolved limits when another process resumes it.

When a limit is reached, the journal marks `observationsTruncated` and gives lifecycle outcomes priority over ordinary observations. It can strip large outcome content to retain the outcome within the byte limit. `flushTimeoutMs` controls how long finish waits for queued observations; each individual store operation remains bounded to one second. A longer drain can preserve a long queue of successful writes but cannot make an unavailable store reliable.

When an application exposes the standard invocation journal route, inspect it without a dashboard:

```sh
vitehub agent invocations list --status running
vitehub agent invocations show INVOCATION_ID
vitehub agent invocations tail INVOCATION_ID
```

The CLI defaults to `http://localhost:5173/api/invocations`. Use `--url` or `VITEHUB_AGENT_INVOCATIONS_URL` for another local endpoint, and `--json` for automation-safe output.

Delete and prune open a SQLite or libSQL journal directly:

```sh
vitehub agent invocations delete INVOCATION_ID
vitehub agent invocations prune --older-than 30d --dry-run --json
vitehub agent invocations prune --database file:./.data/invocations.db --older-than 12h
```

Without `--database` or `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL`, both commands use the Console journal: `VITEHUB_CONSOLE_DATABASE_URL`, or `.vitehub/data/console.sqlite` in the project root. Set `VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN` for an authenticated libSQL endpoint. Durations accept `ms`, `s`, `m`, `h`, `d`, and `w`. `--older-than` defaults to `30d`. Use `--table-prefix` when the store sets `tablePrefix`. The commands refuse a missing database file and never print URL credentials or tokens. For D1, call `invocations.prune()` from a Worker instead.

Configured journals also retain failures and cancellation during Workflow preparation, before provider dispatch. Fresh manual starts get distinct invocation IDs. Durable Channel deliveries keep their delivery run ID across preparation attempts.

Cloudflare and OpenWorkflow create the journal after durable recovery dispatch and reconcile failures after the generated Agent module loads but before the Agent handler starts. If that module cannot be evaluated, use Workflow inspection because the Agent-owned invocation store is unavailable.

Vercel Agent Definitions currently run through the inline Workflow adapter because arbitrary Agent handlers cannot be embedded in Vercel's deterministic native Workflow bundle. An accepted run starts its journal in that Agent worker, and ViteHub keeps bounded journal recovery work inside the active execution. Vercel does not expose a lifecycle hook that can guarantee arbitrary Agent recovery after that execution settles, so treat its journal as best-effort and use Workflow inspection as the authority for accepted runs. A synchronous Vercel start rejection is still recorded as a failed Agent Invocation. The run inspection metadata reports `mode: "inline"` for this path.

### Store invocations in Cloudflare D1

Use the D1 adapter when the application already has a D1 database. The binding can be resolved for each operation, so an Agent Definition does not need access to request bindings at module load:

```ts [server/invocations.ts]
import { env } from 'cloudflare:workers'
import { createD1AgentInvocationStore } from 'vite-hub/agent/invocations/d1'
import { defineAgentInvocations } from 'vite-hub/agent/server'

export const invocations = defineAgentInvocations({
  store: createD1AgentInvocationStore({
    database: () => env.DB,
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
    maxRecords: 10_000,
  }),
})
```

The store creates its table and indexes on first use of each binding in a Worker isolate. The statements use `CREATE ... IF NOT EXISTS`, so concurrent isolates and existing tables are safe. A failed creation is retried on the next operation.

To manage the schema with your own migrations, set `migrate: false` and apply `d1AgentInvocationSchema()` before the first request:

```ts [scripts/invocation-schema.ts]
import { d1AgentInvocationSchema } from '@vite-hub/agent/invocations/d1'

console.log(d1AgentInvocationSchema().join(';\n') + ';')
```

`tablePrefix` defaults to `vitehub_agent_`; pass the same prefix to the schema function and store to use another table name. The table is outside your Drizzle schema, so `vitehub db generate` does not create or drop it. These statements create a new ViteHub-owned schema. They do not convert a custom application journal or the libSQL adapter's tables. Keep an existing journal until its records have been migrated explicitly.

D1 batches make creation and retention atomic. Conditional updates retry when another Worker changes the record, so concurrent observations are preserved. Claims use the database clock and fence updates after ownership changes. After 32 concurrent write conflicts, an update rejects instead of overwriting another writer. The store uses the same terminal-record retention defaults and observation deduplication as the libSQL store. It supports Agent, Capability, triggering-person, status, and text filters, lists recorded person labels with `listTriggeredBy()`, and reads summaries without observation payloads. Use `get(id, { observationNames })` to select observation payloads by name.

[D1 limits a row to 2 MB](https://developers.cloudflare.com/d1/platform/limits/). The adapter caps retained observations at 1,000,000 UTF-8 bytes, even when the journal requests a larger limit. Each record exposes this resolved limit in `observationLimits`. It also checks the full row, including repeated summary and search text. If that row is too large, it removes ordinary observations and marks `observationsTruncated` while keeping lifecycle fields and previously appended evidence. If the remaining row still cannot fit, the update rejects before a database write. Use another store when the complete long trace must be retained.

The adapter targets D1. It does not provide transactions for other Database providers. The database binding stays owned by the host; the store does not open or close it. Use [`redact`](#redact-stored-evidence) to remove sensitive values before they reach D1. Route authorization remains application policy.

On the Cloudflare preset, the Console journal uses this store with the D1 Database binding when no Agent Definition configures `invocations`. See [Cloudflare journal](/docs/development/console#know-what-the-console-stores). Local D1 tests cover the SQL and concurrency contract; they do not measure production D1 limits or latency.

## Append delivery evidence

Use `appendObservation()` when a host must record an external delivery before or after an Invocation finishes:

```ts
const record = await invocations.appendObservation(invocationId, {
  name: 'report.delivered',
  type: 'capability',
  attributes: { 'report.id': reportId },
}, { id: `report-delivered:${reportId}` })
```

The observation ID is required, must be at most 512 characters, and makes retries idempotent within that Invocation. The store assigns the sequence atomically. This operation does not change Invocation status or its active lease, and it applies the configured content policy. The result is the stored record, or `undefined` when the Invocation does not exist. A failed write or full observation capacity throws, so a caller cannot mistake an omitted event for durable evidence. An append uses the observation limits saved with the record, including after restart. It rejects before changing the record if count, byte, or provider row capacity would remove evidence. Accepted appends remain intact under later trace pressure until the whole Invocation is removed by retention. Keep the same observation ID when retrying a write whose result is unknown. Custom stores must implement the `appendObservation` field on `AgentInvocationStoreUpdateInput`; a store that ignores it fails explicitly.

## Inspect invocations in the console

Enable the [ViteHub Console](/docs/development/console) to browse retained sessions and inspect invocation events at `/_vitehub`. The Console is opt-in. Its page, RPC endpoint, plugin, and assets do not exist when `console` is omitted or set to `false`.

The Console guide covers Vite and Nuxt setup, fallback storage, production limits, usage records, and route authorization. An explicit `defineAgent({ invocations })` store remains authoritative when the Console is enabled.

## Control child work

Use [`startAgentInvocation()`](/docs/agents/controlled-child-invocations) when trusted parent code must inspect or cancel a child after starting it. A model-facing application Capability tool can use that controller when it needs child control, or `runAgent()` when it handles the configured runtime's return value.

## Scheduled results and process recovery

For a scheduled invocation, pass the schedule context and request a drained result: `runAgent(agent, runtimeContext, input, { schedule, output: 'drained' })`. This adds the schedule metadata and consumes streamed driver output before returning. The final response, completion hooks, and capacity release finish together. Configure `driver.output.schema` for a validated result that the scheduler can use directly. A thrown stream or schema error remains a failed invocation; applications do not need to reconstruct results from telemetry.

Trusted code can install tools for one inline invocation with the options argument: `runAgent(agent, runtimeContext, input, { tools: { send_message: toolDefinition } })`. For a standalone scheduled call, `runAgent(agent, { prompt }, { schedule, tools: { send_message: toolDefinition }, output: 'drained' })` returns `[error, text]` after the stream finishes. These tools join the agent's tool set for that invocation and are never serialized into `input`. A name collision with an existing tool fails setup. Callable tools select inline execution when the agent only has a host-discovered Workflow default; an explicit `workflow(...)` binding rejects them before starting. Workflow runs continue to return a Workflow Run for calls with a Runtime Context, so `output: 'drained'` only drains inline output.

Invocation tools accept JSON Schema, Valibot, and Zod schemas directly. Valibot schemas are converted to JSON Schema for model tool discovery while their Standard Schema validator still checks input before `execute`. Unsupported Valibot actions may be omitted from the model-facing schema; validation remains authoritative. Zod schemas use their Standard JSON Schema converter. Other Standard Schema implementations must provide `~standard.jsonSchema.input` for Provider Agent tools.

For a process-owned store, `createProcessAgentInvocations` from `vite-hub/agent/runtime/process` runs interrupted-invocation recovery before returning the journal. Pass the normal `defineAgentInvocations` options and a `recovery` object with a `recover(invocation)` ownership predicate. Use `recover: () => true` only when the database belongs exclusively to that service. Recovery failure rejects startup.

With a libSQL Agent state provider, a persistent Nitro server runs this recovery at startup for each Agent journal, before it resumes queued webhook deliveries. It fails the Agent's pending or running invocations that started before the process, except invocations that a persisted queued delivery runs again under the same run ID. Agents with a durable Workflow runtime are skipped. A recovery failure is logged and the queue still resumes.

`agentInvocationId(runId, agentName)` from `vite-hub/agent/server` resolves the canonical invocation ID before admission, allowing applications to include a live Console link in Channel activity.

For GitHub-backed sessions, `createGitHubWorkspaceInspector(host)` from `@vite-hub/agent/server/github` exposes `list({ repository, revision })` and `read({ repository, revision }, path)`. It requires a full commit SHA, rejects unsafe paths, truncated trees, oversized files, and binary previews, and does not retain disposable checkouts.

## Durable retry budgets

On Node hosts, the GitHub inbox can bound repeated provider dispatches and PR work
in its SQLite storage. Every inbox method is asynchronous. This is an explicit scheduler API; configuring it
does not intercept Agent invocations or classify errors automatically.

```ts
import { PullRequestInbox } from 'vite-hub/agent/server/github-inbox'

const inbox = new PullRequestInbox({
  path: './data/inbox.sqlite',
  repositories: ['acme/project'],
  budgets: { providerRetries: 3, noProgress: 3 },
})
```

Reserve each dispatch, including retries, using a scope shared by workers that use
the same provider account. Do not put credentials in the scope. Four reservations
are available: one initial attempt plus three retries. Pending reservations count
toward that bound, so a worker must wait for other in-flight results when all slots
are occupied. Check `providerBudget(scope)` to distinguish pending work from four
recorded failures.

```ts
const token = await inbox.reserveProviderAttempt('codex:primary-account')
if (!token) {
  // Leave the PR claim unstarted. Inspect pending attempts or exhausted failures.
  return
}
const [claim] = await inbox.claim(1)
if (!claim) {
  await inbox.finishProviderAttempt(token, 'other-failure')
  return
}

let result
try {
  result = await invokeRepairAgent(claim)
} catch (error) {
  // Application-owned classification: only known retryable provider failures count.
  const retryable = isRetryableProviderFailure(error)
  await inbox.finishProviderAttempt(token, retryable ? 'retryable-failure' : 'other-failure')
  await inbox.release(claim)
  throw error
}
await inbox.finishProviderAttempt(token, 'success')

try {
  // Compare GitHub/provider state before and after the invocation. Do not parse prose.
  const evidence = await verifyNewProgress(claim, result)
  await inbox.finish(claim, {
    text: result.text,
    retry: !evidence,
    progress: evidence ? { kind: 'verified', evidence } : { kind: 'no-progress' },
  })
}
catch (error) {
  await inbox.release(claim)
  throw error
}
```

`invokeRepairAgent`, `isRetryableProviderFailure`, and `verifyNewProgress` above are
application functions. Concrete progress can be a newly pushed commit, a verified
thread resolution, or a completed merge. A valid external wait belongs in durable
scheduler state; if another invocation repeats that unchanged wait, it is no
progress. Use evidence identifiers for actual transitions. Credited identifiers persist for that head, so even nonconsecutive replay after
a restart or manual reset does not reset the counter. Result text and a successful model response alone are
not progress.

Three no-progress completions stop claims for the same head, even if result status
is completed or another webhook arrives. New head state starts with a fresh budget.
Stale claim completions cannot charge or reset the new head. `summary()` exposes
`progressBudget` with its head, limit, count, exhaustion state and last verified evidence.
The first recorded progress outcome saves the configured limit for that head.
Workers retain this limit across configuration changes and restarts until an explicit
reset adopts the current limit. A new head uses the current configuration.

Provider successes clear only failures from earlier dispatches; late responses
cannot clear newer failures. Other errors release their reservation without
counting as quota failures. Duplicate completion tokens are ignored. SQLite
transactions coordinate workers that open the same database. These guarantees do
not extend to hosts with separate databases.

There is no time-based unblock. Failure counts and uncompleted reservations survive
restart. After inspecting interrupted work or restored quota, an operator can call
`resetProviderBudget(scope, reason)`. This invalidates outstanding tokens and adopts
the current retry limit. Existing provider scopes retain their limit until reset.
For a stopped PR, use `resetProgressBudget(repository, number, expectedHead, reason)`;
it rejects an active lease, a closed PR, or an outdated head. It records the reset
reason separately and preserves already credited evidence IDs. Keep these operations
behind the application's operator authorization. Do not call reset on every webhook
or deployment. The inbox cannot prove an application's evidence or authorization.
