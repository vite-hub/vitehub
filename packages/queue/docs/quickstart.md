---
title: Queue quickstart
description: Register Queue, define one handler, and enqueue a first job.
navigation.title: Quickstart
frameworks: [vite, nitro]
---

This quickstart keeps the setup small and explicit. It shows the current Queue integration points: Vite handles discovery and build output, and Nitro adds the runtime module you call from routes.

## Install the package

```bash
pnpm add @vitehub/queue
```

## Register Queue

::fw{id="vite:dev vite:build"}
Register the Vite plugin and pick a provider explicitly:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubQueue } from '@vitehub/queue/vite'

export default defineConfig({
  plugins: [hubQueue()],
  queue: {
    provider: 'vercel',
    region: 'fra1',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module and pick a provider explicitly:

```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/queue/nitro'],
  queue: {
    provider: 'cloudflare',
    binding: 'WELCOME_EMAIL',
  },
})
```
::

## Define a queue

::fw{id="vite:dev vite:build"}
Create a discovered queue file in `src/**/*.queue.ts`:

```ts [src/welcome-email.queue.ts]
import { defineQueue } from '@vitehub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  console.log(`Processing welcome email for ${job.payload.email}`)
})
```
::

::fw{id="nitro:dev nitro:build"}
Create a discovered queue file in `server/queues/**`:

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vitehub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  console.log(`Processing welcome email for ${job.payload.email}`)
})
```
::

## Enqueue a job

::fw{id="vite:dev vite:build"}
Vite provides discovery and build integration. Keep a normal app entry and build the project so Queue can emit provider-specific outputs:

```ts [src/main.ts]
console.log('Queue definitions are discovered during build.')
```

Then run:

```bash
pnpm vite build
```

Use the provider pages when you need the deployed runtime wiring for Cloudflare or Vercel.
::

::fw{id="nitro:dev nitro:build"}
Add a small route that enqueues the discovered queue:

```ts [server/api/queues/welcome.post.ts]
import { runQueue } from '@vitehub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string }>(event)

  return {
    ok: true,
    result: await runQueue('welcome-email', {
      email: body?.email || 'ava@example.com',
    }),
  }
})
```

Start the app and send one request:

```bash
pnpm nitro dev
curl -X POST http://localhost:3000/api/queues/welcome \
  -H 'content-type: application/json' \
  -d '{"email":"ava@example.com"}'
```
::

## What to read next

- Use [Usage](./usage) for `deferQueue()`, enqueue envelopes, and provider handles.
- Use [Runtime API](./runtime-api) for the exact exports and types.
- Use [Cloudflare](./providers/cloudflare) or [Vercel](./providers/vercel) for provider-specific behavior.
