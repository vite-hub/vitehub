---
title: Queue server API
description: Enqueue Queue Jobs, handle delivery failures, and use the Queue Runtime Helpers from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

Queue runs on Cloudflare, on Vercel, or with the local provider of `host: 'node'`, which runs jobs in the server process. Do [Get started](/docs/queue/get-started) first to set up the host and the `welcome-email` queue used below.

## Public imports

Set `queue: true` in your ViteHub config, then import from `vite-hub/queue`. Route examples use Nitro file routing and explicit H3 imports.

| Import | Use |
| --- | --- |
| `defineQueue` from `vite-hub/queue` | Declare a Queue Definition (one queue file). |
| `sendQueue`, `deferQueue`, `useQueue` from `vite-hub/queue` | Send jobs and get queue clients, with typed names and payloads. |
| `dynamicQueue` from `vite-hub/queue` | Send jobs or get clients for names from outside input. |
| `createQueueClient` from `vite-hub/queue` | Create a direct provider QueueClient. |
| `createQueueMessageId` from `vite-hub/queue` | Make a message id, with an optional prefix. |
| `QueueErrorCode`, `CloudflareQueueErrorCode`, `VercelQueueErrorCode` from `vite-hub/queue` | Types of the `error.code` that a send returns. See [Queue errors](/docs/queue/limits-and-errors). |
| `ViteHubError` and `getViteHubErrorShape` from `vite-hub/runtime` | Throw app failures from a handler and read their code. |
| `handleHostedVercelQueueCallback` from `@vite-hub/queue/runtime/hosted` | Host helper for generated output. Install `@vercel/functions` if you import the Vercel runtime. |

`vite-hub/queue` also exports the option, client, job, provider, registry, and result types. `@vite-hub/queue` has the same APIs for owner packages, with `hubQueue` from `@vite-hub/queue/vite`. `vite-hub` sets these up for apps. Nuxt apps use `vite-hub/nuxt`. Generated output imports the Queue runtime modules by file path. They are not package exports.

## Queue job

The handler gets one job in the same shape on every provider. The examples on this page enqueue the `welcome-email` Definition from Get started:

```ts [server/queues/welcome-email.ts]
import { defineQueue } from 'vite-hub/queue'

export default defineQueue<{ email: string }>(async ({ payload, id }) => {
  console.log(`Processing welcome job ${id} for ${payload.email}`)
})
```

| Field | Type | Description |
| --- | --- | --- |
| `payload` | `TPayload` | The payload you sent. |
| `id` | `string` | The provider message id, or a generated id. |
| `attempts` | `number` | Number of delivery attempts. |
| `metadata` | `unknown` | Provider delivery metadata, if any. |

`sendQueue()` does not return the handler's result.

### Handle failures

Providers can retry a failed delivery, so a handler must be safe to run again after a partial side effect. ViteHub does not promise exactly-once delivery.

| Provider | Default | Override |
| --- | --- | --- |
| Cloudflare | Success acknowledges the message. Failure retries, except for [Queue errors that a retry cannot fix](/docs/queue/limits-and-errors#errors-in-a-queue-handler). | Return `'ack'`, `'retry'`, or `{ retry: { delaySeconds } }` from `onError`, or `void` for the default. |
| Local | Success removes the job. Failure runs it again after 1, 2, and 4 seconds. After 4 attempts, or a [Queue error that a retry cannot fix](/docs/queue/limits-and-errors#errors-in-a-queue-handler), it becomes a dead job. | None. No `onError` or `callbackOptions.retry`. |
| Vercel | Vercel decides. When the callback returns `undefined`, ViteHub acknowledges [Queue errors that a retry cannot fix](/docs/queue/limits-and-errors#errors-in-a-queue-handler), and Vercel retries the rest. | Return a directive from `callbackOptions.retry`, or `void` for the default. |

In `vite dev`, Cloudflare and Vercel apps run jobs with the local provider and their provider's retry rules, without `onError` or `callbackOptions.retry`. See [Dev delivery](/docs/queue/limits-and-errors#dev-delivery).

Throw `ViteHubError` to give a failure a stable code. The code does not choose the retry policy. Use `onError` or `callbackOptions.retry` for that.

```ts [server/queues/image-expiry.ts] fragment
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

`deleteImage` is your helper in `server/utils/images.ts`. It must handle an image that an earlier attempt already deleted.

Error codes and details are public. Keep credentials, provider responses, and private resource locations in `cause`. ViteHub reports each failed delivery before it picks a provider action. A report has the queue, safe message ids, attempt count, `code`, `details` of a `ViteHubError`, `docs` and `fix` of a Queue error, and retry policy. It never includes `cause` or unsafe ids.

## Enqueue work

Call `sendQueue()` in server code, with the payload and the options as separate arguments. This example delays delivery by 60 seconds on any provider.

```ts [server/api/signup.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { sendQueue } from 'vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: unknown }>(event)
  if (typeof body?.email !== 'string' || !body.email.trim()) {
    throw createError({ statusCode: 400, message: 'Send a non-empty email.' })
  }

  const [error, result] = await sendQueue('welcome-email', { email: body.email.trim() }, {
    delaySeconds: 60,
  })
  if (error) throw error
  return result
})
```

The result confirms that the provider accepted the job, not that it ran. ViteHub never reads options from the payload, so payload fields such as `payload`, `region`, and `id` stay your data.

## Queue enqueue options

An option that the provider does not support returns `QUEUE_UNSUPPORTED_OPTION`, and the job is not sent.

### Shared options

| Option | Type | Description |
| --- | --- | --- |
| `id` | `string` | Message ID. Generated if omitted. It does not stop duplicates on every provider. |
| `delaySeconds` | `number` | Delay before delivery, in seconds. |

### Cloudflare options

| Option | Type | Description |
| --- | --- | --- |
| `contentType` | `'bytes' \| 'json' \| 'text' \| 'v8'` | Message content type. Not on Vercel or the local provider. |

Cloudflare accepts the shared options and `contentType`. Guard side effects that must not repeat inside the handler.

### Vercel options

Vercel only. The app needs `host: 'vercel'`, Queue on, `@vercel/queue`, and a deployed Queue callback. See [Vercel](/docs/frameworks-hosts/vercel) and [Queue hosts](/docs/queue/hosts).

| Option | Type | Description |
| --- | --- | --- |
| `idempotencyKey` | `string` | Idempotency key. Defaults to the message `id`. |
| `region` | `string` | Send region for this job. |
| `retentionSeconds` | `number` | Message retention, in seconds. |

To make repeated sends share a key, pass a stable key of your own:

```ts [server/utils/enqueue-welcome.ts]
import { sendQueue } from 'vite-hub/queue'

export async function enqueueWelcome(email: string) {
  const [error, result] = await sendQueue('welcome-email', { email }, {
    idempotencyKey: `welcome:${email}`,
  })
  if (error) throw error
  return result
}
```

The local provider also accepts `idempotencyKey`. While a pending or running job has the same key, `sendQueue()` returns that job's message ID and stores nothing. A dead job frees its key. It rejects `region` and `retentionSeconds`.

Cloudflare rejects `idempotencyKey`, `region`, and `retentionSeconds`. Vercel deduplication still does not make a handler run exactly once, so keep handlers safe to retry.

## Runtime helpers

### `sendQueue(name, payload, options?)`

Sends one job and returns `[error, result]`.

```ts [examples/send-queue.ts]
import { sendQueue } from 'vite-hub/queue'

const [error, result] = await sendQueue('welcome-email', { email: 'ava@example.com' }, { delaySeconds: 60 })
if (error) {
  error.code // 'QUEUE_PROVIDER_FAILED' | 'QUEUE_PROVIDER_INVALID_RESPONSE' | 'QUEUE_UNSUPPORTED_OPTION'
}
```

Returns a `Promise<Result<QueueSendResult, QueueErrorCode>>`, with `Result` from `vite-hub/runtime`. The success value:

```ts [examples/queue-send-result.ts]
type QueueSendResult = {
  messageId?: string
  status: 'queued'
}
```

Config errors, such as an unknown queue name or a missing Cloudflare binding, throw. See [Queue limits and errors](/docs/queue/limits-and-errors).

`status: 'queued'` means accepted on every provider. Vercel returns its message id, or `undefined` when it accepts the job for later processing. Cloudflare returns the ViteHub `id`. Cloudflare never gets that id, so its delivery has a different message id.

### `deferQueue(name, payload, options?)`

Sends the job through the request's `waitUntil` and returns `void`.

```ts [examples/defer-queue.ts]
import { deferQueue } from 'vite-hub/queue'

deferQueue('welcome-email', { email: 'ava@example.com' })
```

Use it when the host has `waitUntil` and the response must not wait for the provider. A return does not mean the provider accepted the job. ViteHub logs send failures and passes them to the queue's `onDispatchError`, if set.

### `useQueue(name)`

Returns the provider's QueueClient for a queue. It throws config errors. `send()` and `sendBatch()` return `[error, result]`.

```ts [examples/use-queue.ts]
import { useQueue } from 'vite-hub/queue'

const queue = await useQueue('welcome-email')
const [error] = await queue.send({ email: 'ava@example.com' })
if (error) throw error
```

| Method | Returns | `error.code` |
| --- | --- | --- |
| `send()` on Cloudflare | `Result<QueueSendResult, CloudflareQueueErrorCode>` | `QUEUE_PROVIDER_FAILED`, `QUEUE_UNSUPPORTED_OPTION` |
| `sendBatch()` on Cloudflare | `Result<QueueSendResult[], CloudflareQueueErrorCode>` | `QUEUE_PROVIDER_FAILED`, `QUEUE_UNSUPPORTED_OPTION` |
| `send()` on Vercel | `Result<QueueSendResult, VercelQueueErrorCode>` | `QUEUE_PROVIDER_FAILED`, `QUEUE_PROVIDER_INVALID_RESPONSE`, `QUEUE_UNSUPPORTED_OPTION` |
| `sendBatch()` on Vercel | `Result<QueueSendResult[], VercelQueueErrorCode>` | `QUEUE_PROVIDER_FAILED`, `QUEUE_PROVIDER_INVALID_RESPONSE` |

For Vercel batch retries, give each job the same `idempotencyKey` from the first attempt. Without one, each call makes a new key, so retries are not deduplicated, also after a request failure.

### `dynamicQueue`

Use `dynamicQueue.send(name, payload, options?)`, `dynamicQueue.defer()`, or `dynamicQueue.use()` for names from outside input. They check at runtime that the queue exists, but not the payload shape. Validate outside data yourself.

### `createQueueClient(options)`

Creates a provider QueueClient directly. Most apps use `sendQueue()` or `useQueue()` instead. A direct client has no Queue Definition, so it accepts any payload.

A Cloudflare direct client needs a binding object, here `binding` from the Worker host.

```ts [examples/cloudflare-client.ts] fragment
import { createQueueClient } from 'vite-hub/queue'

await createQueueClient({
  provider: 'cloudflare',
  binding,
})
```

A Vercel direct client needs an existing topic. Use your own topic and region.

```ts [examples/vercel-client.ts]
import { createQueueClient } from 'vite-hub/queue'

await createQueueClient({
  provider: 'vercel',
  topic: 'topic--77656c636f6d65',
  region: 'iad1',
})
```

## Definition-owned dispatch types

The Vite plugin writes `.vitehub/queue.d.ts`. The `vite-hub/tsconfig` setup in [Installation](/docs/getting-started/installation) loads it. With your own TypeScript config, include this file. Nuxt adds it for you. Names and payloads then come from your queue files:

```ts [examples/typed-dispatch.ts]
import { sendQueue, useQueue } from 'vite-hub/queue'

const [error] = await sendQueue('welcome-email', { email: 'ada@example.com' }, { delaySeconds: 60 })
if (error) throw error
const queue = await useQueue('welcome-email')
const [sendError] = await queue.send({ email: 'ada@example.com' })
if (sendError) throw sendError
```

`QueueRegistry` is the generated map of queues. `QueuePayload<'welcome-email'>` gets a payload type. A missing name or wrong payload is a type error. Run Vite or Nuxt prepare after you add a queue. For a standalone TypeScript host, extend `QueueRegistry` with `typeof import('./welcome.queue').default`.

::note
Earlier versions took an envelope: `sendQueue(name, { payload, ...options })` and `client.send({ payload, ...options })`. Change them to `sendQueue(name, payload, options)` and `client.send(payload, options)`. ViteHub does not detect envelopes, so an old envelope is sent whole as the payload.
::
