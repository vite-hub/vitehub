---
title: Messages usage
description: Model text, data, tools, approvals, errors, and persisted state.
navigation.title: Usage
navigation.order: 2
icon: i-lucide-file-code-2
frameworks: [vite, nitro]
---

Use this page after the [Quickstart](./quickstart).

## Read text

```ts
import { getMessageText } from '@vitehub/messages'

const text = getMessageText(message)
```

`getMessageText()` joins text parts in order. It ignores data, source, tool, approval, and error parts.

## Add structured data

```ts
messages = applyStreamEvent(messages, {
  type: 'data',
  data: {
    ticketId: 'SUP-42',
    priority: 'high',
  },
})
```

Data must be JSON-safe. Do not store functions, symbols, `undefined`, `bigint`, dates, or non-finite numbers.

## Track tools

```ts
messages = applyStreamEvent(messages, {
  type: 'tool-call',
  id: 'tool_1',
  name: 'lookupOrder',
  input: { orderId: '1001' },
})

messages = applyStreamEvent(messages, {
  type: 'tool-result',
  id: 'tool_1',
  name: 'lookupOrder',
  output: { status: 'paid' },
})
```

A tool result must follow a matching tool call or approval request with the same ID.

## Request approval

```ts
messages = applyStreamEvent(messages, {
  type: 'approval-request',
  id: 'refund_1',
  name: 'refundOrder',
  input: { orderId: '1001' },
  reason: 'Refunds require confirmation.',
})
```

Approval requests are message parts. The approval decision belongs to the runtime or interface that handles the request.

## Store and load state

```ts
const stored = serializeMessages(messages)
const restored = deserializeMessages(stored)
```

Serialization validates every message before writing. Deserialization validates every message before returning.

## Collect stream events

```ts
import { collectStreamEvents } from '@vitehub/messages'

const events = await collectStreamEvents(stream)
```

Use this when a caller needs the event list instead of incrementally applying a stream.
