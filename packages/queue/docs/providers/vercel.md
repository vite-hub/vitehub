---
title: Vercel Queue
description: Configure @vitehub/queue to publish to Vercel Queue topics and process hosted callback functions.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 20
icon: i-simple-icons-vercel
frameworks: [vite, nitro]
---

Use the Vercel provider when queue publishing and callback handling should stay inside a Vercel deployment.

Vercel needs the `@vercel/queue` package and a resolvable region. ViteHub derives topics from discovered queue names and generates hosted callback functions for each queue.

::steps{level="2"}

## Install the provider SDK

```bash
pnpm add @vercel/queue
```

## Configure Queue

::fw{id="vite:dev vite:build"}
Register the Vite plugin and set `queue.provider` to `vercel`:

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
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module and set `queue.provider` to `vercel`:

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
::

## Resolve the region

Set `queue.region` when you want an explicit send region.

Queue resolves the Vercel region in this order:

1. `queue.region`
2. `QUEUE_REGION`
3. `VERCEL_REGION`
4. Vercel request headers

If Queue cannot resolve a region for the current `@vercel/queue` client, the provider throws `VERCEL_QUEUE_REGION_REQUIRED`.

## Understand topic names

Queue derives Vercel topics from discovered queue names.

For `welcome-email`:

| Value | Result |
| --- | --- |
| Discovered queue name | `welcome-email` |
| Vercel topic | `topic--77656c636f6d652d656d61696c` |

Use `getVercelQueueTopicName()` when another integration needs the exact topic:

```ts
import { getVercelQueueTopicName } from '@vitehub/queue'

console.log(getVercelQueueTopicName('welcome-email'))
```

## Use hosted callbacks

ViteHub generates hosted callback functions for discovered queues during provider output generation.

The generated callback:

1. Loads the queue definition from the registry.
2. Resolves the active Vercel queue client.
3. Calls `handleHostedVercelQueueCallback()`.
4. Delivers the payload to your `defineQueue()` handler.

You can also wire the callback manually when needed:

```ts
import { handleHostedVercelQueueCallback } from '@vitehub/queue'
import definition from '../../queues/welcome-email'

export default defineEventHandler((event) => {
  return handleHostedVercelQueueCallback(event, 'welcome-email', definition)
})
```

## Tune callback behavior

Use `callbackOptions` on the queue definition:

```ts
import { defineQueue } from '@vitehub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  console.log(job.payload.email)
}, {
  callbackOptions: {
    visibilityTimeoutSeconds: 60,
    retry(error, metadata) {
      return { afterSeconds: 30 }
    },
  },
})
```

Return `{ acknowledge: true }` from `retry()` when a failed message should be acknowledged instead of retried.

## Generated output

::fw{id="vite:build"}
Vite writes Vercel Build Output under `.vercel/output`, including the main server function and one queue callback function per discovered queue.
::

::fw{id="nitro:build"}
For Vercel Nitro presets, the module writes queue callback functions under `.output/functions/api/vitehub/queues/vercel`.
::

Each generated callback function includes a Vercel queue trigger for the derived topic.

## Verify the provider

Call a route that enqueues a known queue:

```bash
curl -X POST http://localhost:3000/api/welcome \
  -H 'content-type: application/json' \
  -d '{"email":"ava@example.com","template":"vip"}'
```

Successful publishing returns a queued result:

```json
{
  "ok": true,
  "result": {
    "status": "queued",
    "messageId": "message-1"
  }
}
```

::

## Common failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `@vercel/queue load failed` | The provider SDK is not installed. | Run `pnpm add @vercel/queue`. |
| `VERCEL_QUEUE_REGION_REQUIRED` | No region was configured or detected. | Set `queue.region`, `QUEUE_REGION`, or `VERCEL_REGION`. |
| `Vercel queue topics are derived from discovered queue names` | A direct Vercel client was created without a topic. | Use `getQueue(name)` or pass a topic to `createQueueClient()`. |
| `Vercel queue does not support enqueue options: contentType` | The send envelope includes a Cloudflare-only field. | Remove `contentType`. |

## Related pages

- [Quickstart](../quickstart)
- [Handle provider delivery](../guides/handle-provider-delivery)
- [Troubleshooting](../troubleshooting)
