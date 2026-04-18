---
title: Queue usage
description: Define queue handlers and send jobs from runtime code.
navigation.title: Usage
navigation.order: 2
icon: i-lucide-play
---

Queue usage has two parts: define a named queue and send jobs to that name.

## Define a handler

::fw{id="vite:dev vite:build"}
Plain Vite runtime handler discovery is out of scope for this release. Use Nitro or Nuxt for discovered queue handlers.
::

::fw{id="nitro:dev nitro:build nuxt:dev nuxt:build"}
Queue definitions live in `server/queues/**`. The queue name comes from the file path below that directory.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vitehub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  await sendWelcomeEmail(job.payload.email)
})
```

This file resolves to the queue name `welcome-email`.
::

## Send a payload

Use a bare payload for the common path.

```ts
await runQueue('welcome-email', {
  email: 'ava@example.com',
})
```

Use an input object when you need delivery options.

```ts
await runQueue('welcome-email', {
  id: 'welcome-ava',
  payload: { email: 'ava@example.com' },
  delaySeconds: 30,
})
```

## Defer after the response

Use `deferQueue()` when the enqueue call should happen after the current response is committed.

```ts [server/api/signup.post.ts]
import { deferQueue } from '@vitehub/queue'

export default defineEventHandler(() => {
  deferQueue('welcome-email', {
    email: 'ava@example.com',
  })

  return { ok: true }
})
```

`deferQueue()` uses the active Nitro request `waitUntil()` hook when the runtime provides one.

## Provider-specific options

Portable options are intentionally small.

| Option | Memory | Cloudflare | Vercel |
| --- | --- | --- | --- |
| `delaySeconds` | accepted | supported | supported |
| `contentType` | accepted | supported | unsupported |
| `idempotencyKey` | accepted | unsupported | supported |
| `retentionSeconds` | accepted | unsupported | supported |

Unsupported hosted-provider options throw `QueueError`.
