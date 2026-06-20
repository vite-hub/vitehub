---
title: Queue
description: Enqueue background jobs and let a Queue Provider deliver them to a Queue Definition.
navigation.order: 9
icon: i-lucide-list-ordered
---

Queue owns background delivery. Use it when a request should enqueue work and return before the work finishes.

Queue is not Workflow. Queue Enqueue means the provider accepted the job; Queue Delivery later invokes the Queue Definition. Use [Workflows](/docs/server-primitives/workflows) when work needs durable orchestration, run state, waits, or inspectable progress.

## Define a queue

Create a Queue Definition for provider-delivered work.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  await sendWelcomeEmail(job.payload.email)
})
```

The queue name comes from discovery. This file is addressed as `welcome-email` by Runtime Helpers.

## Enqueue work

Use `runQueue()` from server code to enqueue a job.

```ts [server/api/signup.post.ts]
import { runQueue } from '@vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)

  return runQueue('welcome-email', {
    payload: { email: body.email },
    idempotencyKey: `welcome:${body.email}`,
  })
})
```

The result describes enqueue status, not the handler result.

## Delivery behavior

Queue Providers decide delivery timing, retry behavior, and provider-specific message metadata. Queue handlers should be idempotent and tolerate retry.

Good queue jobs include emails, webhook fan-out, report generation after upload, and short external sync work. Use Workflow for long-running state machines or work that needs durable checkpoints.

## Provider output

The Queue Package discovers Queue Definitions, generates provider consumers, and hides provider-specific delivery details behind the Queue Provider boundary. Cloudflare queue bindings and Vercel queue topics belong in configuration and generated host output, not in job handlers.

Queue delay, region, retention, and idempotency are Queue Enqueue options when a provider supports them.

## Connect it to Agents

Queue is a server primitive, not an Agent Capability by default. An Agent can enqueue work only when you expose that behavior through an app-owned Capability or server route.

Keep the Capability boundary product-specific. A model should not receive arbitrary queue access just because the app uses Queue internally.

## Next steps

- Use [Workflows](/docs/server-primitives/workflows) for durable orchestration.
- Learn shared discovery rules in [Definitions and discovery](/docs/concepts/definitions-and-discovery).
- Expose app-owned agent actions through [Custom capabilities](/docs/capabilities/custom-capabilities).
