---
title: Messages
description: Store and replay portable conversation state for ViteHub Chat and Agent.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-messages-square
frameworks: [vite, nitro]
---

`@vitehub/messages` defines the conversation state shared by `@vitehub/chat` and `@vitehub/agent`.

Use Messages when you need to create, validate, serialize, deserialize, or replay assistant message state.

```ts
import { createMessage, serializeMessages } from '@vitehub/messages'

const messages = [
  createMessage({
    role: 'user',
    text: 'Summarize this thread',
  }),
]

const stored = serializeMessages(messages)
```

## What Messages owns

::card-group
  :::card
  ---
  icon: i-lucide-file-json
  title: Serializable state
  ---
  Keep message parts as structured data that can survive reloads and retries.
  :::

  :::card
  ---
  icon: i-lucide-list-tree
  title: Stream events
  ---
  Apply text, data, tool, approval, error, and finish events to message history.
  :::

  :::card
  ---
  icon: i-lucide-badge-check
  title: Validation
  ---
  Validate roles, part IDs, JSON-safe values, and tool call/result ordering.
  :::
::

## Package boundary

Messages has no framework or provider dependency. It does not import Chat SDK, AI SDK, Vite, Nitro, Cloudflare, or Vercel.

Chat converts provider conversation events into ViteHub messages. Agent converts ViteHub messages into model calls.

## Start here

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Create messages, apply stream events, and serialize the result.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Work with text, data, tools, approvals, errors, and persisted state.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exported types and helper functions.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Troubleshooting
  description: Fix invalid roles, non-serializable state, and tool result mismatches.
  to: ./troubleshooting
  ---
  :::
::
