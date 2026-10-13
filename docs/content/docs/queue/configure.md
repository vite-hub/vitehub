---
title: Queue configuration
description: Configure the Queue Vite Integration, Queue Providers, generated names, and Queue Definitions.
navigation.title: Configure
navigation.order: 4
icon: i-lucide-sliders-horizontal
---

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
| `onError` | `(error, message, batch) => 'ack' \| 'retry' \| { retry: { delaySeconds?: number } } \| void` | Cloudflare | Handles message delivery errors. See [Handle failures](/docs/queue/server-api#handle-failures). |
| `callbackOptions` | `{ retry?: VercelQueueRetryHandler, visibilityTimeoutSeconds?: number }` | Vercel | Passes callback options to `@vercel/queue` for this Queue Definition. |
| `onDispatchError` | `(error, context) => unknown \| Promise<unknown>` | All | Handles dispatch errors from `deferQueue()`. This is not a Queue Delivery error hook. |
