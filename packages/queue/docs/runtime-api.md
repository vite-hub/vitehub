---
title: Queue runtime API
description: Reference for Queue exports, options, and core types.
navigation.title: Runtime API
navigation.order: 3
icon: i-lucide-braces
---

Use this page when you need the Queue surface area, signatures, or option names.

## Definition APIs

### `defineQueue(handler, options?)`

Use `defineQueue()` for handler-first syntax.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vitehub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  return { email: job.payload.email }
})
```

### `createQueue({ handler, ...options })`

Use `createQueue()` when you want the object form.

```ts [server/queues/welcome-email.ts]
import { createQueue } from '@vitehub/queue'

export default createQueue({
  handler: async (job) => {
    return { id: job.id }
  },
  cache: false,
})
```

## Enqueue APIs

### `runQueue(name, input)`

Use `runQueue()` for the normal enqueue path.

```ts
await runQueue('welcome-email', {
  email: 'ava@example.com',
})
```

### `deferQueue(name, input)`

Use `deferQueue()` when the send should happen after the current response.

```ts
deferQueue('welcome-email', {
  email: 'ava@example.com',
})
```

### `getQueue(name)`

Use `getQueue()` when you need the active provider handle.

```ts
const queue = await getQueue('welcome-email')
console.log(queue.provider)
```

## Config type

```ts
type QueueProvider = 'cloudflare' | 'vercel' | 'memory'
```

```ts
type QueueModuleOptions =
  | false
  | { provider?: undefined, cache?: boolean }
  | { provider: 'memory', cache?: boolean }
  | { provider: 'cloudflare', binding?: string, cache?: boolean }
  | { provider: 'vercel', region?: string, cache?: boolean }
```

## Queue job

Handlers receive a `QueueJob`.

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Message identifier. |
| `payload` | `TPayload` | Payload passed to `runQueue()`. |
| `attempts` | `number` | Current delivery attempt. |
| `signal` | `AbortSignal` | Abort signal for handler work. |
| `metadata` | `unknown` | Provider-specific metadata. |

## Enqueue options

| Option | Description |
| --- | --- |
| `payload` | The message payload. |
| `id` | Optional message identifier. |
| `delaySeconds` | Delay delivery by a number of seconds. |
| `idempotencyKey` | Deduplicate sends when the provider supports it. |
| `retentionSeconds` | Keep the queued message for a limited time when the provider supports it. |
| `contentType` | Set Cloudflare message content type. |
