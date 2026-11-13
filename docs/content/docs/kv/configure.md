---
title: KV configuration
description: Configure the default KV store, add named stores, and pick the driver each host uses in production.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configuration options

Configure one default store, or add named stores with `kv.stores`. The driver is the backend that holds the values.

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
| `kv: false` | Turns KV off. |
| `kv: { driver: 'fs-lite', base?: string }` | Saves values as local files. Default `base`: `.vitehub/data/kv`. |
| `kv: { driver: 'cloudflare-kv-binding', binding?: string, namespaceId?: string }` | Uses Cloudflare KV. Default `binding`: `KV`. `namespaceId` can come from `KV_NAMESPACE_ID`. |
| `kv: { driver: 'deno-kv', path?: string }` | Uses native Deno KV through `Deno.openKv()`. |
| `kv: { driver: 'redis', url?: string, base?: string }` | Uses a Redis server over TCP. Default `url`: `env:REDIS_URL`, which the server reads when the store starts. `env:<NAME>` reads another variable. A literal URL goes into the build output. `base` prefixes the keys. Default `base`: `vitehub:kv:<store>`, so keys that are not ViteHub's stay apart, and `kv.clear()` deletes only this store. Two ViteHub apps on one Redis database share the default, so give each app its own database or `base`. |
| `kv: { driver: 'database', database?: string }` | Keeps the keys in the table `vitehub_kv` of a Database. Default `database`: `default`. The store creates the table when it is missing. Works on Postgres and libSQL, not on D1. |
| `kv: { driver: 'upstash', url?: string, token?: string }` | Uses Upstash REST KV. Values can come from `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or from `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` when the first pair is unset. |
| `kv: { remote?: boolean }` | Infers the driver from the host and the env. `remote: true` lets `vite dev` use the inferred hosted store. See [Development stays local](#development-stays-local). |
| `kv: { stores: Record<string, KVStoreConfig> }` | Defines named KV Stores. `stores.default` is required. |

`cloudflare-kv-binding` and `upstash` stores also accept `remote`. Builds ignore it.

## Providers

| Provider | Driver | Default resolution in a build |
| --- | --- | --- |
| Redis | `redis` | Selected with `driver: 'redis'`; the server reads the URL at runtime. |
| Database | `database` | Used on Node when the app has a Postgres Default Database. |
| Local filesystem | `fs-lite` | Used on Node when neither applies. |
| Cloudflare KV | `cloudflare-kv-binding` | Used on Cloudflare hosting. |
| Deno KV | `deno-kv` | Used on Deno hosting. |
| Upstash | `upstash` | Used when Upstash env vars are present during the build or when Vercel hosting is detected. |

### Node picks a shared store

Several Node processes share KV keys only through a shared store. Without a `driver`, a Node build picks the store in this order:

1. `database` when the app has a Default Database on Postgres. The build reads the Database integration's resolved configuration, without running the Database.
2. `fs-lite` in `.vitehub/data/kv`, which only one host can read.

The driver is selected at build time. To use Redis, set `kv: { driver: 'redis' }` and supply the same `REDIS_URL` on every process. A missing URL fails instead of falling back to another store. Setting `REDIS_URL` for another service does not move KV keys or change its driver.

`vitehub inspect definitions --kind kv` and `vitehub kv list` report the selected driver. `vitehub({ dataDir })` selects `fs-lite` in that directory. `vite dev` keeps the inferred store on `fs-lite`.

The Nitro cache follows KV with `cache: { driver: 'kv' }`, so cached responses are shared too. See [Nitro cache in KV](#nitro-cache-in-kv).

`fs-lite` writes each key as one file in `base`. The file name starts with `key-`, followed by the key with `%` and `:` escaped as in a URL, so `signups` and `signups:reset-at` are the files `key-signups` and `key-signups%3Areset-at`. This prefix keeps application keys separate from migration metadata and temporary files. Most file systems limit a file name to 255 bytes, so an escaped key longer than 251 bytes fails with `KV_OPERATION_FAILED`. Earlier versions wrote `a:b` as the file `a/b`. The store moves those files to their new names when it opens the folder and preserves literal `%` characters in old key names. It keeps a hidden layout record and metadata folder in `base`. The migration lock stays in that folder, so only `base` needs write access. Copies and backups must preserve hidden files and hard links; follow the procedure below before opening a copied store.

### Move an fs-lite store

Stop all processes that use the store before you move it. The hidden layout record and its workspace marker must remain hard links to the same file. This identity separates migration state from application keys. An ordinary `cp -R` breaks it and can make existing keys inaccessible.

On Linux with GNU Coreutils, copy the whole folder with `cp -a`. The destination must be a new path. Verify the hard links before you open the copy:

```sh
copy=/path/to/kv-copy
cp -a -- /path/to/kv "$copy" || exit 1
for record in "$copy"/.unstorage-tmp-vitehub-layout-v1*; do
  workspace=$(cat "$record") || exit 1
  test "$record" -ef "$copy/$workspace/.unstorage-tmp-vitehub-record" || exit 1
done
```

The loop also checks records with a numeric suffix. If any command fails, keep the original store and create a new copy with a tool that preserves hard links. Do not open the failed copy. On other systems, use a backup tool that preserves hidden files and hard links, and verify that the copied record and marker have the same file identity before opening the store.

## Development stays local

In `vite dev` (and `nuxt dev`), a KV store is local unless it sets `remote: true`. Upstash env vars in `.env` and the Vercel host do not select Upstash in development. The inferred store is `fs-lite` in `.vitehub/data/kv`.

On the Cloudflare host, a store uses the KV binding of the dev runtime when there is one, for example on the workerd runner (`nitro.devServer.runner: 'miniflare'`). That binding is a local emulation. Nitro's default Node runner has no binding, so the store uses `fs-lite` in `.vitehub/data/kv-cloudflare/<binding>`. It applies the [Workers KV limits](/docs/kv/limits-and-errors#limits), raises a `ttl` below 60 seconds to 60, and does not support `setIfAbsent()`, like Cloudflare KV.

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

With `remote: true`, development infers the driver as a build does: Upstash env, or the Vercel or Cloudflare host. On Cloudflare, ViteHub writes `remote: true` on the generated Wrangler KV binding, so the dev runtime connects the binding to the real namespace. This needs a runner that provides bindings. Use `remote: true` on the store instead of `experimental_remote` in your own `kv_namespaces`.

Upstash credentials in development can come from Vite's `.env` files for the current mode and `envDir`. Existing process environment values take precedence. These credentials stay in the development server runtime.

An explicit `driver` is honored in development as before: an `upstash` store uses Upstash and prints the notice. Only inference and the Cloudflare fallback depend on `remote`. Builds ignore `remote`, so the build output does not change. `remote: true` with `fs-lite` or `deno-kv`, `remote: false` with `upstash`, and `remote: true` in development without a hosted store fail with [`KV_REMOTE_CONFLICT`](/docs/kv/limits-and-errors#kv_remote_conflict).

## Nitro cache in KV

Nitro keeps entries from `defineCachedFunction()`, `defineCachedEventHandler()`, and route rule caches in its `cache` storage. By default, that is memory in each server instance. Set `cache: { driver: 'kv' }` to keep them in the default KV store:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'cloudflare', kv: true, cache: { driver: 'kv' } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare', kv: true, cache: { driver: 'kv' } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare', kv: true, cache: { driver: 'kv' } })],
})
```
:::
::

- Cache keys start with `nitro-cache:`, apart from your keys. `base` changes the prefix. Development uses the dev store.
- Nitro sends each entry's `maxAge` as the TTL. Cloudflare KV keeps entries at least 60 seconds. Redis, the `database` driver, Upstash, Deno KV, and `fs-lite` expire them on time. Nitro checks the age on each read, so it never serves an expired entry as fresh.
- The build fails when `kv` is not enabled.
- A `cache` mount in `nitro.kv` (`nitro.storage` in Nuxt) wins over this option.
