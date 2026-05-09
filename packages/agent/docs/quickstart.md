---
title: Agent quickstart
description: Create your first ViteHub agent.
navigation.title: Quickstart
navigation.order: 2
icon: i-lucide-rocket
frameworks: [vite, nitro]
---

## Install

```sh
pnpm add @vitehub/agent ai
```

## Define an agent

::fw{id="nitro:dev nitro:build"}
```ts [server/agents/triager.ts]
import { defineAgent } from '@vitehub/agent'

export default defineAgent({
  description: 'Triage support requests',
  model,
  instructions: 'Classify the request and suggest the next action.',
})
```
::

::fw{id="vite:dev vite:build"}
```ts [src/triager.agent.ts]
import { defineAgent } from '@vitehub/agent'

export default defineAgent({
  description: 'Triage support requests',
  model,
  instructions: 'Classify the request and suggest the next action.',
})
```
::

## Register the integration

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/agent/nitro'],
})
```
::

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { hubAgent } from '@vitehub/agent/vite'

export default defineConfig({
  plugins: [hubAgent()],
})
```
::

Chat resolves discovered agents through the generated internal registry.

::fw{id="nitro:dev nitro:build"}
If you also want an HTTP endpoint, opt in with `agent.route`:

```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/agent/nitro'],
  agent: {
    route: '/agents/[agent]',
  },
})
```
::

::fw{id="vite:dev vite:build"}
If you also want an HTTP endpoint, pass `route` to `hubAgent()`:

```ts [vite.config.ts]
import { hubAgent } from '@vitehub/agent/vite'

export default defineConfig({
  plugins: [
    hubAgent({
      route: '/agents/[agent]',
    }),
  ],
})
```
::

## Call it from Chat

Pair Agent with `@vitehub/chat` when the bot should hand direct messages to an agent.

```ts [server/chat.ts]
import { defineChat } from '@vitehub/chat'

export default defineChat({
  adapters,
  agent: 'triager',
  state,
  userName: 'Support Bot',
})
```

Chat handles the message boundary: thread history in, streamed response out. The agent stays focused on model instructions and tools.
