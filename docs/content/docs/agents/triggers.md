---
title: Triggers
description: Translate product events into Agent Invocations while the Driver continues to own execution.
navigation.order: 41
navigation.group: Connect
icon: i-lucide-route
---

A Trigger turns an event into Agent Invocation input. Use a Trigger when a
Capability or a Channel owns the shape of the event and the policy for it. For
example, the Chat Capability owns `chat.message`. It selects history, sessions,
and concurrency before the Driver runs. The Trigger prepares input only. The
Agent Driver still runs the Invocation.

Do not add a Trigger when your own route already validates the input. Call
`runAgent()` or `streamAgent()` directly. See
[Invocations](/docs/agents/invocations).

## Choose how to call the Agent

| Situation | Use |
| --- | --- |
| A server route already owns validation and input. | `runAgent()` or `streamAgent()` |
| A Capability owns history, policy, or event preparation. | `runAgentTrigger()` or `streamAgentTrigger()` |
| A messaging provider delivers an event. | A [Channel](/docs/agents/channels) and its Trigger |
| Your application receives its own webhook events. | An application-owned Channel with `defineChannelTrigger()` |
| A model delegates through a trusted application tool. | A Capability tool backed by [`startAgentInvocation()`](/docs/agents/controlled-child-invocations) or `runAgent()` |

## Use a Capability Trigger

Attach the Capability that registers the Trigger. `chat()` registers
`chat.message`:

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

Call the Trigger from a server-owned route:

```ts [server/api/support-chat.post.ts]
import { streamAgentTrigger } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime/h3'
import support from '../agents/support'
import { loadAuthorizedSupportThreadMessages } from '../support-history'

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
      context: {
        invoker: {
          id: user.id,
          kind: 'customer',
        },
      },
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

The route must do three things before it calls the Trigger:

1. Authenticate the caller, then pass the Actor, the session selection, and
   any trusted metadata.
2. Reject a thread that the caller does not own.
3. Load the ordered messages of the thread and add the new message.

`triggerHistory` limits the messages that you supply. It does not load
messages from `threadId` or from a session id. See
[Chat History and sessions](/docs/agents/chat-history-sessions).

`run` holds origin and trace metadata. It is not chat context.

This streaming route needs a host lifetime API that stays active until the
caller consumes or cancels the stream. A `flushWaitUntil()` call before you
return the stream does not cover work that starts later. See
[Runtime Context](/docs/concepts/runtime-context#background-work-and-cleanup).

## Add an application-owned Trigger

Use `defineChannel()` from `vite-hub/agent/channels` when an application-owned
Channel Kind prepares its own event, such as a ticketing system. This is not
the outbound [`defineOutboundChannel()`](/docs/server-primitives/channels) from
`vite-hub/channels`, which sends messages and does not start an Agent.

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

`defineChannelTrigger()` infers the type of `event` from any
[Standard Schema](https://standardschema.dev/). ViteHub validates the input and
applies schema transforms before `invoke()` runs. For a webhook, ViteHub checks
the signature first. Invalid webhook input gets a generic
`400 invalid_payload` response that does not show schema details.

The Trigger translates the validated event and attaches trusted context. Keep
the model, tools, and execution behavior in the Agent Definition.

When the Channel declares message methods, also return `message`. This is JSON
data that identifies the provider message. Hooks read it through
`event.message`. See
[Act on the Channel message in hooks](/docs/agents/channels#act-on-the-channel-message-in-hooks).

### Verify webhook signatures

Add `webhooks` to the Channel to receive the Trigger over HTTP. `secretHeader`
names the header that carries the signature. `secretToken` supplies the shared
secret. `signature` selects how ViteHub checks the header:

| `signature` | Header format |
| --- | --- |
| Not set | The header equals `secretToken`. |
| `'github-sha256'` | `sha256=<hex HMAC-SHA256 of the raw body>` |
| `'stripe-sha256'` | `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. Any matching `v1` passes, with at most 32 candidates per header. The maximum timestamp age is 300 integer seconds. Future timestamps pass the age check. |
| `{ preset: 'stripe-sha256', toleranceSeconds }` | The same format with another maximum age in seconds. The tolerance must be finite and non-negative. With `0`, current-second and future timestamps pass. Older timestamps fail. |
| `{ verify({ header, rawBody, request, secret }) }` | Your function returns `true` for a valid delivery. |

```ts [server/agents/support.ts]
const ticketing = defineChannel('ticketing', {
  messages: false,
  triggers: { /* ... */ },
  webhooks: {
    path: '/api/ticketing/webhook',
    secretHeader: 'Ticketing-Signature',
    secretToken: () => process.env.TICKETING_WEBHOOK_SECRET,
    signature: 'stripe-sha256',
  },
})
```

ViteHub compares signatures in constant time. A failed check returns `401`
before the Trigger runs. `vitehub channels history` signs its requests for
`'github-sha256'`, `'stripe-sha256'`, and the plain header check.

A webhook adapter can keep ownership of a delivery until it finishes.
Configure timeout, concurrency, and durable delivery on the Channel. Do not add
webhook policy to the Driver.
