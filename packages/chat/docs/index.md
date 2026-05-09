---
title: Chat
description: Define Chat SDK bots and run their webhooks through ViteHub.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-message-circle
frameworks: [vite, nitro]
---

`@vitehub/chat` connects Chat SDK adapters to ViteHub apps. A chat definition owns adapters, state, event hooks, and webhook handling.

Use Chat when an app receives provider chat events and posts responses back to a thread.

```ts [server/chat.ts]
import { defineChat } from '@vitehub/chat'

export default defineChat({
  adapters,
  async onDirectMessage({ message, thread }) {
    await thread.post(`Received: ${message.text}`)
  },
  state,
  userName: 'Support Bot',
})
```

## What Chat owns

::card-group
  :::card
  ---
  icon: i-lucide-webhook
  title: Webhooks
  ---
  Generate webhook handlers and route provider events into Chat SDK adapters.
  :::

  :::card
  ---
  icon: i-lucide-message-circle
  title: Conversation hooks
  ---
  Handle direct messages, mentions, reactions, actions, modal submits, and subscribed messages.
  :::

  :::card
  ---
  icon: i-lucide-bot
  title: Agent handoff
  ---
  Route direct messages to a discovered Agent with ViteHub message history.
  :::
::

## What Chat does not own

Chat does not own model execution or canonical message storage. Use:

| Need | Use |
| --- | --- |
| Model and tool-loop execution | `@vitehub/agent` |
| Portable conversation and stream state | `@vitehub/messages` |
| Durable orchestration | `@vitehub/workflow` |

## Start here

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Register Chat and define one bot.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Configure hooks, multiple chats, webhook routes, and Agent handoff.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exports, options, runtime context, and webhook settings.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Troubleshooting
  description: Fix missing names, unknown platforms, duplicate hooks, and state issues.
  to: ./troubleshooting
  ---
  :::
::

## Providers

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Cloudflare
  description: Use Workers and Durable Objects for Chat webhooks and state.
  icon: i-simple-icons-cloudflare
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Use Vercel Functions with provider-neutral chat definitions.
  icon: i-simple-icons-vercel
  to: ./providers/vercel
  ---
  :::
::
