---
title: Triggers
description: Turn product events into Agent Invocations. The Driver still runs the Agent.
navigation.order: 43
navigation.group: Channels
icon: i-lucide-route
navigation.kind: Guides
---

A Trigger turns a product event, such as a new chat message or an opened ticket, into input for an Invocation (one run of the Agent). Use one when a Capability (tools and behavior that you add to an Agent) decides the event's shape or rules. The Driver, which runs the model, still runs the Invocation.

## Call an Agent directly

When no Capability prepares the event, call `runAgent()` from a route.

```ts [server/api/support.post.ts]
import { defineEventHandler, readValidatedBody } from 'h3'
import * as v from 'valibot'
import { runAgent } from 'vite-hub/agent'
import support from '../agents/support'
import { getRuntimeContext } from 'vite-hub/runtime/h3'

export default defineEventHandler(async (event) => {
  const { prompt } = await readValidatedBody(event, v.parser(v.object({ prompt: v.pipe(v.string(), v.nonEmpty()) })))
  const runtime = getRuntimeContext(event)
  try {
    const [error, result] = await runAgent(support, { prompt }, { runtimeContext: runtime })
    if (error) throw error
    return { text: result.text }
  }
  finally {
    await runtime.flushWaitUntil().catch(console.error)
  }
})
```

Use this in authenticated routes and scheduled code. Without a host lifetime API, finish tracked background work before you return, as the example does while it logs background failures.

## Use a Capability Trigger

The Chat Capability, for example, registers the `chat.message` Trigger, which applies history, session, concurrency, and delivery behavior before the Driver runs.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { chat } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Answer support messages.',
  },
  capabilities: [
    chat({ triggerHistory: { maxMessages: 20, source: 'thread' } }),
  ],
})
```

### Consume a Capability Trigger

Call the Trigger from a server route:

```ts [server/api/support-chat.post.ts] fragment
import { streamAgentTrigger } from 'vite-hub/agent'
import support from '../agents/support'
import { loadAuthorizedSupportThreadMessages } from '../support-history'
import { getRuntimeContext } from 'vite-hub/runtime/h3'

export default defineEventHandler(async (event) => {
  const { text, threadId } = await readBody<{
    text: string
    threadId?: string
  }>(event)
  const user = await requireAuthenticatedUser(event)
  const runId = crypto.randomUUID()
  const messages = await loadAuthorizedSupportThreadMessages({
    actorId: user.id,
    threadId,
  })
  messages.push({
    id: runId,
    role: 'user',
    parts: [{ type: 'text', text }],
  })

  return streamAgentTrigger(
    support,
    getRuntimeContext(event),
    'chat.message',
    {
      messages,
      run: {
        channelId: 'portal',
        messageId: runId,
        origin: 'portal',
        runId,
        threadId,
      },
    },
    { output: 'ui-message-stream' },
  )
})
```

This streaming route needs a host lifetime API that stays active until the stream is read or cancelled. `flushWaitUntil()` before you return the stream does not cover later work. See [Runtime Context](/docs/reference/runtime-context#background-work-and-cleanup) for who owns the lifetime.

`run` contains origin and trace metadata; it is not chat context. Authenticate before passing Invoker identity, session selection, or trusted metadata into the Trigger input.

> [!WARNING]
> Authenticate the caller before you put Invoker identity, session selection, or trusted metadata into the Trigger input.

A route that calls a Trigger directly must, in order: authenticate the caller, reject threads the caller does not own, then load the thread's messages in order, add the new one, and pass them all. `triggerHistory` limits that input; it does not load missing messages from `threadId` or a session ID.

## Add an application-owned Trigger

Put a trigger in the `on` map of a Channel when your own system sends events. The Agent that lists the Channel runs the input that the trigger returns.

```ts [server/channels/ticketing.ts]
import { defineChannelTrigger } from 'vite-hub/agent/channels'
import { defineChannel, webhook } from 'vite-hub/channels'
import * as v from 'valibot'

const ticketOpened = v.object({
  payload: v.object({
    ticketId: v.string(),
    summary: v.pipe(v.string(), v.trim(), v.minLength(1)),
  }),
})

export default defineChannel({
  adapter: webhook({ kind: 'ticketing', signature: 'bearer', secret: () => process.env.TICKETING_WEBHOOK_SECRET }),
  on: {
    webhook: defineChannelTrigger({
      input: ticketOpened,
      invoke(context, { payload: event }) {
        return {
          input: {
            prompt: `Triage ticket ${event.ticketId}: ${event.summary}`,
          },
          run: {
            channelId: context.trigger.channelId,
            origin: 'ticketing',
            runId: event.ticketId,
          },
        }
      },
    }),
  },
})
```

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  channels: ['ticketing'],
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

The trigger gets the verified webhook as `{ payload, body, request }`, where `payload` is the parsed JSON body. `defineChannelTrigger()` infers the `event` type from any [Standard Schema](https://standardschema.dev/) implementation. Webhook authentication runs first, then validation and schema transforms, then `invoke()`. Invalid webhook input gets a generic `400 invalid_payload` response without schema details.

The Trigger translates the validated event and adds trusted context. Keep model selection, tools, and execution behavior in the Agent Definition (what `defineAgent()` returns).

When the Channel declares message methods, also return `message`: JSON that identifies the provider message, which hooks use through `event.message`. See [Act on the Channel message in hooks](/docs/agents/channels#act-on-the-channel-message-in-hooks).

### Ignore a webhook

Return `ignored(reason)` for an event that the Channel does not handle. It answers HTTP 200 with `{ accepted: false, ok: true, reason }`, so the provider does not retry and no Invocation starts.

```ts fragment
import { defineChannelTrigger, ignored } from 'vite-hub/agent/channels'

defineChannelTrigger({
  input: ticketOpened,
  invoke(context, { payload: event }) {
    if (event.summary.startsWith('[bot]')) return ignored('bot_ticket')
    return { input: { prompt: `Triage ticket ${event.ticketId}: ${event.summary}` } }
  },
})
```

Two other helpers answer `{ accepted: false, ok: false, reason }` and start no Invocation.

| Helper | Status | Use it when | Retry |
| --- | --- | --- | --- |
| `ignored(reason)` | 200 | The Channel does not handle the event. | No |
| `retryLater(reason)` | 503 | The Channel cannot take the event yet, such as when a dependency is down. | The sender retries. For a queued delivery that the queue replays, the queue retries, and its error names the reason. |
| `rejected(reason)` | 400 | The Channel will never handle the event, such as a malformed payload. | No. A queued delivery settles as rejected. |

```ts fragment
import { defineChannelTrigger, rejected, retryLater } from 'vite-hub/agent/channels'

defineChannelTrigger({
  input: ticketOpened,
  async invoke(context, event) {
    if (!event.ticketId) return rejected('missing_ticket')
    if (!await ticketing.isReady()) return retryLater('ticketing_unavailable')
    return { input: { prompt: `Triage ticket ${event.ticketId}: ${event.summary}` } }
  },
})
```

### Run deliveries one at a time per key

`webhook.serialize: key` queues a delivery until no other delivery with the same key runs.

```ts fragment
defineChannelTrigger({
  input: ticketOpened,
  invoke: (context, event) => ({
    input: { prompt: `Triage ticket ${event.ticketId}: ${event.summary}` },
    webhook: { deliveryId: event.changeId, serialize: event.ticketId },
  }),
})
```

`serialize: key` equals `concurrencyKey: key` with `concurrencyLimit: 1`, so it needs a state provider (the storage for the queue). The limit counts deliveries of one `concurrencyGroup`, so other keys in the same group also wait. ViteHub throws a `TypeError` when a result sets `serialize` with either of the others.

### Identify a webhook delivery

`webhook.deliveryId` identifies the delivery, so ViteHub drops a retry it already accepted. On a Channel Trigger, the Invocation runs under this ID. The default is the SHA-256 (hex) of the raw request body, so a retry with the same body is the same delivery.

```ts fragment
defineChannelTrigger({
  input: ticketOpened,
  invoke: (context, event) => ({
    input: { prompt: `Triage ticket ${event.ticketId}: ${event.summary}` },
    webhook: { serialize: event.ticketId },
  }),
})
```

Set `deliveryId` when the provider sends an event ID, when two events can share a body, or when a timestamp or nonce changes on each retry. The default applies only when a webhook route runs the Trigger, not to calls from code without a request.

### Debounce webhook deliveries

Some providers send several notifications for one change. `webhook.debounce: { key, delayMs }` runs only the last one: a queued delivery waits `delayMs`, and a later delivery with the same `key` replaces it before it starts and restarts the wait.

```ts fragment
defineChannelTrigger({
  input: recordChanged,
  invoke: (context, event) => ({
    input: { prompt: `Check record ${event.recordId} for duplicates.` },
    webhook: {
      concurrencyLimit: 1,
      debounce: { delayMs: 3 * 60_000, key: event.recordId },
      deliveryId: event.changeId,
    },
  }),
})
```

Debounce needs a state provider and `concurrencyLimit`. A running delivery does not stop; the later one runs after it. A replaced delivery counts as complete, and its Channel delivery record shows a `superseded` event. `debounce` does not work with `busy: 'steer'`.

### Answer the provider

An accepted delivery gets a JSON receipt such as `{ "accepted": true, "ok": true, "queued": true }`. For providers that expect a specific answer, set `webhook.response`:

```ts fragment
defineChannelTrigger({
  input: recordChanged,
  invoke: (context, event) => ({
    input: { prompt: `Check record ${event.recordId} for duplicates.` },
    webhook: { concurrencyLimit: 1, deliveryId: event.changeId, response: new Response(null, { status: 200 }) },
  }),
})
```

It is sent after admission for an accepted, queued, steered, or duplicate delivery. Busy and error answers keep their own status and body. The queue does not store it, so a restart or retry never resends it.

### Prepare accepted work and run tasks

Keep `invoke` fast: it only accepts a delivery and returns JSON input. Put slow or side-effect work in `prepare`. Name units of work in `tasks`, and select one from `invoke` with `task: name`. A task runs another Agent (`agent`) or a plain function (`run`), not both.

```ts fragment
import { defineChannelTrigger, ignored } from 'vite-hub/agent/channels'
import triage from '../agents/triage'

defineChannelTrigger({
  input: ticketChanged,
  tasks: {
    triage: {
      agent: triage,
      async prepare(context, { input }) {
        const ticket = await fetchTicket(input.data.ticketId)
        if (ticket.closed) return ignored('closed_ticket')
        return { ...input, data: ticket }
      },
    },
    mirror: {
      run: (context, { input }) => mirrorToChat(input.data),
    },
  },
  invoke: (context, event) => ({
    task: event.fromAgent ? 'mirror' : 'triage',
    input: { data: { ticketId: event.ticketId }, prompt: `Triage ticket ${event.ticketId}.` },
    webhook: { deliveryId: event.changeId, serialize: event.ticketId },
  }),
})
```

With the webhook queue, ViteHub stores the task key, the task Agent's name, and the accepted JSON input before `prepare`, then runs `prepare` and the task on every attempt. After a restart, it reads the task from the current Trigger definition without calling `invoke` again. So the input and `run` metadata must be JSON-serializable, a task Agent needs a stable `name`, and an attempt fails when its stored task is gone or now runs another Agent.

A task's own `prepare` replaces the Trigger's, which runs only for results without a task. `prepare` returns new input, nothing to keep the input, or a handled `Response`. In the queue, `ignored()` and other 2xx or 4xx answers, including a `Response` from a task's `run`, settle the delivery without an Invocation. A 5xx answer retries it.

`prepare` and a task's `run` receive `{ input, run, invocation }`. With a run ID, `invocation: { id, consoleUrl? }` is the Invocation the input starts: the task Agent's for a task with `agent`, else the Trigger owner's. Use it to link the Invocation in a progress message before the Agent starts. `consoleUrl` needs a [public URL](/docs/development/integrations-and-output#public-url).

Without the queue, `prepare` and the task run before ViteHub answers the webhook, and a handled `Response` is the answer. Direct calls such as `runAgentTrigger()` also run them.

With `busy: 'steer'`, a delivery that starts a queued Invocation runs `prepare` on each attempt. One that steers an active Invocation sends its input directly and skips `prepare`, so put work every delivery needs in `invoke`. Steering cannot select a named task.

`replayChannel()` and `dispatch()` record items in the replaying Agent's journal, so they reject a task that runs another Agent.

### Run a task later from server code

`enqueueChannelTask()` skips the trigger's `invoke`. To run `invoke` too, with its delivery ID, `serialize`, `debounce`, and Channel State, use [`sendChannelTrigger()`](/docs/channels/server-api#start-a-trigger-from-code) from `vite-hub/channels`, for example to reconcile a webhook that a provider lost.

`enqueueChannelTask()` runs a declared task at `notBefore` or after `delayMs` through the Channel's webhook queue. `prepare`, `failed`, retries, restart replay, and the delivery record work as for a queued webhook delivery. `input` is what `invoke` would return for the task.

Call it from server code in the same persistent Node server as the Agent webhook host, such as an Agent hook, an in-process Schedule, or an API route. On persistent Nitro hosts, enqueue and cancel start the queue when needed, even before its startup timer fires.

> [!NOTE]
> Standalone serverless Schedule and API entries on Netlify or Vercel run in separate processes. They cannot use these APIs.

```ts fragment
import { cancelChannelTask, enqueueChannelTask } from 'vite-hub/agent/server'

const [error, receipt] = await enqueueChannelTask('airtable', 'close-duplicate', { data: { closeId, survivorId } }, {
  notBefore: nextWorkingDay(),
  key: `duplicate-pair:${closeId}:${survivorId}`,
  run: { annotations: { 'airtable.record': closeId } },
})

// Someone objected: drop the queued task.
const [cancelError, cancelled] = await cancelChannelTask('airtable', 'close-duplicate', { key: `duplicate-pair:${closeId}:${survivorId}` })
if (cancelError) throw cancelError
```

A later enqueue with the same `key` replaces a queued task of that Trigger that has not started. `cancelChannelTask()` drops queued tasks with the `key` and returns the count. Started tasks keep running, so check live state in `prepare` and return `ignored()` when work is no longer needed.

Tasks with the same name run one at a time. The Channel needs a declared webhook and a queue-capable state provider, such as SQLite or libSQL. When more than one trigger of the Channel declares the task, pass `trigger`. Both functions return a `Result` from `vite-hub/runtime`: `[error, undefined]` or `[undefined, result]`. The receipt has the queue `deliveryId`, the Invocation `runId` and the `notBefore` time. `error.code` is one of these:

#### CHANNEL_TASK_FAILED

The queue or the Agent State store failed while it queued or cancelled the task. `error.cause` keeps the original error. Retry when the store is available again.

#### CHANNEL_TASK_REJECTED

The call cannot run as written. No trigger declares the task, more than one does and `trigger` is missing, the Channel has no running webhook queue in this process, the `key` is empty, or `notBefore` and `delayMs` are invalid or both set. `error.why` names the problem.

### Report a failed webhook delivery

When a Trigger result sets `webhook: { deliveryId, concurrencyLimit }` and the Agent has a state provider, ViteHub queues the delivery and retries a failed run, with three execution attempts. Add `failed` to tell the provider when retries stop.

- Unset `run.runId` defaults to `deliveryId` and unset `run.channelId` to the Channel, so every retry is the same Invocation.
- A retry moves the Invocation from `failed` back to `pending` and runs the Agent again. The record keeps failed-attempt observations; status, error, and `failedAt` come from the latest attempt.
- Cancelling a failed Invocation that waits for another attempt makes it `cancelled`, and the retry does not dispatch. `cancelled` or `completed` Invocations are never reopened.

```ts fragment
defineChannelTrigger({
  input: ticketOpened,
  invoke: (context, event) => ({
    input: { prompt: `Triage ticket ${event.ticketId}: ${event.summary}` },
    webhook: { concurrencyLimit: 1, deliveryId: event.ticketId },
  }),
  async failed(event) {
    await commentOnTicket(event.run?.runId, `Triage failed: ${event.publicError.error} ${event.invocation?.consoleUrl ?? ''}`)
  },
})
```

ViteHub calls `failed` at most once per delivery: after the last failed attempt, after an execution timeout, or when the process stopped during each attempt and used all execution leases. Not for retried attempts or cancelled Invocations. The event has `attempts`, `deliveryId`, `error`, and `publicError`, plus `input`, `run`, and `invocation: { id, consoleUrl? }` when known. `consoleUrl` needs a [public URL](/docs/development/integrations-and-output#public-url).

A task's own `failed` replaces the Trigger's for that task and gets the same event. A row stored without a task key finds its task through `run.origin` when the origin names a declared task.

```ts fragment
defineChannelTrigger({
  input: ticketChanged,
  tasks: {
    triage: {
      agent: triage,
      failed: event => commentOnTicket(event.run?.runId, 'Triage failed. Edit the ticket to retry.'),
    },
  },
  invoke: (context, event) => ({
    task: 'triage',
    input: { prompt: `Triage ticket ${event.ticketId}.` },
    webhook: { deliveryId: event.changeId, serialize: event.ticketId },
  }),
})
```

The delivery is already failed when `failed` runs. If it throws, ViteHub logs the error without retrying or changing the outcome. Keep it short, because the queue worker waits for it.

With the built-in SQLite state providers, a pending notification survives a restart until a worker claims it. Its `failure.notificationStarted` dispatch marker is permanent, so no other worker reruns the callback after a lease expires. When queue ownership expires, recovery completes the terminal delivery and records the Channel failure without calling `failed` again, even when the first callback paused or its process exited before it recorded completion.

> [!WARNING]
> Queue completion does not prove that the callback finished or that its external effects succeeded. Use `deliveryId` to check uncertain effects with the destination. `webhookDeliveries(scope)` shows the dispatch marker until queue completion. Custom queue adapters without durable notification claims give best-effort, at-most-once dispatch.

## Choose how to call the Agent

| Situation | Use |
| --- | --- |
| A server route already owns validation and input | `runAgent()` or `streamAgent()` |
| A Capability owns history, policy, or event preparation | `runAgentTrigger()` or `streamAgentTrigger()` |
| A messaging provider delivers an event | A [Channel](/docs/agents/channels) and its Trigger |
| A model delegates through a trusted application tool | A Capability tool backed by [`startAgentInvocation()`](/docs/agents/controlled-child-invocations) for control or [`runAgent()`](/docs/agents/invocations) for the result |

Webhook adapters can keep ownership of the request until the delivery finishes. Configure timeout, concurrency, and durable delivery in the Channel, not the Driver.
