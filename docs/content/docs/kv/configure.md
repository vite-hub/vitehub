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
| `kv: { driver: 'deno-kv', path?: string }` | Uses Deno KV through `Deno.openKv()`. |
| `kv: { driver: 'upstash', url?: string, token?: string }` | Uses Upstash REST KV. Reads `KV_REST_API_URL` and `KV_REST_API_TOKEN`, else `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. |
| `kv: { stores: Record<string, KVStoreConfig> }` | Adds named stores. `stores.default` is required. |

## Providers

| Provider | Driver | Default resolution |
| --- | --- | --- |
| Local filesystem | `fs-lite` | Local development, when no host is detected. |
| Cloudflare KV | `cloudflare-kv-binding` | Cloudflare. |
| Deno KV | `deno-kv` | Deno. |
| Upstash | `upstash` | Upstash env vars are set, or the host is Vercel. |

## Nitro cache in KV

Nitro keeps entries from `defineCachedFunction()`, `defineCachedEventHandler()`, and route rule caches in its `cache` storage. By default, that is memory in each server instance. Set `cache: { driver: 'kv' }` to keep them in the default KV store:

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

- Cache keys start with `nitro-cache:`, apart from your keys. `base` changes the prefix. Development uses the dev store.
- Nitro sends each entry's `maxAge` as the TTL. Cloudflare KV keeps entries at least 60 seconds, Upstash and Deno KV expire them on time, and `fs-lite` keeps the file until a new write. Nitro checks the age on each read, so it never serves an expired entry as fresh.
- The build fails when `kv` is not enabled.
- A `cache` mount in `nitro.kv` (`nitro.storage` in Nuxt) wins over this option.
