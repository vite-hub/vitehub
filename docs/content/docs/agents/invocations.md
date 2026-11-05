---
title: Invocations
description: Run, stream, and observe one request to an Agent, validate its input, invoke Triggers, and cancel an Invocation.
navigation.order: 12
navigation.group: Define and run
icon: i-lucide-play-circle
navigation.kind: Guides
---

An Agent Invocation is one request to an Agent. ViteHub prepares its input, Actor, Capabilities, Workspace, and Driver, then returns or streams the result.

Start with [Agent Definitions](/docs/agents/agent-definitions). For a complete browser-to-model example, follow [Build a chat app](/docs/agents/build-a-chat-app).

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

Run `vitehub agent info` to inspect the resolved Agent Definition. Run `vitehub agent dev` to talk to the Agent through a running Vite development server. Read [Runtime policy, approvals, and traces](/docs/agents/runtime-policy) for the records produced during execution.

## Run an Agent

For an Agent with `runtime: false`, the shortest call returns an error/result tuple:

```ts
import { runAgent } from 'vite-hub/agent'
import support from './agents/support'

const [error, result] = await runAgent(support, {
  prompt: 'Summarize the support policy.',
})
if (error) throw error
```

For a model's completed text, pass `{ output: 'drained' }` as the third argument. This consumes the inline stream and returns `[error, text]`. Omit it when a custom Driver returns an object that you need to keep unchanged.

Pass a Runtime Context as the second argument when a host must supply request metadata or Workflow discovery. This form returns the result directly and throws failures. Inline runtimes may return a native `Response` when the Agent produces an HTTP-shaped result. Workflow runtimes return a Workflow Run for durable inspection and control. Structured Agent outputs remain typed values, and streaming uses the separate stream contract below.

```ts [server/api/support.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runAgent } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime/h3'
import support from '../agents/support'
import { requireAuthenticatedUser } from '../utils/auth'

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

`requireAuthenticatedUser` is an application helper from `server/utils/auth.ts`, omitted here. Implement it with your authentication provider so it rejects unauthenticated requests and returns the trusted user's `id` and `email`. It is not a ViteHub export. Authenticate the request before passing trusted identity or access facts. `context.invoker` is the current input field for an [Agent Actor](/docs/agents/actors).

The second argument is [Runtime Context](/docs/reference/runtime-context); the third is invocation input. The H3 `getRuntimeContext()` adapter supplies `runtime`, a fresh `memo` cache, and tracked `waitUntil` work. The example drains background work before returning and reports background failures separately.

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
import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai'
import { createError, defineEventHandler, readBody } from 'h3'
import { streamAgent } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime/h3'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const { prompt } = await readBody<{ prompt: string }>(event)

  const output = await streamAgent(
    support,
    getRuntimeContext(event),
    { prompt },
    { output: 'ui-message-stream' },
  )
  if (output instanceof Response) return output
  if (!(output instanceof ReadableStream)) {
    throw createError({ statusCode: 500, statusMessage: 'Expected an Agent UI message stream.' })
  }
  return createUIMessageStreamResponse({
    // The selected output mode emits AI SDK UI message chunks.
    stream: output as ReadableStream<UIMessageChunk>,
  })
})
```

`output: 'ui-message-stream'` returns a `ReadableStream` of AI SDK UI message chunks. Wrap it with `createUIMessageStreamResponse()` to encode those chunks as SSE and set the HTTP headers for a chat client. Return an existing `Response` unchanged. The public return type includes `unknown`, so the example checks the result and narrows the chunk type for the selected output mode. Use `output: 'events'` when server code needs ViteHub stream events.

Streaming routes must provide a real host `waitUntil` lifetime through the event or the adapter options. A drain before returning cannot cover work scheduled when the caller consumes or cancels the stream. See [Runtime Context](/docs/reference/runtime-context#background-work-and-cleanup).

The stream becomes terminal when the caller consumes it, cancels it, or receives an error. A caller that abandons the stream also abandons completion observation.

## Invoke a Trigger

Use `runAgentTrigger()` or `streamAgentTrigger()` when a Capability owns the event shape. This example invokes the Chat Capability's `chat.message` trigger:

```ts [server/api/support-chat.post.ts]
import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai'
import { createError, defineEventHandler, readBody } from 'h3'
import { streamAgentTrigger } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime/h3'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const { text } = await readBody<{ text: string }>(event)
  const runId = crypto.randomUUID()

  const output = await streamAgentTrigger(
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
  if (output instanceof Response) return output
  if (!(output instanceof ReadableStream)) {
    throw createError({ statusCode: 500, statusMessage: 'Expected an Agent UI message stream.' })
  }
  return createUIMessageStreamResponse({
    // The selected output mode emits AI SDK UI message chunks.
    stream: output as ReadableStream<UIMessageChunk>,
  })
})
```

The Agent must attach the [Chat Capability](/docs/agents/capabilities/chat) to register `chat.message`. The consumer supplies the product event. The Capability prepares the Agent input and policy before the Driver starts. A handled Trigger can return a `Response`; the route preserves it. Otherwise, `streamAgentTrigger()` uses the same chunk stream contract and response wrapper as `streamAgent()`. Read [Triggers](/docs/agents/triggers) for when to use this path instead of direct invocation.

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

Use [Invocation storage](/docs/agents/invocation-storage) to retain evidence across restarts.

Every invocation also has an in-memory metadata trace through `runtime.trace` and `runtime.traceLog`. The default log is process-local and is not persisted across a Workflow boundary.

`agent.invocation.finish` carries `result.text` for a text result. A plain object or array result, such as `driver.ask` answers, is `result.output` instead.

An Invocation that starts while another Invocation runs its Driver or an outcome hook is a child of that Invocation. For example, `runAgent()` inside `agent:finish` starts a child. A child without its own trace joins the trace of its parent: both records have the same `traceId`, and each observation of the child has `trace.parentId`, the record `id` of the parent. The parent records `agent.invocation.child.start` and `agent.invocation.child.finish` with `agent.invocation.child.id`, `agent.invocation.child.run.id`, and `agent.invocation.child.agent.name`. The finish observation also has `agent.invocation.child.status` and `agent.invocation.child.durationMs`. The `agent.invocation.start` observation of the child has the same attributes for its parent, under `agent.invocation.parent.*`.

Finish events set `event.invocation.cancelled` to `true` when output consumption is cancelled. Finish effects can use this field to distinguish cancellation from normal completion.

Capability setup callbacks (`configure`, `prepare`, `bind`, `input`, `resolve`, `output`) and `close` emit one `agent.capability.<phase>` event when the callback settles. These events measure the callback itself with a monotonic clock, excluding before/after hooks and trace persistence. Read `agent.capability.id`, `agent.capability.phase`, `agent.capability.outcome`, and `agent.capability.durationMs` to distinguish slow integration setup from model execution. Outcomes are `success`, `error`, or `cancelled`; cancellation means the callback failed while the effective invocation input's abort signal was set.

Timing events carry the available invocation, run, and trace identifiers. They contain no callback arguments, results, configuration, or thrown error messages, and follow the normal trace and journal retention policy. A missing event means timing is unavailable, not zero. Emission does not await arbitrary trace sinks: pending or rejected persistence cannot change callback results or prevent cleanup. The host still owns its trace sink's flushing and retention policy.

Attach the `otlp()` Capability to send completed invocation traces to any OTLP/HTTP JSON receiver:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { otlp } from 'vite-hub/agent/capabilities'

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

Export runs through `runtime.waitUntil()`, so delivery failures do not replace the Agent result. See [`otlp()`](/docs/agents/capabilities/otlp) for batching, deduplication, privacy, and Capability-contribution details.

### Store invocation history

Set `invocations: 'database'` to retain runs in the application's Database, or `'memory'` for process-local history. A journal is opt-in unless the Console supplies one. Set `invocations: false` to disable it for one Agent.

See [Invocation storage](/docs/agents/invocation-storage#store-invocation-history) for configuration and durability. A journal does not replace [Chat History](/docs/agents/chat-history-sessions).

### Use one journal for every Agent

Set `agent.invocations` in `vitehub()` to share a journal across Agents that do not select their own. Read the [app-wide journal setup and host limits](/docs/agents/invocation-storage#use-one-journal-for-every-agent).

### Use a custom store

Pass a store to `defineAgentInvocations()` for a separate SQLite or libSQL journal or an application adapter. See [custom stores](/docs/agents/invocation-storage#use-a-custom-store) and [retention limits](/docs/agents/invocation-storage#set-retention-limits).

### Choose how storage failures affect a run

The default `best-effort` journal lets work start when storage cannot confirm startup. Use `strict` when the journal claim must prevent duplicate runs. Channel replay always uses strict claims. Read [enforcement and timeouts](/docs/agents/invocation-storage#choose-how-storage-failures-affect-a-run) before choosing a policy.

### Store invocations in a ViteHub Database

Use `createDatabaseAgentInvocationStore()` to select a named Database and retention options. The [Database adapter](/docs/agents/invocation-storage#store-invocations-in-a-vitehub-database) supports local SQLite, hosted libSQL, and native D1.

### Redact stored evidence

Journals keep metadata by default. Set `content: 'content'` to retain model content, and use synchronous `redact` and `redactError` callbacks to remove sensitive values before storage. See [redaction](/docs/agents/invocation-storage#redact-stored-evidence), [observation limits](/docs/agents/invocation-storage#bound-observation-storage), and [prompt reruns](/docs/agents/invocation-storage#rerun-a-recorded-prompt).

#### Compact a journal file

Prune terminal records before compacting a local SQLite journal. Read [disk space and locking requirements](/docs/agents/invocation-storage#compact-a-journal-file) before running `vitehub agent invocations compact`.

### Store invocations in Cloudflare D1

Use `createD1AgentInvocationStore()` for a host-supplied D1 binding. Read the [D1 schema, retention, and row limits](/docs/agents/invocation-storage#store-invocations-in-cloudflare-d1).

## Append delivery evidence

`invocations.appendObservation()` records external delivery evidence with an idempotent observation ID. It does not change run status. Read the [append contract](/docs/agents/invocation-storage#append-delivery-evidence) for capacity limits and retry behavior.

## Cancel an invocation

Call `invocations.cancel(id)` to request cancellation. A `requested` outcome confirms the request, not that execution stopped. Read the final journal status to confirm completion.

Model and provider Drivers receive an abort signal. A custom `run` Driver must stop its own I/O; ViteHub cannot stop that callback and reports `notEnforcedBy: 'run'` after dispatch. See [cancellation outcomes and durable requests](/docs/agents/invocation-storage#cancel-an-invocation) for cross-process behavior and failure handling.

## Inspect invocations in the console

Enable the [ViteHub Console](/docs/development/console) to browse retained sessions and inspect invocation events at `/_vitehub`. The Console is opt-in. Its page, RPC endpoint, plugin, and assets do not exist when `console` is omitted or set to `false`.

The Console guide covers Vite and Nuxt setup, fallback storage, production limits, usage records, and route authorization. A journal from `defineAgent({ invocations })` or `agent.invocations` remains authoritative when the Console is enabled.

## Control child work

Use [`startAgentInvocation()`](/docs/agents/controlled-child-invocations) when trusted parent code must inspect or cancel a child after starting it. A model-facing application Capability tool can use that controller when it needs child control, or `runAgent()` when it handles the configured runtime's return value.

## Scheduled results and process recovery

For a scheduled invocation, pass the schedule context and request a drained result: `runAgent(agent, runtimeContext, input, { schedule, output: 'drained' })`. This adds the schedule metadata and consumes streamed driver output before returning. The final response, completion hooks, and capacity release finish together. Configure `driver.output.schema` for a validated result that the scheduler can use directly. A thrown stream or schema error remains a failed invocation; applications do not need to reconstruct results from telemetry.

Trusted code can install tools for one inline invocation with the options argument: `runAgent(agent, runtimeContext, input, { tools: { send_message: toolDefinition } })`. For a standalone scheduled call, `runAgent(agent, { prompt }, { schedule, tools: { send_message: toolDefinition }, output: 'drained' })` returns `[error, text]` after the stream finishes. These tools join the agent's tool set for that invocation and are never serialized into `input`. A name collision with an existing tool fails setup. Callable tools select inline execution when the agent only has a host-discovered Workflow default; an explicit `workflow(...)` binding rejects them before starting. Workflow runs continue to return a Workflow Run for calls with a Runtime Context, so `output: 'drained'` only drains inline output.

A standalone call inside a running host gets the runtime capabilities that the generated Agent routes give Agents: Connections, KV, Blob, Database, Console, and Schedules, as configured. A Schedule handler in `server/schedules/` does not need to import the Connections registry. To replace one capability for one run, pass it in `runtimeContext`: `runAgent(agent, { prompt }, { schedule, runtimeContext: { capabilities: { connections } } })`. Keys in `runtimeContext.capabilities` override the host values; the other host values stay. The generated Agent route module registers the host capabilities when it loads. A Nitro server imports that module at startup on Node, Cloudflare, and Vercel. The generated Deno server and Netlify function are that module. In each case the capabilities are ready before a Schedule runs. Code that runs without the host server, such as a unit test or a plain Node script, gets only the capabilities that it passes.

To give one invocation more Agent Capabilities, pass them in `capabilities`: `runAgent(agent, { prompt }, { schedule, output: 'drained', capabilities: [delivery] })`. They join the run after the agent's own Capabilities. The Agent Definition does not change, and a later run without the option does not get them. Use this when a background job runs one registered agent with job-specific tools, such as a delivery tool, so that you do not define one agent for each job. A Capability id that the agent already uses fails setup. These Capabilities cannot add triggers, Workspace Sources, or chat access, because those are fixed when the agent is defined. Like invocation tools, they select inline execution, and an explicit `workflow(...)` binding rejects them before starting.

`capabilities` and `runtimeContext.capabilities` are different options. `capabilities` adds Agent Capabilities, which give the agent tools and behavior. `runtimeContext.capabilities` replaces host runtime values, such as Connections or KV, that Capabilities read.

Invocation tools accept JSON Schema, Valibot, and Zod schemas directly. Valibot schemas are converted to JSON Schema for model tool discovery while their Standard Schema validator still checks input before `execute`. Unsupported Valibot actions may be omitted from the model-facing schema; validation remains authoritative. Zod schemas use their Standard JSON Schema converter. Other Standard Schema implementations must provide `~standard.jsonSchema.input` for Provider Agent tools.

For journal recovery after a process restart, see [Recover interrupted Invocations](/docs/agents/invocation-storage#recover-interrupted-invocations). Recovery depends on store ownership and the host lifecycle.

`agentInvocationId(runId, agentName)` from `vite-hub/agent/server` resolves the canonical invocation ID before admission, allowing applications to include a live Console link in Channel activity.

For GitHub-backed sessions, `createGitHubWorkspaceInspector(host)` from `@vite-hub/agent/server/github` exposes `list({ repository, revision })` and `read({ repository, revision }, path)`. It requires a full commit SHA, rejects unsafe paths, truncated trees, oversized files, and binary previews, and does not retain disposable checkouts.

An expired execution lease does not prove that its Driver stopped. Cancellation of an unowned running Invocation remains a durable request until the execution owner observes it.

Cancellation of an unowned pending Invocation remains a durable request. A later worker reads the request before starting its Driver and records cancellation. Pending journal status alone does not prove that an earlier Driver never started.

## Next steps

Add [Instructions](/docs/agents/instructions) and [Capabilities](/docs/agents/capabilities) to control what the Driver can do. Use [Test an Agent](/docs/agents/testing) to check the result before connecting more callers.
