---
title: Messages quickstart
description: Create, update, and serialize ViteHub messages.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide creates a short message history and applies one assistant stream.

::steps

### Install Messages

```bash
pnpm add @vitehub/messages
```

### Create the first message

```ts
import { createMessage } from '@vitehub/messages'

let messages = [
  createMessage({
    role: 'user',
    text: 'Write a release note for the queue fix.',
  }),
]
```

### Apply stream events

```ts
import { applyStreamEvent } from '@vitehub/messages'

messages = applyStreamEvent(messages, {
  type: 'text-delta',
  messageId: 'assistant-1',
  role: 'assistant',
  text: 'Fixed queue delivery retries.',
})

messages = applyStreamEvent(messages, {
  type: 'finish',
  messageId: 'assistant-1',
  reason: 'stop',
})
```

### Store the history

```ts
import { serializeMessages } from '@vitehub/messages'

const stored = serializeMessages(messages)
```

### Load it again

```ts
import { deserializeMessages } from '@vitehub/messages'

messages = deserializeMessages(stored)
```

::

## Verify

`deserializeMessages()` returns a validated `Message[]`. If a message contains invalid roles, mismatched tool results, or non-serializable values, it throws before returning state.
