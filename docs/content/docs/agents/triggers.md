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
import { chat, entry } from '@vite-hub/agent/capabilities'

const supportChat = chat({
  history: { maxMessages: 20 },
})

export default defineAgent({
  capabilities: [
    supportChat,
    entry({
      id: 'portal',
      chat: { capability: supportChat, origin: 'portal' },
    }),
  ],
  instructions,
  model,
})
```

The Chat Capability can own webhook autowiring, Agent Invoker identity, and Chat History behavior. The Agent still owns the model-backed invocation.

Trusted chat surfaces can pass app-owned metadata through the trigger input `meta` field. ViteHub preserves that payload as `chat.meta` and includes it in the default chat invoker metadata when the trigger derives identity from chat user data, so Access, Rate Limit, and instruction callbacks can share fields such as `email` or `customer` without a custom context helper.

Generated Chat App Route request bodies are client-controlled unless the host authenticates them first. When email affects access or rate limits, populate `user` and `meta` from server-owned auth state, not from untrusted browser input.

```ts [server/api/support-chat.post.ts]
import { runAgentChatRoute, validateAgentChatRouteBody } from '@vite-hub/agent/server'
import { readValidatedBody } from 'h3'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const request = event.req.clone()
  const body = await readValidatedBody(event, validateAgentChatRouteBody)
  const authenticatedUser = await requireAuthenticatedUser(event)

  return runAgentChatRoute(support, {
    ...body,
    user: { email: authenticatedUser.email },
    meta: {
      customer: authenticatedUser.customer,
      email: authenticatedUser.email,
    },
    run: { ...body.run, origin: 'portal' },
  }, {
    request,
  })
})
```

`validateAgentChatRouteBody` validates the Chat App Route transport body. Keep auth, rate limits, and trusted metadata derivation in the route before ViteHub runs the `chat.message` trigger.

## Schedule trigger

Schedule can start an Agent Invocation, but Schedule is not itself an Agent Capability.

Use Schedule when runtime time is the reason the Agent runs. Use a Capability Trigger when the event belongs to an agent ability.
