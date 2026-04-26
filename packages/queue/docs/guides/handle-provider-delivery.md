---
title: Handle provider delivery
description: Understand how Cloudflare batches and Vercel callbacks invoke discovered queue definitions.
navigation.title: Handle provider delivery
navigation.group: Guides
navigation.order: 31
icon: i-lucide-inbox
frameworks: [vite, nitro]
---

Queue producers send messages. Providers deliver those messages later. ViteHub connects provider delivery back to your discovered `defineQueue()` handler.

## Handler shape

Every provider delivers the same `QueueJob` shape to your definition:

```ts
import { defineQueue } from '@vitehub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  console.log(job.id)
  console.log(job.attempts)
  console.log(job.payload.email)
})
```

Use `job.metadata` only for provider-specific diagnostics or advanced integrations.

## Cloudflare batches

Cloudflare calls a Worker `queue()` handler with a batch. ViteHub maps the encoded Cloudflare queue name back to the discovered queue name and invokes the matching definition for each message.

Set `concurrency` when one batch should process more than one message at a time:

```ts
export default defineQueue<{ email: string }>(async (job) => {
  await sendWelcomeEmail(job.payload.email)
}, {
  concurrency: 4,
})
```

Control failed messages with `onError`:

```ts
export default defineQueue(handler, {
  onError(error, message) {
    if (message.attempts >= 3) {
      return 'ack'
    }

    return { retry: { delaySeconds: 60 } }
  },
})
```

If `onError` returns nothing, Queue retries the message.

## Vercel callbacks

Vercel calls a hosted callback function for the derived topic. ViteHub's generated callback loads the definition and passes the callback payload to the handler.

Set `callbackOptions` when you need Vercel callback retry behavior:

```ts
export default defineQueue<{ email: string }>(async (job) => {
  await sendWelcomeEmail(job.payload.email)
}, {
  callbackOptions: {
    visibilityTimeoutSeconds: 60,
    retry(error, metadata) {
      return { afterSeconds: 30 }
    },
  },
})
```

Return `{ acknowledge: true }` from `retry()` when the failed callback should be acknowledged.

## Manual provider helpers

Most apps use the generated output. Use provider helpers only when wiring custom runtime entries.

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts
    import { createCloudflareQueueBatchHandler } from '@vitehub/queue'

    export default createCloudflareQueueBatchHandler({
      concurrency: 4,
      async onMessage(message) {
        console.log(message.body)
      },
    })
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
    ```ts
    import { handleHostedVercelQueueCallback } from '@vitehub/queue'
    import definition from '../../queues/welcome-email'

    export default defineEventHandler((event) => {
      return handleHostedVercelQueueCallback(event, 'welcome-email', definition)
    })
    ```
  :::
::

## Related pages

- [Cloudflare](../providers/cloudflare)
- [Vercel](../providers/vercel)
- [Runtime API](../runtime-api)
