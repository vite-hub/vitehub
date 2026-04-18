---
title: Vercel Queue
description: Configure @vitehub/queue for Vercel Queues.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 11
icon: i-simple-icons-vercel
---

Use Vercel Queue when queue publishing and consumption should stay inside the Vercel deployment model.

## Install the SDK

Install `@vercel/queue` with `@vitehub/queue`.

```bash [Terminal]
pnpm add @vitehub/queue @vercel/queue
```

## Configuration

::fw{id="vite:dev vite:build"}
The Vite entrypoint registers bridge config. Use Nitro or Nuxt for discovered runtime queue handlers.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubQueue } from '@vitehub/queue/vite'

export default defineConfig({
  plugins: [hubQueue()],
  queue: {
    provider: 'vercel',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/queue/nitro'],
  queue: {
    provider: 'vercel',
  },
})
```
::

::fw{id="nuxt:dev nuxt:build"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/queue/nuxt'],
  queue: {
    provider: 'vercel',
  },
})
```
::

On Vercel hosting, ViteHub can infer this provider when `queue.provider` is omitted.

## Topics and callbacks

The discovered queue name becomes the Vercel topic when it contains only letters, numbers, `_`, or `-`. For `server/queues/welcome-email.ts`, ViteHub sends to the topic `welcome-email`.

Queue names with other characters are hex-encoded as `queue__<hex>` so they are safe Vercel topics. For `server/queues/email/welcome.ts`, ViteHub sends to the topic `queue__656d61696c2f77656c636f6d65`. Topic names matching `queue__<hex>` are reserved by `@vitehub/queue`.

During Vercel builds, ViteHub generates hidden queue consumer functions in `.vercel/output/functions/api/vitehub/queues/vercel/**` and adds the `queue/v2beta` trigger metadata.

## Local development

ViteHub does not manage a local Vercel queue emulator. Use `queue.provider = 'memory'` for local contract testing, then deploy with the Vercel provider.

## Related

- [Overview](../index)
- [Quickstart](../quickstart)
- [Runtime API](../runtime-api)
