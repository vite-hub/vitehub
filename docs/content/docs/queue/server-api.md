---
title: Queue server API
description: Enqueue Queue Jobs, handle delivery failures, and use the Queue Runtime Helpers from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

Queue needs a hosted Cloudflare or Vercel provider. It has no local delivery provider. Complete [Get started](/docs/queue/get-started) to configure the host, provision its resources, and discover the `welcome-email` Definition used below.

## Public imports

Application code imports from `vite-hub/queue` after enabling `queue: true` in the existing ViteHub configuration. Route examples use Nitro file routing and explicit H3 imports.

| Import | Use |
| --- | --- |
| `defineQueue` from `vite-hub/queue` | Declare a Queue Definition. |
| `runQueue`, `deferQueue`, `getQueue` from `vite-hub/queue` | Enqueue jobs and access discovered QueueClients with typed names and payloads. |
| `dynamicQueue` from `vite-hub/queue` | Enqueue jobs or get clients for names read from external input. |
| `createQueueClient` from `vite-hub/queue` | Create a direct provider QueueClient. |
| `createQueueMessageId` from `vite-hub/queue` | Generate a ViteHub message id with an optional prefix. |
| `QueueErrorCode`, `CloudflareQueueErrorCode`, `VercelQueueErrorCode` from `vite-hub/queue` | Type the `error.code` that a send method returns. See [Queue errors](/docs/queue/limits-and-errors). |
| `ViteHubError` and `getViteHubErrorShape` from `vite-hub/runtime` | Throw application failures from a Queue handler and read their code. |
| `createCloudflareQueueBatchHandler` from `vite-hub/queue` | Build a Cloudflare batch handler outside the generated Nitro plugin. |
| `getCloudflareQueueName`, `getCloudflareQueueBindingName`, `getCloudflareQueueDefinitionName`, `getVercelQueueTopicName` from `vite-hub/queue` | Inspect provider-derived names. Do not persist these names as application identifiers. |
| `handleHostedVercelQueueCallback` from `@vite-hub/queue/runtime/hosted`, `createQueueCloudflareWorker` from `vite-hub/queue` | Host adapter helpers used by generated Provider Output. Install `@vercel/functions` when you import the Vercel-specific runtime. |

Queue option, client, job, provider, registry, and result types are exported from `vite-hub/queue`. For advanced owner-package composition, `@vite-hub/queue` exposes the same APIs, with `hubQueue` from `@vite-hub/queue/vite` and the `@vite-hub/queue/nuxt` module. The framework distribution configures these integrations for applications. Generated output uses the specific `@vite-hub/queue/internal/runtime/*` subpaths listed in the package exports; do not import those runtime modules from application code.

## Queue job

The handler receives a normalized Queue Job.

| Field | Type | Description |
| --- | --- | --- |
| `payload` | `TPayload` | The payload passed by Queue Enqueue. |
| `id` | `string` | The provider message id when available, otherwise a generated message id. |
| `attempts` | `number` | Delivery attempt count. |
| `metadata` | `unknown` | Provider delivery metadata when the Queue Provider supplies it. |

Handler return values belong to Queue Delivery. `runQueue()` does not return the handler result.

### Handle failures

Providers can retry failed delivery, so a handler must tolerate another run after a partial side effect. ViteHub does not guarantee exactly-once delivery.

| Provider | Default | Override |
| --- | --- | --- |
| Cloudflare | A successful handler acknowledges the message. A failed handler retries, except for [Queue errors that a retry cannot fix](/docs/queue/limits-and-errors#errors-in-a-queue-handler). | Return `'ack'`, `'retry'`, or `{ retry: { delaySeconds } }` from `onError`. Return `void` to keep the default. |
| Vercel | Provider behavior. ViteHub acknowledges [Queue errors that a retry cannot fix](/docs/queue/limits-and-errors#errors-in-a-queue-handler) when the callback returns `undefined`; other `undefined` results keep Vercel's retry behavior. | Return a directive from `callbackOptions.retry`. Return `void` to keep the default. |

Throw `ViteHubError` when the Queue Definition needs a stable application failure code. Application error codes do not choose retry policy. Use `onError` or `callbackOptions.retry` for that.

```ts [server/queues/image-expiry.ts]
import { getViteHubErrorShape, ViteHubError } from 'vite-hub/runtime'
import { defineQueue } from 'vite-hub/queue'
import { deleteImage } from '../utils/images'

export default defineQueue<{ key?: string }>(async ({ payload }) => {
  if (!payload.key) {
    throw new ViteHubError('EXPIRY_INVALID_PAYLOAD', 'Image expiry payload requires a key.', {
      details: { field: 'key' },
    })
  }

  try {
    await deleteImage(payload.key)
  }
  catch (cause) {
    throw new ViteHubError('EXPIRY_FAILED', 'Image expiry failed.', {
      cause,
      details: { key: payload.key },
    })
  }
}, {
  onError: error => getViteHubErrorShape(error)?.code === 'EXPIRY_INVALID_PAYLOAD' ? 'ack' : undefined,
  callbackOptions: {
    retry: error => getViteHubErrorShape(error)?.code === 'EXPIRY_INVALID_PAYLOAD'
      ? { acknowledge: true }
      : undefined,
  },
})
```

`deleteImage` is your application helper in `server/utils/images.ts`. It must tolerate an image that a previous attempt already deleted.

Application error codes and details are public. Keep credentials, provider responses, and private resource locations in `cause`. ViteHub reports each failed delivery before it chooses a provider action. Reports include the Queue Definition, safe message identifiers, attempt count, `code`, `details` of a `ViteHubError`, `docs` and `fix` of a Queue error, and retry policy. They do not serialize `cause` or unsafe identifiers.

## Enqueue work

Use `runQueue()` from server code. Pass the payload and the enqueue options as separate arguments. This example delays delivery by 60 seconds on either provider.

```ts [server/api/signup.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { runQueue } from 'vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: unknown }>(event)
  if (typeof body?.email !== 'string' || !body.email.trim()) {
    throw createError({ statusCode: 400, message: 'Send a non-empty email.' })
  }

  const [error, result] = await runQueue('welcome-email', { email: body.email.trim() }, {
    delaySeconds: 60,
  })
  if (error) throw error
  return result
})
```

The result confirms provider acceptance. It does not confirm delivery or contain the handler's result. Payload fields such as `payload`, `region`, and `id` remain application data. ViteHub does not read enqueue options from the payload.

## Queue enqueue options

An option that the selected provider does not support returns `QUEUE_UNSUPPORTED_OPTION`. ViteHub does not send the job in that case.

### Shared options

| Option | Type | Description |
| --- | --- | --- |
| `id` | `string` | ViteHub message ID. If omitted, ViteHub generates one. This is not a portable duplicate-delivery check. |
| `delaySeconds` | `number` | Provider-supported enqueue delay, in seconds. |

### Cloudflare options

| Option | Type | Description |
| --- | --- | --- |
| `contentType` | `'bytes' \| 'json' \| 'text' \| 'v8'` | Cloudflare message content type. Vercel does not support this option. |

Cloudflare accepts the shared options and `contentType`. Protect non-repeatable side effects inside the handler.

### Vercel options

Use these options only with the Vercel provider. The app needs `preset: 'vercel'`, Queue enabled, the `@vercel/queue` package, and a deployed Queue callback. See [Vercel](/docs/frameworks-hosts/vercel) and [Queue hosts](/docs/queue/hosts).

| Option | Type | Description |
| --- | --- | --- |
| `idempotencyKey` | `string` | Vercel enqueue idempotency key. Defaults to the message `id` when omitted. |
| `region` | `string` | Vercel send region for this enqueue. |
| `retentionSeconds` | `number` | Vercel message retention time, in seconds. |

Pass a stable application key when repeated enqueue attempts should share a key:

```ts [server/utils/enqueue-welcome.ts]
import { runQueue } from 'vite-hub/queue'

export async function enqueueWelcome(email: string) {
  const [error, result] = await runQueue('welcome-email', { email }, {
    idempotencyKey: `welcome:${email}`,
  })
  if (error) throw error
  return result
}
```

Cloudflare rejects `idempotencyKey`, `region`, and `retentionSeconds`. Vercel enqueue deduplication still does not guarantee that a handler runs exactly once. Keep handlers safe to retry.

## Runtime helpers

### `runQueue(name, payload, options?)`

Enqueues one Queue Job and returns `[error, result]`.

```ts [examples/run-queue.ts]
import { runQueue } from 'vite-hub/queue'

const [error, result] = await runQueue('welcome-email', { email: 'ava@example.com' }, { delaySeconds: 60 })
if (error) {
  error.code // 'QUEUE_PROVIDER_FAILED' | 'QUEUE_PROVIDER_INVALID_RESPONSE' | 'QUEUE_UNSUPPORTED_OPTION'
}
```

Returns a `Promise<Result<QueueSendResult, QueueErrorCode>>`. `Result` comes from `vite-hub/runtime`. The success value has this shape:

```ts [examples/queue-send-result.ts]
type QueueSendResult = {
  messageId?: string
  status: 'queued'
}
```

Configuration errors, for example an unknown Queue name or a missing Cloudflare binding, throw. See [Queue limits and errors](/docs/queue/limits-and-errors).

`status: 'queued'` is the portable acceptance signal. Vercel returns the message id from its enqueue response. When Vercel accepts the job for deferred processing, it has no id yet and `messageId` is `undefined`. Cloudflare returns the ViteHub `id`. Cloudflare does not receive that id, and its later delivery has a different Cloudflare message id.

### `deferQueue(name, payload, options?)`

Schedules Queue Enqueue through the current request's `waitUntil` support and returns `void`.

```ts [examples/defer-queue.ts]
import { deferQueue } from 'vite-hub/queue'

deferQueue('welcome-email', { email: 'ava@example.com' })
```

Use this in a request whose host provides `waitUntil`, when the response must not wait for provider acceptance. Returning from `deferQueue()` does not confirm that the provider accepted the job. ViteHub logs dispatch failures and passes them to `onDispatchError` when the Queue Definition provides one.

### `getQueue(name)`

Returns the provider-specific QueueClient for a discovered Queue Definition. It throws configuration errors. `send()` and the Cloudflare `sendBatch()` return `[error, result]`.

```ts [examples/get-queue.ts]
import { getQueue } from 'vite-hub/queue'

const queue = await getQueue('welcome-email')
const [error] = await queue.send({ email: 'ava@example.com' })
if (error) throw error
```

| Method | Returns | `error.code` |
| --- | --- | --- |
| `send()` on Cloudflare | `Result<QueueSendResult, CloudflareQueueErrorCode>` | `QUEUE_PROVIDER_FAILED`, `QUEUE_UNSUPPORTED_OPTION` |
| `sendBatch()` on Cloudflare | `Result<QueueSendResult[], CloudflareQueueErrorCode>` | `QUEUE_PROVIDER_FAILED`, `QUEUE_UNSUPPORTED_OPTION` |
| `send()` on Vercel | `Result<QueueSendResult, VercelQueueErrorCode>` | `QUEUE_PROVIDER_FAILED`, `QUEUE_PROVIDER_INVALID_RESPONSE`, `QUEUE_UNSUPPORTED_OPTION` |

### `dynamicQueue`

Use `dynamicQueue.run(name, payload, options?)`, `dynamicQueue.defer()`, or `dynamicQueue.get()` for names read from external input. These methods check at runtime that the Definition exists. They do not validate the payload shape, so validate external data in your application.

### `createQueueClient(options)`

Creates a direct provider QueueClient. Most application code can use `runQueue()` or `getQueue()` and let ViteHub handle discovery and provider configuration. Direct clients accept unknown payloads because they have no Queue Definition.

Cloudflare direct clients require a concrete binding object, supplied here as `binding` by the Worker host.

```ts [examples/cloudflare-client.ts]
import { createQueueClient } from 'vite-hub/queue'

await createQueueClient({
  provider: 'cloudflare',
  binding,
})
```

Vercel direct clients require an existing topic. Replace the example topic and region with your deployment's values.

```ts [examples/vercel-client.ts]
import { createQueueClient } from 'vite-hub/queue'

await createQueueClient({
  provider: 'vercel',
  topic: 'topic--77656c636f6d65',
  region: 'iad1',
})
```

## Definition-owned dispatch types

The Vite Integration writes `.vitehub/queue.d.ts`. The `vite-hub/tsconfig` setup in [Installation](/docs/getting-started/installation) loads the generated declarations. If you manage TypeScript configuration yourself, include this file. The Nuxt Integration adds it to the generated type context. Names and payloads then come from the discovered Queue Definitions:

```ts [examples/typed-dispatch.ts]
import { getQueue, runQueue } from 'vite-hub/queue'

const [error] = await runQueue('welcome-email', { email: 'ada@example.com' }, { delaySeconds: 60 })
if (error) throw error
const queue = await getQueue('welcome-email')
const [sendError] = await queue.send({ email: 'ada@example.com' })
if (sendError) throw sendError
```

`QueueRegistry` is the generated Definition map. `QueuePayload<'welcome-email'>` extracts a payload type. A missing name or wrong payload is a type error. Run Vite configuration or the Nuxt prepare step after you add a Definition. For a standalone TypeScript host, you can extend `QueueRegistry` with `typeof import('./welcome.queue').default`.

::note
Earlier versions accepted an envelope: `runQueue(name, { payload, ...options })` and `client.send({ payload, ...options })`. Replace them with `runQueue(name, payload, options)` and `client.send(payload, options)`. There is no envelope detection. Existing envelope objects are delivered whole as payloads.
::
