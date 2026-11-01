---
title: KV configuration
description: Configure the Default KV Store, add named KV Stores, and select the KV driver that each host uses in production.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configuration options

Configure a default store directly, or configure named stores with `kv.stores`.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubKv()],
  kv: {
    stores: {
      default: { driver: 'fs-lite' },
      rateLimit: { driver: 'upstash' },
    },
  },
})
```

| Shape | Description |
| --- | --- |
| `kv: false` | Disables KV runtime configuration. |
| `kv: { driver: 'fs-lite', base?: string }` | Uses local filesystem-backed KV. Default `base`: `.vitehub/data/kv`. |
| `kv: { driver: 'cloudflare-kv-binding', binding?: string, namespaceId?: string }` | Uses Cloudflare KV. Default `binding`: `KV`. `namespaceId` can come from `KV_NAMESPACE_ID`. |
| `kv: { driver: 'deno-kv', path?: string }` | Uses native Deno KV through `Deno.openKv()`. |
| `kv: { driver: 'upstash', url?: string, token?: string }` | Uses Upstash REST KV. Values can come from `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or from `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` when the first pair is unset. |
| `kv: { stores: Record<string, KVStoreConfig> }` | Defines named KV Stores. `stores.default` is required. |

## Providers

| Provider | Driver | Default resolution |
| --- | --- | --- |
| Local filesystem | `fs-lite` | Used for local/non-hosted development when no hosted env is detected. |
| Cloudflare KV | `cloudflare-kv-binding` | Used on Cloudflare hosting. |
| Deno KV | `deno-kv` | Used on Deno hosting. |
| Upstash | `upstash` | Used when Upstash env vars are present or when Vercel hosting is detected. |

## Nitro cache in KV

Nitro keeps `defineCachedFunction()`, `defineCachedEventHandler()`, and route rule cache entries in its `cache` storage, which is memory in each server instance unless something mounts it. With `vitehub()`, set `cache: { driver: 'kv' }` to keep them in the default KV Store instead:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({ preset: 'cloudflare', kv: true, cache: { driver: 'kv' } })],
})
```

Cache keys get the `nitro-cache:` prefix, so they stay apart from the app's keys. `base` changes the prefix. Development uses the dev KV Store too. Nitro passes each entry's `maxAge` as the TTL: Cloudflare KV keeps an entry at least 60 seconds, Upstash and Deno KV expire it on time, and `fs-lite` keeps the file until it is overwritten. Nitro checks the entry's age on every read, so an entry that outlives its TTL is never served as fresh. The option fails the build when `kv` is not enabled. A `cache` mount in `nitro.storage` takes precedence.
