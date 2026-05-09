---
title: Chat quickstart
description: Register Chat and define one webhook-backed bot.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide registers Chat and defines one bot.

::steps

### Install Chat

```bash
pnpm add @vitehub/chat chat
```

Install the Chat SDK adapter package for the provider you use.

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

### Define a chat

```ts [server/chat.ts]
import { defineChat } from '@vitehub/chat'

export default defineChat({
  adapters: ({ runtimeConfig }) => ({
    telegram: createTelegramAdapter({
      botToken: runtimeConfig.telegram.botToken,
    }),
  }),
  async onDirectMessage({ message, thread }) {
    await thread.post(`Received: ${message.text}`)
  },
  state,
  userName: 'Support Bot',
})
```

### Configure the webhook

Point the provider webhook at the generated route.

```txt
/api/webhooks/telegram
```

::

## Verify

Send a direct message through the provider. The handler should post `Received: ...` back to the same thread.

## Add Agent handoff

Use `agent` when direct messages should go through a discovered Agent.

```ts [server/chat.ts]
export default defineChat({
  adapters,
  agent: 'triager',
  state,
  userName: 'Support Bot',
})
```
