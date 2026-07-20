---
title: Triggers
description: Start Agent Invocations from product events without mixing trigger behavior into Agent Drivers.
navigation.order: 26
icon: i-lucide-route
---

An Agent Trigger is server-side behavior that starts an Agent Invocation for a specific product event. Triggers prepare input, run metadata, and context values; the Agent Driver still owns execution.

Triggers are not Channels, Chat Platform Adapters, or model adapters. A trigger may receive message-shaped input, but message input is not required for every trigger.

## Use a route for direct invocation

An app route can call `runAgent` directly when no Capability owns the event shape.

```ts [server/api/support.post.ts]
import { runAgent } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt: string }>(event)

  return runAgent(support, { runtime: 'unknown' }, {
    prompt: body.prompt,
  })
})
```

This route is a direct Agent Invocation consumer. It does not register an Agent Trigger.

## Use Capability-owned triggers

Capabilities can register Agent Trigger behavior when an ability owns a product event. The Chat Capability registers `chat.message`.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { chat } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: 'Answer support messages.',
  },
  capabilities: [
    chat({
      sessions: true,
      threadHistory: { maxMessages: 20 },
    }),
  ],
})
```

The Chat Capability owns Chat History behavior and the `chat.message` trigger. Message-shaped Channels own delivery and webhook admission; the Agent Definition still owns the active Agent Driver.

## Consume a trigger from an app route

Application routes can consume a resolved trigger when the app owns authentication, request validation, or UI-specific delivery.

```ts [server/api/support-chat.post.ts]
import { streamAgentTrigger } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ text: string }>(event)
  const user = await requireAuthenticatedUser(event)
  const runId = crypto.randomUUID()

  return streamAgentTrigger(support, { runtime: 'unknown' }, 'chat.message', {
    invoker: {
      id: user.id,
      kind: 'customer',
      meta: { customer: user.customer },
    },
    messages: [{
      id: runId,
      parts: [{ text: body.text, type: 'text' }],
      role: 'user',
    }],
    run: { origin: 'portal', runId },
  }, {
    output: 'ui-message-stream',
  })
})
```

The route is an Agent Trigger Consumer. It does not declare Chat Capability behavior itself. The `run` field is invocation provenance; Chat context stays focused on message, session, user, and chat-scoped metadata.

## Add app-owned Channel triggers

Use a custom Channel for app-owned product events that need a named trigger but have not earned a more specific Channel Kind.

```ts [server/agents/tickets.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { defineChannel } from '@vite-hub/agent/channels'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: 'Triage incoming tickets.',
  },
  channels: {
    tickets: defineChannel('tickets', {
      messages: false,
      triggers: {
        created: {
          invoke(context, ticket: { id: string, title: string }) {
            return {
              input: {
                prompt: `Triage ticket ${ticket.id}: ${ticket.title}`,
              },
              run: {
                channelId: context.trigger.channelId,
                origin: 'tickets',
                runId: ticket.id,
              },
            }
          },
        },
      },
    }),
  },
})
```

Create a custom Capability when the event has reusable product behavior, requirements, tools, or policy. Keep one-off app route logic in the app, and keep app-owned reachability on Channels.

## Own webhook delivery execution

A Channel trigger can ask the generated webhook route to claim a provider delivery before starting the Agent Driver. Add a stable provider delivery ID to the trigger result to make repeated deliveries idempotent. Add a concurrency key when only one matching execution may run at a time.

```ts [server/agents/review.ts]
invoke(context, event: { deliveryId: string, pullRequest: number, head: string }) {
  return {
    input: { prompt: `Review pull request #${event.pullRequest}` },
    webhook: {
      deliveryId: event.deliveryId,
      concurrencyKey: `pull-request:${event.pullRequest}:${event.head}`,
    },
  }
}
```

Delivery claims are durable and do not expire. A duplicate delivery does not start another Agent Invocation. Concurrency leases default to 30 seconds and heartbeat for the lifetime of inline execution, so a dead owner releases work promptly; set `concurrencyTtlMs` when an integration needs a different recovery window. A busy delivery remains unclaimed so the provider can retry it. Webhook ownership requires durable Agent State, and concurrency ownership rejects execution that would be queued to a Workflow because the route cannot retain that lease across the Workflow boundary.

## Next steps

- Read [Channels](/docs/agents/channels) to keep delivery separate from identity.
- Read [Invocations](/docs/agents/invocations) for trigger runtime helpers.
- Read [Capabilities](/docs/capabilities) for `chat()`, `inputCommands()`, and `schedule()`.
