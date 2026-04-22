---
title: Queue runtime API
description: Reference for the portable Queue APIs and the provider-specific runtime helpers.
navigation.title: Runtime API
frameworks: [vite, nitro]
---

Use this page when you need the exported Queue surface area. For a guided setup, start with [Quickstart](./quickstart).

## Entry points

| Entry point | Use it for |
| --- | --- |
| `@vitehub/queue` | Portable runtime APIs, shared helpers, and types. |
| `@vitehub/queue/vite` | The Vite plugin returned by `hubQueue()`. |
| `@vitehub/queue/nitro` | The Nitro module that registers Queue runtime support. |

## Portable exports

### `defineQueue(handler, options?)`

Registers one discovered queue handler.

```ts
import { defineQueue } from '@vitehub/queue'

export default defineQueue(async (job) => {
  return job.id
})
```

### `runQueue(name, input)`

Enqueues a job immediately and resolves to `{ status: 'queued', messageId? }`.

### `deferQueue(name, input)`

Schedules the enqueue call against the current request context and returns `void`.

### `getQueue(name)`

Resolves the active provider client for one discovered queue.

### `createQueueMessageId(prefix?)`

Builds a generated queue message id when you want to create ids outside `runQueue()`.

### `normalizeQueueOptions(options, input?)`

Normalizes `queue` config to the resolved provider shape.

## Provider helpers

### Cloudflare

These helpers are public exports from `@vitehub/queue`:

| Export | Purpose |
| --- | --- |
| `createCloudflareQueueBatchHandler()` | Turns a message callback into a Cloudflare batch handler. |
| `getCloudflareQueueBindingName()` | Derives the binding name for a discovered queue. |
| `getCloudflareQueueDefinitionName()` | Maps encoded Cloudflare queue names back to discovered names. |
| `getCloudflareQueueName()` | Builds the encoded Cloudflare queue name. |
| `createQueueCloudflareWorker()` | Creates a Cloudflare Worker with `fetch()` and `queue()` handlers. |

### Vercel

These helpers are public exports from `@vitehub/queue`:

| Export | Purpose |
| --- | --- |
| `getVercelQueueTopicName()` | Builds the encoded Vercel topic name for a discovered queue. |
| `handleHostedVercelQueueCallback()` | Runs a hosted Vercel queue callback against one discovered definition. |

## Core types

### `QueueJob<TPayload>`

The object delivered to your queue handler.

| Field | Type |
| --- | --- |
| `id` | `string` |
| `payload` | `TPayload` |
| `attempts` | `number` |
| `metadata` | `unknown` |

### `QueueDefinitionOptions`

Portable handler options:

| Option | Purpose |
| --- | --- |
| `cache` | Disable cached client reuse for this definition. |
| `callbackOptions` | Configure hosted Vercel callback behavior. |
| `concurrency` | Limit Cloudflare batch concurrency. |
| `onDispatchError` | Observe enqueue failures from `deferQueue()`. |
| `onError` | Customize Cloudflare batch retry and ack behavior. |

### `QueueEnqueueInput<TPayload>`

Accepts either a bare payload or an enqueue envelope with `payload` plus shared send options.

### `QueueClient`

The resolved provider client returned by `getQueue()`.

Provider-specific client types are also exported:

- `CloudflareQueueClient`
- `VercelQueueClient`
- `CloudflareQueueMessage`
- `CloudflareQueueMessageBatch`
- `VercelQueueSendResult`

## Related pages

- [Usage](./usage)
- [Cloudflare](./providers/cloudflare)
- [Vercel](./providers/vercel)
