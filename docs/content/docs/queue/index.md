---
title: Queue
layout: landing
navigation.title: Overview
description: Send slow work to a queue so your route can reply at once, and run that work later on Cloudflare or Vercel.
navigation.order: 1
icon: i-lucide-list-ordered
---

::product-hero{tagline="Send slow work to a queue so your route replies at once, and the work runs later." hosts="Node, Docker, Cloudflare, Vercel"}
  :hero-figure{name="queue"}
::

::code-tree{feature="queue"}
```ts [server/api/signup.post.ts]
import { defineEventHandler, readValidatedBody } from 'h3'
import * as v from 'valibot'
import { sendQueue } from 'vite-hub/queue'

// Returns when the queue accepts the job, before it runs
export default defineEventHandler(async (event) => {
  const { email } = await readValidatedBody(event, body => v.parse(v.object({ email: v.string() }), body))
  const [error, result] = await sendQueue('welcome-email', { email })
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

```ts [server/api/reminder.post.ts]
import { defineEventHandler, readValidatedBody } from 'h3'
import * as v from 'valibot'
import { sendQueue } from 'vite-hub/queue'

// Run the same job in 10 minutes
export default defineEventHandler(async (event) => {
  const { email } = await readValidatedBody(event, body => v.parse(v.object({ email: v.string() }), body))
  const [error, result] = await sendQueue('welcome-email', { email }, { delaySeconds: 600 })
  if (error) throw error
  return result
})
```

:::framework{name="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'cloudflare',
    // On Cloudflare, jobs go to Cloudflare Queues
    queue: true,
  },
})
```
:::
:::framework{name="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'cloudflare',
      // On Cloudflare, jobs go to Cloudflare Queues
      queue: true,
    }),
    nitro(),
  ],
})
```
:::
:::framework{name="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'cloudflare',
      // On Cloudflare, jobs go to Cloudflare Queues
      queue: true,
    }),
  ],
})
```
:::
::

::product-features
  :::product-feature-item{title="One file per queue" icon="i-lucide-file-code-2" to="/docs/queue/configure#define-a-queue"}
  Add a file to `server/queues`. The file name is the queue name, and its function runs each job.
  :::

  :::product-feature-item{title="Reply first, work later" icon="i-lucide-list-ordered" to="/docs/queue/server-api#enqueue-work"}
  `sendQueue()` returns when the queue accepts the job. The job runs after your route replies.
  :::

  :::product-feature-item{title="Wait before a job runs" icon="i-lucide-clock-3" to="/docs/queue/server-api#queue-enqueue-options"}
  Set `delaySeconds` to start a job later.
  :::

  :::product-feature-item{title="Typed names and data" icon="i-lucide-shield-check" to="/docs/queue/server-api#definition-owned-dispatch-types"}
  A wrong queue name or wrong job data is a type error in your editor.
  :::

  :::product-feature-item{title="Failed jobs run again" icon="i-lucide-refresh-cw" to="/docs/queue/server-api#handle-failures"}
  A failed job can run again, so make a second run safe.
  :::

  :::product-feature-item{title="Node, Cloudflare, or Vercel" icon="i-lucide-cloud-cog" to="/docs/queue/configure#providers"}
  On Node, jobs run in the server process, on one instance only. On Cloudflare and Vercel, they run on Cloudflare Queues or Vercel Queues.
  :::
::

::agent-only{skill="queue"}
Use Queue to send work to a consumer that can run after the request ends. Queue Definitions own consumer code, retries, and concurrency.

Treat enqueue as a handoff. Make the job idempotent, keep payloads bounded, and choose retry behavior for the side effect. Queue configuration does not make a job exactly once.

Use a Queue for independent background work, a Schedule for when work starts,
and a Workflow when several durable steps must be inspected together.

Prove enqueue, consumer execution, retry, and a poison or invalid payload. Inspect the Nitro output for the target host.
::
