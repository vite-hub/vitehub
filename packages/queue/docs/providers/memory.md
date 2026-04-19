---
title: Memory Queue
description: Use the local in-process queue provider.
navigation.title: Memory
navigation.group: Providers
navigation.order: 12
icon: i-lucide-memory-stick
---

Memory is the default local provider. It stores messages in process memory and runs discovered handlers after enqueue.

## Configuration

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubQueue } from '@vitehub/queue/vite'

export default defineConfig({
  plugins: [hubQueue()],
  queue: {
    provider: 'memory',
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
    provider: 'memory',
  },
})
```
::

::fw{id="nuxt:dev nuxt:build"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/queue/nuxt'],
  queue: {
    provider: 'memory',
  },
})
```
::

## Behavior

Memory is useful for local development and tests. It is not durable and does not share jobs across processes.

Use Cloudflare or Vercel when you need hosted delivery, retry, and platform-managed execution.

## Related

- [Overview](../index)
- [Quickstart](../quickstart)
- [Usage](../usage)
