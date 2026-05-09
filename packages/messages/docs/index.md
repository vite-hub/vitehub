---
title: Messages
description: Canonical AI conversation state and stream protocol primitives for ViteHub.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-messages-square
frameworks: [vite, nitro]
---

`@vitehub/messages` is the shared message protocol for ViteHub AI packages. It gives Chat, Agent, DevTools, persistence, and future AI primitives one durable shape for conversation state instead of sharing provider-specific message objects.

Use Messages when you need to store, replay, stream, or adapt AI conversation state across packages.

```ts
import { applyStreamEvent, createMessage, serializeMessages } from '@vitehub/messages'

let messages = [
  createMessage({
    role: 'user',
    text: 'Summarize this thread',
  }),
]

messages = applyStreamEvent(messages, {
  text: 'Here is the summary.',
  type: 'text-delta',
})

const stored = serializeMessages(messages)
```

## What Messages owns

Messages defines the canonical Interface for:

- message roles and parts
- text, data, source, and error parts
- tool calls and tool results
- approval requests
- stream events
- serialization and rehydration
- validation of required fields and tool result ordering

It does not depend on Chat SDK, Vercel AI SDK, Nitro, Vite, Cloudflare, or Vercel. Provider and framework details stay in adapters at the edges.

## Package roles

`@vitehub/chat` owns provider chat ingress, webhooks, thread handling, and Chat SDK adapters.

`@vitehub/agent` owns model execution, tool loops, policies, retries, approvals, and run lifecycle.

`@vitehub/messages` is the handoff Interface between those packages.
