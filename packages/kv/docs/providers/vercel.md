---
title: Vercel KV
description: Configure @vitehub/kv for Vercel KV REST credentials.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 11
icon: i-simple-icons-vercel
---

Use this path when your Vercel deployment should resolve KV through Vercel KV REST credentials.

## Configuration

Set `kv.driver` to `vercel` when you want to configure Vercel KV explicitly. Prefer environment variables for credentials so runtime adapters resolve secrets without serializing them into build output.

::fw{id="vite:dev vite:build"}
The Vite plugin owns KV config resolution. Use Nitro or Nuxt for runtime access to the `kv` handle.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubKv } from '@vitehub/kv/vite'

export default defineConfig({
  plugins: [hubKv()],
  kv: {
    driver: 'vercel',
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
    driver: 'vercel',
  },
})
```
::

::fw{id="nuxt:dev nuxt:build"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/kv/nuxt'],
  kv: {
    driver: 'vercel',
  },
})
```
::

## Environment variables

The resolver supports these env vars:

```bash
KV_REST_API_URL=https://example.vercel-storage.local
KV_REST_API_TOKEN=<kv-rest-token>
```

It also accepts the legacy aliases:

```bash
UPSTASH_REDIS_REST_URL=https://example.vercel-storage.local
UPSTASH_REDIS_REST_TOKEN=<kv-rest-token>
```

## Related

- [Overview](../index)
- [Quickstart](../quickstart)
- [Usage](../usage)
