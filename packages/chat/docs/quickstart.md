---
title: Chat quickstart
description: Register Chat, define one Nitro bot, and verify the generated webhook route.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide creates one Chat SDK bot definition and exposes it through a generated Nitro webhook route.

The example uses a small in-memory state adapter so you can verify routing locally before adding a real chat platform adapter.

::code-collapse

```txt [Prompt]
Set up @vitehub/chat in this app.

- Install @vitehub/chat and chat
- Register hubChat() with Nitro or add @vitehub/chat/nitro with chatDevtools()
- Add server/chat.ts with defineChat()
- Configure a local state adapter for development
- Verify that /api/webhooks/demo reaches the generated handler

Docs: /docs/vite/chat/quickstart or /docs/nitro/chat/quickstart
```

::

::steps

### Install Chat

```bash
pnpm add @vitehub/chat chat chat-state-cloudflare-do
```

### Register the integration

::fw{id="vite:dev vite:build"}
Register the Vite plugin next to Nitro:

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

If you want to keep Chat registered as a Nitro module, add the Chat DevTools companion as a Vite plugin:

```ts [vite.config.ts]
import { chatDevtools } from '@vitehub/chat/vite'
import { DevTools } from '@vitejs/devtools'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    DevTools(),
    chatDevtools(),
    nitro({
      modules: ['@vitehub/chat/nitro'],
    }),
  ],
})
```

`@vitehub/chat/nitro` creates the bridge route and runtime wiring. `chatDevtools()` adds only the Vite DevTools dock and RPC calls for that bridge. `DevTools()` plus `nitro({ modules: ['@vitehub/chat/nitro'] })` alone cannot show the Chat dock because Vite DevTools discovers panels from Vite plugins.
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module:

```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/chat/nitro'],
})
```
::

### Define a chat

Create `server/chat.ts`:

```ts [server/chat.ts]
import { defineChat } from '@vitehub/chat'
import { cloudflareDurableObjectState } from '@vitehub/chat/cloudflare'

export default defineChat({
  adapters: {},
  hooks: {
    async onDirectMessage({ message, thread }) {
      await thread.post(`Received: ${message.text}`)
    },
  },
  state: cloudflareDurableObjectState(),
  userName: 'Demo Bot',
})
```

In local development, `cloudflareDurableObjectState()` can use the Chat dev memory fallback. In production, configure the Cloudflare Durable Object binding before using this state resolver.

### Start the app

```bash
pnpm dev
```

### Verify the route

Send a request to the generated webhook route:

```bash
curl -i -X POST http://localhost:3000/api/webhooks/demo
```

The route should respond from the generated Chat handler. If the demo platform has no adapter webhook registered, the handler returns an unknown platform response instead of a missing route.

::

## Add a provider adapter

After the generated route is working, install the adapter package for the chat platform and add it to `adapters`.

```ts [server/chat.ts]
import { createTelegramAdapter } from '@chat-adapter/telegram'
import { defineChat } from '@vitehub/chat'

export default defineChat({
  adapters: {
    telegram: ({ runtimeConfig }) => createTelegramAdapter({
      botToken: runtimeConfig.telegram.botToken,
    }),
  },
  state,
  userName: 'Support Bot',
})
```

Store provider credentials in runtime config or environment variables. Do not inline bot tokens in the chat definition.

## Next steps

- Use [Usage](./usage) for multiple chats, hook inputs, lifecycle hooks, and custom webhook routes.
- Use [Cloudflare](./providers/cloudflare) for Durable Object state.
- Use [Runtime API](./runtime-api) for exact option shapes and handler exports.
