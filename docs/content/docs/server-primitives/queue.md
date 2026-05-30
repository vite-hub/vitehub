---
title: Queue
description: Move work outside the response path and let the host deliver jobs to a consumer.
navigation.order: 8
icon: i-lucide-list-ordered
---

Queue is the primitive for background delivery. Use it when a request should enqueue work and return before the work finishes.

Use Workflow when the work needs durable steps, waits, retries, or inspectable run state. Queue is about delivery.

## Define a queue

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  await sendWelcomeEmail(job.payload.email)
})
```

The queue name comes from discovery. In this example, server code calls `welcome-email`.

## Enqueue work

```ts [server/api/signup.post.ts]
import { runQueue } from '@vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)
  return runQueue('welcome-email', body)
})
```

Keep the route small: validate input, enqueue work, return a result.

## Delivery semantics

Queue delivery is host-specific. Your handler should be idempotent and should tolerate retry.

Good queue jobs:

- Send an email.
- Fan out webhook processing.
- Generate a report after upload.
- Sync a record into another service.

Poor queue jobs:

- Multi-step orchestration with waits.
- User-visible state machines.
- Work that must expose progress and resume points.

Use [Workflow](/docs/server-primitives/workflow) for those.

## Cloudflare Queue binding

Cloudflare queue setup needs queue bindings and generated consumer output. Keep the binding details in configuration. The queue handler should stay host-neutral.

## Vercel Queue topic

Vercel queue setup needs topic and region configuration. Keep region and token setup out of the job handler.
