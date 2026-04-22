---
title: Queue quickstart
description: Register Queue, define one handler, and enqueue a first job.
navigation.title: Quickstart
frameworks: [vite, nitro]
---

This quickstart keeps the setup small and explicit. It shows the current Queue integration points: Vite handles discovery and build output, and Nitro adds the runtime module you call from routes.

::steps

### Install the package

```bash
pnpm add @vitehub/queue
```

### Register Queue

::fw{id="vite:dev vite:build"}
Register the Vite plugin and choose the provider you deploy to:

::tabs{sync="provider"}
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

    ::callout{to="https://vercel.com/docs/queues"}
    Vercel Queue stays backed by Vercel's hosted queue service. Queue does not create a local in-memory queue for this provider.
    ::
  :::

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

    ::callout{to="https://developers.cloudflare.com/queues/configuration/local-development/"}
    Cloudflare queue development runs locally through Wrangler and Miniflare, which simulate your Worker and queue bindings.
    ::
  :::
::
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module and choose the provider you deploy to:

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

    ::callout{to="https://developers.cloudflare.com/queues/configuration/local-development/"}
    Cloudflare queue development runs locally through Wrangler and Miniflare, which simulate your Worker and queue bindings.
    ::
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

    ::callout{to="https://vercel.com/docs/queues"}
    Vercel Queue stays backed by Vercel's hosted queue service. Queue does not create a local in-memory queue for this provider.
    ::
  :::
::
::

### Define a queue

::fw{id="vite:dev vite:build"}
Create a discovered queue file in `src/**/*.queue.ts`:

```ts [src/welcome-email.queue.ts]
import { defineQueue } from '@vitehub/queue'

type WelcomeEmailPayload = {
  email: string
  template: 'default' | 'vip'
}

export default defineQueue<WelcomeEmailPayload>(async (job) => {
  console.log(`Processing ${job.payload.template} welcome email for ${job.payload.email}`)
})
```
::

::fw{id="nitro:dev nitro:build"}
Create a discovered queue file in `server/queues/**`:

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vitehub/queue'

type WelcomeEmailPayload = {
  email: string
  template: 'default' | 'vip'
}

export default defineQueue<WelcomeEmailPayload>(async (job) => {
  console.log(`Processing ${job.payload.template} welcome email for ${job.payload.email}`)
})
```
::

### Enqueue a job

::fw{id="vite:dev vite:build"}
Add a small Vite server entry that calls Queue:

```ts [src/server.ts]
import { H3, readBody } from 'h3'

import { runQueue } from '@vitehub/queue'

type WelcomeEmailPayload = {
  email: string
  template: 'default' | 'vip'
}

const app = new H3()

app.post('/api/welcome', async (event) => {
  const payload = await readBody<WelcomeEmailPayload>(event)

  // Use deferQueue('welcome-email', payload) when you do not need a promise.
  return { ok: true, payload, result: await runQueue('welcome-email', payload) }
})

export default app
```

Then call that route from `src/main.ts`:

```ts [src/main.ts]
const response = await fetch('/api/welcome', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'ava@example.com',
    template: 'vip',
  }),
})

console.log(await response.json())
```

Then run:

```bash
pnpm vite build
```

Queue discovers `src/**/*.queue.ts`, bundles the server entry, and emits provider-specific outputs.
::

::fw{id="nitro:dev nitro:build"}
Add one route that enqueues the discovered queue:

```ts [server/api/welcome.post.ts]
import { runQueue } from '@vitehub/queue'

type WelcomeEmailPayload = {
  email: string
  template: 'default' | 'vip'
}

export default defineEventHandler(async (event) => {
  const payload = await readBody<WelcomeEmailPayload>(event)

  // Use deferQueue('welcome-email', payload) when you do not need a promise.
  return { ok: true, payload, result: await runQueue('welcome-email', payload) }
})
```

Start the app and send one request:

```bash
pnpm nitro dev
curl -X POST http://localhost:3000/api/welcome \
  -H 'content-type: application/json' \
  -d '{"email":"ava@example.com","template":"vip"}'
```
::

::

## What to read next

- Use [Usage](./usage) for `deferQueue()`, enqueue envelopes, and provider handles.
- Use [Runtime API](./runtime-api) for the exact exports and types.
- Use [Cloudflare](./providers/cloudflare) or [Vercel](./providers/vercel) for provider-specific behavior.
