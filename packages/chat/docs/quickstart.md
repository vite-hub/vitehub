---
title: Chat quickstart
description: Register Chat and define one chat-enabled Agent.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide registers Chat and defines one chat-enabled Agent.

::steps

### Install Chat

```bash
pnpm add @vitehub/chat @vitehub/agent @vitehub/messages chat
```

### Register the integration

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { hubChat } from '@vitehub/chat/vite'
import { DevTools } from '@vitejs/devtools'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    DevTools(),
    hubChat(),
    nitro(),
  ],
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/chat/nitro'],
})
```
::

### Define a chat Agent

```ts [server/agents/triage.ts]
import { defineAgent, defineTool } from '@vitehub/agent'
import { getMessageText } from '@vitehub/messages'

const classifyMessage = defineTool<{ message: string }, { queue: string; priority: string }>({
  name: 'classifyMessage',
  description: 'Classify an incoming chat message before queue handoff.',
  execute: ({ message }) => ({
    queue: /refund|invoice|payment/i.test(message) ? 'billing' : 'product',
    priority: /urgent|down|broken/i.test(message) ? 'urgent' : 'normal',
  }),
})

export default defineAgent({
  chat: {
    adapters,
    state,
  },
  async run({ input }) {
    const latest = input.messages?.at(-1)
    const message = latest ? getMessageText(latest) : ''
    const ticket = await classifyMessage.execute?.({ message })

    return {
      raw: { ticket },
      text: ticket
        ? `Queued for ${ticket.queue} with ${ticket.priority} priority.`
        : 'Unable to classify the support request.',
    }
  },
})
```

### Configure the webhook

Point the provider webhook at the generated route.

```txt
/api/webhooks/telegram
```

::

## Verify

Send a direct message through the provider. Chat should run the `triage` Agent and post the queue result back to the same thread.
