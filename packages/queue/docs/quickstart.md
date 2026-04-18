---
title: Queue quickstart
description: Define and enqueue a first queue job.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-rocket
---

This quickstart uses the Cloudflare provider. Use the Vercel provider page when your deployment target is Vercel Queues.

## Configure Queue

::fw{id="vite:dev vite:build"}
The Vite entrypoint registers the Queue bridge for ViteHub environments. Runtime queue discovery and handlers currently require Nitro or Nuxt.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubQueue } from '@vitehub/queue/vite'

export default defineConfig({
  plugins: [hubQueue()],
  queue: {
    provider: 'cloudflare',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/queue/nitro'],
  queue: {
    provider: 'cloudflare',
  },
})
```
::

::fw{id="nuxt:dev nuxt:build"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/queue/nuxt'],
  queue: {
    provider: 'cloudflare',
  },
})
```
::

## Define a queue

::fw{id="vite:dev vite:build"}
Plain Vite processes do not discover queue handlers by themselves in this release. Use Nitro or Nuxt when you need runtime queue handlers.
::

::fw{id="nitro:dev nitro:build nuxt:dev nuxt:build"}
Create a queue definition under `server/queues`.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vitehub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  console.log(`Queued welcome email for ${job.payload.email}`)
})
```
::

## Send a job

::fw{id="vite:dev vite:build"}
Use the Nitro or Nuxt setup when you need the runtime `runQueue()` path.
::

::fw{id="nitro:dev nitro:build nuxt:dev nuxt:build"}
```ts [server/api/queues/welcome.post.ts]
import { runQueue } from '@vitehub/queue'

export default defineEventHandler(async () => {
  return await runQueue('welcome-email', {
    id: 'welcome-ava',
    payload: { email: 'ava@example.com' },
    delaySeconds: 5,
  })
})
```
::

## Verify the result

Start the app and send one request:

```bash [Terminal]
curl -X POST http://localhost:3000/api/queues/welcome
```

With the Cloudflare provider, the route returns a queued result and Cloudflare dispatches the handler through its queue consumer.

## Next steps

- Use [Usage](./usage) for `runQueue()` and `deferQueue()` patterns.
- Use [Runtime API](./runtime-api) for the complete public surface.
- Move to [Cloudflare](./providers/cloudflare) or [Vercel](./providers/vercel) for hosted queues.
