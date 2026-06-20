---
title: Channels
description: Keep message origins, delivery facts, Agent Invokers, and input commands separate.
navigation.order: 25
icon: i-lucide-radio
---

A Channel names where an Agent Invocation came from and how message-shaped events move through the system. Channels carry origin, event, delivery, thread, and message facts; they do not carry trusted caller identity by themselves.

Use Channels for reachability and delivery. Use Agent Invokers for identity, and use input commands for explicit user-authored command handling.

## Boundary map

| Boundary | Owns | Does not own |
| --- | --- | --- |
| Channel | Origin, event, delivery, thread, and message metadata. | Trusted identity, access decisions, command rewriting. |
| Agent Invoker | Trusted caller identity for one Agent Invocation. | Transport delivery, webhook shape, UI session state. |
| Input Command | User-authored command parsing and input rewriting before the Agent Driver runs. | Channel verification, delivery, caller identity. |

This split keeps shared channels from becoming implicit access roles. A Teams channel, GitHub comment, or app chat thread can reach an Agent without proving who the trusted caller is.

## Message-shaped input

Chat and channel surfaces usually start Agents with `messages`. The Chat Capability registers the `chat.message` Agent Trigger and translates UI-message-like input into Agent messages.

```ts [server/api/support-chat.post.ts]
import { streamAgentTrigger } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ text: string, threadId?: string }>(event)
  const runId = crypto.randomUUID()

  return streamAgentTrigger(support, { runtime: 'unknown' }, 'chat.message', {
    messages: [{
      id: runId,
      parts: [{ text: body.text, type: 'text' }],
      role: 'user',
    }],
    run: {
      channelId: 'portal-support',
      messageId: runId,
      origin: 'portal',
      runId,
      threadId: body.threadId,
    },
  })
})
```

The `run` fields are Agent Run State and observability metadata. They help DevTools, traces, and finish hooks explain where the invocation came from.

## Add identity separately

When the channel handler authenticates a user, pass that identity as the Agent Invoker. The Agent and Capabilities then read `context.invoker` instead of inferring identity from the channel.

```ts [server/api/support-chat.post.ts]
return streamAgentTrigger(support, { runtime: 'unknown' }, 'chat.message', {
  messages,
  invoker: {
    id: user.id,
    kind: 'customer',
    label: user.email,
    meta: { customer: user.customer },
  },
  run,
})
```

Validate the channel request before passing the Agent Invoker. ViteHub trusts invokers supplied by server-owned Agent Trigger Consumers.

## Keep commands in Capabilities

Input Commands are Capability behavior. A channel can deliver `/summary`, but `inputCommands()` should own command admission, rewriting, and command-specific trust.

Link command docs and command examples to [Capabilities](/docs/capabilities), not to channel configuration.

## Next steps

- Read [Triggers](/docs/agents/triggers) for `chat.message` and app-owned trigger consumers.
- Read [Invokers](/docs/agents/invokers) for trusted identity.
- Read [Chat History and sessions](/docs/agents/chat-history-sessions) for conversation boundaries.
