---
title: Queue
navigation.title: Overview
description: Send slow work to a queue so your route can reply at once, and run that work later on Cloudflare or Vercel.
navigation.order: 1
icon: i-lucide-list-ordered
---

::product-hero{tagline="Send slow work to a queue so your route replies at once, and the work runs later." hosts="Cloudflare, Vercel"}
  :::product-files
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
  import { defineQueue } from 'vite-hub/queue'

  // The file name is the queue name.
  // This runs later, after the route replies.
  export default defineQueue<{ email: string }>(
    async ({ payload, attempts }) => {
      // Send the email here
      console.log(payload.email, attempts)
    },
  )
  ```

  ```ts [vite.config.ts]
  import { nitro } from 'nitro/vite'
  import { defineConfig } from 'vite'
  import { vitehub } from 'vite-hub'

  export default defineConfig({
    plugins: [
      // Jobs go to Cloudflare Queues
      vitehub({ preset: 'cloudflare', queue: true }),
      nitro() as never,
    ],
  })
  ```

  ```ts [server/api/signup.post.ts]
  import { defineEventHandler, readBody } from 'h3'
  import { runQueue } from 'vite-hub/queue'

  // Returns { status: 'queued' } at once
  export default defineEventHandler(async (event) => {
    const body = await readBody<{ email: string }>(event)
    return runQueue('welcome-email', body)
  })
  ```

  ```ts [server/api/reminder.post.ts]
  import { defineEventHandler, readBody } from 'h3'
  import { runQueue } from 'vite-hub/queue'

  // Run the same job in 10 minutes
  export default defineEventHandler(async (event) => {
    const body = await readBody<{ email: string }>(event)
    return runQueue(
      'welcome-email',
      { email: body.email },
      { delaySeconds: 600 },
    )
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="One file per queue" icon="i-lucide-file-code-2" to="/docs/queue/configure#define-a-queue"}
  Add a file to `server/queues`. Its name is the queue name, and its function runs each job.
  :::

  :::product-feature-item{title="Reply first, work later" icon="i-lucide-list-ordered" to="/docs/queue/server-api#enqueue-work"}
  `runQueue()` returns when the queue accepts the job. The job runs after your route replies.
  :::

  :::product-feature-item{title="Wait before a job runs" icon="i-lucide-clock-3" to="/docs/queue/server-api#queue-enqueue-options"}
  Set `delaySeconds` to start a job later.
  :::product-feature-item{title="Enqueue confirms acceptance, not the handler result" icon="i-lucide-list-ordered" to="/docs/queue/server-api"}
  `runQueue()` returns `[error, result]`, and `result.status` is `'queued'` when the provider accepts.
  :::

  :::product-feature-item{title="Typed names, payloads, and options" icon="i-lucide-shield-check" to="/docs/queue/server-api#queue-enqueue-options"}
  Typed from Definitions; an unsupported option returns `QUEUE_UNSUPPORTED_OPTION`.
  :::

  :::product-feature-item{title="Typed names and data" icon="i-lucide-shield-check" to="/docs/queue/server-api#definition-owned-dispatch-types"}
  A wrong queue name or wrong job data is a type error in your editor.
  :::

  :::product-feature-item{title="Failed jobs run again" icon="i-lucide-refresh-cw" to="/docs/queue/server-api#handle-failures"}
  A job that fails can run again. Write each job so that a second run is safe.
  :::product-feature-item{title="Check discovery and Nitro output with a build" icon="i-lucide-terminal" to="/docs/queue/hosts"}
  No local delivery; build and inspect the Wrangler or Vercel output.
  :::

  :::product-feature-item{title="Cloudflare or Vercel" icon="i-lucide-cloud-cog" to="/docs/queue/configure#providers"}
  Jobs run on Cloudflare Queues or Vercel Queues. They do not run on your own machine.
  :::
::
