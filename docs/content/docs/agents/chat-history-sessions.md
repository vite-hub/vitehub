---
title: Chat History and sessions
description: Select prior conversation messages without confusing them with durable Agent Memory.
navigation.order: 43
navigation.group: Connect
icon: i-lucide-messages-square
---

Chat History is the ordered list of earlier messages that one chat Invocation
can see. A Chat Session marks where one conversation starts and ends. Use them
when the Agent must continue a conversation. Neither one is durable Agent
Memory.

By default, ViteHub sends only the current message to the Agent. Set
`triggerHistory` on the Chat Capability to send a bounded window of earlier
messages. A Channel adapter's `threadHistory` setting controls backfill and
caching only. It does not select model input.

| Need | Use |
| --- | --- |
| Continue the visible thread | Thread-backed Chat History |
| Continue a conversation when the transport thread changes | A Chat Session |
| Keep knowledge or preferences across conversations | [Memory Capability](/docs/capabilities/memory) |

## Enable thread history

Configure history on the Chat Capability:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { chat } from 'vite-hub/agent/capabilities'

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
        maxAgeMs: 30 * 60 * 1000,
        maxMessages: 20,
        source: 'thread',
      },
    }),
  ],
})
```

The window limits the messages that the next Invocation receives. It does not
delete stored history.

- `maxMessages` includes the current message.
- `maxAgeMs` is optional. It removes older messages, measured from the current
  message. A message without a timestamp starts a new window.

Thread scope is the usual choice for Discord threads, Slack threads, Teams
conversations, GitHub comment threads, and support chats in your application.

Adapter-backed Channels load thread history themselves. A route that calls
`runAgentTrigger()` or `streamAgentTrigger()` must supply the ordered messages
of the current thread, including the new message. `triggerHistory` only limits
that array. It does not load messages from `threadId` or from a session id. See
[Consume a Capability Trigger](/docs/agents/triggers#consume-a-capability-trigger).

## Add a session

Use a session when the product has a stable conversation id that does not
depend on the current provider thread.

```ts [server/agents/support.ts]
import { chat } from 'vite-hub/agent/capabilities'

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

| `strategy` | A new session starts when |
| --- | --- |
| `'manual'` | A trusted host passes a new session id. `sessions: true` selects this strategy. |
| `'idle-timeout'` | The conversation is inactive for `idleTimeoutMs`. |
| `'hybrid'` | Either of the two happens. |

Without `strategy`, ViteHub uses `'idle-timeout'` when `idleTimeoutMs` is set,
and `'manual'` otherwise.

ViteHub reads the session id of each message from its metadata, at
`metadataKey`. The `chat.message` input can also select a session:
`session: { action: 'switch', id }` switches to a session, and
`session: { action: 'new' }` starts one with only the current message.

The authenticated route or Channel supplies the session id. Do not accept a
session id from an untrusted request. It can expose the history of another
conversation.

## Partition transcripts

Align transcript keys with the product boundary. Use thread keys when each
platform thread is independent. Include the Channel or tenant identity when ids
can be the same across providers.

History selection and storage are separate. The Chat Capability selects a
bounded window. The configured Agent State store owns durability, order,
retention, and deletion.

| Host output | Default Agent State |
| --- | --- |
| Cloudflare | The generated Durable Object binding, also for Channel handlers that generated Workflows invoke. An explicit state provider still wins. A state configuration with only `url` keeps automatic libSQL selection. |
| Other production output | None. Set a durable `VITEHUB_AGENT_STATE_URL` or an explicit Agent State provider URL before stateful traffic. |

Cloudflare, Vercel, and Netlify production output reject `file:` URLs because
their compute filesystems are temporary.

## Keep SQLite transcripts

Pass `transcripts: { retention: 'forever' }` to `createLibsqlAgentState()` from
`vite-hub/agent/state/sqlite`. The adapter then clears transcript expiry during
startup cleanup, including rows that already expired, and ignores later
transcript TTLs. Other cached state keeps its normal expiry. ViteHub cannot
recover rows that it deleted before you enabled this option.

## Inspect the result

Send two messages through the same thread or session. Then inspect the second
Invocation with the [CLI](/docs/development/cli). The prepared input contains
the bounded earlier messages and the current message. A different thread or
session starts without that history.
