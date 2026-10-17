---
title: Queue
navigation.title: Overview
description: Define Queue Definitions, enqueue Queue Jobs, and choose Cloudflare or Vercel Queue Providers.
navigation.order: 1
icon: i-lucide-list-ordered
---

::agent-only{skill="queue"}
Use Queue to send work to a consumer that can run after the request ends. Queue Definitions own consumer code, retries, and concurrency.

Read [Get started](/docs/queue/get-started), [Configure](/docs/queue/configure), [Server API](/docs/queue/server-api), or [Hosts](/docs/queue/hosts).

Treat enqueue as a handoff. Make the job idempotent, keep payloads bounded, and choose retry behavior for the side effect. Queue configuration does not make a job exactly once.

Use a Queue for independent background work, a Schedule for when work starts,
and a Workflow when several durable steps must be inspected together.

Prove enqueue, consumer execution, retry, and a poison or invalid payload. Inspect the Nitro output for the target host.
::

::product-hero{tagline="One runQueue() call sends a job to Cloudflare Queues or Vercel Queues, and the request returns before it runs." hosts="Cloudflare, Vercel"}
  :::code-group
  ```ts [server/api/signup.post.ts]
  import { runQueue } from '@vite-hub/queue'

  export default defineEventHandler(async (event) => {
    const { email } = await readBody<{ email: string }>(event)
    const [error, result] = await runQueue('welcome-email', { email })
    if (error) throw error
    return result
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
  `runQueue()` returns `[error, result]`, and `result.status` is `'queued'` when the provider accepts.
  :::

  :::product-feature-item{title="Typed names, payloads, and options" icon="i-lucide-shield-check" to="/docs/queue/server-api#queue-enqueue-options"}
  Typed from Definitions; an unsupported option returns `QUEUE_UNSUPPORTED_OPTION`.
  :::

  :::product-feature-item{title="A handler must tolerate a second delivery" icon="i-lucide-circle-alert" to="/docs/queue/limits-and-errors"}
  Providers retry failed delivery; ViteHub does not guarantee exactly once.
  :::

  :::product-feature-item{title="Check discovery and Nitro output with a build" icon="i-lucide-terminal" to="/docs/queue/hosts"}
  No local delivery; build and inspect the Wrangler or Vercel output.
  :::

  :::product-feature-item{title="Delayed delivery stays typed" icon="i-lucide-clock-3" to="/docs/queue/server-api"}
  Pass `delaySeconds` when the provider supports delayed jobs.
  :::
::
