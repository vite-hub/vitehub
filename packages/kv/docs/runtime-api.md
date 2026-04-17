---
title: KV runtime API
description: Reference for the `kv` handle and the common KV config types.
navigation.title: Runtime API
navigation.order: 3
icon: i-lucide-braces
---

## Runtime export

| Export | Use it for |
| --- | --- |
| `kv` | The active key-value storage handle. |

The Vite plugin resolves KV config and exposes it to Vite environments. The `kv` handle is mounted by the Nitro runtime adapter; Nuxt uses that Nitro path under the hood.

## Vite virtual config

Vite code can import the resolved setup config from `virtual:@vitehub/kv/config`.

```ts
import config, { hosting, kv } from 'virtual:@vitehub/kv/config'
```

If TypeScript cannot find the virtual module, add the package's ambient type entry to your app config.

```json [tsconfig.json]
{
  "compilerOptions": {
    "types": ["@vitehub/kv/virtual"]
  }
}
```

## Common methods

| Method | Use it for |
| --- | --- |
| `kv.get(key)` | Read one value. |
| `kv.set(key, value, options?)` | Write one value. |
| `kv.has(key)` | Check whether a key exists. |
| `kv.del(key)` | Remove one key. |
| `kv.clear(prefix?)` | Clear the store or one prefix. |
| `kv.keys(prefix?)` | List keys. |

## Supported driver union

```ts
type KVDriver = 'cloudflare-kv-binding' | 'upstash' | 'fs-lite'
```

## Config types

| Type | Description |
| --- | --- |
| `CloudflareKVStoreConfig` | Config for the Cloudflare KV binding driver. |
| `UpstashKVStoreConfig` | Config for the Upstash driver. |
| `FsLiteKVStoreConfig` | Config for the local filesystem driver. |
| `KVStorage` | The runtime storage handle type. |
| `KVModuleOptions` | Module-level KV config. |
| `KVStoreConfig` | One supported KV driver config. |
| `ResolvedKVStoreConfig` | The resolved driver config union. |
| `ResolvedKVModuleOptions` | The resolved KV config at setup time. |

## Driver config shapes

### `CloudflareKVStoreConfig`

```ts
{
  driver: 'cloudflare-kv-binding'
  binding?: string
  namespaceId?: string
}
```

### `UpstashKVStoreConfig`

```ts
{
  driver: 'upstash'
  url?: string
  token?: string
}
```

When Upstash credentials come from env vars, setup stores masked placeholders and the runtime plugin reads the real values from `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Inline `url` and `token` values are treated as explicit config, but env vars are preferred for hosted deployments.

### `FsLiteKVStoreConfig`

```ts
{
  driver: 'fs-lite'
  base?: string
}
```

## Method options

`KVStorage` methods accept `options?: unknown` and pass those options through to the underlying storage driver.

Treat those options as provider-specific. They are not currently documented as a portable ViteHub KV API contract.
