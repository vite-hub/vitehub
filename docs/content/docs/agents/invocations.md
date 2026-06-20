---
title: Invocations
description: Run, stream, and inspect one Agent Invocation.
navigation.order: 23
icon: i-lucide-play-circle
---

An Agent Invocation is one runtime request to an Agent. It receives input, resolves the Agent Invoker, applies Capabilities, runs the selected Agent Driver, records lifecycle state, and returns or streams output.

Invoke Agents from server code, Agent Triggers, schedules, DevTools, or framework-owned routes. The invocation input carries prompt or message content plus trusted context values.

## Run an Agent

Use `runAgent` when the caller expects a final result. Pass host runtime context separately from invocation input.

```ts [server/api/support.post.ts]
import { runAgent } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt: string }>(event)
  const user = await requireAuthenticatedUser(event)

  return runAgent(support, { runtime: 'unknown' }, {
    prompt: body.prompt,
    context: {
      invoker: {
        id: user.id,
        kind: 'customer',
        label: user.email,
        meta: { customer: user.customer },
      },
    },
  })
})
```

The `context.invoker` input is trusted server data. Validate the request before passing identity or access facts into ViteHub.

## Stream an Agent

Use `streamAgent` when a UI or channel should receive incremental output. The same Agent Driver and Capability boundaries apply.

```ts [server/api/support-stream.post.ts]
import { streamAgent } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt: string }>(event)

  return streamAgent(support, { runtime: 'unknown' }, {
    prompt: body.prompt,
  }, {
    output: 'ui-message-stream',
  })
})
```

Use `output: 'events'` when an internal caller wants ViteHub stream events. Use `output: 'ui-message-stream'` when a chat UI expects UI message stream chunks.

## Invoke a trigger

Use `runAgentTrigger` or `streamAgentTrigger` when a Capability owns the product event shape. The trigger prepares Agent Invocation input, metadata, and run state before the Agent Driver starts.

```ts [server/api/support-chat.post.ts]
import { streamAgentTrigger } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ text: string }>(event)
  const runId = crypto.randomUUID()

  return streamAgentTrigger(support, { runtime: 'unknown' }, 'chat.message', {
    messages: [{
      id: runId,
      parts: [{ text: body.text, type: 'text' }],
      role: 'user',
    }],
    run: {
      channelId: 'support-web',
      messageId: runId,
      origin: 'portal',
      runId,
    },
  }, {
    output: 'ui-message-stream',
  })
})
```

Agent Trigger Consumers call the trigger surface. They do not own the Capability behavior that registered the trigger.

## Finish lifecycle

Use an Agent Finish Hook to observe the completed invocation. Finish hooks are appropriate for usage export, trace collection, cleanup, or product-side notifications.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: 'Answer support requests.',
  },
  hooks: {
    'agent:finish'(event) {
      event.runtime.waitUntil(recordUsage(event))
    },
  },
})
```

Finish hooks should not quietly grant new abilities. Capabilities and Agent Drivers remain the authority boundaries.

## Next steps

- Read [Triggers](/docs/agents/triggers) for Capability-owned entry points.
- Read [Invokers](/docs/agents/invokers) for trusted caller identity.
- Read [DevTools](/docs/agents/devtools) to inspect Agent Invocation state.
