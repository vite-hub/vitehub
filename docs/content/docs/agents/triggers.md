---
title: Triggers
description: Start Agent Invocations from server routes, chat surfaces, schedules, or product events.
navigation.order: 24
icon: i-lucide-route
---

An Agent Trigger is server-side behavior that starts an Agent Invocation for a specific event.

Triggers do not configure model execution. They are not chat platform adapters. They prepare input, context, and run state, then start the Agent.

## Route trigger

The simplest trigger is an application route.

```ts [server/api/support.post.ts]
import { runAgent } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  return runAgent(support, { runtime: 'unknown' }, await readBody(event))
})
```

## Capability-owned trigger

Some Capabilities own product event behavior. Chat is the clearest example: a chat platform event is adapted into an Agent Invocation through the Chat Capability.

```ts
import { chat } from '@vite-hub/agent/capabilities'

const supportChat = chat({
  history: { maxMessages: 20 },
})

export default defineAgent({
  capabilities: [
    supportChat,
  ],
  instructions,
  model,
})
```

The Chat Capability can own webhook autowiring, default Agent Invoker identity, and Chat History behavior. The Agent still owns the model-backed invocation.

Trusted chat surfaces can pass an explicit Agent Invoker through the trigger input `invoker` field. Use this when the route has already authenticated the caller and resolved product-specific scope such as customer, tenant, or staff access.

The trigger input `meta` field is preserved as `chat.meta`. When the Chat Capability derives a default invoker from `user`, ViteHub also includes that metadata in the default invoker. When an explicit `invoker` is provided, keep caller facts on `invoker.meta` and keep chat-only payload on `meta`.

Application routes can still consume the `chat.message` trigger directly. Keep auth, rate limits, and trusted metadata derivation in the route before ViteHub runs the trigger.

```ts [server/api/support-chat.post.ts]
import { runAgentTrigger } from '@vite-hub/agent'
import { readBody } from 'h3'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ activePage?: string, text: string }>(event)
  const authenticatedUser = await requireAuthenticatedUser(event)
  const messageId = crypto.randomUUID()

  return runAgentTrigger(support, { runtime: 'unknown' }, 'chat.message', {
    invoker: {
      id: `portal:${authenticatedUser.customer}:${authenticatedUser.id}`,
      kind: 'customerPortal',
      meta: {
        customer: authenticatedUser.customer,
        email: authenticatedUser.email,
      },
    },
    messages: [{
      id: messageId,
      parts: [{ text: body.text, type: 'text' }],
      role: 'user',
    }],
    meta: {
      activePage: body.activePage,
    },
    run: { origin: 'portal', runId: messageId },
    user: { email: authenticatedUser.email },
  })
})
```

## Schedule trigger

Schedule can start an Agent Invocation, but Schedule is not itself an Agent Capability.

Use Schedule when runtime time is the reason the Agent runs. Use a Capability Trigger when the event belongs to an agent ability.
