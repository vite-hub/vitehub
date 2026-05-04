---
title: Chat usage
description: Define chats, resolve runtime config, configure webhook discovery, and handle Chat SDK events.
navigation.title: Usage
navigation.order: 2
icon: i-lucide-file-code-2
frameworks: [vite, nitro]
---

Use this page after the [Quickstart](./quickstart) when you need more than the default single-chat setup.

## Define one chat

`defineChat()` accepts Chat SDK config plus ViteHub-specific resolvers for adapters, state, hooks, and lifecycle behavior.

```ts [server/chat.ts]
import { defineChat } from '@vitehub/chat'

export default defineChat({
  adapters: {
    telegram: ({ runtimeConfig }) => createTelegramAdapter({
      botToken: runtimeConfig.telegram.botToken,
    }),
  },
  hooks: {
    async onDirectMessage({ message, thread }) {
      await thread.post(`Received: ${message.text}`)
    },
  },
  state: ({ runtimeConfig }) => createState(runtimeConfig),
  userName: 'Support Bot',
})
```

`adapters` and `state` can be static values, functions, or objects with a `resolve(context)` method. Use resolvers when they need runtime config, Cloudflare bindings, the current request, or per-request memoization.

## Use runtime config

The generated handler passes the active runtime config into chat resolvers and hook args.

```ts
interface ChatRuntimeConfig {
  telegram: {
    botToken: string
  }
}

export default defineChat<ChatRuntimeConfig>({
  adapters({ runtimeConfig }) {
    return {
      telegram: createTelegramAdapter({
        botToken: runtimeConfig.telegram.botToken,
      }),
    }
  },
  state,
  userName: 'Support Bot',
})
```

Pair Chat with `@vitehub/env` when you want typed server-only runtime config for secrets.

## Handle events

The `hooks` object wraps common Chat SDK event registrations and passes object-style arguments.

```ts
export default defineChat({
  adapters,
  hooks: {
    onDirectMessage: async ({ message, thread }) => {
      await thread.post(`Received: ${message.text}`)
    },
    onNewMessage: {
      pattern: /^!help/,
      handler: async ({ thread }) => {
        await thread.post('Available commands: !help')
      },
    },
    onReaction: {
      thumbs_up: async ({ event }) => {
        console.log('Reaction received', event)
      },
    },
  },
  state,
  userName: 'Support Bot',
})
```

Supported hook keys are `onDirectMessage`, `onNewMention`, `onSubscribedMessage`, `onNewMessage`, `onReaction`, `onAction`, and `onModalSubmit`.

## Run setup code

Use `setup` when the Chat SDK adapter needs direct bot access.

```ts
export default defineChat({
  adapters,
  async setup(bot, context) {
    bot.webhooks.telegram = createTelegramWebhook(bot, {
      secretToken: context.runtimeConfig.telegram.webhookSecretToken,
    })
  },
  state,
  userName: 'Support Bot',
})
```

`setup` runs after ViteHub registers hook sugar and before the generated webhook handles a request.

## Use multiple chats

Use `server/chats/**` when one app serves more than one bot.

```txt
server/chats/support.ts
server/chats/ops.ts
```

The generated registry route resolves the chat from the webhook route. With the default route shape, requests include both chat and platform params:

```txt
/api/webhooks/support/telegram
/api/webhooks/ops/telegram
```

## Customize webhook routes

Pass `webhook` options in config when the default route does not match your provider setup.

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { hubChat } from '@vitehub/chat/vite'

export default defineConfig({
  plugins: [hubChat({
    webhook: {
      route: '/api/chat/[platform]',
      routeParam: 'platform',
    },
  })],
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/chat/nitro'],
  chat: {
    webhook: {
      route: '/api/chat/[platform]',
      routeParam: 'platform',
    },
  },
})
```
::

Set `webhook: false` to disable generated webhook routes.

## Add lifecycle hooks

Lifecycle hooks run around the generated webhook flow.

```ts
export default defineChat({
  adapters,
  lifecycleHooks: {
    request(context) {
      console.log('Incoming chat request', context.platform)
    },
    error(error, context) {
      console.error('Chat webhook failed', context.platform, error)
    },
  },
  state,
  userName: 'Support Bot',
})
```

Use lifecycle hooks for logging and observability. Keep message behavior in Chat SDK event hooks.
