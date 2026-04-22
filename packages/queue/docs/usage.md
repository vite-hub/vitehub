---
title: Queue usage
description: Define queues, enqueue payloads, and work with provider-specific clients.
navigation.title: Usage
frameworks: [vite, nitro]
---

Use this page when you already have Queue installed and need the common runtime patterns.

## Define queues with typed payloads

Use `defineQueue()` to register one handler for one discovered queue.

::fw{id="vite:dev vite:build"}
```ts [src/welcome-email.queue.ts]
import { defineQueue } from '@vitehub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  console.log(job.payload.email)
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vitehub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  console.log(job.payload.email)
})
```
::

## Send a bare payload

Pass the payload directly when you do not need delivery options:

```ts
import { runQueue } from '@vitehub/queue'

await runQueue('welcome-email', {
  email: 'ava@example.com',
})
```

## Send an enqueue envelope

Pass an object with `payload` when you need queue options:

```ts
await runQueue('welcome-email', {
  id: 'welcome-email-1',
  payload: {
    email: 'ava@example.com',
  },
  delaySeconds: 30,
  idempotencyKey: 'welcome-email-1',
})
```

The shared enqueue envelope supports these fields:

| Field | Purpose |
| --- | --- |
| `payload` | The job payload delivered to your queue handler. |
| `id` | Override the generated message id. |
| `delaySeconds` | Delay delivery when the provider supports it. |
| `contentType` | Override Cloudflare payload encoding. |
| `idempotencyKey` | Deduplicate sends when the provider supports it. |
| `region` | Override the Vercel region for a send. |
| `retentionSeconds` | Keep a queued message longer when the provider supports it. |

## Defer dispatch until after the response

Use `deferQueue()` when the request should return immediately and the enqueue call can happen through the current runtime context:

```ts
import { deferQueue } from '@vitehub/queue'

export default defineEventHandler(() => {
  deferQueue('welcome-email', {
    email: 'ava@example.com',
  })

  return { ok: true }
})
```

`deferQueue()` uses `waitUntil()` when the runtime provides it and falls back to a fire-and-forget dispatch otherwise.

## Resolve the active provider client

Use `getQueue()` when you need the concrete provider client instead of a plain send call:

```ts
import { getQueue } from '@vitehub/queue'

const queue = await getQueue('welcome-email')

if (queue.provider === 'cloudflare') {
  console.log(queue.binding)
}
```

Provider-specific client methods:

| Provider | Extra methods |
| --- | --- |
| Cloudflare | `sendBatch()`, `createBatchHandler()` |
| Vercel | `callback()` |

## Queue naming rules

Queue names always come from discovered files:

::fw{id="vite:dev vite:build"}
- `src/welcome-email.queue.ts` -> `welcome-email`
- `src/email/welcome.queue.ts` -> `email/welcome`
::

::fw{id="nitro:dev nitro:build"}
- `server/queues/welcome-email.ts` -> `welcome-email`
- `server/queues/email/welcome.ts` -> `email/welcome`
::

Use [Runtime API](./runtime-api) when you need the exact signatures and exported types.
