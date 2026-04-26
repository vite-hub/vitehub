---
title: Queue quickstart
description: Register Queue, define a welcome-email handler, enqueue a job from a route, and verify the queued response.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide creates one `welcome-email` queue. The route accepts an email payload, enqueues a background job, and returns a JSON response before the queue handler runs.

The provider is the only part that changes between Cloudflare and Vercel. The queue definition and producer call stay the same.

::code-collapse

```txt [Prompt]
Set up @vitehub/queue in this app.

- Install @vitehub/queue and @vercel/queue when using the Vercel provider
- Register hubQueue() for Vite or @vitehub/queue/nitro for Nitro
- Configure queue.provider as cloudflare or vercel
- Define welcome-email as a discovered queue
- Call runQueue('welcome-email', payload) from a route
- Return the queued result to the caller

Docs: /docs/vite/queue/quickstart or /docs/nitro/queue/quickstart
```

::

::steps

### Install Queue

```bash
pnpm add @vitehub/queue
```

Install the Vercel SDK when Vercel will publish or process the queue:

```bash [Vercel]
pnpm add @vercel/queue
```

Cloudflare uses runtime queue bindings and does not need an extra queue SDK.

### Register the integration

::fw{id="vite:dev vite:build"}
Register the Vite plugin and choose the provider:

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
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
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
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
  :::
::
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module and choose the provider:

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts [nitro.config.ts]
    import { defineNitroConfig } from 'nitro/config'

    export default defineNitroConfig({
      modules: ['@vitehub/queue/nitro'],
      queue: {
        provider: 'cloudflare',
      },
    })
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
    ```ts [nitro.config.ts]
    import { defineNitroConfig } from 'nitro/config'

    export default defineNitroConfig({
      modules: ['@vitehub/queue/nitro'],
      queue: {
        provider: 'vercel',
        region: 'fra1',
      },
    })
    ```
  :::
::
::

### Define the queue

::fw{id="vite:dev vite:build"}
Create a discovered Vite queue file:

```ts [src/welcome-email.queue.ts]
import { defineQueue } from '@vitehub/queue'

export type WelcomeEmailPayload = {
  email: string
  template: 'default' | 'vip'
}

export default defineQueue<WelcomeEmailPayload>(async (job) => {
  console.log(`Queued ${job.payload.template} welcome email for ${job.payload.email}`)
})
```
::

::fw{id="nitro:dev nitro:build"}
Create a discovered Nitro queue file:

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
::

### Enqueue from a route

::fw{id="vite:dev vite:build"}
Add a Vite server entry that reads the request body and enqueues the named queue:

```ts [src/server.ts]
import { H3, readBody } from 'h3'
import { runQueue } from '@vitehub/queue'
import type { WelcomeEmailPayload } from './welcome-email.queue'

const app = new H3()

app.post('/api/welcome', async (event) => {
  const payload = await readBody<WelcomeEmailPayload>(event)
  const result = await runQueue('welcome-email', payload)

  return { ok: true, payload, result }
})

export default app
```
::

::fw{id="nitro:dev nitro:build"}
Add a Nitro route that reads the request body and enqueues the named queue:

```ts [server/api/welcome.post.ts]
import { runQueue } from '@vitehub/queue'
import type { WelcomeEmailPayload } from '../queues/welcome-email'

export default defineEventHandler(async (event) => {
  const payload = await readBody<WelcomeEmailPayload>(event)
  const result = await runQueue('welcome-email', payload)

  return { ok: true, payload, result }
})
```
::

### Verify the response

Run or deploy the app with a configured provider, then send a request:

```bash
curl -X POST http://localhost:3000/api/welcome \
  -H 'content-type: application/json' \
  -d '{"email":"ava@example.com","template":"vip"}'
```

The route returns the enqueue result:

```json
{
  "ok": true,
  "payload": {
    "email": "ava@example.com",
    "template": "vip"
  },
  "result": {
    "status": "queued",
    "messageId": "queue_7f1b6f8e-7b5c-4c5e-b3a1-8d6a4b3d4c2a"
  }
}
```

::
