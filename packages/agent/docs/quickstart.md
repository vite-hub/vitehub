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
import { defineAgent, type AgentToolDefinition } from '@vitehub/agent'
import { gateway } from '@ai-sdk/gateway'

const classifyTicket: AgentToolDefinition<{ message: string }, { queue: string; priority: string }> = {
  name: 'classifyTicket',
  description: 'Classify a support request before queue handoff.',
  execute: ({ message }) => ({
    queue: /refund|invoice|payment/i.test(message) ? 'billing' : 'product',
    priority: /urgent|down|broken/i.test(message) ? 'urgent' : 'normal',
  }),
}

export default defineAgent({
  capabilities: [{
    id: 'support-triage',
    tools: { classifyTicket },
  }],
  description: 'Triage support requests and prepare a queue handoff.',
  instructions: 'Classify support requests and prepare queue handoff.',
  model: gateway('openai/gpt-5.1-mini'),
  adapter: 'ai-sdk',
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/agents/triager.ts]
import { defineAgent, type AgentToolDefinition } from '@vitehub/agent'
import { gateway } from '@ai-sdk/gateway'

const classifyTicket: AgentToolDefinition<{ message: string }, { queue: string; priority: string }> = {
  name: 'classifyTicket',
  description: 'Classify a support request before queue handoff.',
  execute: ({ message }) => ({
    queue: /refund|invoice|payment/i.test(message) ? 'billing' : 'product',
    priority: /urgent|down|broken/i.test(message) ? 'urgent' : 'normal',
  }),
}

export default defineAgent({
  capabilities: [{
    id: 'support-triage',
    tools: { classifyTicket },
  }],
  description: 'Triage support requests and prepare a queue handoff.',
  instructions: 'Classify support requests and prepare queue handoff.',
  model: gateway('openai/gpt-5.1-mini'),
  adapter: 'ai-sdk',
})
```
::

### Call it from Chat

`@vitehub/agent/chat` can route direct messages to a discovered agent by name.

```ts [server/chat.ts]
import { defineChat } from '@vitehub/agent/chat'

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
