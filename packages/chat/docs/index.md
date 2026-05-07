---
title: Chat
description: Define Chat SDK bots once and run their webhooks through Vite, Nitro, Cloudflare, or Vercel.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-message-circle
frameworks: [vite, nitro]
---

`@vitehub/chat` connects the Chat SDK to ViteHub apps. Define a bot with adapters, state, and event hooks, then let ViteHub generate webhook handlers for the runtime that serves the app.

Use Chat when an app needs a bot entrypoint without hand-writing platform-specific webhook routes, `waitUntil` plumbing, or Cloudflare Durable Object state setup.

::code-group
```ts [server/chat.ts]
import { defineChat } from '@vitehub/chat'
import { cloudflareDurableObjectState } from '@vitehub/chat/cloudflare'

export default defineChat({
  adapters: ({ runtimeConfig }) => ({
    telegram: createTelegramAdapter({
      botToken: runtimeConfig.telegram.botToken,
    }),
  }),
  async onDirectMessage({ message, thread }) {
    await thread.post(`Received: ${message.text}`)
  },
  state: cloudflareDurableObjectState(),
  userName: 'Support Bot',
})
```

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

## What Chat solves

Chat keeps bot behavior in one definition while deployment-specific wiring stays in config.

::card-group
  :::card
  ---
  icon: i-lucide-bot
  title: One bot definition
  ---
  Configure Chat SDK adapters, state, and message handlers in `defineChat()`.
  :::

  :::card
  ---
  icon: i-lucide-route
  title: Generated webhooks
  ---
  Discover chat files and mount webhook routes such as `/api/webhooks/[platform]`.
  :::

  :::card
  ---
  icon: i-lucide-cloud
  title: Runtime context
  ---
  Resolve adapters and state from Nitro runtime config, Cloudflare bindings, or Vercel `waitUntil`.
  :::

  :::card
  ---
  icon: i-lucide-database
  title: Durable state
  ---
  Use Cloudflare Durable Objects for Chat SDK state, with a memory fallback during local development.
  :::
::

## One portable flow

1. Install `@vitehub/chat` and the Chat SDK adapter packages your bot needs.
2. Register `hubChat()` or `@vitehub/chat/nitro`.
3. Add `server/chat.ts` or named files under `server/chats/`.
4. Export `defineChat()` from each chat file.
5. Point provider webhooks at the generated route.

::callout{icon="i-lucide-info" color="info"}
Adapter packages, bot tokens, and webhook secrets come from the provider you are integrating with. `@vitehub/chat` provides the ViteHub runtime integration around those Chat SDK pieces.
::

## Discovery model

::fw{id="vite:dev vite:build"}
Vite apps use `hubChat()` and Nitro's Vite plugin together. Chat definitions are discovered from the Nitro server tree.

If you register `@vitehub/chat/nitro` directly in `nitro({ modules })`, the module adds the Chat panel to Vite DevTools automatically during development. The Nitro module owns the generated bridge route and runtime behavior.
::

::fw{id="nitro:dev nitro:build"}
Nitro discovers a single `server/chat.ts` definition or a registry under `server/chats/**`.

`server/chat.ts` becomes the default chat. `server/chats/support.ts` becomes a named chat called `support`.
::

## Supported providers

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Cloudflare
  description: Use Workers and Durable Objects for webhook execution and Chat SDK state.
  icon: i-simple-icons-cloudflare
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Use Vercel Functions with provider-neutral webhook handlers.
  icon: i-simple-icons-vercel
  to: ./providers/vercel
  ---
  :::
::

## Start here

Start with [Quickstart](./quickstart) for the smallest Nitro webhook setup. Use [Usage](./usage) when you need multiple chats, hook sugar, or custom routes.

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Register Chat, define one bot, and verify the generated webhook route.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Configure discovery, hooks, state, lifecycle hooks, and webhook routes.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exports, option shapes, handlers, and runtime context fields.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Troubleshooting
  description: Fix missing user names, unknown platforms, bindings, and local state issues.
  to: ./troubleshooting
  ---
  :::
::
