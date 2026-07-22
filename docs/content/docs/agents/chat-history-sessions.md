---
title: Chat History and sessions
description: Keep conversation-scoped Chat History separate from Agent Memory and Agent Run State.
navigation.order: 29
icon: i-lucide-messages-square
---

Chat History is ordered conversational messages for one chat interaction with an Agent. A Chat Session is the host-visible boundary that decides which supplied messages are eligible for the Chat History Window.

Chat History is not Agent Memory. Chat History is conversation-scoped message state, while Agent Memory is durable knowledge or preferences across Agent Invocations.

## Enable Chat History

The Chat Capability owns Chat History selection. Configure it on the Agent Definition when prior messages should be included in future `chat.message` invocations.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { chat } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: 'Answer support chat messages.',
  },
  capabilities: [
    chat({
      triggerHistory: { maxMessages: 20, source: 'thread' },
    }),
  ],
})
```

The Chat History Window limits how many prior messages enter the Agent Invocation. It does not delete the host's preserved history.
When `threadHistory.maxMessages` is configured and `triggerHistory` is omitted, ViteHub derives a thread-backed Chat History Window from that explicit bound.

## Use threads as conversation boundaries

Use thread-scoped Chat History when the platform or application already has a visible conversation thread. Discord threads, Slack channel threads, Teams conversations, GitHub comment threads, and app-owned support chats should usually keep follow-up context inside that thread.

```ts [server/agents/support.ts]
import { chat } from '@vite-hub/agent/capabilities'

export const supportChat = chat({
  concurrency: 'queue',
  lockScope: 'thread',
  threadHistory: { maxMessages: 20 },
})
```

With this configuration, a follow-up in the same thread can keep the same Chat History Window. A new Discord or Slack thread starts a separate conversation boundary, so it should not inherit the previous thread's context.

This is not Agent Memory. Thread-scoped Chat History keeps recent conversation input together; it does not remember user preferences or facts across unrelated threads.

For Chat Platform Adapters, ViteHub receives normalized channel, message, and thread facts from the message-shaped Channel. For app-owned chat routes, pass the current thread's messages to `chat.message` and include a stable first-class `run.threadId` so CLI output, traces, sessions, and finish hooks can describe the same boundary without making run metadata part of Chat context.

Use `sessions` only when one platform thread can contain more than one host-visible conversation. For example, add sessions when a support UI has a "new conversation" button inside the same customer chat, or when inactivity should start a fresh conversation without creating a new platform thread.

## Add sessions

Sessions select which messages belong to the active conversation before the Chat History Window is applied.

```ts [server/agents/support.ts]
import { chat } from '@vite-hub/agent/capabilities'

export const supportChat = chat({
  sessions: {
    idleTimeoutMs: 30 * 60 * 1000,
    metadataKey: 'sessionId',
    strategy: 'hybrid',
  },
  triggerHistory: { maxMessages: 20, source: 'thread' },
})
```

Use `strategy: 'manual'` when the host passes explicit session ids. Use `strategy: 'idle-timeout'` when inactivity should start a new session. Use `strategy: 'hybrid'` when both rules should apply.

## Select a session from a trigger

The `chat.message` trigger can receive a session instruction from a trusted Agent Trigger Consumer.

```ts [server/api/support-chat.post.ts]
import { streamAgentTrigger } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ sessionId: string, text: string }>(event)
  const runId = crypto.randomUUID()

  return streamAgentTrigger(support, { runtime: 'unknown' }, 'chat.message', {
    messages: [{
      id: runId,
      parts: [{ text: body.text, type: 'text' }],
      role: 'user',
    }],
    session: {
      action: 'switch',
      id: body.sessionId,
    },
    run: { origin: 'portal', runId },
  }, {
    output: 'ui-message-stream',
  })
})
```

Trusted entry points can select configured Agent Actor Profiles through `invokerProfileId` before a new Chat Session starts. They should not switch Actors in the middle of one conversation.

## Partition transcripts by Channel

When you enable `transcripts` without an explicit `identity` resolver, ViteHub uses `${channel}:${author.userId}` as the transcript key for human authors. The `channel` portion is the Channel key from your Agent Definition, not the underlying adapter's name. Qualifying the platform user ID with the Channel prevents identical IDs from colliding across Channels, including multiple Channels backed by the same kind of adapter. The default does not link the same person across platforms and does not replace Agent Actor identity.

The default resolver returns `null` for bot authors, so Chat SDK does not associate their messages with a user transcript. Provide an explicit `identity` resolver when your application has a verified cross-platform or internal user ID. An explicit resolver always overrides the default.

## Persist state deliberately

Chat History and the Concurrent Invocation Guard need an Agent State Provider when they should survive process restarts. The default `provider: 'auto'` uses Cloudflare state on Cloudflare and local SQLite at `file:.data/vitehub-agent-state.sqlite` during Vite development. Production output requires `VITEHUB_AGENT_STATE_URL` or explicit provider options before stateful webhook traffic; Cloudflare, Vercel, and Netlify production output rejects `file:` URLs because their compute filesystems are ephemeral.

```ts [vite.config.ts]
import { hubAgent } from '@vite-hub/agent/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubAgent()],
  agent: {
    providers: {
      state: {
        provider: 'sqlite',
        url: process.env.VITEHUB_AGENT_STATE_URL,
      },
    },
  },
})
```

Use a hosted libSQL URL for serverless output. A `file:` URL is appropriate only when the Node host has a persistent local filesystem and a SQLite-safe deployment topology.

## Next steps

- Read [Channels](/docs/agents/channels) for message origins and delivery metadata.
- Read [Agent Actors](/docs/agents/actors) for trusted caller identity.
- Read [Capabilities](/docs/capabilities) for `chat()` and `memory()`.
