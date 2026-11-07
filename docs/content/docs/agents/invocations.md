---
title: Invocations
description: Run, stream, and observe one request to an Agent, validate its input, invoke Triggers, and cancel an Invocation.
navigation.order: 12
navigation.group: Define and run
icon: i-lucide-play-circle
navigation.kind: Guides
---

An Invocation is one run of an [Agent Definition](/docs/agents/agent-definitions), the reusable file that describes an Agent. ViteHub prepares the request, runs it, and returns or streams the result. [Build a chat app](/docs/agents/build-a-chat-app) shows a full example.

## What happens during an Invocation

| Stage | What happens |
| --- | --- |
| Entry | A route, Channel, schedule, webhook, CLI command, or another caller provides input. |
| Actor | ViteHub resolves the trusted [Agent Actor](/docs/agents/actors). |
| Capabilities | The Definition and invocation context select the abilities for this request. |
| Context | ViteHub prepares tools, policy, context values, and the Workspace Scope. |
| Execution | The Agent Driver runs the prepared request. |
| Result | ViteHub returns or streams the output and records events and usage. |

A Capability is an ability attached to an Agent, such as chat or a tool; only those selected for the Invocation add anything. The Driver runs the model or provider CLI.

| Term | Describes |
| --- | --- |
| Channel | Message origin and delivery facts around an Invocation. |
| Workflow Run | Durable work that can continue across waits or server restarts. |
| Agent Memory | Persistent context stored outside the Invocation. |

A Channel can start many Invocations, and a Workflow Run can carry one, but each keeps its own record. `vitehub agent info` shows the resolved Definition, and `vitehub agent dev` talks to the Agent through a running Vite dev server. [Runtime policy, approvals, and traces](/docs/agents/runtime-policy) covers run records.

## Run an Agent

For an Agent with `runtime: false`, the shortest call returns an `[error, result]` tuple:

```ts
import { runAgent } from 'vite-hub/agent'
import support from './agents/support'

const [error, result] = await runAgent(support, {
  prompt: 'Summarize the support policy.',
})
if (error) throw error
```

Pass `{ output: 'drained' }` as the third argument to read the whole stream and get `[error, text]`. Leave it out when a custom Driver returns an object that you must keep unchanged.

In a server route, pass a [Runtime Context](/docs/reference/runtime-context) second, for request metadata and host Workflow lookup. This form returns the result directly and throws on failure. Inline runs can return a native `Response`, Workflow runs return a Workflow Run to control later, and structured outputs stay typed. Streaming has its own contract ([Stream an Agent](#stream-an-agent)).

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

`requireAuthenticatedUser` is your own helper in `server/utils/auth.ts`, not a ViteHub export. It must reject requests without a signed-in user and return the trusted `id` and `email`. Always authenticate before you pass identity or access facts to the Agent. `context.invoker` sets the [Agent Actor](/docs/agents/actors), the caller's trusted identity.

The H3 `getRuntimeContext()` adapter gives `runtime`, a fresh `memo` cache, and tracked `waitUntil` work. The example waits for background work before it returns and logs its failures separately.

### Run without a host context

In a script, or without a server request, pass the input as the second argument:

```ts
const [error, result] = await runAgent(support, { prompt: 'Summarize the support policy.' })
if (error) throw error
```

This form:

- creates a fresh memo cache and run ID and uses the `unknown` runtime
- returns `[null, result]` or `[Error, null]`
- waits for background work started before the call settles, and returns an error tuple when it fails (the run error wins when both fail)
- wraps a thrown non-`Error` value in an `Error` with the original as its `cause`

Inline output stays unchanged, and an explicit Workflow binding returns its Workflow Run. An Agent that relies on the host to find its Workflow returns an error tuple: set `runtime: false`, configure an explicit `workflow("name")` binding, or use the three-argument form.

This form has no request metadata, runtime configuration, or host lifetime for background work, including streams that start work while the caller reads them. Use the three-argument form for those. The tuple covers only the call: errors while you read a returned stream or `Response` body appear during that read.

## Stream an Agent

`streamAgent()` sends the output piece by piece, for example to a chat UI.

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

`output: 'ui-message-stream'` returns a `ReadableStream` of AI SDK UI message chunks, which `createUIMessageStreamResponse()` encodes as SSE with chat-client headers. Return an Agent `Response` unchanged. The return type includes `unknown`, so the example checks it and narrows the chunk type. `output: 'events'` gives ViteHub stream events for server code.

::warning
A streaming route must give a real host `waitUntil` lifetime, through the event or the adapter options. Waiting for background work before you return does not cover work that starts while the caller reads or cancels the stream. See [Runtime Context](/docs/reference/runtime-context#background-work-and-cleanup).
::

The stream ends when the caller reads all of it, cancels it, or gets an error. A caller that stops reading also stops observing completion.

## Invoke a Trigger

A Trigger is a named event that a Capability defines and shapes, such as `chat.message`. Send it with `runAgentTrigger()` or `streamAgentTrigger()`. This example invokes the Chat Capability's `chat.message` Trigger:

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

The Agent must attach the [Chat Capability](/docs/agents/capabilities/chat), which registers `chat.message`. The Capability prepares input and policy before the Driver starts. Return a handled Trigger's `Response` unchanged; otherwise the stream matches `streamAgent()`. [Triggers](/docs/agents/triggers) explains when to prefer a Trigger.

## Validate input

An `agent:input` hook checks that trusted input is present before the Driver runs.

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

Validate untrusted request data in the route. The hook protects the Agent when several trusted callers run the same Definition.

For structured values, set `defineAgent({ data })`. ViteHub validates `input.data` before hooks and the Driver run, and `runAgent()` returns an error tuple for invalid data. See [Accept structured data](/docs/agents/agent-definitions#accept-structured-data).

## Observe the outcome

Hooks record what each run did. `agent:finish` gets the normalized duration, result kind, and usage. `agent:error` gets each failed Invocation.

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

When a Channel (a message source such as Slack or GitHub) started the Invocation, both hooks also get `event.message`. Its methods act on the provider message, for example to reply or add a label. With `dryRun: true` in the input, ViteHub records write calls in the trace instead of calling the provider. See [Act on the Channel message in hooks](/docs/agents/channels#act-on-the-channel-message-in-hooks).

Error hooks get the raw `event.error`, only for protected server diagnostics, and the sanitized `event.publicError` for logs, HTTP responses, or Channel replies. See [Agent public errors](/docs/reference/errors-diagnostics#agent-public-errors) for stable codes and redaction rules.

To keep evidence across restarts, use [Invocation storage](/docs/agents/invocation-storage). Each Invocation also has an in-memory metadata trace in `runtime.trace` and `runtime.traceLog`. It stays in the process and is not kept across a Workflow boundary.

`agent.invocation.finish` has `result.text` for a text result, and `result.output` for a plain object or array, such as `driver.ask` answers.

### Child Invocations

An Invocation that starts while another runs its Driver or an outcome hook, such as `runAgent()` inside `agent:finish`, is its child. A child without its own trace joins the parent trace:

- Both records share the `traceId`. Each child observation has `trace.parentId`, the parent record `id`.
- The parent records `agent.invocation.child.start` and `agent.invocation.child.finish`, with `agent.invocation.child.id`, `agent.invocation.child.run.id`, and `agent.invocation.child.agent.name`. Finish also has `agent.invocation.child.status` and `agent.invocation.child.durationMs`.
- The child's `agent.invocation.start` has the same attributes for its parent under `agent.invocation.parent.*`.

When the caller cancels reading the output, finish events set `event.invocation.cancelled` to `true`, so finish effects can tell it from a normal finish.

Capability timing events show whether a slow run comes from integration setup or the model. The `configure`, `prepare`, `bind`, `input`, `resolve`, `output`, and `close` callbacks each emit one `agent.capability.<phase>` event when they settle. It measures only the callback with a monotonic clock, without before and after hooks or trace persistence. Fields:

- `agent.capability.id` and `agent.capability.phase`
- `agent.capability.outcome`: `success`, `error`, or `cancelled` (the callback failed while the abort signal of the effective Invocation input was set)
- `agent.capability.durationMs`

Timing events carry available Invocation, run, and trace IDs, but no callback arguments, results, configuration, or error messages, and follow normal retention. A missing event means unavailable, not zero. ViteHub does not wait for trace sinks, so a failed write cannot change callback results or stop cleanup. The host owns sink flushing and retention.

### Export traces with OTLP

The `otlp()` Capability sends completed Invocation traces to any OTLP/HTTP JSON receiver:

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

- Pass the base endpoint; ViteHub appends `/v1/logs` and `/v1/traces`.
- With `live: true`, new Trace Events go out in batches as correlated OTLP LogRecords during the run, then one completed trace. Without it, only the completed trace goes out, with Trace Events as span events.
- Only metadata is sent by default. For a trusted receiver, turn on `content.inputs`, `content.outputs`, or `content.instructions` independently.

The export runs through `runtime.waitUntil()`, so a failed delivery does not replace the Agent result. See [`otlp()`](/docs/agents/capabilities/otlp) for batching, deduplication, and privacy.

### Store invocation history

A journal records each run. It is off unless set or supplied by the Console. `invocations: 'database'` keeps runs in the application's Database, `'memory'` keeps them in the process, and `false` turns it off for one Agent. See [Invocation storage](/docs/agents/invocation-storage#store-invocation-history). A journal does not replace [Chat History](/docs/agents/chat-history-sessions).

### Use one journal for every Agent

`agent.invocations` in `vitehub()` shares one journal across Agents that select none. See [app-wide journal setup and host limits](/docs/agents/invocation-storage#use-one-journal-for-every-agent).

### Use a custom store

Pass a store to `defineAgentInvocations()` for a separate SQLite or libSQL journal or your own adapter. See [custom stores](/docs/agents/invocation-storage#use-a-custom-store) and [retention limits](/docs/agents/invocation-storage#set-retention-limits).

### Choose how storage failures affect a run

`best-effort` (default) starts work even when storage cannot confirm the start. Use `strict` when the journal claim must prevent duplicate runs. Channel replay always uses strict claims. Read [enforcement and timeouts](/docs/agents/invocation-storage#choose-how-storage-failures-affect-a-run) first.

### Store invocations in a ViteHub Database

`createDatabaseAgentInvocationStore()` selects a named Database and retention options. The [Database adapter](/docs/agents/invocation-storage#store-invocations-in-a-vitehub-database) supports local SQLite, hosted libSQL, and native D1.

### Redact stored evidence

Journals keep only metadata by default. `content: 'content'` keeps model content too. The synchronous `redact` and `redactError` callbacks remove sensitive values before storage. See [redaction](/docs/agents/invocation-storage#redact-stored-evidence), [observation limits](/docs/agents/invocation-storage#bound-observation-storage), and [prompt reruns](/docs/agents/invocation-storage#rerun-a-recorded-prompt).

#### Compact a journal file

Prune finished records before you compact a local SQLite journal, and read [disk space and locking requirements](/docs/agents/invocation-storage#compact-a-journal-file) before you run `vitehub agent invocations compact`.

### Store invocations in Cloudflare D1

Use `createD1AgentInvocationStore()` with a host D1 binding. See [D1 schema, retention, and row limits](/docs/agents/invocation-storage#store-invocations-in-cloudflare-d1).

## Append delivery evidence

`invocations.appendObservation()` records proof of an external delivery, such as a delivered report. Its idempotent observation ID stops retries from adding a second record. It does not change the run status. See the [append contract](/docs/agents/invocation-storage#append-delivery-evidence) for capacity limits and retries.

## Cancel an invocation

`invocations.cancel(id)` asks ViteHub to stop a run. A `requested` outcome confirms only the request; read the final journal status to confirm the stop.

Model and provider Drivers get an abort signal. A custom `run` Driver must stop its own I/O, because ViteHub cannot stop that callback; it reports `notEnforcedBy: 'run'` after dispatch. See [cancellation outcomes and durable requests](/docs/agents/invocation-storage#cancel-an-invocation) for behavior across processes and for failure handling.

## Inspect invocations in the console

The [ViteHub Console](/docs/development/console) at `/_vitehub` shows stored sessions and Invocation events. It is off by default: without `console`, or with `false`, its page, RPC endpoint, plugin, and assets do not exist. A journal from `defineAgent({ invocations })` or `agent.invocations` stays the source of truth. The Console guide covers setup, fallback storage, production limits, usage records, and route authorization.

## Control child work

Use [`startAgentInvocation()`](/docs/agents/controlled-child-invocations) when trusted parent code must inspect or cancel a child after it starts. A model-facing tool in your own Capability can use that controller for child control, or `runAgent()` when it handles the configured runtime's return value.

## Scheduled results and process recovery

### Get a final result for a Schedule

`runAgent(agent, runtimeContext, input, { schedule, output: 'drained' })` adds schedule metadata and reads all Driver output before it returns, so the final response, completion hooks, and capacity release finish together. `driver.output.schema` gives the scheduler a validated result, with no rebuilding from telemetry. A thrown stream or schema error still fails the Invocation.

### Add tools for one run

Trusted code can add tools to one inline Invocation: `runAgent(agent, runtimeContext, input, { tools: { send_message: toolDefinition } })`. A standalone scheduled call, `runAgent(agent, { prompt }, { schedule, tools: { send_message: toolDefinition }, output: 'drained' })`, returns `[error, text]` after the stream finishes.

- The tools join the tool set for that Invocation only and are never serialized into `input`.
- A name that matches an existing tool fails setup.
- They make a run inline when the Agent has only a host-found Workflow default. An explicit `workflow(...)` binding rejects them before the run starts.
- A call with a Runtime Context still returns a Workflow Run for Workflow runs, so `output: 'drained'` drains only inline output.

Tools accept JSON Schema, Valibot, and Zod schemas directly. Valibot converts to JSON Schema so the model can discover the tool, and its Standard Schema validator still checks input before `execute`. Unsupported Valibot actions may be omitted from the model-facing schema; validation remains authoritative. Zod uses its Standard JSON Schema converter. For Provider Agent tools, other Standard Schema implementations must provide `~standard.jsonSchema.input`.

### Use host values in a standalone call

A standalone call inside a running host gets the runtime values that generated Agent routes give Agents: Connections, KV, Blob, Database, Console, and Schedules, as configured. So a Schedule handler in `server/schedules/` need not import the Connections registry. To replace one value for one run, pass it in `runtimeContext`: `runAgent(agent, { prompt }, { schedule, runtimeContext: { capabilities: { connections } } })`. Other host values stay.

The values are ready before a Schedule runs: the generated Agent route module registers them when it loads, a Nitro server imports it at startup on Node, Cloudflare, and Vercel, and the generated Deno server and Netlify function are that module. Code without the host server, such as a unit test or plain Node script, gets only what it passes.

### Add Capabilities for one run

Pass extra Agent Capabilities for one Invocation in `capabilities`: `runAgent(agent, { prompt }, { schedule, output: 'drained', capabilities: [delivery] })`. A background job can then run one registered Agent with job tools, such as delivery, instead of one Agent per job.

- They join after the Agent's own Capabilities and do not change the Definition or later runs.
- A Capability id that the Agent already uses fails setup.
- They cannot add Triggers, Workspace Sources, or chat access, which are fixed at definition.
- Like Invocation tools, they make the run inline, and an explicit `workflow(...)` binding rejects them.

::note
`capabilities` adds Agent Capabilities (tools and behavior). `runtimeContext.capabilities` replaces host runtime values, such as Connections or KV, that Capabilities read.
::

### Recover after a restart

[Recover interrupted Invocations](/docs/agents/invocation-storage#recover-interrupted-invocations) explains recovery, which depends on who owns the store and the host lifecycle. When no process owns an Invocation:

- An expired execution lease does not prove that its Driver stopped.
- Cancelling a running one stores a durable request until the run owner sees it.
- Cancelling a pending one stores a durable request that a later worker reads, and records, before it starts its Driver.
- A pending journal status does not prove that an earlier Driver never started.

### Link to a run before it starts

`agentInvocationId(runId, agentName)` from `vite-hub/agent/server` gives the canonical Invocation ID before admission, for a live Console link in Channel activity.

### Inspect a GitHub checkout

For GitHub-backed sessions, `createGitHubWorkspaceInspector(host)` from `@vite-hub/agent/server/github` gives `list({ repository, revision })` and `read({ repository, revision }, path)`. It requires a full commit SHA, rejects unsafe paths, truncated trees, oversized files, and binary previews, and keeps no disposable checkouts.

## Next steps

Add [Instructions](/docs/agents/instructions) and [Capabilities](/docs/agents/capabilities) to control what the Driver can do, and [test the Agent](/docs/agents/testing) before you connect more callers.
