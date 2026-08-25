---
title: Invocations
description: Run, stream, and observe one request to an Agent.
navigation.order: 22
navigation.group: Core
icon: i-lucide-play-circle
---

An Agent Invocation is one request to an Agent. ViteHub prepares its input, Actor, Capabilities, Workspace, and Driver, then returns or streams the result.

## Run an Agent

Use `runAgent()` when the caller needs the final result.

```ts [server/api/support.post.ts]
import { runAgent } from 'vite-hub/agent'
import support from '../agents/support'
import { getRuntimeContext } from '../runtime-context'

export default defineEventHandler(async (event) => {
  const { prompt } = await readBody<{ prompt: string }>(event)
  const user = await requireAuthenticatedUser(event)

  return runAgent(support, getRuntimeContext(event), {
    prompt,
    context: {
      invoker: {
        id: user.id,
        kind: 'customer',
        label: user.email,
      },
    },
  })
})
```

Authenticate the request before passing trusted identity or access facts. `context.invoker` is the current input field for an [Agent Actor](/docs/agents/actors).

The second argument is [Runtime Context](/docs/concepts/runtime-context); the third is invocation input. The application-owned `getRuntimeContext()` helper supplies the host's required `runtime`, `memo`, and `waitUntil` values. Keeping them separate prevents host resources from becoming user-controlled task data.

## Stream an Agent

Use `streamAgent()` when a chat UI or internal consumer needs incremental output.

```ts [server/api/support-stream.post.ts]
import { streamAgent } from 'vite-hub/agent'
import support from '../agents/support'
import { getRuntimeContext } from '../runtime-context'

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

The stream becomes terminal when the caller consumes it, cancels it, or receives an error. A caller that abandons the stream also abandons completion observation.

## Invoke a Trigger

Use `runAgentTrigger()` or `streamAgentTrigger()` when a Capability owns the event shape. This example invokes the Chat Capability's `chat.message` trigger:

```ts [server/api/support-chat.post.ts]
import { streamAgentTrigger } from 'vite-hub/agent'
import support from '../agents/support'
import { getRuntimeContext } from '../runtime-context'

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
  store: createLibsqlAgentInvocationStore({ url: 'file:./.data/invocations.db' }),
})

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  invocations,
})
```

Invocation journals are metadata-only by default. Set `content: 'content'` only when the application must persist prompts, messages, reasoning, tool inputs and outputs, and result text. That opt-in stores sensitive model content in the configured durable store; apply the same access controls, retention policy, and encryption requirements as the source data.

The journal records pending, running, completed, failed, and cancelled states plus bounded invocation metadata and trace observations. Failed records retain bounded `cause` and `AggregateError.errors` trees, common status and code fields, and public ViteHub error details. Use `invocations.list()` for cursor-based summaries, `invocations.get(id)` for a stored record ID, and `invocations.getByRunId(runId, agentName?)` when starting from the source run ID. Always pass the Agent Definition name for a named Definition; the name is part of its durable invocation identity. Journal failures never change the Agent Invocation result.

When an application exposes the standard invocation journal route, inspect it without a dashboard:

```sh
vitehub agent invocations list --status running
vitehub agent invocations show INVOCATION_ID
vitehub agent invocations tail INVOCATION_ID
```

The CLI defaults to `http://localhost:5173/api/invocations`. Use `--url` or `VITEHUB_AGENT_INVOCATIONS_URL` for another local endpoint, and `--json` for automation-safe output.

Cloudflare and OpenWorkflow create the journal after durable recovery dispatch and reconcile failures after the generated Agent module loads but before the Agent handler starts. If that module cannot be evaluated, use Workflow inspection because the Agent-owned invocation store is unavailable.

Vercel Agent Definitions currently run through the inline Workflow adapter because arbitrary Agent handlers cannot be embedded in Vercel's deterministic native Workflow bundle. An accepted run starts its journal in that Agent worker, and ViteHub keeps bounded journal recovery work inside the active execution. Vercel does not expose a lifecycle hook that can guarantee arbitrary Agent recovery after that execution settles, so treat its journal as best-effort and use Workflow inspection as the authority for accepted runs. A synchronous Vercel start rejection is still recorded as a failed Agent Invocation. The run inspection metadata reports `mode: "inline"` for this path.

## Inspect invocations in the console

Enable the [ViteHub Console](/docs/development/console) to browse retained sessions and inspect invocation events at `/_vitehub`. The Console is opt-in. Its page, API, plugin, and assets do not exist when `console` is omitted or set to `false`.

The Console guide covers Vite and Nuxt setup, fallback storage, production limits, usage records, and route authorization. An explicit `defineAgent({ invocations })` store remains authoritative when the Console is enabled.

## Control child work

Use [`startAgentInvocation()`](/docs/agents/controlled-child-invocations) when trusted parent code must inspect or cancel a child after starting it. Use the [Subagents Capability](/docs/capabilities/subagents) when the active model delegates work itself.
