---
title: Queue
description: Define Queue Definitions, enqueue Queue Jobs, and choose Cloudflare or Vercel Queue Providers.
navigation.order: 9
navigation.group: Background work
icon: i-lucide-list-ordered
---

Use Queue when a request needs to hand off work and return before that work finishes. You define a handler in a Queue Definition, then call `runQueue()` with the Definition name and a payload. ViteHub sends the job to Cloudflare Queues or Vercel Queues, and the provider delivers it to your handler later.

Enqueueing confirms that the provider accepted the job. It does not confirm that the handler ran successfully. Queue works without Agents.

::tip
Choose the background-work primitive by what the caller needs:

- Queue: hand off one job and return. The caller gets provider acceptance, not a handler result or run status.
- [Workflows](/docs/server-primitives/workflows): long-running work with a tracked run id, durable steps, waits, and progress inspection.
- [Schedule](/docs/server-primitives/schedule): start work at cron times, from static entries or Runtime Schedules.
::

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
  plugins: [hubQueue({ provider: 'cloudflare' })],
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

With the `vite-hub` package, use `vitehub({ preset, queue: true })` and import from `vite-hub/queue`. The `cloudflare` and `vercel` presets select the matching provider. On Cloudflare, `vitehub()` also sets `namePrefix` to `<app-name>-`. Other presets reject Queue.

## Public imports

| Import | Use |
| --- | --- |
| `defineQueue` from `@vite-hub/queue` | Declare a Queue Definition. |
| `runQueue`, `deferQueue`, `getQueue` from `@vite-hub/queue` | Enqueue jobs and access discovered QueueClients with typed names and payloads. |
| `dynamicQueue` from `@vite-hub/queue` | Enqueue jobs or get clients for names read from external input. |
| `createQueueClient` from `@vite-hub/queue` | Create a direct provider QueueClient. |
| `createQueueMessageId` from `@vite-hub/queue` | Generate a ViteHub message id with an optional prefix. |
| `ViteHubError` and `getViteHubErrorShape` from `@vite-hub/runtime` | Throw application failures or inspect Queue errors by namespaced code. |
| `createCloudflareQueueBatchHandler` from `@vite-hub/queue` | Build a Cloudflare batch handler outside generated Provider Output. |
| `getCloudflareQueueName`, `getCloudflareQueueBindingName`, `getCloudflareQueueDefinitionName`, `getVercelQueueTopicName` from `@vite-hub/queue` | Inspect provider-derived names. Do not persist these names as application identifiers. |
| `handleHostedVercelQueueCallback` from `@vite-hub/queue/runtime/hosted`, `createQueueCloudflareWorker` from `@vite-hub/queue` | Host adapter helpers used by generated Provider Output. Install `@vercel/functions` when you import the Vercel-specific runtime. |
| `hubQueue`, `createCloudflareQueueConfig` from `@vite-hub/queue/vite` | Register the Vite Integration and emit Cloudflare queue config. |
| `@vite-hub/queue/nuxt` | Compose Queue into a Nuxt app. |

Queue option, client, job, provider, registry, and result types are exported from `@vite-hub/queue`. Generated output uses the specific `@vite-hub/queue/internal/runtime/*` subpaths listed in the package exports; do not import those runtime modules from application code.

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

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | `'cloudflare' \| 'vercel'` | inferred | Selects the Queue Provider. ViteHub resolves Cloudflare for Cloudflare hosting and Vercel for other supported production builds. Netlify cannot infer a Queue Provider, so set `provider` or disable Queue there. |
| `cache` | `boolean` | `true` | Controls named QueueClient reuse for providers that can cache clients. Cloudflare QueueClients still resolve the request-scoped binding for each request. |
| `binding` | `string` | derived | Cloudflare only. Overrides the generated binding name. You can use it with one Queue Definition only. |
| `namePrefix` | `string` | none | Cloudflare only. Prefixes the generated queue names: `<namePrefix>queue--<hex-name>`. |
| `region` | `string` | resolved at runtime | Vercel only. Sets the default Vercel Queue region. |

### `queue: false`

Disables runtime queue dispatch and skips generated Vercel queue consumer functions. Runtime calls throw `QUEUE_DISABLED`.

## Providers

| Provider | Configure with | Generated output | Notes |
| --- | --- | --- | --- |
| Cloudflare | `queue: { provider: 'cloudflare' }` | Worker queue handler and `wrangler.json` `queues.producers` / `queues.consumers` entries. | Uses request-scoped queue bindings. Supports `contentType` and `delaySeconds`. |
| Vercel | `queue: { provider: 'vercel', region?: string }` | `.vercel/output` queue consumer functions with Vercel queue triggers. | Requires `@vercel/queue`. Supports idempotency, region, retention, and delayed send options. |

ViteHub has no Queue Provider for local delivery, Deno, or self-hosted Node. Check the [runtime and host support matrix](/docs/frameworks-hosts/support-matrix) before you choose a deployment target.

### Cloudflare names

Without `binding`, ViteHub derives a binding from the Queue Definition name, such as `QUEUE_77656C636F6D65` for `welcome`. Cloudflare queue names are generated as `<namePrefix>queue--<hex-name>`. A name longer than 63 characters becomes a readable prefix plus a digest. Application code must not depend on these names. Use `runQueue()` with the Queue Definition name.

### Vercel region and topics

If you omit `region`, ViteHub checks `QUEUE_REGION`, then `VERCEL_REGION`, then request headers in a Vercel request context.

Vercel topic names are generated as `topic--<hex-name>`. Application code must not depend on that topic. Use `runQueue()` with the Queue Definition name.

## Define a queue

Create a Queue Definition in `server/queues/<name>.ts` or `src/<name>.queue.ts`.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  await sendWelcomeEmail(job.payload.email)
})
```

The queue name comes from discovery. Runtime Helpers address this file as `welcome-email`.

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

| Option | Type | Provider | Description |
| --- | --- | --- | --- |
| `cache` | `boolean` | All | Overrides QueueClient caching for this Queue Definition. |
| `concurrency` | `number` | Cloudflare | Controls batch delivery concurrency. Default: `1`. Values are floored to an integer and never lower than `1`. |
| `onError` | `(error, message, batch) => 'ack' \| 'retry' \| { retry: { delaySeconds?: number } } \| void` | Cloudflare | Handles message delivery errors. See [Handle failures](#handle-failures). |
| `callbackOptions` | `{ retry?: VercelQueueRetryHandler, visibilityTimeoutSeconds?: number }` | Vercel | Passes callback options to `@vercel/queue` for this Queue Definition. |
| `onDispatchError` | `(error, context) => unknown \| Promise<unknown>` | All | Handles dispatch errors from `deferQueue()`. This is not a Queue Delivery error hook. |

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
| Cloudflare | A successful handler acknowledges the message. A failed handler retries, except for non-retryable built-in Queue errors. | Return `'ack'`, `'retry'`, or `{ retry: { delaySeconds } }` from `onError`. Return `void` to keep the default. |
| Vercel | Provider behavior. ViteHub acknowledges errors classified as non-retryable built-in Queue errors when the callback returns `undefined`; other `undefined` results keep Vercel's retry behavior. | Return a directive from `callbackOptions.retry`. Return `void` to keep the default. |

Throw `ViteHubError` when the Queue Definition needs a stable application failure code. Application error codes do not choose retry policy. Use `onError` or `callbackOptions.retry` for that.

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

Application error codes and details are public. Keep credentials, provider responses, and private resource locations in `cause`. ViteHub reports each failed delivery before it chooses a provider action. Reports include the Queue Definition, safe message identifiers, attempt count, `code`, `details`, and retry policy. They do not serialize `cause` or unsafe identifiers.

## Enqueue work

Use `runQueue()` from server code. Pass the payload and the enqueue options as separate arguments.

```ts [server/api/signup.post.ts]
import { runQueue } from '@vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)

  return runQueue('welcome-email', { email: body.email }, {
    idempotencyKey: `welcome:${body.email}`,
  })
})
```

Payload fields such as `payload`, `region`, and `id` remain business data. ViteHub does not read options from the payload.

## Queue Enqueue options

| Option | Type | Cloudflare | Vercel | Description |
| --- | --- | --- | --- | --- |
| `id` | `string` | Yes | Yes | ViteHub message id. If omitted, ViteHub generates one. |
| `contentType` | `'bytes' \| 'json' \| 'text' \| 'v8'` | Yes | No | Cloudflare message content type. |
| `delaySeconds` | `number` | Yes | Yes | Provider-supported enqueue delay. |
| `idempotencyKey` | `string` | No | Yes | Vercel idempotency key. Defaults to the message `id` when omitted. |
| `region` | `string` | No | Yes | Vercel send region for this Queue Enqueue. |
| `retentionSeconds` | `number` | No | Yes | Vercel message retention time. |

Unsupported provider options throw `ViteHubError` with a provider-specific code instead of being ignored. Cloudflare does not accept `idempotencyKey`, so protect non-repeatable side effects inside the handler.

## Runtime helpers

### `runQueue(name, payload, options?)`

Enqueues one Queue Job and returns the Queue Provider acceptance result.

```ts
const result = await runQueue('welcome-email', { email: 'ava@example.com' }, { delaySeconds: 60 })
```

Returns:

```ts
type QueueSendResult = {
  messageId?: string
  status: 'queued'
}
```

`status: 'queued'` is the portable acceptance signal. Vercel returns the message id from its enqueue response. Cloudflare returns the ViteHub `id`. Cloudflare does not receive that id, and its later delivery has a different Cloudflare message id.

### `deferQueue(name, payload, options?)`

Schedules Queue Enqueue through the current request's `waitUntil` support and returns `void`.

```ts
deferQueue('welcome-email', { email: 'ava@example.com' })
```

Use this when the current request must return without waiting for provider enqueue. ViteHub logs dispatch failures and passes them to `onDispatchError` when the Queue Definition provides one.

### `getQueue(name)`

Returns the provider-specific QueueClient for a discovered Queue Definition.

```ts
const queue = await getQueue('welcome-email')
await queue.send({ email: 'ava@example.com' })
```

### `dynamicQueue`

Use `dynamicQueue.run(name, payload, options?)`, `dynamicQueue.defer()`, or `dynamicQueue.get()` for names read from external input. These methods check at runtime that the Definition exists. They do not validate the payload shape, so validate external data in your application.

### `createQueueClient(options)`

Creates a direct provider QueueClient. Most application code can use `runQueue()` or `getQueue()` and let ViteHub handle discovery and provider configuration. Direct clients accept unknown payloads because they have no Queue Definition.

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

## Definition-owned dispatch types

The Vite Integration writes `.vitehub/queue.d.ts`. Include that file in your TypeScript project. The Nuxt Integration adds it to the generated type context. Names and payloads then come from the discovered Queue Definitions:

```ts
await runQueue('welcome-email', { email: 'ada@example.com' }, { delaySeconds: 60 })
const queue = await getQueue('welcome-email')
await queue.send({ email: 'ada@example.com' })
```

`QueueRegistry` is the generated Definition map. `QueuePayload<'welcome-email'>` extracts a payload type. A missing name or wrong payload is a type error. Run Vite configuration or the Nuxt prepare step after you add a Definition. For a standalone TypeScript host, you can extend `QueueRegistry` with `typeof import('./welcome.queue').default`.

::note
Earlier versions accepted an envelope: `runQueue(name, { payload, ...options })` and `client.send({ payload, ...options })`. Replace them with `runQueue(name, payload, options)` and `client.send(payload, options)`. There is no envelope detection. Existing envelope objects are delivered whole as payloads.
::

## Errors

Queue APIs throw the shared `ViteHubError`. Built-in failures use the closed `QueueErrorCode` union, fixed public messages, and allowlisted details such as `{ provider, operation }`. The raw SDK or binding failure stays in `error.cause` for protected server-side diagnostics. `JSON.stringify(error)` uses the shared safe shape and omits `cause`.

Application failures can use any stable code with a public message, JSON-safe `details`, an optional `requestId`, and a non-serialized `cause`:

```ts
new ViteHubError('WELCOME_EMAIL_REJECTED', 'Welcome email was rejected.', {
  cause,
  details: { campaign: 'welcome' },
})
```

When you migrate from package-specific Queue errors, import `ViteHubError` from `@vite-hub/runtime` for application failures. Move acknowledgement and retry decisions into `onError` or `callbackOptions.retry`.

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

## Develop locally

Queue has no in-memory Queue Provider for local delivery. Use a build to check that ViteHub discovers your Queue Definitions and generates the right provider output. A standalone Node process, such as a `tsx` script, does not run Vite discovery or load the generated Queue Runtime Registry, so `runQueue()` cannot find queue files from there.

```bash [Terminal]
pnpm vite build
pnpm add vite-hub
pnpm vitehub inspect definitions --kind queue
```

The build writes `.vitehub/queue/registry.mjs`. `vitehub inspect definitions` lists the Queue Definitions that ViteHub found. Then inspect the Provider Output for the Queue Provider you configured.

| Provider | Output to inspect |
| --- | --- |
| Cloudflare | `dist/**/wrangler.json` queue producers and consumers, plus the generated worker bundle. |
| Vercel | `.vercel/output/functions/api/vitehub/queues/vercel/**` consumer functions and trigger config. |

Vercel projects that typecheck generated Queue Provider Output need `lib: ['DOM', 'ESNext']` and `types: ['node']` in `tsconfig.json`.

For fast unit coverage, test the code that your handler calls. To prove Queue Enqueue and Queue Delivery together, use the generated provider runtime or deployed provider output.

## Provider output

The Queue Package discovers Queue Definitions, generates a Runtime Registry, and emits provider-specific Queue Delivery output.

| Provider | Output |
| --- | --- |
| Cloudflare | Worker bundle plus `wrangler.json` queue producer and consumer entries. |
| Vercel | Queue consumer functions under `.vercel/output/functions/api/vitehub/queues/vercel/**` and queue trigger config. |

Generated files are Provider Output. Do not import them from application code.

## Production checks

- `runQueue()` resolves when the provider accepts the job. Track handler results in your own storage, or use [Workflows](/docs/server-primitives/workflows) when the caller needs run status.
- Providers can deliver a job more than once. Make handlers safe to run again after a partial side effect.
- Cloudflare needs a deployed request-scoped binding and an existing queue. `vitehub provision run --provider cloudflare` can create the generated queues when account credentials are present. See [Provisioning](/docs/development/provisioning).
- Vercel needs the generated topic, the `@vercel/queue` runtime, and a resolvable region when the installed SDK requires one.

## Connect Queue to Agents

Queue has no official Agent Capability. An Agent can enqueue work only when you expose that behavior through an app-owned Capability or server route.

Keep the Capability specific to the product task. Do not give a model arbitrary queue access because the app uses Queue internally.

## Next steps

- Use [Workflows](/docs/server-primitives/workflows) for durable orchestration.
- Use [Schedule](/docs/server-primitives/schedule) for recurring work.
- Learn shared discovery rules in [Definitions and discovery](/docs/concepts/definitions-and-discovery).
- Expose app-owned agent actions through [Custom capabilities](/docs/capabilities/custom-capabilities).
