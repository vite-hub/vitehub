---
title: Vercel KV
description: Configure @vitehub/kv for Vercel using the Upstash-backed driver.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 11
icon: i-simple-icons-vercel
---

Use this path when your Vercel deployment should resolve KV through Upstash.

## Configuration

The Vercel story in `@vitehub/kv` is Upstash-backed. Set `kv.driver` to `upstash` when you want to configure it explicitly. Prefer environment variables for credentials so Nitro resolves secrets at runtime instead of serializing them into build output.

::fw{id="vite:dev vite:build"}
The Vite entrypoint only registers the bridge config. Use Nitro or Nuxt for runtime access to the `kv` handle.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubKv } from '@vitehub/kv/vite'

export default defineConfig({
  plugins: [hubKv()],
  kv: {
    driver: 'upstash',
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
    driver: 'upstash',
  },
})
```
::

::fw{id="nuxt:dev nuxt:build"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/kv/nuxt'],
  kv: {
    driver: 'upstash',
  },
})
```
::

## Environment variables

The resolver supports these env vars:

```bash
KV_REST_API_URL=https://example.upstash.io
KV_REST_API_TOKEN=<upstash-rest-token>
```

It also accepts the legacy aliases:

```bash
UPSTASH_REDIS_REST_URL=https://example.upstash.io
UPSTASH_REDIS_REST_TOKEN=<upstash-rest-token>
```

## Related

- [Overview](../index)
- [Quickstart](../quickstart)
- [Usage](../usage)
