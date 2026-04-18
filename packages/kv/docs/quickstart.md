---
title: KV quickstart
description: Read and write a first key with Cloudflare KV.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-rocket
---

This quickstart configures the Cloudflare KV provider.

## Configure KV

::fw{id="vite:dev vite:build"}
The Vite plugin is the KV config primitive. Nitro and Nuxt build on this same resolver for runtime storage.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubKv } from '@vitehub/kv/vite'

export default defineConfig({
  plugins: [hubKv()],
  kv: {
    driver: 'cloudflare-kv-binding',
    binding: 'KV',
    namespaceId: '<kv-namespace-id>',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/kv/nitro'],
  kv: {
    driver: 'cloudflare-kv-binding',
    binding: 'KV',
    namespaceId: '<kv-namespace-id>',
  },
})
```
::

::fw{id="nuxt:dev nuxt:build"}
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
::

## Write and read a value

::fw{id="vite:dev vite:build"}
Use the Nitro or Nuxt setup when you need the runtime `kv` handle. The Vite plugin resolves and exposes KV config for Vite environments.
::

::fw{id="nitro:dev nitro:build nuxt:dev nuxt:build"}
```ts [server/api/settings.get.ts]
export default defineEventHandler(() => {
  return kv.get('settings')
})
```

```ts [server/api/settings.put.ts]
export default defineEventHandler(async () => {
  await kv.set('settings', { enabled: true })
})
```

```ts [server/api/settings.delete.ts]
export default defineEventHandler(async () => {
  await kv.del('settings')
})
```
::

## Hosted providers

- For Cloudflare setup, see [Cloudflare](./providers/cloudflare).
- For Vercel setup, see [Vercel](./providers/vercel).

## Next steps

- Use [Usage](./usage) for the common runtime methods.
- Use [Runtime API](./runtime-api) to review the shared config and handle types.
