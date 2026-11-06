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
| `kv: { remote?: boolean }` | Infers the driver from the host and the env. `remote: true` lets `vite dev` use the inferred hosted store. See [Development stays local](#development-stays-local). |
| `kv: { stores: Record<string, KVStoreConfig> }` | Defines named KV Stores. `stores.default` is required. |

`cloudflare-kv-binding` and `upstash` stores also accept `remote`. Builds ignore it.

## Providers

| Provider | Driver | Default resolution in a build |
| --- | --- | --- |
| Local filesystem | `fs-lite` | Used when no hosted env or host is detected. |
| Cloudflare KV | `cloudflare-kv-binding` | Used on Cloudflare hosting. |
| Deno KV | `deno-kv` | Used on Deno hosting. |
| Upstash | `upstash` | Used when Upstash env vars are present or when Vercel hosting is detected. |

## Development stays local

In `vite dev` (and `nuxt dev`), a KV store is local unless it sets `remote: true`. Upstash env vars in `.env` and the Vercel preset do not select Upstash in development. The inferred store is `fs-lite` in `.vitehub/data/kv`.

On the Cloudflare preset, a store uses the KV binding of the dev runtime when there is one, for example on the workerd runner (`nitro.devServer.runner: 'miniflare'`). That binding is a local emulation. Nitro's default Node runner has no binding, so the store uses `fs-lite` in `.vitehub/data/kv-cloudflare/<binding>`. It applies the [Workers KV limits](/docs/kv/limits-and-errors#limits) and does not support `setIfAbsent()`, like Cloudflare KV. It does not expire keys.

Set `remote: true` to use the real store in development:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({ kv: { remote: true } })],
})
```

::warning
Writes from `vite dev` then change real data. The development server prints `KV store "default" is remote` on the first operation, and `vitehub inspect definitions --kind kv` shows `Development: Remote`.
::

With `remote: true`, development infers the driver as a build does: Upstash env, or the Vercel or Cloudflare preset. On Cloudflare, ViteHub writes `remote: true` on the generated Wrangler KV binding, so the dev runtime connects the binding to the real namespace. This needs a runner that provides bindings. Use `remote: true` on the store instead of `experimental_remote` in your own `kv_namespaces`.

An explicit `driver` is honored in development as before: an `upstash` store uses Upstash and prints the notice. Only inference and the Cloudflare fallback depend on `remote`. Builds ignore `remote`, so the build output does not change. `remote: true` with `fs-lite` or `deno-kv`, `remote: false` with `upstash`, and `remote: true` in development without a hosted store fail with [`KV_REMOTE_CONFLICT`](/docs/kv/limits-and-errors#kv_remote_conflict).

## Nitro cache in KV

Nitro keeps `defineCachedFunction()`, `defineCachedEventHandler()`, and route rule cache entries in its `cache` storage, which is memory in each server instance unless something mounts it. With `vitehub()`, set `cache: { driver: 'kv' }` to keep them in the default KV Store instead:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({ preset: 'cloudflare', kv: true, cache: { driver: 'kv' } })],
})
```

Cache keys get the `nitro-cache:` prefix, so they stay apart from the app's keys. `base` changes the prefix. Development uses the dev KV Store too. Nitro passes each entry's `maxAge` as the TTL: Cloudflare KV keeps an entry at least 60 seconds, Upstash and Deno KV expire it on time, and `fs-lite` keeps the file until it is overwritten. Nitro checks the entry's age on every read, so an entry that outlives its TTL is never served as fresh. The option fails the build when `kv` is not enabled. A `cache` mount in `nitro.kv` (`nitro.storage` in Nuxt) takes precedence.
