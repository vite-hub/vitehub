---
title: Queue runtime API
description: Reference for Queue exports, definition options, enqueue inputs, provider clients, and provider-specific helpers.
navigation.title: Runtime API
navigation.order: 90
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Use this page when you need exact names, signatures, and option fields. For a guided setup, start with [Quickstart](./quickstart).

## Imports

Most application code imports from `@vitehub/queue`:

```ts
import {
  defineQueue,
  deferQueue,
  getQueue,
  runQueue,
} from '@vitehub/queue'
```

::fw{id="vite:dev vite:build"}
Vite config imports the plugin from `@vitehub/queue/vite`:

```ts
import { hubQueue } from '@vitehub/queue/vite'
```
::

::fw{id="nitro:dev nitro:build"}
Nitro config registers the module by name:

```ts
export default defineNitroConfig({
  modules: ['@vitehub/queue/nitro'],
})
```
::

## Definition API

### `defineQueue(handler, options?)`

Default-export `defineQueue()` from every discovered queue definition.

```ts
import { defineQueue } from '@vitehub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  console.log(job.id, job.attempts, job.payload.email)
}, {
  concurrency: 4,
})
```

The handler receives:

| Argument | Type | Description |
| --- | --- | --- |
| `job` | `QueueJob<TPayload>` | Provider-delivered job data. |

### `QueueJob<TPayload>`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Message id from the provider metadata or ViteHub fallback. |
| `payload` | `TPayload` | Payload passed to `runQueue()` or `deferQueue()`. |
| `attempts` | `number` | Delivery attempt count when the provider reports it, otherwise `1`. |
| `metadata` | `unknown` | Provider-specific message metadata. |

### `QueueDefinitionOptions`

| Option | Provider | Description |
| --- | --- | --- |
| `cache` | Cloudflare, Vercel | Set to `false` to avoid cached provider client reuse for this definition. |
| `callbackOptions` | Vercel | Options passed to the hosted Vercel queue callback. |
| `concurrency` | Cloudflare | Maximum concurrent message handlers inside one Cloudflare batch. |
| `onDispatchError` | Cloudflare, Vercel | Called when `deferQueue()` fails to enqueue. |
| `onError` | Cloudflare | Controls ack or retry behavior when a Cloudflare message handler throws. |

## Enqueue API

### `runQueue(name, input)`

Enqueue one job immediately and wait for the provider send call.

```ts
import { runQueue } from '@vitehub/queue'

const result = await runQueue('welcome-email', {
  email: 'ava@example.com',
})
```

`runQueue()` resolves to:

```ts
type QueueSendResult = {
  messageId?: string
  status: 'queued'
}
```

`runQueue()` throws `QueueError` when the queue is unknown, disabled, missing provider setup, or receives unsupported enqueue options.

### `deferQueue(name, input)`

Schedule the enqueue call against the current request context and return `void`.

```ts
import { deferQueue } from '@vitehub/queue'

deferQueue('welcome-email', {
  email: 'ava@example.com',
})
```

`deferQueue()` uses runtime `waitUntil()` when available. It does not throw to the caller for async enqueue failures.

### `getQueue(name)`

Resolve the active provider client for one discovered queue.

```ts
import { getQueue } from '@vitehub/queue'

const queue = await getQueue('welcome-email')
await queue.send({ email: 'ava@example.com' })
```

### `createQueueMessageId(prefix?)`

Create a message id with the default `queue` prefix or a custom prefix.

```ts
import { createQueueMessageId } from '@vitehub/queue'

const id = createQueueMessageId('welcome')
```

## Enqueue input

### `QueueEnqueueInput<TPayload>`

Pass either a bare payload:

```ts
await runQueue('welcome-email', { email: 'ava@example.com' })
```

Or an envelope:

```ts
await runQueue('welcome-email', {
  id: 'welcome-email-1',
  payload: { email: 'ava@example.com' },
  delaySeconds: 30,
})
```

### `QueueEnqueueEnvelope<TPayload>`

| Field | Type | Description |
| --- | --- | --- |
| `payload` | `TPayload` | Job payload delivered to the handler. |
| `id` | `string` | Message id used by ViteHub. |
| `contentType` | `'bytes' \| 'json' \| 'text' \| 'v8'` | Cloudflare payload encoding. |
| `delaySeconds` | `number` | Delivery delay. |
| `idempotencyKey` | `string` | Vercel idempotency key. |
| `region` | `string` | Vercel send region override. |
| `retentionSeconds` | `number` | Vercel retention setting. |

## Provider config

The top-level config key is `queue`.

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts
    queue: {
      provider: 'cloudflare',
      binding: 'QUEUE_77656C636F6D652D656D61696C',
      cache: false,
    }
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
    ```ts
    queue: {
      provider: 'vercel',
      region: 'fra1',
      cache: false,
    }
    ```
  :::
::

If `queue.provider` is omitted, Queue infers `cloudflare` for Cloudflare hosting and `vercel` otherwise.

## Provider clients

### `CloudflareQueueClient`

| Field / Method | Description |
| --- | --- |
| `provider` | Always `'cloudflare'`. |
| `binding` | Resolved Cloudflare queue binding. |
| `send(input)` | Send one message. |
| `sendBatch(items, options?)` | Send a Cloudflare batch. |
| `createBatchHandler(options)` | Create a Cloudflare batch handler. |

### `VercelQueueClient`

| Field / Method | Description |
| --- | --- |
| `provider` | Always `'vercel'`. |
| `topic` | Derived Vercel topic name. |
| `send(input)` | Send one message. |
| `callback(handler, options?)` | Create a Vercel queue callback handler. |

## Provider helpers

### Cloudflare

| Export | Purpose |
| --- | --- |
| `createCloudflareQueueBatchHandler()` | Turn a message callback into a Cloudflare batch handler. |
| `getCloudflareQueueBindingName()` | Derive the default binding name for a discovered queue. |
| `getCloudflareQueueDefinitionName()` | Map encoded Cloudflare queue names back to discovered names. |
| `getCloudflareQueueName()` | Build the encoded Cloudflare queue name. |
| `createQueueCloudflareWorker()` | Create a Cloudflare Worker with `fetch()` and `queue()` handlers. |

### Vercel

| Export | Purpose |
| --- | --- |
| `getVercelQueueTopicName()` | Build the encoded Vercel topic name. |
| `handleHostedVercelQueueCallback()` | Run a hosted Vercel queue callback against one discovered definition. |

## Errors

Queue setup and send failures throw `QueueError`.

Useful fields include:

| Field | Description |
| --- | --- |
| `message` | Human-readable failure message. |
| `code` | Stable error code when available. |
| `provider` | Provider that produced the error when available. |
| `httpStatus` | Suggested HTTP status when available. |
| `details` | Provider or validation diagnostics when available. |

## Related pages

- [Quickstart](./quickstart)
- [Usage](./usage)
- [Cloudflare](./providers/cloudflare)
- [Vercel](./providers/vercel)
