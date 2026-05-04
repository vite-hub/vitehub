---
title: Chat on Cloudflare
description: Run Chat webhooks on Cloudflare Workers and store Chat SDK state in Durable Objects.
navigation.title: Cloudflare
navigation.order: 20
icon: i-simple-icons-cloudflare
frameworks: [vite, nitro]
---

Use Cloudflare when you want Chat webhooks to run close to users and store Chat SDK state in Durable Objects.

## Register Chat for Cloudflare

Configure Chat with the Cloudflare provider and Durable Object state.

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { hubChat } from '@vitehub/chat/vite'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubChat({
      provider: 'cloudflare',
      cloudflare: {
        durableObjectState: true,
      },
    }),
    ...nitro({
      preset: 'cloudflare_module',
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
  preset: 'cloudflare_module',
  chat: {
    provider: 'cloudflare',
    cloudflare: {
      durableObjectState: true,
    },
  },
})
```
::

## Use Durable Object state

In the chat definition, use the Cloudflare state resolver:

```ts [server/chat.ts]
import { defineChat } from '@vitehub/chat'
import { cloudflareDurableObjectState } from '@vitehub/chat/cloudflare'

export default defineChat({
  adapters,
  hooks,
  state: cloudflareDurableObjectState(),
  userName: 'Support Bot',
})
```

The default binding is `CHAT_STATE`. The default Durable Object class is `ChatStateDO`.

## Customize the binding

Use matching names in module config and runtime state config.

```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/chat/nitro'],
  chat: {
    provider: 'cloudflare',
    cloudflare: {
      durableObjectState: {
        binding: 'SUPPORT_CHAT_STATE',
        className: 'SupportChatStateDO',
        migrationTag: 'v1',
      },
    },
  },
})
```

```ts [server/chat.ts]
export default defineChat({
  adapters,
  state: cloudflareDurableObjectState({
    binding: 'SUPPORT_CHAT_STATE',
    className: 'SupportChatStateDO',
  }),
  userName: 'Support Bot',
})
```

## Runtime context

Cloudflare handlers populate `context.cloudflare.env`, `context.cloudflare.context`, and `context.waitUntil`.

Use those fields only in resolvers or lifecycle hooks that need Cloudflare-specific behavior. Keep message handling provider-neutral when possible.
