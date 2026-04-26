---
title: Queue usage
description: Practical patterns for typed jobs, enqueue envelopes, deferred dispatch, provider clients, and stable queue names.
navigation.title: Usage
navigation.order: 3
icon: i-lucide-workflow
frameworks: [vite, nitro]
---

After the quickstart works, most Queue code falls into four patterns: define a typed job, enqueue a payload, choose whether dispatch is awaited or deferred, and let the provider deliver the handler later.

## Define payload types

Export payload types from the queue definition when producer code needs them.

::fw{id="vite:dev vite:build"}
```ts [src/welcome-email.queue.ts]
import { defineQueue } from '@vitehub/queue'

export type WelcomeEmailPayload = {
  email: string
  template: 'default' | 'vip'
}

export default defineQueue<WelcomeEmailPayload>(async (job) => {
  console.log(job.id, job.attempts, job.payload.email)
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vitehub/queue'

export type WelcomeEmailPayload = {
  email: string
  template: 'default' | 'vip'
}

export default defineQueue<WelcomeEmailPayload>(async (job) => {
  console.log(job.id, job.attempts, job.payload.email)
})
```
::

The handler receives a `QueueJob<TPayload>` with `id`, `payload`, `attempts`, and optional provider metadata.

## Keep producers provider-neutral

The route should not know whether Cloudflare or Vercel is delivering the job.

```ts
const result = await runQueue('welcome-email', payload)
```

Provider details belong in config:

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts
    queue: {
      provider: 'cloudflare',
    }
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
    ```ts
    queue: {
      provider: 'vercel',
      region: 'fra1',
    }
    ```
  :::
::

## Send a bare payload

Pass the payload directly when you do not need delivery options:

```ts
await runQueue('welcome-email', {
  email: 'ava@example.com',
  template: 'vip',
})
```

`runQueue()` resolves after the provider accepts the send:

```json
{
  "status": "queued",
  "messageId": "queue_7f1b6f8e-7b5c-4c5e-b3a1-8d6a4b3d4c2a"
}
```

## Send an enqueue envelope

Pass an object with `payload` when you need delivery options:

```ts
await runQueue('welcome-email', {
  id: 'welcome-email-1',
  payload: {
    email: 'ava@example.com',
    template: 'vip',
  },
  delaySeconds: 30,
  idempotencyKey: 'welcome-email-1',
})
```

The shared envelope supports these fields:

| Field | Provider support | Description |
| --- | --- | --- |
| `payload` | Cloudflare, Vercel | The job payload delivered to the queue handler. |
| `id` | Cloudflare, Vercel | Message id used in the ViteHub enqueue result. Vercel also uses it as the default idempotency key. |
| `delaySeconds` | Cloudflare, Vercel | Delay delivery when the provider supports it. |
| `contentType` | Cloudflare | Payload encoding passed to Cloudflare Queues. |
| `idempotencyKey` | Vercel | Deduplicate sends through Vercel Queue. |
| `region` | Vercel | Override the Vercel region for this send. |
| `retentionSeconds` | Vercel | Keep a queued message longer when supported by Vercel Queue. |

::callout{icon="i-lucide-alert-triangle" color="warning"}
Unsupported provider options throw `QueueError`. Cloudflare rejects `idempotencyKey` and `retentionSeconds`; Vercel rejects `contentType`.
::

## Defer dispatch until after the response

Use `deferQueue()` when the route should return immediately and enqueue dispatch can run through the current runtime context:

```ts
import { deferQueue } from '@vitehub/queue'

export default defineEventHandler(() => {
  deferQueue('welcome-email', {
    email: 'ava@example.com',
    template: 'default',
  })

  return { ok: true }
})
```

`deferQueue()` uses `waitUntil()` when the runtime provides it. If enqueue fails, Queue logs the failure and calls `onDispatchError` from the queue definition when configured.

```ts
export default defineQueue<WelcomeEmailPayload>(async (job) => {
  console.log(job.payload.email)
}, {
  onDispatchError(error, context) {
    console.error(`Deferred dispatch failed for ${context.name}`, error)
  },
})
```

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
- `src/welcome-email.queue.ts` becomes `welcome-email`
- `src/email/welcome.queue.ts` becomes `email/welcome`
::

::fw{id="nitro:dev nitro:build"}
- `server/queues/welcome-email.ts` becomes `welcome-email`
- `server/queues/email/welcome.ts` becomes `email/welcome`
::

## Next steps

- Use [Enqueue a job](./guides/enqueue-a-job) for full producer examples.
- Use [Handle provider delivery](./guides/handle-provider-delivery) for Cloudflare and Vercel consumer behavior.
- Use [Runtime API](./runtime-api) for exact signatures and exported types.
