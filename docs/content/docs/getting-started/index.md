---
title: Getting started
description: Set up your first ViteHub package and continue with the KV quickstart.
navigation.title: Getting started
icon: i-lucide-rocket
---

ViteHub currently ships [`@vitehub/kv`](../kv), [`@vitehub/blob`](/docs/vite/blob), and server-side queueing through [`@vitehub/queue`](/docs/vite/queue).

::fw{vite nitro}
`@vitehub/blob` and `@vitehub/queue` both support Vite and Nitro.
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

::fw{id="vite:dev vite:build"}
::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Blob overview
  description: Understand Blob driver resolution and the shared runtime surface.
  to: /docs/vite/blob
  ---
  :::
  :::u-page-card
  ---
  title: Blob quickstart
  description: Read and write a first blob locally.
  to: /docs/vite/blob/quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Blob on Cloudflare
  description: Configure Blob storage against a Cloudflare R2 binding.
  to: /docs/vite/blob/providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Blob on Vercel
  description: Configure Blob storage against Vercel Blob.
  to: /docs/vite/blob/providers/vercel
  ---
  :::
  :::u-page-card
  ---
  title: Queue overview
  description: Discover background job routing for Vite and Nitro.
  to: /docs/vite/queue
  ---
  :::
  :::u-page-card
  ---
  title: Queue quickstart
  description: Register Queue and enqueue a first job.
  to: /docs/vite/queue/quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Queue on Cloudflare
  description: Configure Cloudflare queue bindings and batch processing.
  to: /docs/vite/queue/providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Queue on Vercel
  description: Configure Vercel topics and hosted callbacks.
  to: /docs/vite/queue/providers/vercel
  ---
  :::
::
::

::fw{id="nitro:dev nitro:build"}
::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Blob overview
  description: Understand Blob driver resolution and the shared runtime surface.
  to: /docs/nitro/blob
  ---
  :::
  :::u-page-card
  ---
  title: Blob quickstart
  description: Read and write a first blob locally.
  to: /docs/nitro/blob/quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Blob on Cloudflare
  description: Configure Blob storage against a Cloudflare R2 binding.
  to: /docs/nitro/blob/providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Blob on Vercel
  description: Configure Blob storage against Vercel Blob.
  to: /docs/nitro/blob/providers/vercel
  ---
  :::
  :::u-page-card
  ---
  title: Queue overview
  description: Discover background job routing for Vite and Nitro.
  to: /docs/nitro/queue
  ---
  :::
  :::u-page-card
  ---
  title: Queue quickstart
  description: Register Queue and enqueue a first job.
  to: /docs/nitro/queue/quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Queue on Cloudflare
  description: Configure Cloudflare queue bindings and batch processing.
  to: /docs/nitro/queue/providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Queue on Vercel
  description: Configure Vercel topics and hosted callbacks.
  to: /docs/nitro/queue/providers/vercel
  ---
  :::
::
::
