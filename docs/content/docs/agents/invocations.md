---
title: Invocations
description: Run, stream, and observe one request to an Agent.
navigation.order: 22
navigation.group: Core
icon: i-lucide-play-circle
---

An Agent Invocation is one request to an Agent. ViteHub prepares its input, Actor, Capabilities, Workspace, and Driver, then returns or streams the result.

## Run an Agent

Use `runAgent()` when the caller needs to invoke the Agent directly. Inline runtimes return the Agent output, while Workflow runtimes return a Workflow Run for durable inspection and control.

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

Error hooks receive the raw `event.error` for protected server diagnostics and a
sanitized `event.publicError` for logs, HTTP responses, or Channel replies. See
[Agent public errors](/docs/reference/errors-diagnostics#agent-public-errors) for
the stable codes and redaction rules.

Every invocation also has an in-memory metadata trace through `runtime.trace` and `runtime.traceLog`. The default log is process-local and is not persisted across a Workflow boundary.

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

The SQLite adapter keeps at most 10,000 terminal records from the last 30 days by default. Pending and running invocations remain available until they reach a terminal state. Set `maxAgeMs` or `maxRecords` to `false` to disable that limit. Retention runs after successful creates and terminal transitions, so a journal without either event may retain an expired record.

Invocation journals are metadata-only by default. Set `content: 'content'` only when the application must persist prompts, messages, reasoning, tool inputs and outputs, and result text. That opt-in stores sensitive model content in the configured durable store; apply the same access controls, retention policy, and encryption requirements as the source data.

The journal records pending, running, completed, failed, and cancelled states plus bounded invocation metadata and trace observations. Failed records retain bounded `cause` and `AggregateError.errors` trees, common status and code fields, and public ViteHub error details. Use `invocations.list()` for cursor-based summaries, `invocations.get(id)` for a stored record ID, and `invocations.getByRunId(runId, agentName?)` when starting from the source run ID. Always pass the Agent Definition name for a named Definition; the name is part of its durable invocation identity. Journal failures never change the Agent Invocation result.

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

Defaults are 256 observations, 65,536 UTF-16 code units of content strings per observation value budget, 16 MiB of serialized observation data, and a 1-second finish drain. Maximum values are 8,192 observations, 1,048,576 code units, 64 MiB, and 60 seconds. The byte limit counts the UTF-8 encoded observations array after privacy filtering. It does not limit provider output, the live trace log, or total process memory. A record keeps its resolved limits when another process resumes it.

When a limit is reached, the journal marks `observationsTruncated` and gives lifecycle outcomes priority over ordinary observations. It can strip large outcome content to retain the outcome within the byte limit. `flushTimeoutMs` controls how long finish waits for queued observations; each individual store operation remains bounded to one second. A longer drain can preserve a long queue of successful writes but cannot make an unavailable store reliable.

When an application exposes the standard invocation journal route, inspect it without a dashboard:

```sh
vitehub agent invocations list --status running
vitehub agent invocations show INVOCATION_ID
vitehub agent invocations tail INVOCATION_ID
```

The CLI defaults to `http://localhost:5173/api/invocations`. Use `--url` or `VITEHUB_AGENT_INVOCATIONS_URL` for another local endpoint, and `--json` for automation-safe output.

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

Create the tables before the first request. Generate a SQL migration with `d1AgentInvocationSchema()` and apply it with your D1 migration tool:

```ts [scripts/invocation-schema.ts]
import { d1AgentInvocationSchema } from '@vite-hub/agent/invocations/d1'

console.log(d1AgentInvocationSchema().join(';\n') + ';')
```

The adapter does not run schema changes during requests. `tablePrefix` defaults to `vitehub_agent_`; pass the same prefix to the schema function and store to use another table name. These statements create a new ViteHub-owned schema. They do not convert a custom application journal or the libSQL adapter's tables. Keep an existing journal until its records have been migrated explicitly.

D1 batches make creation and retention atomic. Conditional updates retry when another Worker changes the record, so concurrent observations are preserved. Claims use the database clock and fence updates after ownership changes. After 32 concurrent write conflicts, an update rejects instead of overwriting another writer. The store uses the same terminal-record retention defaults and observation deduplication as the libSQL store. It supports Agent, Capability, status, and text filters, and reads summaries without observation payloads.

[D1 limits a row to 2 MB](https://developers.cloudflare.com/d1/platform/limits/). The adapter caps retained observations at 1,000,000 UTF-8 bytes, even when the journal requests a larger limit. Each record exposes this resolved limit in `observationLimits`. It also checks the full row, including repeated summary and search text. If that row is too large, it removes ordinary observations and marks `observationsTruncated` while keeping lifecycle fields and previously appended evidence. If the remaining row still cannot fit, the update rejects before a database write. Use another store when the complete long trace must be retained.

The adapter targets D1. It does not provide transactions for other Database providers. The database binding stays owned by the host; the store does not open or close it. Application redaction and route authorization remain application policy. Local D1 tests cover the SQL and concurrency contract; they do not measure production D1 limits or latency.

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

Enable the [ViteHub Console](/docs/development/console) to browse retained sessions and inspect invocation events at `/_vitehub`. The Console is opt-in. Its page, Devframe transport, plugin, and assets do not exist when `console` is omitted or set to `false`.

The Console guide covers Vite and Nuxt setup, fallback storage, production limits, usage records, and route authorization. An explicit `defineAgent({ invocations })` store remains authoritative when the Console is enabled.

## Control child work

Use [`startAgentInvocation()`](/docs/agents/controlled-child-invocations) when trusted parent code must inspect or cancel a child after starting it. A model-facing application Capability tool can use that controller when it needs child control, or `runAgent()` when it handles the configured runtime's return value.

## Scheduled results and process recovery

`runScheduledAgent()` consumes streamed driver output before returning. The final response, completion hooks, and capacity release finish together. Configure `driver.output.schema` for a validated result that the scheduler can use directly. A thrown stream or schema error remains a failed invocation; applications do not need to reconstruct results from telemetry.

For a process-owned store, `createProcessAgentInvocations` from `vite-hub/agent/runtime/process` runs interrupted-invocation recovery before returning the journal. Pass the normal `defineAgentInvocations` options and a `recovery` object with a `recover(invocation)` ownership predicate. Use `recover: () => true` only when the database belongs exclusively to that service. Recovery failure rejects startup.

`agentInvocationId(runId, agentName)` from `vite-hub/agent/server` resolves the canonical invocation ID before admission, allowing applications to include a live Console link in Channel activity.

For GitHub-backed sessions, `createGitHubWorkspaceInspector(host)` from `@vite-hub/agent/server/github` exposes `list({ repository, revision })` and `read({ repository, revision }, path)`. It requires a full commit SHA, rejects unsafe paths, truncated trees, oversized files, and binary previews, and does not retain disposable checkouts.
