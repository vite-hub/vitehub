---
title: Cloudflare Queue
description: Configure Queue for Cloudflare bindings and Workers queue processing.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 10
icon: i-logos-cloudflare-icon
frameworks: [vite, nitro]
---

Use Cloudflare when producers and consumers should run through Cloudflare Queues.

## Configure the provider

Set `queue.provider = 'cloudflare'`. Add `queue.binding` only when you want to override the derived binding name.

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubQueue } from '@vitehub/queue/vite'

export default defineConfig({
  plugins: [hubQueue()],
  queue: {
    provider: 'cloudflare',
    binding: 'WELCOME_EMAIL',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
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

## Binding naming

Queue derives Cloudflare names from the discovered queue name:

- queue name: `welcome-email`
- Cloudflare queue name: `queue--77656c636f6d652d656d61696c`
- default binding: `QUEUE_77656C636F6D652D656D61696C`

Use `getCloudflareQueueName()` and `getCloudflareQueueBindingName()` when you need the exact derived values in your own integration code.

## Batch processing

Cloudflare delivers batches of messages. Queue exposes `createCloudflareQueueBatchHandler()` so you can turn a message-level callback into a Cloudflare batch handler with optional concurrency and retry control.

```ts
import { createCloudflareQueueBatchHandler } from '@vitehub/queue'

export default createCloudflareQueueBatchHandler({
  concurrency: 4,
  async onMessage(message) {
    console.log(message.body)
  },
})
```

## Queue definition options

Cloudflare-specific definition options:

| Option | Purpose |
| --- | --- |
| `concurrency` | Limits concurrent message processing inside a batch. |
| `onError` | Chooses whether a failed message is acknowledged or retried. |

## Related pages

- [Overview](../index)
- [Quickstart](../quickstart)
- [Runtime API](../runtime-api)
