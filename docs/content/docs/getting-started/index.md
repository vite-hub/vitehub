---
title: Getting started
description: Set up your first ViteHub package and continue with package quickstarts.
navigation.title: Getting started
icon: i-lucide-rocket
---

ViteHub currently ships [`@vitehub/kv`](/docs/nuxt/kv) and [`@vitehub/blob`](/docs/nuxt/blob), Vite-first packages with Nitro and Nuxt runtime adapters.

This page gives you the first framework-specific setup step, then points you to package docs where the full examples live.

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
  to: /docs/nuxt/kv
  ---
  :::
  :::u-page-card
  ---
  title: KV quickstart
  description: Read, write, and delete a first key locally.
  to: /docs/nuxt/kv/quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Blob overview
  description: Store and serve files from server routes.
  to: /docs/nuxt/blob
  ---
  :::
  :::u-page-card
  ---
  title: Blob quickstart
  description: Configure R2 or Vercel Blob and upload a first file.
  to: /docs/nuxt/blob/quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Cloudflare provider
  description: Configure the Cloudflare KV path.
  to: /docs/nuxt/kv/providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel provider
  description: Configure the Upstash-backed Vercel path.
  to: /docs/nuxt/kv/providers/vercel
  ---
  :::
  :::u-page-card
  ---
  title: Blob providers
  description: Configure Cloudflare R2 or Vercel Blob.
  to: /docs/nuxt/blob/providers/cloudflare
  ---
  :::
::
