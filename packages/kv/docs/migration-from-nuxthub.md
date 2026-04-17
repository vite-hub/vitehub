---
title: NuxtHub KV to ViteHub KV migration
description: Move existing NuxtHub KV apps to ViteHub KV safely.
navigation.title: NuxtHub KV migration
navigation.order: 4
icon: i-lucide-arrow-right-left
---

Use this guide when you are moving an existing NuxtHub KV app to ViteHub KV.

## What stays the same

- You still use one shared `kv` handle at runtime.
- Driver-specific options still belong in app config instead of application call sites.

## What changes

- Nuxt config moves from `hub.kv` to the top-level `kv` key.
- Nuxt integration now uses `modules: ['@vitehub/kv/nuxt']`.
- Canonical runtime imports are `@vitehub/kv`.

## Mapping the docs and config

| NuxtHub | ViteHub |
| --- | --- |
| `hub.kv` | top-level `kv` |
| `@nuxthub/kv` | `@vitehub/kv` |
| NuxtHub KV setup page | [Overview](./index) |
| NuxtHub KV SDK page | [Usage](./usage) |

## Update the Nuxt config shape

### Before

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  hub: {
    kv: {
      driver: 'cloudflare-kv-binding',
      namespaceId: '<kv-namespace-id>',
    },
  },
})
```

### After

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/kv/nuxt'],
  kv: {
    driver: 'cloudflare-kv-binding',
    binding: 'KV',
    namespaceId: '<kv-namespace-id>',
  },
})
```

For the full hosted Cloudflare setup, see [Cloudflare](./providers/cloudflare).

## Update runtime imports

### Before

```ts [server/api/settings.post.ts]
import { kv } from '@nuxthub/kv'
```

### After

```ts [server/api/settings.post.ts]
import { kv } from '@vitehub/kv'
```
