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
      history: { maxMessages: 20, source: 'thread' },
      sessions: true,
    }),
  ],
})
```

The Chat Capability owns Chat History behavior, optional Chat Platform Adapter webhooks, and the `chat.message` trigger. The Agent Definition still owns the active Agent Driver.

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

## Add app-owned event triggers

Use the Entry Capability for app-owned product events that need a named trigger but have not earned a more specific Capability.

```ts [server/agents/tickets.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { entry } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: 'Triage incoming tickets.',
  },
  capabilities: [
    entry({
      id: 'tickets',
      triggers: {
        created: {
          invoke(_context, ticket: { id: string, title: string }) {
            return {
              input: {
                prompt: `Triage ticket ${ticket.id}: ${ticket.title}`,
              },
              run: {
                origin: 'tickets',
                runId: ticket.id,
              },
            }
          },
        },
      },
    }),
  ],
})
```

Create a custom Capability when the event has reusable product behavior, requirements, tools, or policy. Keep one-off app route logic in the app.

## Next steps

- Read [Channels](/docs/agents/channels) to keep delivery separate from identity.
- Read [Invocations](/docs/agents/invocations) for trigger runtime helpers.
- Read [Capabilities](/docs/capabilities) for `chat()`, `entry()`, and `schedule()`.
