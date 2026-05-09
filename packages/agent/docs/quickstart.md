---
title: Agent quickstart
description: Register Agent and define a first server agent.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide creates one discovered agent.

::steps

### Install Agent

```bash
pnpm add @vitehub/agent ai
```

### Register the integration

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { hubAgent } from '@vitehub/agent/vite'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubAgent(),
    nitro(),
  ],
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/agent/nitro'],
})
```
::

### Define the agent

::fw{id="vite:dev vite:build"}
```ts [server/agents/triager.ts]
import { defineAgent, defineTool } from '@vitehub/agent'
import { getMessageText } from '@vitehub/messages'

const classifyTicket = defineTool<{ message: string }, { queue: string; priority: string }>({
  name: 'classifyTicket',
  description: 'Classify a support request before queue handoff.',
  execute: ({ message }) => ({
    queue: /refund|invoice|payment/i.test(message) ? 'billing' : 'product',
    priority: /urgent|down|broken/i.test(message) ? 'urgent' : 'normal',
  }),
})

export default defineAgent({
  description: 'Triage support requests and prepare a queue handoff.',
  async run({ input }) {
    const latest = input.messages?.at(-1)
    const message = latest ? getMessageText(latest) : ''
    const ticket = await classifyTicket.execute?.({ message })

    return {
      raw: { ticket },
      text: ticket
        ? `Queued for ${ticket.queue} with ${ticket.priority} priority.`
        : 'Unable to classify the support request.',
    }
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/agents/triager.ts]
import { defineAgent, defineTool } from '@vitehub/agent'
import { getMessageText } from '@vitehub/messages'

const classifyTicket = defineTool<{ message: string }, { queue: string; priority: string }>({
  name: 'classifyTicket',
  description: 'Classify a support request before queue handoff.',
  execute: ({ message }) => ({
    queue: /refund|invoice|payment/i.test(message) ? 'billing' : 'product',
    priority: /urgent|down|broken/i.test(message) ? 'urgent' : 'normal',
  }),
})

export default defineAgent({
  description: 'Triage support requests and prepare a queue handoff.',
  async run({ input }) {
    const latest = input.messages?.at(-1)
    const message = latest ? getMessageText(latest) : ''
    const ticket = await classifyTicket.execute?.({ message })

    return {
      raw: { ticket },
      text: ticket
        ? `Queued for ${ticket.queue} with ${ticket.priority} priority.`
        : 'Unable to classify the support request.',
    }
  },
})
```
::

### Call it from Chat

`@vitehub/chat` can route direct messages to a discovered agent by name.

```ts [server/chat.ts]
import { defineChat } from '@vitehub/chat'

export default defineChat({
  adapters,
  agent: 'triager',
  state,
  userName: 'Support Bot',
})
```

::

## Verify

The agent is available to other ViteHub packages through the generated registry. If you also enable routes, the generated route can call the same discovered agent.

## Next steps

- Use [Usage](./usage) to expose an HTTP route or customize `run`.
- Use [Runtime API](./runtime-api) for exact option shapes.
