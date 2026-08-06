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
      concurrencyGroup: 'pull-requests',
      concurrencyKey: `pull-request:${event.pullRequest}`,
      concurrencyLimit: 2,
      busy: 'steer',
    },
  }
}
```

Setting `concurrencyLimit` persists each delivery before returning from the webhook route. Eligible deliveries run in FIFO order within their webhook state scope, while the group limit caps total active work and the concurrency key excludes matching work. Group names and limits should remain stable across deliveries. The generated server resumes queued work on startup, so a new webhook is not required after a process restart.

Setting `busy: 'steer'` first offers the full Agent input to an active inline Harness invocation with the same scoped concurrency key in the current server process. An accepted input remains durably reserved by delivery ID until that invocation succeeds. When the active invocation is on another process, or no matching prompt control accepts the input, the delivery follows the same durable queue path.

Queue leases default to 30 seconds and heartbeat while the Agent runs. A dead owner releases its delivery for retry; set `concurrencyTtlMs` when an integration needs a different recovery window. Delivery IDs remain durable after completion, so duplicates do not start another Agent Invocation. Completed delivery records are retained indefinitely: budget database storage for delivery history and use a separate state database when an integration requires its own retention lifecycle.

Without `concurrencyLimit`, the route keeps the inline ownership path: `concurrencyKey` prevents matching work from running concurrently, and a busy delivery remains unclaimed so the provider can retry it. Both paths require durable Agent State and reject execution that would be queued to a Workflow because the route cannot retain ownership across that boundary. Persistent concurrency additionally requires a queue-capable SQLite or libSQL Agent State provider.

## Next steps

- Read [Channels](/docs/agents/channels) to keep delivery separate from identity.
- Read [Invocations](/docs/agents/invocations) for trigger runtime helpers.
- Read [Capabilities](/docs/capabilities) for `chat()`, `inputCommands()`, and `schedule()`.
