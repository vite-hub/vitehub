---
title: KV configuration
description: Configure the Default KV Store, add named KV Stores, and select the KV driver that each host uses in production.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configuration options

Configure a default store directly, or configure named stores with `kv.stores`.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    kv: {
      stores: {
        default: { driver: 'fs-lite' },
        rateLimit: { driver: 'upstash' },
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      kv: {
        stores: {
          default: { driver: 'fs-lite' },
          rateLimit: { driver: 'upstash' },
        },
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      kv: {
        stores: {
          default: { driver: 'fs-lite' },
          rateLimit: { driver: 'upstash' },
        },
      },
    }),
  ],
})
```
:::
::

| Shape | Description |
| --- | --- |
| `kv: false` | Disables KV runtime configuration. |
| `kv: { driver: 'fs-lite', base?: string }` | Uses local filesystem-backed KV. Default `base`: `.vitehub/data/kv`. |
| `kv: { driver: 'cloudflare-kv-binding', binding?: string, namespaceId?: string }` | Uses Cloudflare KV. Default `binding`: `KV`. `namespaceId` can come from `KV_NAMESPACE_ID`. |
| `kv: { driver: 'deno-kv', path?: string }` | Uses native Deno KV through `Deno.openKv()`. |
| `kv: { driver: 'redis', url?: string, base?: string }` | Uses a Redis server over TCP. Default `url`: `env:REDIS_URL`, which the server reads when the store starts. `env:<NAME>` reads another variable. A literal URL goes into the build output. `base` prefixes the keys. Default `base`: `vitehub:kv:<store>`, so a Redis database that other apps use keeps their keys apart, and `kv.clear()` deletes only this store. |
| `kv: { driver: 'database', database?: string }` | Keeps the keys in the table `vitehub_kv` of a Database. Default `database`: `default`. The store creates the table when it is missing. Works on Postgres and libSQL, not on D1. |
| `kv: { driver: 'upstash', url?: string, token?: string }` | Uses Upstash REST KV. Values can come from `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or from `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` when the first pair is unset. |
| `kv: { remote?: boolean }` | Infers the driver from the host and the env. `remote: true` lets `vite dev` use the inferred hosted store. See [Development stays local](#development-stays-local). |
| `kv: { stores: Record<string, KVStoreConfig> }` | Defines named KV Stores. `stores.default` is required. |

`cloudflare-kv-binding` and `upstash` stores also accept `remote`. Builds ignore it.

## Providers

| Provider | Driver | Default resolution in a build |
| --- | --- | --- |
| Redis | `redis` | Used on Node when `REDIS_URL` is set on the server. |
| Database | `database` | Used on Node when the app has a Postgres Default Database and `REDIS_URL` is not set. |
| Local filesystem | `fs-lite` | Used on Node when neither applies. |
| Cloudflare KV | `cloudflare-kv-binding` | Used on Cloudflare hosting. |
| Deno KV | `deno-kv` | Used on Deno hosting. |
| Upstash | `upstash` | Used when Upstash env vars are present during the build or when Vercel hosting is detected. |

### Node picks a shared store

Several Node processes share KV keys only through a shared store. Without a `driver`, a Node build picks the store in this order:

1. `redis` when `REDIS_URL` is set. The server reads it when the store starts, so one build can run with or without Redis.
2. `database` when the app has a Default Database on Postgres. The build reads the Database Definition for that, without running it.
3. `fs-lite` in `.vitehub/data/kv`, which only one host can read.

`vitehub inspect definitions --kind kv` shows the build driver, for example `database, or redis when REDIS_URL is set at runtime`. Each server process prints the driver it picked when it starts, for example `[vitehub] KV store "default" uses Redis, because REDIS_URL is set.`, and `vitehub kv list` prints it too. Set the same `REDIS_URL` on every process: a process without it uses another store. An explicit `driver` turns the inference off, and so does `vitehub({ dataDir })`, which selects `fs-lite` in that directory. `vite dev` keeps the inferred store on `fs-lite`.

The Nitro cache follows KV with `cache: { driver: 'kv' }`, so cached responses are shared too. See [Nitro cache in KV](#nitro-cache-in-kv).

## Development stays local

In `vite dev` (and `nuxt dev`), a KV store is local unless it sets `remote: true`. Upstash env vars in `.env` and the Vercel preset do not select Upstash in development. The inferred store is `fs-lite` in `.vitehub/data/kv`.

On the Cloudflare preset, a store uses the KV binding of the dev runtime when there is one, for example on the workerd runner (`nitro.devServer.runner: 'miniflare'`). That binding is a local emulation. Nitro's default Node runner has no binding, so the store uses `fs-lite` in `.vitehub/data/kv-cloudflare/<binding>`. It applies the [Workers KV limits](/docs/kv/limits-and-errors#limits) and does not support `setIfAbsent()`, like Cloudflare KV. It does not expire keys.

Set `remote: true` to use the real store in development:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    kv: { remote: true },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({ kv: { remote: true } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ kv: { remote: true } })],
})
```
:::
::

::warning
Writes from `vite dev` then change real data. The development server prints `KV store "default" is remote` on the first operation, and `vitehub inspect definitions --kind kv` shows `Development: Remote`.
::

With `remote: true`, development infers the driver as a build does: Upstash env, or the Vercel or Cloudflare preset. On Cloudflare, ViteHub writes `remote: true` on the generated Wrangler KV binding, so the dev runtime connects the binding to the real namespace. This needs a runner that provides bindings. Use `remote: true` on the store instead of `experimental_remote` in your own `kv_namespaces`.

Upstash credentials in development can come from Vite's `.env` files for the current mode and `envDir`. Existing process environment values take precedence. These credentials stay in the development server runtime.

An explicit `driver` is honored in development as before: an `upstash` store uses Upstash and prints the notice. Only inference and the Cloudflare fallback depend on `remote`. Builds ignore `remote`, so the build output does not change. `remote: true` with `fs-lite` or `deno-kv`, `remote: false` with `upstash`, and `remote: true` in development without a hosted store fail with [`KV_REMOTE_CONFLICT`](/docs/kv/limits-and-errors#kv_remote_conflict).

## Nitro cache in KV

Nitro keeps `defineCachedFunction()`, `defineCachedEventHandler()`, and route rule cache entries in its `cache` storage, which is memory in each server instance unless something mounts it. With `vitehub()`, set `cache: { driver: 'kv' }` to keep them in the default KV Store instead:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { preset: 'cloudflare', kv: true, cache: { driver: 'kv' } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'cloudflare', kv: true, cache: { driver: 'kv' } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: 'cloudflare', kv: true, cache: { driver: 'kv' } })],
})
```
:::
::

Cache keys get the `nitro-cache:` prefix, so they stay apart from the app's keys. `base` changes the prefix. Development uses the dev KV Store too. Nitro passes each entry's `maxAge` as the TTL: Cloudflare KV keeps an entry at least 60 seconds, Redis, the `database` driver, Upstash, and Deno KV expire it on time, and `fs-lite` keeps the file until it is overwritten. Nitro checks the entry's age on every read, so an entry that outlives its TTL is never served as fresh. The option fails the build when `kv` is not enabled. A `cache` mount in `nitro.kv` (`nitro.storage` in Nuxt) takes precedence.
