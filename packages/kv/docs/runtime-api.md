---
title: KV runtime API
description: Reference for KV exports, runtime methods, Vite virtual config, config shapes, driver routing, and framework registration.
navigation.title: Runtime API
navigation.order: 90
icon: i-lucide-braces
frameworks: [vite, nitro, nuxt]
---

Use this page when you need exact names, signatures, and option fields. For a guided setup, start with [Quickstart](./quickstart).

## Imports

Runtime code imports the `kv` handle from `@vitehub/kv`:

```ts
import { kv } from '@vitehub/kv'
```

::fw{id="vite:dev vite:build"}
Vite config imports the plugin from `@vitehub/kv/vite`:

```ts
import { hubKv } from '@vitehub/kv/vite'
```
::

::fw{id="nitro:dev nitro:build"}
Nitro config registers the module by name:

```ts
export default defineNitroConfig({
  modules: ['@vitehub/kv/nitro'],
})
```
::

::fw{id="nuxt:dev nuxt:build"}
Nuxt config registers the Nuxt module by name:

```ts
export default defineNuxtConfig({
  modules: ['@vitehub/kv/nuxt'],
})
```
::

## Runtime Handle

### `kv`

`kv` is a small wrapper around the active Nitro storage mount named `kv`.

```ts
const value = await kv.get('settings')
```

### `KVStorage`

```ts
interface KVStorage {
  clear(base?: string, options?: unknown): Promise<void>
  del(key: string, options?: unknown): Promise<void>
  get<T = unknown>(key: string, options?: unknown): Promise<T | null>
  has(key: string, options?: unknown): Promise<boolean>
  keys(base?: string, options?: unknown): Promise<string[]>
  set<T = unknown>(key: string, value: T, options?: unknown): Promise<void>
}
```

| Method | Description |
| --- | --- |
| `kv.get(key)` | Read one value. Returns `null` when the key is missing. |
| `kv.set(key, value, options?)` | Write one value. |
| `kv.has(key, options?)` | Check whether a key exists. |
| `kv.del(key, options?)` | Remove one key. |
| `kv.keys(base?, options?)` | List keys, optionally under a prefix. |
| `kv.clear(base?, options?)` | Clear the whole store or one prefix. |

Method options are passed to the underlying unstorage driver. Treat them as provider-specific.

## Module Options

### `KVModuleOptions`

```ts
type KVModuleOptions = KVStoreConfig | false
```

Set `kv: false` to disable runtime mounting.

### `KVDriver`

```ts
type KVDriver = 'cloudflare-kv-binding' | 'upstash' | 'fs-lite'
```

### `KVStoreConfig`

```ts
type KVStoreConfig =
  | CloudflareKVStoreConfig
  | UpstashKVStoreConfig
  | FsLiteKVStoreConfig
```

## Driver Config Shapes

### `CloudflareKVStoreConfig`

```ts
{
  driver: 'cloudflare-kv-binding'
  binding?: string
  namespaceId?: string
}
```

| Option | Default | Description |
| --- | --- | --- |
| `driver` | required | Selects the Cloudflare KV binding driver. |
| `binding` | `KV` | Cloudflare binding name. |
| `namespaceId` | `KV_NAMESPACE_ID` env var | Cloudflare KV namespace ID used to generate Wrangler config. |

### `UpstashKVStoreConfig`

```ts
{
  driver: 'upstash'
  url?: string
  token?: string
}
```

When credentials come from env vars, ViteHub stores masked placeholders at build time and reads real values at runtime.

Supported env vars:

| Value | Preferred env var | Alias |
| --- | --- | --- |
| REST URL | `KV_REST_API_URL` | `UPSTASH_REDIS_REST_URL` |
| REST token | `KV_REST_API_TOKEN` | `UPSTASH_REDIS_REST_TOKEN` |

### `FsLiteKVStoreConfig`

```ts
{
  driver: 'fs-lite'
  base?: string
}
```

| Option | Default | Description |
| --- | --- | --- |
| `driver` | required | Selects the local filesystem driver. |
| `base` | `.data/kv` | Directory used by the `fs-lite` driver. |

## Resolution Rules

`normalizeKVOptions()` resolves the active driver in this order:

1. `kv: false` disables KV.
2. Explicit `kv.driver` config wins.
3. Upstash env vars select `upstash`.
4. Vercel hosting selects `upstash`.
5. Cloudflare hosting selects `cloudflare-kv-binding`.
6. Everything else falls back to `fs-lite`.

Unknown drivers throw:

```txt
Unknown `kv.driver`: "...". Expected "cloudflare-kv-binding", "upstash", or "fs-lite".
```

Non-object config throws:

```txt
`kv` must be a plain object.
```

## Vite Plugin API

### `hubKv(options?)`

```ts
import { hubKv } from '@vitehub/kv/vite'

export default defineConfig({
  plugins: [hubKv({ driver: 'fs-lite' })],
})
```

The plugin exposes `api.getConfig()` for tooling and examples:

```ts
const plugin = hubKv()
const config = plugin.api.getConfig()
```

Top-level Vite config `kv` overrides inline plugin options.

## Vite Virtual Config

Vite code can import the resolved setup config from `virtual:@vitehub/kv/config`:

```ts
import config, { hosting, kv } from 'virtual:@vitehub/kv/config'
```

If TypeScript cannot find the virtual module, add the package's ambient type entry:

```json [tsconfig.json]
{
  "compilerOptions": {
    "types": ["@vitehub/kv/virtual"]
  }
}
```

## Nitro Runtime Wiring

The Nitro module:

- resolves KV config from `nitro.options.kv`
- writes resolved config to `runtimeConfig.kv`
- mounts the active driver as Nitro storage at `kv`
- aliases `@vitehub/kv` to the runtime package entry
- adds the runtime plugin that remounts lazy Upstash config
- adds Cloudflare Wrangler KV namespace config when `namespaceId` is available

## Nuxt Runtime Wiring

The Nuxt module:

- reads top-level `kv` config
- installs `@vitehub/kv/nitro`
- forwards `kv` config to Nitro
- does nothing when top-level `kv` is `false`

## Related Pages

- [Usage](./usage)
- [Choose a driver](./guides/choose-a-driver)
- [Cloudflare](./providers/cloudflare)
- [Vercel](./providers/vercel)
