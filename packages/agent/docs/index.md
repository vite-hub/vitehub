---
title: Agent
description: Define Vercel AI SDK agents and choose where they run with ViteHub.
navigation.title: Agent
navigation.order: 1
icon: i-lucide-bot
frameworks: [vite, nitro]
---

`@vitehub/agent` provides ViteHub conventions for model and tool-loop agents. Define portable agents with `defineAgent()`, discover them from Vite or Nitro files, and pick runtime capabilities through config.

Agent accepts and emits the shared `@vitehub/messages` protocol. The first model adapter is Vercel AI SDK, but ViteHub-owned message and stream types are the public handoff Interface between Chat, Agent, DevTools, persistence, and future AI packages.

::code-group
```ts [server/agents/triager.ts]
import { defineAgent } from '@vitehub/agent'

export default defineAgent({
  description: 'Triage incoming chat messages',
  model,
  instructions: 'Classify the message and suggest the next action.',
})
```

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

## What Agent Adds

::card-group
  :::card
  ---
  icon: i-lucide-bot
  title: Portable agent definitions
  ---
  Keep model instructions and tools in discovered `defineAgent()` files.
  :::

  :::card
  ---
  icon: i-lucide-message-circle
  title: Message protocol handoff
  ---
  Let `@vitehub/chat` call agents with `@vitehub/messages` history and stream replies back to the conversation.
  :::

  :::card
  ---
  icon: i-lucide-route
  title: Generated routes
  ---
  Nitro can expose discovered agents for direct server calls when you opt in with `agent.route`.
  :::
::
