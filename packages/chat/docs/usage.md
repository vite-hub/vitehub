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

`defineChat()` accepts Chat SDK config plus ViteHub-specific resolvers for adapters, state, top-level event handlers, and lifecycle behavior.

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
  adapters: ({ runtimeConfig }) => ({
    telegram: createTelegramAdapter({
      botToken: runtimeConfig.telegram.botToken,
    }),
  }),
  state,
  userName: 'Support Bot',
})
```

Pair Chat with `@vitehub/env` when you want typed server-only runtime config for secrets.

## Handle events

Top-level event handlers wrap common Chat SDK event registrations and pass object-style arguments.

```ts
export default defineChat({
  adapters,
  async onDirectMessage({ message, thread }) {
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
  state,
  userName: 'Support Bot',
})
```

Supported top-level handler keys are `onDirectMessage`, `onNewMention`, `onSubscribedMessage`, `onNewMessage`, `onReaction`, `onAction`, and `onModalSubmit`. The older `hooks` object still works, but do not define the same handler in both places.

## Bind a chat to an agent

When `@vitehub/agent` is enabled, a chat can route direct messages to a discovered agent without manually converting history or posting streams.

```ts [server/chat.ts]
export default defineChat({
  adapters,
  agent: 'triager',
  state,
  userName: 'Support Bot',
})
```

The default binding gives the agent the latest thread context and streams the answer back into the same conversation.

```txt [flow]
direct message -> thread history -> triager agent -> thread.post(stream)
```

Use the object form when you need to customize the boundary:

```ts
export default defineChat({
  adapters,
  agent: {
    name: 'triager',
    hooks: {
      prepareInput({ history, message, thread }) {
        return {
          messages: history,
          context: {
            chat: {
              messageId: message.id,
              source: 'chat',
              threadId: thread.id,
            },
          },
        }
      },
      async sendResponse({ result, thread }) {
        await thread.post(result)
      },
    },
  },
  state,
  userName: 'Support Bot',
})
```

The v1 binding handles direct messages and inline agent execution. Use explicit event hooks when you need custom event routing.

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
import { DevTools } from '@vitejs/devtools'

export default defineConfig({
  plugins: [
    DevTools(),
    hubChat({
      webhook: {
        route: '/api/chat/[platform]',
        routeParam: 'platform',
      },
    }),
  ],
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
