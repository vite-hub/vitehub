---
title: Getting started
description: Set up your first ViteHub package and continue with the KV quickstart.
navigation.title: Getting started
icon: i-lucide-rocket
---

ViteHub currently ships [`@vitehub/kv`](../kv) and [`@vitehub/blob`](../blob).

::fw{vite nitro}
It also ships [`@vitehub/queue`](../queue) for background jobs on Vite and Nitro.
::

This page gives you the first framework-specific setup step, then points you to the package docs where the full examples live.

## Start with KV

Install the package:

```bash
pnpm add @vitehub/kv
```

::fw{id="vite:dev vite:build"}

Then register the Vite plugin:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubKv } from '@vitehub/kv/vite'

export default defineConfig({
  plugins: [hubKv()],
})
```

After that, continue with the [KV quickstart](/docs/vite/kv/quickstart). Use the Nitro or Nuxt path when you need runtime reads and writes.

::

::fw{id="nitro:dev nitro:build"}

Then register the Nitro module:

```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/kv/nitro'],
})
```

After that, continue with the [KV quickstart](/docs/nitro/kv/quickstart).

::

::fw{id="nuxt:dev nuxt:build"}

Then register the Nuxt module:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/kv/nuxt'],
})
```

After that, continue with the [KV quickstart](/docs/nuxt/kv/quickstart).

::

## What to read next

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: KV overview
  description: Understand what the KV package provides and how it resolves drivers.
  to: ../kv
  ---
  :::
  :::u-page-card
  ---
  title: KV quickstart
  description: Read, write, and delete a first key locally.
  to: ../kv/quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Cloudflare provider
  description: Configure the Cloudflare KV path.
  to: ../kv/providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel provider
  description: Configure the Upstash-backed Vercel path.
  to: ../kv/providers/vercel
  ---
  :::
::

::fw{vite nitro}
::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Queue overview
  description: Discover background job routing for Vite and Nitro.
  to: ../queue
  ---
  :::
  :::u-page-card
  ---
  title: Queue quickstart
  description: Register Queue and enqueue a first job.
  to: ../queue/quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Queue on Cloudflare
  description: Configure Cloudflare queue bindings and batch processing.
  to: ../queue/providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Queue on Vercel
  description: Configure Vercel topics and hosted callbacks.
  to: ../queue/providers/vercel
  ---
  :::
::
::
