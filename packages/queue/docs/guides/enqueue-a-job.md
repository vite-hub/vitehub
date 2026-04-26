---
title: Enqueue a job
description: Call a discovered queue from Vite or Nitro server code and return a clear application response.
navigation.title: Enqueue a job
navigation.group: Guides
navigation.order: 30
icon: i-lucide-send
frameworks: [vite, nitro]
---

This guide focuses on the producer-side call. It assumes Queue is already registered and a `welcome-email` definition exists.

## Call pattern

Every producer follows the same shape:

1. Read or build a payload.
2. Call `runQueue(name, payload)`.
3. Return the `QueueSendResult`.

::fw{id="vite:dev vite:build"}
```ts [src/server.ts]
import { H3, readBody } from 'h3'
import { runQueue } from '@vitehub/queue'
import type { WelcomeEmailPayload } from './welcome-email.queue'

const app = new H3()

app.post('/api/welcome', async (event) => {
  const payload = await readBody<WelcomeEmailPayload>(event)
  const result = await runQueue('welcome-email', payload)

  return { ok: true, result }
})

export default app
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/api/welcome.post.ts]
import { runQueue } from '@vitehub/queue'
import type { WelcomeEmailPayload } from '../queues/welcome-email'

export default defineEventHandler(async (event) => {
  const payload = await readBody<WelcomeEmailPayload>(event)
  const result = await runQueue('welcome-email', payload)

  return { ok: true, result }
})
```
::

## Add delivery options

Use an enqueue envelope when the send needs provider options:

```ts
const result = await runQueue('welcome-email', {
  id: 'welcome-email-1',
  payload: {
    email: 'ava@example.com',
    template: 'vip',
  },
  delaySeconds: 30,
})
```

Keep provider-specific fields out of shared helper code unless the helper is intentionally provider-specific.

## Defer the enqueue call

Use `deferQueue()` when the route does not need the queued result:

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

The runtime uses `waitUntil()` when available, so the response can finish while the enqueue promise continues.

## Verify the route

```bash
curl -X POST http://localhost:3000/api/welcome \
  -H 'content-type: application/json' \
  -d '{"email":"ava@example.com","template":"vip"}'
```

Expected response:

```json
{
  "ok": true,
  "result": {
    "status": "queued",
    "messageId": "queue_7f1b6f8e-7b5c-4c5e-b3a1-8d6a4b3d4c2a"
  }
}
```

## Avoid these mistakes

| Mistake | Fix |
| --- | --- |
| Expecting `runQueue()` to return the handler result | Treat it as a provider send result only. |
| Calling a name that does not match discovery | Check the queue file path and generated queue name. |
| Passing provider-only fields everywhere | Keep `contentType`, `idempotencyKey`, `region`, and `retentionSeconds` close to provider-aware code. |

## Related pages

- [Quickstart](../quickstart)
- [Usage](../usage)
- [Runtime API](../runtime-api)
