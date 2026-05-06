---
title: Chat on Vercel
description: Run Chat webhooks through Vercel Functions with provider-neutral chat definitions.
navigation.title: Vercel
navigation.order: 21
icon: i-simple-icons-vercel
frameworks: [vite, nitro]
---

Use Vercel when your app already deploys Nitro output to Vercel Functions and your Chat SDK state adapter is available from that runtime.

## Register Chat for Vercel

Set the provider to `vercel` when automatic provider detection is not enough.

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { hubChat } from '@vitehub/chat/vite'
import { DevTools } from '@vitejs/devtools'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    DevTools(),
    hubChat({
      provider: 'vercel',
    }),
    nitro({
      preset: 'vercel',
    }),
  ],
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/chat/nitro'],
  preset: 'vercel',
  chat: {
    provider: 'vercel',
  },
})
```
::

## Define a chat

Use a state adapter that works in Vercel Functions.

```ts [server/chat.ts]
import { defineChat } from '@vitehub/chat'

export default defineChat({
  adapters: {
    telegram: ({ runtimeConfig }) => createTelegramAdapter({
      botToken: runtimeConfig.telegram.botToken,
    }),
  },
  state: ({ runtimeConfig }) => createStateAdapter(runtimeConfig),
  userName: 'Support Bot',
})
```

## Manual handler

If you are wiring a Vercel route manually, use `defineVercelChatHandler()`.

```ts
import chat from './chat'
import { defineVercelChatHandler } from '@vitehub/chat/vercel'

export const POST = defineVercelChatHandler(chat)
```

The handler infers the platform from the last URL segment unless you pass `platform`.

```ts
export const POST = defineVercelChatHandler(chat, {
  platform: 'telegram',
})
```
