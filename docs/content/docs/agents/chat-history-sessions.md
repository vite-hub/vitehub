---
title: Chat History and sessions
description: Keep conversation-scoped Chat History separate from Agent Memory and Agent Run State.
navigation.order: 29
icon: i-lucide-messages-square
---

Chat History is ordered conversational messages for one chat interaction with an Agent. A Chat Session is the host-visible boundary that decides which messages are eligible for the Chat History Window.

Chat History is not Agent Memory. Chat History is conversation-scoped message state, while Agent Memory is durable knowledge or preferences across Agent Invocations.

## Enable Chat History

The Chat Capability owns Chat History behavior. Configure it on the Agent Definition when message history should be included in future `chat.message` invocations.

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
      history: { maxMessages: 20, source: 'thread' },
    }),
  ],
})
```

The Chat History Window limits how many prior messages enter the Agent Invocation. It does not delete the host's preserved history.

## Add sessions

Sessions select which messages belong to the active conversation before the Chat History Window is applied.

```ts [server/agents/support.ts]
import { chat } from '@vite-hub/agent/capabilities'

export const supportChat = chat({
  history: { maxMessages: 20, source: 'thread' },
  sessions: {
    idleTimeoutMs: 30 * 60 * 1000,
    metadataKey: 'sessionId',
    strategy: 'hybrid',
  },
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

DevTools can select configured Agent Invoker Profiles before a new Chat Session starts. It should not switch invokers in the middle of one conversation.

## Persist state deliberately

Chat History and the Concurrent Invocation Guard need an Agent State Provider when they should survive process restarts. Development state providers are useful locally, but hosted runtimes should configure durable state.

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

Choose a durable provider before treating Chat History as production conversation state.

## Next steps

- Read [Channels](/docs/agents/channels) for message origins and delivery metadata.
- Read [Invokers](/docs/agents/invokers) for trusted caller identity.
- Read [Capabilities](/docs/capabilities) for `chat()` and `memory()`.
