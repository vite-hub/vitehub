---
title: Cloudflare Blob
description: Configure @vitehub/blob for Cloudflare R2.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 10
icon: i-logos-cloudflare-icon
---

Use this path when you deploy Blob-backed server code to Cloudflare Workers or Pages.

## Configuration

Set `blob.driver` to `cloudflare-r2`. The binding name defaults to `BLOB`.

::fw{id="vite:dev vite:build"}
The Vite plugin scopes Blob to server environments. Use Nitro or Nuxt for runtime access to the `blob` handle.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubBlob } from '@vitehub/blob/vite'

export default defineConfig({
  plugins: [hubBlob()],
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/blob/nitro'],
  blob: {
    driver: 'cloudflare-r2',
    binding: 'BLOB',
    bucketName: '<r2-bucket-name>',
  },
})
```
::

::fw{id="nuxt:dev nuxt:build"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/blob/nuxt'],
  blob: {
    driver: 'cloudflare-r2',
    binding: 'BLOB',
    bucketName: '<r2-bucket-name>',
  },
})
```
::

## Bindings

Cloudflare uses bindings to connect a Worker to R2. When `bucketName` is set, the Nitro module adds an R2 bucket entry to Wrangler output using the configured binding.

## Runtime access

```ts
import { blob } from '@vitehub/blob'

const uploaded = await blob.put('images/example.txt', 'hello blob', {
  contentType: 'text/plain',
})
```

## Related

- [Overview](../index)
- [Quickstart](../quickstart)
- [Usage](../usage)
