---
title: Chat History and sessions
description: Select prior conversation messages without confusing them with durable Agent Memory.
navigation.order: 43
navigation.group: Connect
icon: i-lucide-messages-square
---

Chat History is the ordered set of prior messages eligible for one chat invocation. A Chat Session selects the host-visible conversation boundary. Neither is durable Agent Memory.

| Need | Use |
| --- | --- |
| Continue the visible thread | Thread-backed Chat History |
| Continue a conversation across changing transport threads | A Chat Session |
| Preserve knowledge or preferences across conversations | [Memory Capability](/docs/capabilities/memory) |

## Enable thread history

Configure history on the Chat Capability:

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { chat } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Answer support chat messages.',
  },
  capabilities: [
    chat({
      concurrency: 'queue',
      lockScope: 'thread',
      triggerHistory: {
        maxMessages: 20,
        source: 'thread',
      },
    }),
  ],
})
```

The window limits messages supplied to the next invocation; it does not delete preserved history. Thread scope is the normal choice for Discord threads, Slack threads, Teams conversations, GitHub comment threads, and application-owned support chats.

## Add a session

Use a session when the product has a stable conversation id that is independent of the current provider thread.

```ts [server/agents/support.ts]
import { chat } from '@vite-hub/agent/capabilities'

export const supportChat = chat({
  sessions: {
    idleTimeoutMs: 30 * 60 * 1000,
    metadataKey: 'sessionId',
    strategy: 'hybrid',
  },
  triggerHistory: {
    maxMessages: 20,
    source: 'thread',
  },
})
```

Use `strategy: 'manual'` when a trusted host passes explicit session ids, `idle-timeout` when inactivity should start a conversation, or `hybrid` for both. The `chat.message` input selects a manual session with `session: { action: 'switch', id }`.

The authenticated route or Channel should supply that id. Do not accept an arbitrary session id from an untrusted request, because that can expose another conversation's history.

## Partition transcripts

Keep transcript keys aligned with the product boundary. Use thread keys when each platform thread is independent; include Channel or tenant identity when ids can collide across providers.

History selection and persistence are separate decisions. The Chat Capability can select a bounded window, but the configured store owns durability, ordering, retention, and deletion. Without a persistent store, process-local history disappears with the process.

## Inspect the result

Run two messages through the same thread or session, then inspect the second invocation in the [CLI](/docs/development/cli). The prepared input should contain the bounded prior messages plus the current message. A different thread or session should start without that history.
