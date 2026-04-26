---
title: NuxtHub KV to ViteHub KV migration
description: Move existing NuxtHub KV apps to ViteHub KV while keeping runtime call sites small.
navigation.title: NuxtHub KV migration
navigation.order: 50
icon: i-lucide-arrow-right-left
frameworks: [vite, nitro, nuxt]
---

Use this guide when an existing NuxtHub KV app should move to ViteHub KV.

The runtime shape is still a shared `kv` handle. The main changes are the package name, module registration, and top-level config key.

## What Stays the Same

- Store and read values with one runtime handle.
- Keep provider options in app config.
- Use Cloudflare KV bindings for Cloudflare deployments.
- Use key prefixes to group related values.

## What Changes

| NuxtHub | ViteHub |
| --- | --- |
| `hub.kv` | top-level `kv` |
| `@nuxthub/kv` | `@vitehub/kv` |
| NuxtHub module setup | `modules: ['@vitehub/kv/nuxt']` |
| NuxtHub KV SDK docs | [ViteHub KV usage](./usage) |

## Update Nuxt Config

Before:

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

After:

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

## Update Runtime Imports

Before:

```ts [server/api/settings.get.ts]
import { kv } from '@nuxthub/kv'
```

After:

```ts [server/api/settings.get.ts]
import { kv } from '@vitehub/kv'
```

## Verify One Route

Add or keep a simple read route:

```ts [server/api/settings.get.ts]
import { kv } from '@vitehub/kv'

export default defineEventHandler(async () => {
  return {
    settings: await kv.get('settings'),
  }
})
```

Then deploy or run locally and request it:

```bash
curl http://localhost:3000/api/settings
```

## Migration Checklist

- Install `@vitehub/kv`.
- Register `@vitehub/kv/nuxt`.
- Move config from `hub.kv` to top-level `kv`.
- Replace `@nuxthub/kv` imports with `@vitehub/kv`.
- Confirm Cloudflare `binding` and `namespaceId` values.
- Use [Troubleshooting](./troubleshooting) if the runtime mount or provider credentials fail.
