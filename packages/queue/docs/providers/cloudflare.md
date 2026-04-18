---
title: Cloudflare Queue
description: Configure @vitehub/queue for Cloudflare Queues.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 10
icon: i-simple-icons-cloudflare
---

Use Cloudflare Queue when producers and consumers should run on Cloudflare Workers.

## Configuration

::fw{id="vite:dev vite:build"}
The Vite entrypoint registers bridge config. Use Nitro or Nuxt for discovered runtime queue handlers.

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
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/queue/nitro'],
  queue: {
    provider: 'cloudflare',
  },
})
```
::

::fw{id="nuxt:dev nuxt:build"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/queue/nuxt'],
  queue: {
    provider: 'cloudflare',
  },
})
```
::

On Cloudflare hosting, ViteHub can infer this provider when `queue.provider` is omitted.

## Bindings

ViteHub derives one queue binding per discovered queue by hex-encoding the queue name. For `server/queues/welcome-email.ts`, the queue name is `welcome-email` and the generated binding is `QUEUE_77656C636F6D652D656D61696C`.

The Nitro module registers Wrangler queue producers and consumers:

```json
{
  "queues": {
    "producers": [{ "binding": "QUEUE_77656C636F6D652D656D61696C", "queue": "welcome-email" }],
    "consumers": [{ "queue": "welcome-email" }]
  }
}
```

Set `queue.binding` only when you have a single queue and need a specific binding name.

## Handler behavior

Cloudflare sends batches to the Worker queue handler. ViteHub maps each Cloudflare message to a `QueueJob`, calls the discovered queue handler, and acknowledges the message when the handler succeeds.

If the handler throws, ViteHub retries the message unless `onError` returns `ack`, `retry`, or `{ retry }`.

## Related

- [Overview](../index)
- [Quickstart](../quickstart)
- [Runtime API](../runtime-api)
