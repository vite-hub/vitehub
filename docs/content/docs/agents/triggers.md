---
title: Triggers
description: Translate product events into Agent Invocations while the Driver continues to own execution.
navigation.order: 41
navigation.group: Connect
icon: i-lucide-route
---

A Trigger turns a product event into Agent Invocation input. Use it when a Capability owns the event's shape or policy. The Agent Driver still owns execution.

## Call an Agent directly

An application route can call `runAgent()` when no Capability needs to prepare the event.

```ts [server/api/support.post.ts]
import { runAgent } from 'vite-hub/agent'
import support from '../agents/support'
import { getRuntimeContext } from 'vite-hub/runtime/h3'

export default defineEventHandler(async (event) => {
  const { prompt } = await readBody<{ prompt: string }>(event)
  const runtime = getRuntimeContext(event)
  try {
    return await runAgent(support, runtime, { prompt })
  }
  finally {
    await runtime.flushWaitUntil().catch(console.error)
  }
})
```

Use this direct call for ordinary authenticated server routes and scheduled application code. Without a host lifetime API, drain tracked work before returning. The example reports background failures without replacing the Agent result or error.

## Use a Capability Trigger

Use a Trigger when a Capability owns event preparation. The Chat Capability registers `chat.message` and can apply history, session, concurrency, and delivery behavior before the Driver runs.

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

Call the trigger from a server-owned route:

```ts [server/api/support-chat.post.ts]
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

This streaming route requires a host lifetime API that stays active until the stream is consumed or cancelled. Calling `flushWaitUntil()` before returning the stream does not cover work scheduled later. See [Runtime Context](/docs/reference/runtime-context#background-work-and-cleanup) for host lifetime ownership.

`run` contains origin and trace metadata; it is not chat context. Authenticate before passing Actor identity, session selection, or trusted metadata into the Trigger input.

Direct Trigger consumers must authenticate first, reject threads the caller does not own, then load and supply the current thread's ordered messages, including the new message. `triggerHistory` limits that input; it does not backfill messages from `threadId` or a session id.

## Add an application-owned Trigger

Use `defineChannel()` when an application-owned Channel Kind prepares its own event.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { defineChannel, defineChannelTrigger } from 'vite-hub/agent/channels'
import * as v from 'valibot'

const ticketOpened = v.object({
  ticketId: v.string(),
  summary: v.pipe(v.string(), v.trim(), v.minLength(1)),
})

const ticketing = defineChannel('ticketing', {
  messages: false,
  triggers: {
    'ticket.opened': defineChannelTrigger({
      input: ticketOpened,
      invoke(context, event) {
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

export default defineAgent({
  channels: { ticketing },
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

`defineChannelTrigger()` infers `event` from any [Standard Schema](https://standardschema.dev/) implementation. ViteHub validates and applies schema transforms before `invoke()`. Webhook authentication runs first, and invalid webhook input receives a generic `400 invalid_payload` response without exposing schema details.

The Trigger translates the validated event and attaches trusted context. Keep model selection, tools, and execution behavior in the Agent Definition.

When the Channel declares message methods, also return `message`: JSON data that identifies the provider message. Hooks use it through `event.message`. See [Act on the Channel message in hooks](/docs/agents/channels#act-on-the-channel-message-in-hooks).

### Report a failed webhook delivery

When a Trigger result sets `webhook: { deliveryId, concurrencyLimit }` and the Agent has a state provider, ViteHub queues the webhook delivery and retries a failed execution. A delivery gets three execution attempts. Add `failed` to the Trigger to report the failure to the provider when the queue stops retrying.

```ts
defineChannelTrigger({
  input: ticketOpened,
  invoke: (context, event) => ({
    input: { prompt: `Triage ticket ${event.ticketId}: ${event.summary}` },
    run: { runId: event.ticketId },
    webhook: { concurrencyLimit: 1, deliveryId: event.ticketId },
  }),
  async failed(event) {
    await commentOnTicket(event.run?.runId, `Triage failed: ${event.publicError.error} ${event.invocation?.consoleUrl ?? ''}`)
  },
})
```

ViteHub dispatches `failed` at most once per delivery: after the last failed attempt, after an execution timeout, or when the delivery used all its execution leases because the process stopped during each attempt. It does not call `failed` for an attempt that the queue retries, or for a cancelled Invocation. The event has `attempts`, `deliveryId`, `error`, `publicError`, and, when they are known, `input`, `run`, and `invocation: { id, consoleUrl? }`. `consoleUrl` needs a [public URL](/docs/development/integrations-and-output#public-url).

The delivery is already marked as failed when `failed` runs. ViteHub logs an error from `failed` and does not retry the delivery or change its outcome. Keep the callback short, because the queue worker waits for it.

With the built-in SQLite state providers, a pending notification survives a restart until a worker claims it. Its `failure.notificationStarted` dispatch marker is permanent, so another worker cannot repeat the callback after a lease expires. Queue ownership still expires: recovery completes the terminal delivery and records the channel failure without replaying `failed`, even if the original callback is paused or its process exited before recording completion. Queue completion therefore does not prove that the callback finished or that its external effects succeeded. Reconcile uncertain effects with the destination using `deliveryId`. `webhookDeliveries(scope)` exposes the dispatch marker until queue completion. Custom queue adapters without durable notification claims provide best-effort, at-most-once dispatch.

## Choose how to call the Agent

| Situation | Use |
| --- | --- |
| A server route already owns validation and input | `runAgent()` or `streamAgent()` |
| A Capability owns history, policy, or event preparation | `runAgentTrigger()` or `streamAgentTrigger()` |
| A messaging provider delivers an event | A [Channel](/docs/agents/channels) and its Trigger |
| A model delegates through a trusted application tool | A Capability tool backed by [`startAgentInvocation()`](/docs/agents/controlled-child-invocations) for control or [`runAgent()`](/docs/agents/invocations), handling its runtime-specific return value |

Webhook adapters may retain ownership until delivery finishes. Configure Channel timeout, concurrency, and durable delivery there rather than adding webhook policy to the Driver.
