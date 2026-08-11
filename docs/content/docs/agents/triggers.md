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
import { runAgent } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const { prompt } = await readBody<{ prompt: string }>(event)
  return runAgent(support, { runtime: 'unknown' }, { prompt })
})
```

This is a direct consumer, not a registered Trigger. Prefer it for ordinary authenticated server routes and scheduled application code.

## Use a Capability Trigger

Use a Trigger when a Capability owns event preparation. The Chat Capability registers `chat.message` and can apply history, session, concurrency, and delivery behavior before the Driver runs.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { chat } from '@vite-hub/agent/capabilities'

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
import { streamAgentTrigger } from '@vite-hub/agent'
import support from '../agents/support'
import { loadSupportThreadMessages } from '../support-history'

export default defineEventHandler(async (event) => {
  const { text, threadId } = await readBody<{
    text: string
    threadId?: string
  }>(event)
  const runId = crypto.randomUUID()
  const messages = await loadSupportThreadMessages(threadId)
  messages.push({
    id: runId,
    role: 'user',
    parts: [{ type: 'text', text }],
  })

  return streamAgentTrigger(
    support,
    { runtime: 'unknown' },
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

`run` contains origin and trace metadata; it is not chat context. Authenticate before passing Actor identity, session selection, or trusted metadata into the Trigger input.

Direct Trigger consumers must load and supply the current thread's ordered messages, including the new message. `triggerHistory` limits that input; it does not backfill messages from `threadId` or a session id.

## Add an application-owned Trigger

Use `defineChannel()` when an application-owned Channel Kind should prepare its own event.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { defineChannel } from '@vite-hub/agent/channels'

const ticketing = defineChannel('ticketing', {
  messages: false,
  triggers: {
    'ticket.opened': {
      invoke(context, event: { ticketId: string, summary: string }) {
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
    },
  },
})

export default defineAgent({
  channels: { ticketing },
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

The Trigger should translate the event and attach trusted context. Keep model selection, tools, and execution behavior in the Agent Definition.

## Choose the boundary

| Situation | Use |
| --- | --- |
| A server route already owns validation and input | `runAgent()` or `streamAgent()` |
| A Capability owns history, policy, or event preparation | `runAgentTrigger()` or `streamAgentTrigger()` |
| A messaging provider delivers an event | A [Channel](/docs/agents/channels) and its Trigger |
| A model should delegate to another Agent | [Subagents Capability](/docs/capabilities/subagents) |

Webhook adapters may retain ownership until delivery finishes. Configure Channel timeout, concurrency, and durable delivery there rather than adding webhook policy to the Driver.
