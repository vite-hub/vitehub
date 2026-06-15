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

## Schedule trigger

Schedule can start an Agent Invocation, but Schedule is not itself an Agent Capability.

Use Schedule when runtime time is the reason the Agent runs. Use a Capability Trigger when the event belongs to an agent ability.
