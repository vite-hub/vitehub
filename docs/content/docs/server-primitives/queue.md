---
title: Queue
description: Define Queue Definitions, enqueue Queue Jobs, and choose Cloudflare or Vercel Queue Providers.
navigation.order: 9
navigation.group: Background work
icon: i-lucide-list-ordered
---

Use Queue when a request needs to hand off work and return before that work finishes. Enqueueing confirms that the provider accepted the job. It doesn't confirm that the handler ran successfully.

Use [Workflows](/docs/server-primitives/workflows) when work needs a tracked run, durable steps, waits, or progress inspection.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/queue @vite-hub/runtime
```

For Vercel Queues, also install the provider package and ambient TypeScript types:

```bash [Terminal]
pnpm add @vercel/queue
pnpm add -D @types/node @types/ws
```

### Configure

```ts [vite.config.ts]
import { hubQueue } from '@vite-hub/queue/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubQueue()],
})
```

### Start using it

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ email: string }>(async ({ payload }) => {
  await sendWelcomeEmail(payload.email)
})
```

```ts [server/api/welcome.post.ts]
import { runQueue } from '@vite-hub/queue'

export default defineEventHandler(async () => {
  return runQueue('welcome-email', { email: 'ada@example.com' })
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `defineQueue` from `@vite-hub/queue` | Declare a Queue Definition. |
| `runQueue`, `deferQueue`, `getQueue` from `@vite-hub/queue` | Enqueue jobs and access discovered QueueClients. |
| `createQueueClient` from `@vite-hub/queue` | Create a direct provider QueueClient. |
| `createQueueMessageId` from `@vite-hub/queue` | Generate a ViteHub message id with an optional prefix. |
| `ViteHubError` and `getViteHubErrorShape` from `@vite-hub/runtime` | Throw application failures or inspect Queue errors by namespaced code. |
| `createCloudflareQueueBatchHandler` from `@vite-hub/queue` | Build a Cloudflare batch handler outside generated Provider Output. |
| `getCloudflareQueueName`, `getCloudflareQueueBindingName`, `getCloudflareQueueDefinitionName`, `getVercelQueueTopicName` from `@vite-hub/queue` | Inspect provider-derived names. Don't persist these names as application identifiers. |
| `handleHostedVercelQueueCallback` from `@vite-hub/queue/runtime/hosted`, `createQueueCloudflareWorker` from `@vite-hub/queue` | Host adapter helpers used by generated Provider Output. Install `@vercel/functions` when importing the Vercel-specific runtime. |
| `hubQueue`, `createCloudflareQueueConfig` from `@vite-hub/queue/vite` | Register the Vite Integration and emit Cloudflare queue config. |

All Queue option, client, job, provider, and result types are exported from `@vite-hub/queue`.

## Configure the Vite Integration

Register the Queue Vite Integration and choose a Queue Provider with the `queue` Integration Options.

```ts [vite.config.ts]
import { hubQueue } from '@vite-hub/queue/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubQueue()],
  queue: {
    provider: 'cloudflare',
  },
})
```

You can also pass the same options to `hubQueue()`. A `queue` key in `vite.config.ts` takes precedence.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubQueue({ provider: 'vercel', region: 'iad1' })],
})
```

### `provider` `'cloudflare' | 'vercel'`

Selects the Queue Provider. If you omit it, ViteHub resolves Cloudflare for Cloudflare hosting and Vercel for other supported production builds. Netlify cannot infer a Queue Provider, so set `provider` explicitly or disable Queue there.

### Integration-level `cache` `boolean`

Controls named QueueClient reuse for providers that can cache clients. Default: enabled. Cloudflare QueueClients still resolve the request-scoped binding for each request.

### `queue: false`

Disables runtime queue dispatch and skips generated Vercel queue consumer functions. Runtime calls throw `QUEUE_DISABLED`.

## Providers

| Provider | Configure with | Generated output | Nuance |
| --- | --- | --- | --- |
| Cloudflare | `queue: { provider: 'cloudflare' }` | Worker queue handler and `wrangler.json` `queues.producers` / `queues.consumers` entries. | Uses request-scoped queue bindings. Supports `contentType` and `delaySeconds`. |
| Vercel | `queue: { provider: 'vercel', region?: string }` | `.vercel/output` queue consumer functions with Vercel queue triggers. | Requires `@vercel/queue`. Supports idempotency, region, retention, and delayed send options. |

### Cloudflare options

`binding` `string`

Overrides the generated Cloudflare binding name. Without this option, ViteHub derives a binding from the Queue Definition name, such as `QUEUE_77656C636F6D65`.

Cloudflare queue names are generated as `queue--<hex-name>`. Application code must not depend on that name. Use `runQueue()` with the Queue Definition name.

### Vercel options

`region` `string`

Sets the default Vercel Queue region. If you omit it, ViteHub checks `QUEUE_REGION`, then `VERCEL_REGION`, then request headers in a Vercel request context.

Vercel topic names are generated as `topic--<hex-name>`. Application code must not depend on that topic. Use `runQueue()` with the Queue Definition name.

## Define a queue

Create a Queue Definition in `server/queues/<name>.ts` or `src/<name>.queue.ts`.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  await sendWelcomeEmail(job.payload.email)
})
```

The queue name comes from discovery. This file is addressed as `welcome-email` by Runtime Helpers.

## Queue job

The handler receives a normalized Queue Job.

| Field | Type | Description |
| --- | --- | --- |
| `payload` | `TPayload` | The payload passed by Queue Enqueue. |
| `id` | `string` | The provider message id when available, otherwise a generated message id. |
| `attempts` | `number` | Delivery attempt count. |
| `metadata` | `unknown` | Provider delivery metadata when the Queue Provider supplies it. |

Handler return values belong to Queue Delivery. `runQueue()` does not return the handler result.

Throw `ViteHubError` when the Queue Definition needs a stable application failure code. Queue retry policy belongs to Queue Delivery and provider callbacks, not the error object.

```ts [server/queues/image-expiry.ts]
import { getViteHubErrorShape, ViteHubError } from '@vite-hub/runtime'
import { defineQueue } from '@vite-hub/queue'

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

Application error codes and details are public. Keep credentials, provider responses, and private resource locations in `cause`. ViteHub reports each failed delivery before it chooses a provider action. Reports include the Queue Definition, safe message identifiers, attempt count, `code`, `details`, and retry policy. They don't serialize `cause` or unsafe identifiers.

## Queue Definition options

Pass Definition Options as the second argument to `defineQueue()`.

```ts [server/queues/report.ts]
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ reportId: string }>(async (job) => {
  await buildReport(job.payload.reportId)
}, {
  concurrency: 5,
})
```

### Definition-level `cache` `boolean`

Overrides QueueClient caching for this Queue Definition.

### `concurrency` `number`

Controls Cloudflare batch delivery concurrency for this Queue Definition. Default: `1`. Values are floored to an integer and never lower than `1`.

### `onError` `(error, message, batch) => 'ack' | 'retry' | { retry: { delaySeconds?: number } } | void`

Handles Cloudflare message delivery errors. Return `'ack'` to acknowledge the failed message, `'retry'` to retry it, or `{ retry: { delaySeconds } }` to retry with a delay. Returning `void` applies the default Queue Delivery policy.

An explicit return value overrides the default Queue Delivery action. Returning `void` uses the built-in action for the error code.

### `callbackOptions` `{ retry?: VercelQueueRetryHandler, visibilityTimeoutSeconds?: number }`

Passes Vercel callback options to `@vercel/queue` for this Queue Definition.

When `retry` returns a directive, that directive overrides the default Queue Delivery action. Returning `void` preserves normal provider behavior.

### `onDispatchError` `(error, context) => unknown | Promise<unknown>`

Handles dispatch errors from `deferQueue()`. This is not a Queue Delivery error hook.

## Enqueue work

Use `runQueue()` from server code.

```ts [server/api/signup.post.ts]
import { runQueue } from '@vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)

  return runQueue('welcome-email', {
    payload: { email: body.email },
    idempotencyKey: `welcome:${body.email}`,
  })
})
```

You can pass the payload directly when you do not need Queue Enqueue options.

```ts
await runQueue('welcome-email', { email: 'ava@example.com' })
```

## Queue Enqueue options

Queue Enqueue accepts either a raw payload or an envelope with `payload` and options.

```ts
await runQueue('welcome-email', {
  payload: { email: 'ava@example.com' },
  delaySeconds: 60,
})
```

| Option | Type | Cloudflare | Vercel | Description |
| --- | --- | --- | --- | --- |
| `payload` | `TPayload` | Yes | Yes | The payload delivered to the Queue Definition. Required when using the envelope form. |
| `id` | `string` | Yes | Yes | ViteHub message id. If omitted, ViteHub generates one. |
| `contentType` | `CloudflareQueueContentType` | Yes | No | Cloudflare message content type. Values: `bytes`, `json`, `text`, `v8`. |
| `delaySeconds` | `number` | Yes | Yes | Provider-supported enqueue delay. |
| `idempotencyKey` | `string` | No | Yes | Vercel idempotency key. Defaults to the generated `id` when omitted. |
| `region` | `string` | No | Yes | Vercel send region for this Queue Enqueue. |
| `retentionSeconds` | `number` | No | Yes | Vercel message retention time. |

Unsupported provider options throw `ViteHubError` with a provider-specific code instead of being ignored.

## Develop locally

Use the Vite Integration to check that ViteHub discovers your Queue Definitions and generates the right provider output. A standalone Node process, such as a `tsx` script, does not run Vite discovery or load the generated Queue Runtime Registry, so `runQueue()` cannot find queue files from there.

```bash [Terminal]
pnpm vite build
```

After the build, inspect `.vitehub/queue/registry.mjs` to confirm that ViteHub found the queue. Then inspect the Queue Provider Output for the Queue Provider you configured.

| Provider | Output to inspect |
| --- | --- |
| Cloudflare | `dist/**/wrangler.json` queue producers and consumers, plus the generated worker bundle. |
| Vercel | `.vercel/output/functions/api/vitehub/queues/vercel/**` consumer functions and trigger config. |

Vercel projects that typecheck generated Queue Provider Output need `lib: ['DOM', 'ESNext']` and `types: ['node']` in `tsconfig.json`.

::note
Queue does not include an in-memory Queue Provider for local Queue Delivery. Test the code your handler calls when you need fast unit coverage, and use generated provider runtime or deployed provider output when you need to prove Queue Enqueue and Queue Delivery together.
::

## Runtime helpers

### `runQueue(name, input)`

Enqueues one Queue Job and returns the Queue Provider acceptance result.

```ts
const result = await runQueue('welcome-email', { email: 'ava@example.com' })
```

Returns:

```ts
type QueueSendResult = {
  messageId?: string
  status: 'queued'
}
```

### `deferQueue(name, input)`

Schedules Queue Enqueue through the current request's `waitUntil` support and returns `void`.

```ts
deferQueue('welcome-email', { email: 'ava@example.com' })
```

Use this when the current request must return without awaiting provider enqueue. ViteHub logs dispatch failures and passes them to `onDispatchError` when the Queue Definition provides one.

### `getQueue(name)`

Returns the provider-specific QueueClient for a discovered Queue Definition.

```ts
const queue = await getQueue('welcome-email')
await queue.send({ email: 'ava@example.com' })
```

### `createQueueClient(options)`

Creates a direct provider QueueClient. Most application code can use `runQueue()` or `getQueue()` and let ViteHub handle discovery and provider configuration.

Cloudflare direct clients require a concrete binding object.

```ts
await createQueueClient({
  provider: 'cloudflare',
  binding,
})
```

Vercel direct clients require a concrete topic.

```ts
await createQueueClient({
  provider: 'vercel',
  topic: 'topic--77656c636f6d65',
  region: 'iad1',
})
```

## Errors

Queue APIs throw the shared `ViteHubError`. Built-in failures derive their public message and allowlisted details from a closed `QueueErrorCode` vocabulary. Application failures can use any stable code with a public message, JSON-safe `details`, an optional `requestId`, and a non-serialized `cause`.

Built-in failures use the closed `QueueErrorCode` union and allowlisted details. Queue Definitions can add an application code explicitly:

```ts
new ViteHubError('WELCOME_EMAIL_REJECTED', 'Welcome email was rejected.', {
  cause,
  details: { campaign: 'welcome' },
})
```

`JSON.stringify(error)` uses the shared safe shape and omits `cause`. Built-in provider errors use fixed messages and allowlisted `{ provider, operation }` details, while the raw SDK or binding failure remains available as `error.cause` in protected server-side diagnostics.

When migrating from package-specific Queue errors, import `ViteHubError` from `@vite-hub/runtime` for application failures and move acknowledgement or retry decisions into `onError` or `callbackOptions.retry`.

| Code | Meaning |
| --- | --- |
| `QUEUE_DISABLED` | Queue runtime support is disabled. |
| `QUEUE_DEFINITION_NOT_FOUND` | No discovered Queue Definition matches the requested name. |
| `QUEUE_DEFINITION_LOAD_FAILED` | A discovered Queue Definition could not be loaded. |
| `QUEUE_PROVIDER_OPERATION_FAILED` | Queue client creation, send, or batch send failed. |
| `QUEUE_PROVIDER_RESPONSE_INVALID` | A successful Vercel send returned a missing or malformed `messageId`. |
| `CLOUDFLARE_BINDING_RESOLUTION_REQUIRED` | A direct Cloudflare client was created without a concrete binding. |
| `CLOUDFLARE_BINDING_INVALID` | The Cloudflare binding does not expose `send()` and `sendBatch()`. |
| `CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS` | Cloudflare received unsupported enqueue options: `idempotencyKey`, `region`, or `retentionSeconds`. |
| `VERCEL_QUEUE_SDK_LOAD_FAILED` | `@vercel/queue` could not be loaded. |
| `VERCEL_QUEUE_SDK_INVALID` | `@vercel/queue` did not expose the expected client API. |
| `VERCEL_QUEUE_REGION_REQUIRED` | Vercel region could not be resolved for the installed SDK shape. |
| `VERCEL_PROVIDER_EXPECTED` | Hosted Vercel Queue Delivery resolved another provider. |
| `VERCEL_TOPIC_RESOLUTION_REQUIRED` | A direct Vercel client was created without a topic. |
| `VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS` | Vercel received unsupported enqueue options such as `contentType`. |

## Provider output

The Queue Package discovers Queue Definitions, generates a Runtime Registry, and emits provider-specific Queue Delivery output.

| Provider | Output |
| --- | --- |
| Cloudflare | Worker bundle plus `wrangler.json` queue producer and consumer entries. |
| Vercel | Queue consumer functions under `.vercel/output/functions/api/vitehub/queues/vercel/**` and queue trigger config. |

Generated files are Provider Output. Do not import them from application code.

## Connect Queue to Agents

Queue is a server primitive, not an Agent Capability by default. An Agent can enqueue work only when you expose that behavior through an app-owned Capability or server route.

Keep the Capability specific to the product task. Don't give a model arbitrary queue access because the app uses Queue internally.

## Next steps

- Use [Workflows](/docs/server-primitives/workflows) for durable orchestration.
- Learn shared discovery rules in [Definitions and discovery](/docs/concepts/definitions-and-discovery).
- Expose app-owned agent actions through [Custom capabilities](/docs/capabilities/custom-capabilities).
