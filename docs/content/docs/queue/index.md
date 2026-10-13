---
title: Queue
navigation.title: Overview
description: Define Queue Definitions, enqueue Queue Jobs, and choose Cloudflare or Vercel Queue Providers.
navigation.order: 1
icon: i-lucide-list-ordered
---

::product-hero{tagline="One runQueue() call sends a job to Cloudflare Queues or Vercel Queues, and the request returns before it runs." hosts="Cloudflare, Vercel"}
  :::code-group
  ```ts [server/api/signup.post.ts]
  import { runQueue } from '@vite-hub/queue'

  export default defineEventHandler(async (event) => {
    const { email } = await readBody<{ email: string }>(event)
    return await runQueue('welcome-email', { email })
  })
  ```

  ```ts [server/queues/welcome-email.ts]
  import { defineQueue } from '@vite-hub/queue'

  export default defineQueue<{ email: string }>(async ({ payload }) => {
    await sendWelcomeEmail(payload.email)
  })
  ```

  ```ts [vite.config.ts]
  import { hubQueue } from '@vite-hub/queue/vite'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [hubQueue({ provider: 'cloudflare' })],
  })
  ```

  ```bash [Terminal]
  pnpm add vite-hub
  pnpm vite build
  pnpm vitehub inspect definitions --kind queue
  ```
  :::
::


::product-features
  :::product-feature-item{title="The file name is the queue name" icon="i-lucide-code-2" to="/docs/queue/configure"}
  `server/queues/<name>.ts` defines the queue; ViteHub generates provider names.
  :::

  :::product-feature-item{title="Enqueue confirms acceptance, not the handler result" icon="i-lucide-list-ordered" to="/docs/queue/server-api"}
  `runQueue()` resolves with `status: 'queued'` when the provider accepts.
  :::

  :::product-feature-item{title="Typed names, payloads, and options" icon="i-lucide-shield-check" to="/docs/queue/server-api#queue-enqueue-options"}
  Typed from Definitions; an unsupported option throws `ViteHubError`.
  :::

  :::product-feature-item{title="A handler must tolerate a second delivery" icon="i-lucide-circle-alert" to="/docs/queue/limits-and-errors"}
  Providers retry failed delivery; ViteHub does not guarantee exactly once.
  :::

  :::product-feature-item{title="Check discovery and provider output with a build" icon="i-lucide-terminal" to="/docs/queue/hosts"}
  No local delivery; build and inspect the Wrangler or Vercel output.
  :::

  :::product-feature-item{title="Delayed delivery stays typed" icon="i-lucide-clock-3" to="/docs/queue/server-api"}
  Pass `delaySeconds` when the provider supports delayed jobs.
  :::
::
