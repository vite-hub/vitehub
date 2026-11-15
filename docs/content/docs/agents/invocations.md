---
title: Invocations
description: Run, stream, and observe one request to an Agent, validate its input, invoke Triggers, and cancel an Invocation.
navigation.order: 12
navigation.group: Define and run
icon: i-lucide-play-circle
navigation.kind: Guides
---

An Agent Invocation is one request to an Agent. ViteHub prepares its input, Invoker, Capabilities, Workspace, and Driver, then returns or streams the result.

Start with [Agent Definitions](/docs/agents/agent-definitions). For a complete browser-to-model example, follow [Build a chat app](/docs/agents/build-a-chat-app).

## What happens during an Invocation

| Stage | What happens |
| --- | --- |
| Entry | A route, Channel, schedule, webhook, CLI command, or another caller provides input. |
| Invoker | ViteHub resolves the trusted [Agent Invoker](/docs/agents/trusted-invokers). |
| Capabilities | The Definition and invocation context select the abilities for this request. |
| Context | ViteHub prepares tools, policy, context values, and the Workspace Scope. |
| Execution | The Agent Driver runs the prepared request. |
| Result | ViteHub returns or streams the output and records events and usage. |

A Capability is an ability attached to an Agent, such as chat or a tool; only those selected for the Invocation add anything. The Driver runs the model or provider CLI.

| Term | Describes |
| --- | --- |
| Channel | Message origin and delivery facts around an Invocation. |
| Workflow Run | Durable work that a provider stores and retries. An Agent turn that stops during its Driver fails and does not run again. |
| Agent Memory | Persistent context stored outside the Invocation. |

A Channel can start many Invocations, and a Workflow Run can carry one, but each keeps its own record. `vitehub agent info` shows the resolved Definition, and `vitehub agent dev` talks to the Agent through a running Vite dev server. [Runtime policy, approvals, and traces](/docs/agents/runtime-policy) covers run records.

## Run an Agent

`runAgent(agent, input, options?)` runs the Agent in the calling process and waits for its output. It returns an `[error, result]` tuple and does not throw for a failed run:

```ts fragment
import { runAgent } from 'vite-hub/agent'
import support from './agents/support'

const [error, result] = await runAgent(support, {
  prompt: 'Summarize the support policy.',
})
if (error) throw error
result.text // the final text
```

The success value is an `AgentRunResult`:

| Field | Value |
| --- | --- |
| `text` | The final text. `runAgent()` consumes a streamed output or a `Response` body before it returns. |
| `output` | The typed Agent output: the `driver.output` schema value, the `driver.ask` answers, the `intercept` value, or the value that a `run` Driver returns. A model Driver without a schema sets no `output`. |
| `usage`, `usageRecord`, `finishReason`, `warnings` | Facts that the Driver reports. |
| `raw` | The Driver result, or the `Response` that the Agent returned. |

`error.code` is `AGENT_RUN_FAILED` or `AGENT_RUN_CANCELLED`, and `error.cause` has the original failure, for example a `CHANNEL_DELIVERY_REQUIRED` error or an invalid `data` error. See [Errors](#errors).

### Pass the host Runtime Context

In a route, pass the host [Runtime Context](/docs/reference/runtime-context) as `runtimeContext`. It carries request metadata, the runtime config, and the host `waitUntil`:

The route reads the signed-in user with a helper of the app:

```ts [server/utils/auth.ts]
import { createError } from 'h3'
import { auth } from 'vite-hub/auth/server'
import type { H3Event } from 'h3'

export async function requireAuthenticatedUser(event: H3Event) {
  const session = await auth.api.getSession({ headers: event.req.headers })
  if (!session) throw createError({ status: 401 })
  return session.user
}
```

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Answer support questions. Say when you need more information.',
  },
})
```

```ts [server/api/support.post.ts]
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import * as v from 'valibot'
import { runAgent } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime'
import support from '../agents/support'
import { requireAuthenticatedUser } from '../utils/auth'

export default defineEventHandler(async (event) => {
  const { prompt } = await readValidatedBody(event, body => v.parse(v.object({ prompt: v.string() }), body))
  const user = await requireAuthenticatedUser(event)

  const [error, result] = await runAgent(support, {
    prompt,
    context: {
      invoker: {
        id: user.id,
        kind: 'customer',
        label: user.email,
      },
    },
  }, { runtimeContext: getRuntimeContext(event) })
  if (error) throw createError({ statusCode: 500, statusMessage: error.why })
  return { text: result.text }
})
```

`requireAuthenticatedUser` is an application helper from `server/utils/auth.ts`, omitted here. Implement it with your authentication provider so it rejects unauthenticated requests and returns the trusted user's `id` and `email`. It is not a ViteHub export. Authenticate the request before passing trusted identity or access facts. `context.invoker` is the current input field for an [Agent Invoker](/docs/agents/trusted-invokers).

The option is `runtimeContext`, not `context`, because `input.context` already holds the Invocation context values that instructions and hooks read, such as `context.customInstructions`.

Without `runtimeContext`, `runAgent()` creates a fresh memo cache and run ID, uses the `unknown` runtime, and waits for background work that the run registers with `waitUntil()` before it returns. A background failure returns `AGENT_RUN_FAILED`; an invocation failure takes precedence if both fail. When `runtimeContext.waitUntil` is set, the host keeps background work alive and `runAgent()` does not wait for it.

`runAgent()` runs the Agent inline, whatever its `runtime` setting. The generated Agent routes and Channels start Workflow runs for Agents that have one. To start a durable run that you inspect or cancel later, use [`startAgentInvocation()`](/docs/agents/controlled-child-invocations).

## Stream an Agent

Use `streamAgent(agent, input, options?)` when a chat UI or internal consumer needs incremental output. It returns `[error, stream]`.

```ts [server/api/support-stream.post.ts]
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import * as v from 'valibot'
import { streamAgent } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const { prompt } = await readValidatedBody(event, body => v.parse(v.object({ prompt: v.pipe(v.string(), v.minLength(1)) }), body))

  const [error, response] = await streamAgent(support, { prompt }, {
    output: 'ui-message-stream',
    runtimeContext: getRuntimeContext(event),
  })
  if (error) throw createError({ statusCode: 500, statusMessage: error.why })
  return response
})
```

`output: 'ui-message-stream'` returns a `Response` with an AI SDK UI message stream that a chat client reads. Without `output`, `streamAgent()` returns an `AsyncIterable<StreamEvent>` of typed ViteHub stream events:

```ts fragment
const [error, events] = await streamAgent(support, { prompt })
if (error) throw error
for await (const event of events) {
  if (event.type === 'text-delta') process.stdout.write(event.text)
}
```

The tuple covers the start of the Invocation. An error during stream consumption reaches the reader of the stream.

Streaming routes must provide a real host `waitUntil` lifetime in `runtimeContext`. A drain before returning cannot cover work scheduled when the caller consumes or cancels the stream. See [Runtime Context](/docs/reference/runtime-context#background-work-and-cleanup).

The stream ends when the caller reads all of it, cancels it, or gets an error. A caller that stops reading also stops observing completion.

## Invoke a Trigger

A Trigger is a named event that a Capability defines and shapes, such as `chat.message`. Send it with `runAgentTrigger()` or `streamAgentTrigger()`. This example invokes the Chat Capability's `chat.message` Trigger:

```ts [server/api/support-chat.post.ts]
import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import * as v from 'valibot'
import { streamAgentTrigger } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const { text } = await readValidatedBody(event, body => v.parse(v.object({ text: v.string() }), body))
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

The Agent must attach the [Chat Capability](/docs/agents/capabilities/chat) to register `chat.message`. The consumer supplies the product event. The Capability prepares the Agent input and policy before the Driver starts. A handled Trigger can return a `Response`; the route preserves it. Otherwise, `streamAgentTrigger()` returns the UI message chunk stream, which the route wraps with `createUIMessageStreamResponse()`. Read [Triggers](/docs/agents/triggers) for when to use this path instead of direct invocation.

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

Set `defineAgent({ data })` when callers pass structured values. ViteHub validates `input.data` with the schema before hooks and the Driver run, and `runAgent()` returns `AGENT_RUN_FAILED` with the validation error as `error.cause` for invalid data. See [Accept structured data](/docs/agents/agent-definitions#accept-structured-data).

## Observe the outcome

Hooks record what each run did. `agent:finish` gets the normalized duration, result kind, and usage. `agent:error` gets each failed Invocation.

```ts [server/agents/support.ts] fragment
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

Set `invocations: 'database'` to retain runs in the application's Database, or `'memory'` for process-local history. Without a setting, the Agent records into the [default journal](/docs/agents/invocation-storage#use-the-default-journal), with the Console on or off. Set `invocations: false` to disable it for one Agent.

See [Invocation storage](/docs/agents/invocation-storage#store-invocation-history) for configuration and durability. A journal does not replace [Chat History](/docs/agents/chat-history-sessions).

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

## Import a session that ran elsewhere

Codex and Claude Code often run outside the app: on a laptop, in CI, or on an eval runner. Each CLI writes a session file. `@vite-hub/agent/sessions` reads that file and writes it to a journal store as a finished Invocation with the session's own timestamps. The Console then shows its messages, thinking, commands, file changes, and usage like a run of the app.

```ts
import { readFile } from 'node:fs/promises'
import { importAgentSession, readCodexSession } from '@vite-hub/agent/sessions'
import { createLibsqlAgentInvocationStore } from '@vite-hub/agent/invocations'

const rolloutPath = './rollout.jsonl'
const store = createLibsqlAgentInvocationStore({ url: 'file:./agent-journal.sqlite' })
const session = readCodexSession(await readFile(rolloutPath, 'utf8'))
const { id } = await importAgentSession(store, session, { agentName: 'coder', runId: 'eval-42', title: 'Add a health route' })
```

`readClaudeCodeSession()` reads `$CLAUDE_CONFIG_DIR/projects/<project>/<session>.jsonl`, and `readCodexSession()` reads `$CODEX_HOME/sessions/**/rollout-*.jsonl`. The record id is `agentInvocationId(runId, agentName)`. Importing the same `agentName` and `runId` again replaces the record, so the store must implement `delete()`. Pass `configuration` to record the skills, MCP servers, and Workspace the session had, and `cost` to record a price, because the CLIs report only tokens.

## Cancel an invocation

`invocations.cancel(id)` asks ViteHub to stop a run. A `requested` outcome confirms only the request; read the final journal status to confirm the stop.

Model and provider Drivers get an abort signal. A custom `run` Driver must stop its own I/O, because ViteHub cannot stop that callback; it reports `notEnforcedBy: 'run'` after dispatch. See [cancellation outcomes and durable requests](/docs/agents/invocation-storage#cancel-an-invocation) for behavior across processes and for failure handling.

## Inspect invocations in the console

Open the app in the [ViteHub Console](/docs/development/console) to browse retained sessions and inspect invocation events. The Console calls the app's Operations endpoint. A production build has no endpoint when `console` is omitted or set to `false`.

The Console guide covers Vite and Nuxt setup, the journal that it reads, production limits, usage records, and route authorization. A journal from `defineAgent({ invocations })` or `agent.invocations` remains authoritative when the Console is enabled.

## Control child work

Use [`startAgentInvocation()`](/docs/agents/controlled-child-invocations) when trusted parent code must inspect or cancel a child after it starts. A model-facing Capability tool can use that controller for child control, or `runAgent()` for the result.

## Scheduled results and process recovery

### Get a final result for a Schedule

Pass the schedule context as `runAgent(agent, input, { schedule })`. This adds metadata to `context.schedule` and reads all Driver output before it returns. The final response, completion hooks, and capacity release finish together. Set `driver.output.schema` for a validated result. Stream and schema errors fail the Invocation.

### Add tools for one run

Trusted code can add tools with `runAgent(agent, { prompt }, { schedule, tools: { send_message: toolDefinition } })`. These tools join the Agent's tools for that Invocation and are never serialized into `input`. A name collision fails setup. Read the completed text from `result.text`.

Tools accept JSON Schema, Valibot, and Zod schemas directly. Valibot converts to JSON Schema so the model can discover the tool, and its Standard Schema validator still checks input before `execute`. Unsupported Valibot actions may be omitted from the model-facing schema; validation remains authoritative. Zod uses its Standard JSON Schema converter. For Provider Agent tools, other Standard Schema implementations must provide `~standard.jsonSchema.input`.

### Use host values in a standalone call

A standalone call inside a running host gets the runtime values that generated Agent routes give Agents: Connections, KV, Blob, Database, Console, and Schedules, as configured. A Schedule handler in `server/schedules/` need not import the Connections registry. To replace one value for one run, pass it in `runtimeContext`: `runAgent(agent, { prompt }, { schedule, runtimeContext: { capabilities: { connections } } })`. Other host values stay.

The generated Agent route module registers these values when it loads. Nitro loads it on the first request. A Schedule that runs before any request loads it first. The generated Deno server and Netlify function are that module. In each case, the values are ready before a Schedule runs. Code without the host server, such as a unit test or plain Node script, gets only what it passes.

### Add Capabilities for one run

Pass extra Agent Capabilities in `capabilities`: `runAgent(agent, { prompt }, { schedule, capabilities: [delivery] })`. A background job can then run one registered Agent with job tools, such as delivery, instead of one Agent per job.

- They join after the Agent's own Capabilities and do not change the Definition or later runs.
- A Capability id that the Agent already uses fails setup.
- They cannot add Triggers, Workspace Sources, or chat access, which are fixed at definition.

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

## Errors

`runAgent()` and `streamAgent()` return these codes as `[error, undefined]`. `error.cause` keeps the original failure. `JSON.stringify(error)` includes only `name`, `code`, `why`, `fix`, and `docs`, because a cause can contain private data. Log `cause` only on the server.

### AGENT_RUN_FAILED

The Invocation failed. The cause is the error from the Driver, a hook, a Capability, `data` validation, or background work. Read `error.cause` and its `code`, such as `CHANNEL_DELIVERY_REQUIRED`.

### AGENT_RUN_CANCELLED

The Invocation stopped because the `abortSignal` of its input aborted. `error.cause` has the abort reason. Start a new Invocation if the work is still needed.

## Next steps

Add [Instructions](/docs/agents/instructions) and [Capabilities](/docs/agents/capabilities) to control what the Driver can do, and [test the Agent](/docs/agents/testing) before you connect more callers.
