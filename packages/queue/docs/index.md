---
title: Queue
description: Enqueue background work from Vite and Nitro with one portable API and provider-managed delivery.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-list-ordered
frameworks: [vite, nitro]
---

`@vitehub/queue` gives Vite and Nitro apps one way to define background job handlers, enqueue work from request code, and deliver those jobs through Cloudflare Queues or Vercel Queue.

Use Queue when the request should return before the work finishes. The application keeps a small typed enqueue call. The provider handles delivery, retry behavior, and callback execution.

::code-group
```ts [server/api/welcome.post.ts]
import { runQueue } from '@vitehub/queue'
import type { WelcomeEmailPayload } from '../queues/welcome-email'

export default defineEventHandler(async (event) => {
  const payload = await readBody<WelcomeEmailPayload>(event)
  const result = await runQueue('welcome-email', payload)

  return { ok: true, result }
})
```

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vitehub/queue'

export type WelcomeEmailPayload = {
  email: string
  template: 'default' | 'vip'
}

export default defineQueue<WelcomeEmailPayload>(async (job) => {
  console.log(`Processing ${job.payload.template} welcome email for ${job.payload.email}`)
})
```

```json [Response]
{
  "ok": true,
  "result": {
    "status": "queued",
    "messageId": "queue_7f1b6f8e-7b5c-4c5e-b3a1-8d6a4b3d4c2a"
  }
}
```
::

## What Queue solves

Inline request work is the simplest option until the work can happen after the response, needs provider-managed retry, or should move behind a named background boundary.

Queue moves that work behind a discovered definition:

::card-group
  :::card
  ---
  icon: i-lucide-send
  title: Fast request paths
  ---
  Enqueue a job and return an application response without waiting for the handler to finish.
  :::

  :::card
  ---
  icon: i-lucide-route
  title: Portable producers
  ---
  Keep `runQueue()` and `deferQueue()` calls the same while provider setup stays in framework config.
  :::

  :::card
  ---
  icon: i-lucide-repeat-2
  title: Provider delivery
  ---
  Use Cloudflare or Vercel queue infrastructure for delivery, delayed sends, callbacks, and retries.
  :::

  :::card
  ---
  icon: i-lucide-file-code-2
  title: Discovered handlers
  ---
  Let ViteHub find queue files and generate the runtime registry for the active framework.
  :::
::

## One portable flow

The same shape works across providers:

1. Register the Vite plugin or Nitro module.
2. Choose `cloudflare` or `vercel` in `queue.provider`.
3. Define a named queue with `defineQueue()`.
4. Enqueue work with `runQueue(name, payload)`.
5. Use `deferQueue(name, payload)` when dispatch can happen after the response.

::callout{icon="i-lucide-info" color="info"}
Provider-specific setup belongs in app config and deployment output. Queue definitions and producer calls should stay provider-neutral whenever possible.
::

## Discovery model

::fw{id="vite:dev vite:build"}
Vite discovers queue definitions from `src/**/*.queue.ts`.

The queue name comes from the path under `src`, without the `.queue` suffix. `src/email/welcome.queue.ts` becomes `email/welcome`.
::

::fw{id="nitro:dev nitro:build"}
Nitro discovers queue definitions from `server/queues/**`.

The queue name comes from the path under `server/queues`, without the file extension. `server/queues/email/welcome.ts` becomes `email/welcome`.
::

## Supported providers

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Cloudflare
  description: Use Cloudflare Queues with generated producer bindings and batch consumers.
  icon: i-simple-icons-cloudflare
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Use Vercel Queue with generated topics and hosted callback functions.
  icon: i-simple-icons-vercel
  to: ./providers/vercel
  ---
  :::
::

## Start here

Start with [Quickstart](./quickstart) for the smallest complete setup. Use the [primitive comparison](../compare) when you are deciding between KV, Blob, Queue, Sandbox, or inline request code.

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Define a welcome-email queue and enqueue it from a route.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Use typed jobs, enqueue envelopes, deferred dispatch, and provider clients.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exports, signatures, options, and provider-specific helpers.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Troubleshooting
  description: Fix unknown queues, missing bindings, Vercel regions, and unsupported options.
  to: ./troubleshooting
  ---
  :::
::
