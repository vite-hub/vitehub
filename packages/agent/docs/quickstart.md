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
pnpm add @vite-hub/agent @ai-sdk/gateway ai
```

### Register the integration

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { hubAgent } from '@vite-hub/agent/vite'
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
  modules: ['@vite-hub/agent/nitro'],
})
```
::

### Define the agent

::fw{id="vite:dev vite:build"}
```ts [server/agents/triager.ts]
import { defineAgent, type AgentToolDefinition } from '@vite-hub/agent'
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
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/agents/triager.ts]
import { defineAgent, type AgentToolDefinition } from '@vite-hub/agent'
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
})
```
::

### Add Chat

Attach the Chat Capability to the discovered Agent. DevTools and host routes consume the resulting `chat.message` Agent Trigger.

```ts [server/agents/triager.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { chat } from '@vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [chat({ concurrency: 'queue', history: { source: 'thread', maxMessages: 20 } })],
  model: gateway('openai/gpt-5.1-mini'),
})
```

::

## Verify

The agent is available to other ViteHub packages through the generated registry. If you also enable routes, the generated route can call the same discovered agent.

## Next steps

- Use [Usage](./usage) to expose an HTTP route or customize `run`.
- Use [Runtime API](./runtime-api) for exact option shapes.
