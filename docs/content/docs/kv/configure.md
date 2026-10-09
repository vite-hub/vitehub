---
title: KV configuration
description: Configure the Default KV Store, named KV Stores, and KV drivers.
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
