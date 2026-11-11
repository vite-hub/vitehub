---
title: Chat History and sessions
description: Choose which earlier chat messages an Agent sees, and how this differs from Memory.
navigation.order: 30
navigation.group: History and context
icon: i-lucide-messages-square
navigation.kind: Guides
---

Chat History is the earlier messages one chat Invocation can see, in order. A
Chat Session marks where one conversation starts and ends. Use them so the
Agent can continue a conversation. Neither one is lasting Agent Memory.

By default, the Agent gets only the current message. Set `triggerHistory` on
the Chat Capability to send a limited window of earlier messages. A Channel
adapter's `threadHistory` only controls backfill and caching, not model input.

| Need | Use |
| --- | --- |
| Continue the visible thread | Thread-backed Chat History |
| Continue a conversation when the transport thread changes | A Chat Session |
| Keep knowledge or preferences across conversations | [Memory Capability](/docs/agents/capabilities/memory) |

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

The window limits what the next Invocation gets. It does not delete stored
history.

- `maxMessages` includes the current message.
- `maxAgeMs` is optional. It drops messages older than this, counted from the
  current message. A message without a timestamp starts a new window.
- `maxImages` is optional. See
  [Send recent history photos](#send-recent-history-photos).

Thread scope fits Discord and Slack threads, Teams conversations, GitHub
comment threads, and support chats in your app.

Adapter-backed Channels load thread history themselves. A route that calls
`runAgentTrigger()` or `streamAgentTrigger()` must pass the thread's messages
in order, with the new message. `triggerHistory` only trims that array. It does
not load messages by `threadId` or session id. See
[Consume a Capability Trigger](/docs/agents/triggers#consume-a-capability-trigger).

## What the model reads

For adapter-backed Channels, ViteHub adds a header line before each user
message. It has the send time with UTC offset, the platform message number, and
a label per attachment:

```txt
[Tue 2026-10-13 18:06:29 +02:00 · msg 109313 · photo AQADxyz]
```

- Set `timeZone` in the Channel `messages` options to an IANA time zone, such
  as `'Europe/Stockholm'`. The default, and the fallback for an invalid value,
  is UTC.
- An attachment label is `photo`, `voice`, `video`, or `file`. Telegram adds
  the permanent file id. `(not shown)` marks an attachment not in the model
  input.
- Outside direct messages, the header also names the sender and the sender id.
- `edited` marks an edited message.

A reply becomes one line after the header:

```txt
↪ replying to your msg 109315 (Tue 18:07): "Should I log the nachos or the banana?"
```

`your` means a message from the Agent. The quote is at most 280 characters.
If the replied message is already in the window, the line shows
`(shown above)` instead. Assistant messages get no header or reply line. The
header is model input only. Message `filter` hooks get the message without it.

Models sometimes copy these lines at the start of their answer. ViteHub removes
them from the start of the answer before the user sees it: in streamed replies,
the reply ViteHub posts, and `event.text` in the `agent:finish` hook. A line
that only looks similar, or a header later in the answer, stays.

## Send recent history photos

History messages keep their text, but their attachments are not sent by
default. Set `maxImages` to send the newest history photos again:

```ts [server/utils/meal-chat.ts]
import { chat } from 'vite-hub/agent/capabilities'

export const mealChat = chat({
  timeZone: 'Europe/Stockholm',
  triggerHistory: {
    maxAgeMs: 30 * 60 * 1000,
    maxImages: 3,
    maxMessages: 20,
    source: 'thread',
  },
})
```

- Only images sent within `maxAgeMs` of the current message count.
- The current message and queued messages keep all their attachments.
- ViteHub downloads the photos again through the Channel adapter on each
  Invocation. The adapter must support `rehydrateAttachment()`, as Telegram
  does.
- A photo that fails to download, or does not fit in the remaining
  `driver.execution.attachments.maxBytes` budget, is left out. The Invocation
  continues.

Provider Drivers, such as Codex and Claude Code, attach these photos to the
turn that starts a new provider thread. A resumed provider thread already has
the earlier turns, so it gets only attachments from the current message and
any queued or coalesced messages. A Sandbox provider gets no history photos.

## Add a session

Use a session when your product has a stable conversation id that does not
depend on the provider thread.

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
else `'manual'`.

ViteHub reads each message's session id from its metadata at `metadataKey`.
The `chat.message` input can also pick a session:
`session: { action: 'switch', id }` switches to it, and
`session: { action: 'new' }` starts one with only the current message.

::warning
The authenticated route or Channel supplies the session id. Never accept one
from an untrusted request. It can expose another conversation's history.
::

## Partition transcripts

Match transcript keys to your product's boundaries. Use thread keys when each
platform thread stands alone. Add the Channel or tenant identity when ids can
repeat across providers.

The Chat Capability picks the window. The Agent State store owns durability,
order, retention, and deletion.

| Host output | Default Agent State |
| --- | --- |
| Cloudflare | The generated Durable Object binding, also for Channel handlers that generated Workflows call. An explicit state provider wins. A state configuration with only `url` keeps automatic libSQL selection. |
| Other production output | None. Set a durable `VITEHUB_AGENT_STATE_URL` or an explicit Agent State provider URL before stateful traffic. |

Cloudflare, Vercel, and Netlify production output reject `file:` URLs, because
their filesystems are temporary.

## Keep SQLite transcripts

Pass `transcripts: { retention: 'forever' }` to `createLibsqlAgentState()` from
`vite-hub/agent/state`. The adapter then clears transcript expiry during
startup cleanup, including rows that already expired, and ignores later
transcript TTLs. Other cached state keeps its normal expiry. ViteHub cannot
recover rows that it deleted before you enabled this option.

## Inspect the result

Send two messages in the same thread or session. Inspect the second
Invocation with the [CLI](/docs/development/cli). Its input has the earlier
messages in the window and the current message. Another thread or session
starts with no history.

## Next steps

Use [Workspace context](/docs/agents/workspace-context) for project files and [Channels](/docs/agents/channels) for message delivery. [Build a chat app](/docs/agents/build-a-chat-app) shows browser chat state with streaming. [Invocation storage](/docs/agents/invocation-storage) keeps run records apart from model history.
