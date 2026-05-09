---
title: Chat usage
description: Configure hooks, multiple chats, webhook routes, lifecycle hooks, and Agent handoff.
navigation.title: Usage
navigation.order: 2
icon: i-lucide-file-code-2
frameworks: [vite, nitro]
---

Use this page after the [Quickstart](./quickstart).

## Define hooks

You can define hooks at the top level:

```ts
export default defineChat({
  adapters,
  async onDirectMessage({ message, thread }) {
    await thread.post(message.text)
  },
  async onNewMention({ message, thread }) {
    await thread.post(`Mentioned: ${message.text}`)
  },
  state,
  userName: 'Support Bot',
})
```

Or group them under `hooks`:

```ts
export default defineChat({
  adapters,
  hooks: {
    async onDirectMessage({ message, thread }) {
      await thread.post(message.text)
    },
  },
  state,
  userName: 'Support Bot',
})
```

Do not define the same hook in both places.

## Handle events

```ts
export default defineChat({
  adapters,
  onReaction: {
    '👍': async ({ event }) => {
      console.log(event)
    },
  },
  onAction: {
    approve: async ({ event }) => {
      console.log(event)
    },
  },
  state,
  userName: 'Support Bot',
})
```

Use `$all` in `onReaction`, `onAction`, or `onModalSubmit` when one handler should receive all events of that type.

## Bind Chat to Agent

When `@vitehub/agent` is enabled, Chat can route direct messages to a discovered agent.

```ts
export default defineChat({
  adapters,
  agent: 'triager',
  state,
  userName: 'Support Bot',
})
```

Use the object form to customize history or response behavior.

```ts
export default defineChat({
  adapters,
  agent: {
    name: 'triager',
    history: {
      source: 'thread',
      maxMessages: 20,
    },
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

`agent` handles direct messages. Use `onDirectMessage` instead when you want to own the full flow.

## Use setup

Use `setup` when the Chat SDK adapter needs direct bot access before webhooks run.

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

## Use multiple chats

Use `server/chats/**` when one app serves more than one bot.

```txt
server/chats/support.ts
server/chats/ops.ts
```

With the default route shape, requests include both chat and platform params.

```txt
/api/webhooks/support/telegram
/api/webhooks/ops/telegram
```

## Customize webhook routes

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
hubChat({
  webhook: {
    route: '/api/chat/[platform]',
    routeParam: 'platform',
  },
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
      console.log(context.platform)
    },
    error(error) {
      console.error(error)
    },
  },
  state,
  userName: 'Support Bot',
})
```
