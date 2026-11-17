---
title: Queue configuration
description: Configure the Queue Vite Integration, Queue drivers, generated names, and Queue Definitions.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configure the Vite Integration

Turn on Queue with `queue: true`. The `host` picks the Queue Provider (the service that stores and delivers jobs).

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'cloudflare', queue: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare', queue: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare', queue: true })],
})
```
:::
::

With `vitehub()`, the host sets `driver`, and on Cloudflare the app name sets `namePrefix`. On `host: 'node'`, ViteHub picks `postgres` when the app has a Postgres Default Database, else `local`. To pick it yourself, set `queue: { driver: 'postgres' }` or `queue: { driver: 'local' }`:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', queue: { driver: 'postgres' } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', queue: { driver: 'postgres' } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', queue: { driver: 'postgres' } })],
})
```
:::
::

Set other Queue options directly in `vitehub({ queue: { ... } })` or the Nuxt `vitehub.queue` object. An option that you set wins over the host:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'vercel', queue: { driver: 'vercel', region: 'iad1' } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'vercel', queue: { driver: 'vercel', region: 'iad1' } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'vercel', queue: { driver: 'vercel', region: 'iad1' } })],
})
```
:::
::

With `@vite-hub/queue` alone, pass the same options to `hubQueue()` from `@vite-hub/queue/vite`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `driver` | `'cloudflare' \| 'vercel' \| 'local' \| 'postgres'` | inferred | The Queue Provider. Cloudflare on Cloudflare hosting, and Vercel for other production builds. On a Node server (`host: 'node'` or Nitro `node-server`), `postgres` with a Postgres Default Database, else `local`. On Netlify, set `driver` or turn Queue off. |
| `cache` | `boolean` | `true` | Reuses named QueueClients where the driver allows it. Cloudflare clients still read the request's binding on each request. |
| `binding` | `string` | derived | Cloudflare only. Overrides the generated binding name. Works with one Queue Definition only. |
| `namePrefix` | `string` | none | Cloudflare only. Prefix of generated queue names: `<namePrefix>queue--<hex-name>`. |
| `region` | `string` | resolved at runtime | Vercel only. Default Vercel Queue region. |
| `base` | `string` | `.vitehub/data/queue` | Local only. Folder of stored jobs, relative to the server's working directory. |

### `queue: false`

Turns Queue off. The server then has no Queue runtime, so `sendQueue()` throws `QUEUE_DEFINITION_NOT_FOUND`. This applies to `vitehub()` and to `hubQueue(false)` from `@vite-hub/queue`. `hubQueue(false)` also adds no Vercel consumer functions. In Vitest, the generated test setup installs the `false` config, so Queue calls throw `QUEUE_DISABLED`.

## Drivers

| Driver | Configure with | Generated output | Notes |
| --- | --- | --- | --- |
| Cloudflare | `queue: { driver: 'cloudflare' }` | Worker queue handler and `wrangler.json` `queues.producers` / `queues.consumers` entries. | Uses the request's queue bindings. Supports `contentType` and `delaySeconds`. |
| Vercel | `queue: { driver: 'vercel', region?: string }` | One Nitro route per Queue Definition with a Vercel queue trigger. | Needs `@vercel/queue` and `@vercel/functions` in the app. Supports idempotency, region, retention, and delay. |
| Local | `queue: { driver: 'local', base?: string }` | A Nitro plugin that runs stored jobs in the server process. | Default of the Node host without a Postgres Database. Supports `delaySeconds` and `idempotencyKey`. Jobs stay on one host. `pnpm dev` uses it for every driver, with that driver's rules. |
| Postgres | `queue: { driver: 'postgres' }` | A Nitro plugin that starts workers in each server process and stops them when Nitro closes. | Default of the Node host with a Postgres Default Database. Uses the Default Database's connection. `QUEUE_POSTGRES_URL` overrides it, and an explicit driver without a Postgres Database needs it. Every instance runs jobs. Supports `delaySeconds` and `idempotencyKey`. Install `postgres`. |

ViteHub has no Queue Provider for Deno. The local driver keeps jobs on one host, so read [Local delivery](/docs/queue/limits-and-errors#local-delivery) before you run more than one server. For more than one Node server, use the postgres driver: see [Postgres delivery](/docs/queue/limits-and-errors#postgres-delivery). Check the [support matrix](/docs/frameworks-hosts/support-matrix) before you pick a host.

### Cloudflare names

Without `binding`, the binding comes from the queue name, such as `QUEUE_77656C636F6D65` for `welcome`. Cloudflare queue names are `<namePrefix>queue--<hex-name>`. A name over 63 characters becomes a readable prefix plus a digest. Do not depend on these names. Call `sendQueue()` with the queue name.

### Vercel region and topics

Without `region`, ViteHub reads `QUEUE_REGION`, then `VERCEL_REGION`, then the headers of a Vercel request.

Vercel topic names are `topic--<hex-name>`. Do not depend on them. Call `sendQueue()` with the queue name.

## Define a queue

Create a Queue Definition (the file that handles one queue's jobs) in `server/queues/<name>.ts` or `src/<name>.queue.ts`.

```ts [server/queues/welcome-email.ts] fragment
import { defineQueue } from 'vite-hub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  await sendWelcomeEmail(job.payload.email)
})
```

The file path gives the queue name. Runtime helpers call this file `welcome-email`.

## Queue Definition options

Pass options as the second argument to `defineQueue()`.

```ts [server/queues/report.ts] fragment
import { defineQueue } from 'vite-hub/queue'

export default defineQueue<{ reportId: string }>(async (job) => {
  await buildReport(job.payload.reportId)
}, {
  concurrency: 5,
})
```

| Option | Type | Provider | Description |
| --- | --- | --- | --- |
| `cache` | `boolean` | All | Overrides QueueClient caching for this queue. |
| `concurrency` | `number` | Cloudflare | Batch delivery concurrency. Default `1`. Rounded down to an integer, at least `1`. |
| `onError` | `(error, message, batch) => 'ack' \| 'retry' \| { retry: { delaySeconds?: number } } \| void` | Cloudflare | Handles delivery errors. See [Handle failures](/docs/queue/server-api#handle-failures). |
| `callbackOptions` | `{ retry?: VercelQueueRetryHandler, visibilityTimeoutSeconds?: number }` | Vercel | Callback options for `@vercel/queue` for this queue. |
| `onDispatchError` | `(error, context) => unknown \| Promise<unknown>` | All | Handles dispatch errors from `deferQueue()`, not delivery errors. |

## Contribute Queues from a package

A package can add a queue from its Vite plugin, so apps do not write `server/queues/<name>.ts`. Add `vitehub.queues` to the plugin:

```ts [my-package/vite.ts] fragment
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import type { QueueContributingPlugin } from '@vite-hub/queue/vite'

export function myPackage(): Plugin & QueueContributingPlugin {
  return {
    name: 'my-package/vite',
    vitehub: {
      queues: [{
        name: 'my-package-deliveries',
        definition: { module: fileURLToPath(new URL('./deliver.js', import.meta.url)) },
        reason: 'Delivers webhooks after their delay.',
      }],
    },
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Queue name for `sendQueue()` and provider output. Letters, numbers, `.`, `_`, `-`, and `/`. |
| `definition.module` | `string` | Absolute file path or `file:` URL of a module with `export default defineQueue(...)`. |
| `definition.export` | `string` | Must be `default`. Default `default`. |
| `reason` | `string` | Optional. Why the package adds it. Shown by `vitehub inspect definitions` and the Console. |

`vitehub.queues` accepts an array or a factory, which can be async and gets `{ root, projectRoot, serverDirs }`. A package queue works like a `server/queues/` file on every host: it gets the generated types, a Cloudflare binding and consumer, a Vercel consumer route, provisioning, and the local or postgres worker on Node.

Build errors:

- `QUEUE_DEFINITION_DUPLICATE`: the name is already used by a file or another plugin. The message names both.
- `QUEUE_CONTRIBUTION_INVALID`: the entry is invalid, or the module does not exist.

`collectQueueContributions(plugins, context)` from `@vite-hub/queue/vite` returns the checked list for other build steps.
