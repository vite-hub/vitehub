---
title: Cloudflare Queue
description: Configure @vitehub/queue to publish through Cloudflare Queues and process Worker queue batches.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 10
icon: i-simple-icons-cloudflare
frameworks: [vite, nitro]
---

Use the Cloudflare provider when queue producers and consumers should run through Cloudflare Workers and Cloudflare Queues.

Cloudflare needs runtime queue bindings. ViteHub derives those bindings from discovered queue names and generates the Worker or Nitro queue wiring.

::steps{level="2"}

## Configure Queue

::fw{id="vite:dev vite:build"}
Register the Vite plugin and set `queue.provider` to `cloudflare`:

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
Register the Nitro module and set `queue.provider` to `cloudflare`:

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

## Understand generated names

Queue derives Cloudflare queue names and producer binding names from the discovered queue name.

For `welcome-email`:

| Value | Result |
| --- | --- |
| Discovered queue name | `welcome-email` |
| Cloudflare queue name | `queue--77656c636f6d652d656d61696c` |
| Default producer binding | `QUEUE_77656C636F6D652D656D61696C` |

Use these helpers when another config file needs the exact values:

```ts
import {
  getCloudflareQueueBindingName,
  getCloudflareQueueName,
} from '@vitehub/queue'

console.log(getCloudflareQueueName('welcome-email'))
console.log(getCloudflareQueueBindingName('welcome-email'))
```

## Use an explicit binding name

Use `queue.binding` when you already provide one binding manually:

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubQueue()],
  queue: {
    provider: 'cloudflare',
    binding: 'WELCOME_EMAIL_QUEUE',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/queue/nitro'],
  queue: {
    provider: 'cloudflare',
    binding: 'WELCOME_EMAIL_QUEUE',
  },
})
```
::

`runQueue()` resolves the binding from the current Cloudflare request environment.

## Process batches

Cloudflare delivers batches of messages. Queue turns each message into a `QueueJob` and calls the discovered handler.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vitehub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  console.log(job.id, job.payload.email)
}, {
  concurrency: 4,
})
```

Use `onError` to control message retry behavior when a handler throws:

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

By default, failed messages are retried.

## Generated output

::fw{id="vite:build"}
Vite builds a Cloudflare Worker entry and a `wrangler.json` under `dist/<app-name>`.

When static Vite output contains `index.html`, the generated config also copies assets and runs the Worker first for `/api/*`.
::

::fw{id="nitro:build"}
For Cloudflare Nitro presets, the module adds Cloudflare queue producers and consumers to Nitro's generated Wrangler config.
::

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
    "messageId": "queue_7f1b6f8e-7b5c-4c5e-b3a1-8d6a4b3d4c2a"
  }
}
```

::

## Common failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cloudflare queue direct clients require a binding` | A direct Cloudflare client was created without a binding object. | Use runtime `runQueue()` in a Cloudflare request or pass a real binding to `createQueueClient()`. |
| `Cloudflare queue binding names require request-scoped runtime resolution` | A binding name was used outside a request/runtime context. | Run inside Cloudflare, or pass a direct binding object for tests. |
| `Invalid Cloudflare queue binding` | The resolved binding does not expose `send()` and `sendBatch()`. | Check the binding name and Cloudflare queue configuration. |
| `Cloudflare queue does not support enqueue options` | The send envelope includes Vercel-only fields. | Remove `idempotencyKey` and `retentionSeconds`. |

## Related pages

- [Quickstart](../quickstart)
- [Handle provider delivery](../guides/handle-provider-delivery)
- [Troubleshooting](../troubleshooting)
