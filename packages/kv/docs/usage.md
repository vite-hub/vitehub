---
title: KV usage
description: Practical patterns for keys, JSON values, prefixes, deletes, lists, clears, and provider-neutral runtime code.
navigation.title: Usage
navigation.order: 3
icon: i-lucide-workflow
frameworks: [vite, nitro, nuxt]
---

After the quickstart works, most KV code falls into four patterns: choose stable keys, store JSON values, group related keys with prefixes, and keep provider details out of route code.

## Import the Runtime Handle

Use the canonical portable import from server/runtime code:

```ts
import { kv } from '@vitehub/kv'
```

The handle is backed by Nitro storage. Nitro mounts the active driver at startup, and Nuxt uses that Nitro path under the hood.

## Set and Get JSON Values

`kv.set()` stores one value. `kv.get()` returns that value or `null` when the key is missing.

```ts
await kv.set('settings', {
  theme: 'system',
  notifications: true,
})

const settings = await kv.get<{
  theme: string
  notifications: boolean
}>('settings')
```

Route example:

```ts [server/api/settings.get.ts]
import { kv } from '@vitehub/kv'

export default defineEventHandler(async () => {
  const settings = await kv.get('settings')

  return {
    settings: settings ?? {
      theme: 'system',
      notifications: true,
    },
  }
})
```

## Use Prefixes for Related Keys

KV keys are strings. Use prefixes when a feature owns a group of values:

```ts
await kv.set('users:ava:preferences', { density: 'compact' })
await kv.set('users:ava:flags', { beta: true })
```

Then list only that group:

```ts
const userKeys = await kv.keys('users:ava')
```

Example response:

```json
{
  "keys": [
    "users:ava:flags",
    "users:ava:preferences"
  ]
}
```

## Check Before Doing Expensive Work

Use `kv.has()` when the value is not needed:

```ts
if (await kv.has('reports:daily:2026-04-26')) {
  return { cached: true }
}
```

Use `kv.get()` when the route needs the value anyway. That avoids a separate round trip for remote providers.

## Delete One Key

```ts
await kv.del('settings')
```

Use this for explicit user actions such as resetting preferences or removing a cache entry.

## Clear a Prefix

`kv.clear()` clears the whole active store. Pass a prefix when only one feature namespace should be removed:

```ts
await kv.clear('users:ava')
```

::callout{icon="i-lucide-alert-triangle" color="warning"}
Use unscoped `kv.clear()` carefully. In hosted providers it targets the configured namespace or database, not only the current route.
::

## Keep Provider Logic in Config

Route code should look the same for local, Cloudflare, and Vercel:

```ts
await kv.set('settings', { enabled: true })
return { settings: await kv.get('settings') }
```

Provider details belong in config:

::tabs{sync="provider"}
  :::tabs-item{label="Local" icon="i-lucide-folder" class="p-4"}
    ```ts
    kv: {
      driver: 'fs-lite',
      base: '.data/kv',
    }
    ```
  :::

  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts
    kv: {
      driver: 'cloudflare-kv-binding',
      binding: 'KV',
      namespaceId: '<kv-namespace-id>',
    }
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
    ```ts
    kv: {
      driver: 'upstash',
    }
    ```
  :::
::

## Pass Driver-Specific Options Intentionally

Every method accepts an optional `options` argument and passes it to the underlying unstorage driver:

```ts
await kv.set('settings', { enabled: true }, {
  ttl: 60,
})
```

Those options are driver-specific. ViteHub does not currently define a portable option contract for TTLs, metadata, or consistency behavior.

## Disable KV

Set `kv: false` when a Nuxt or Nitro app should install the package but not mount runtime KV:

```ts
export default defineNuxtConfig({
  modules: ['@vitehub/kv/nuxt'],
  kv: false,
})
```

## Next Steps

- Use [Write and read values](./guides/read-write-values) for complete route examples.
- Use [Choose a driver](./guides/choose-a-driver) when deciding between local, Cloudflare, and Vercel.
- Use [Runtime API](./runtime-api) for method signatures and config types.
