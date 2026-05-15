---
title: Messages runtime API
description: Reference for message types, stream events, and helper functions.
navigation.title: Runtime API
navigation.order: 3
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Use this page for exact exported names.

## Imports

```ts
import {
  applyStreamEvent,
  collectStreamEvents,
  createMessage,
  deserializeMessages,
  getMessageText,
  getToolInvocations,
  serializeMessages,
  validateMessage,
} from '@vitehub/messages'
```

## Message

```ts
interface Message {
  id: string
  role: 'assistant' | 'system' | 'tool' | 'user'
  parts: MessagePart[]
  createdAt?: string
  metadata?: Record<string, unknown>
}
```

## Parts

```ts
type MessagePart =
  | { type: 'text'; id?: string; text: string }
  | { type: 'data'; id?: string; data: unknown }
  | { type: 'source'; id?: string; title?: string; url?: string; sourceType?: string }
  | { type: 'error'; id?: string; error: string; recoverable?: boolean }
  | { type: 'tool-call'; id: string; name: string; input?: unknown; state: 'proposed' | 'running' | 'approval-required' | 'failed' }
  | { type: 'tool-result'; id: string; name: string; output?: unknown; error?: string; state: 'completed' | 'failed' }
  | { type: 'approval-request'; id: string; name: string; input?: unknown; reason?: string }
```

## Stream events

```ts
type StreamEvent =
  | { type: 'text-delta'; text: string; id?: string; messageId?: string; role?: MessageRole }
  | { type: 'data'; data: unknown; id?: string; messageId?: string }
  | { type: 'tool-input-start' | 'tool-call'; id: string; name: string; input?: unknown; messageId?: string }
  | { type: 'tool-result'; id: string; name: string; output?: unknown; error?: string; messageId?: string }
  | { type: 'approval-request'; id: string; name: string; input?: unknown; reason?: string; messageId?: string }
  | { type: 'error'; error: string; id?: string; recoverable?: boolean; messageId?: string }
  | { type: 'finish'; reason?: string; messageId?: string }
```

## Helpers

| Function | Use |
| --- | --- |
| `createMessage(options)` | Create and validate a message. |
| `applyStreamEvent(messages, event)` | Return a new message array with the event applied. |
| `collectStreamEvents(stream)` | Read an async stream into an event array. |
| `serializeMessages(messages)` | Validate and stringify message state. |
| `deserializeMessages(input)` | Parse and validate stored state. |
| `validateMessage(message)` | Validate one message in place. |
| `getMessageText(message)` | Join text parts. |
| `getToolInvocations(message)` | Read tool calls, approvals, and results as invocations. |
