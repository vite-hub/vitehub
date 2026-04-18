---
title: Blob quickstart
description: Configure a hosted Blob provider and write a first file.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-rocket
---

This quickstart configures the server-side Blob runtime. Choose Cloudflare R2 or Vercel Blob before calling the `blob` handle.

## Configure Blob

::fw{id="vite:dev vite:build"}
The Vite plugin is server-environment aware. Use Nitro or Nuxt when you need runtime access to the `blob` handle.

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
    driver: 'vercel-blob',
  },
})
```
::

## Write a file

::fw{id="vite:dev vite:build"}
Use the Nitro or Nuxt setup when you need the runtime `blob` handle. The Vite plugin only scopes Blob to server environments.
::

::fw{id="nitro:dev nitro:build nuxt:dev nuxt:build"}
```ts [server/api/files.post.ts]
import { blob } from '@vitehub/blob'

export default defineEventHandler(async () => {
  return await blob.put('avatars/user-1.txt', 'hello blob', {
    contentType: 'text/plain',
  })
})
```
::

## Serve the file

::fw{id="nitro:dev nitro:build nuxt:dev nuxt:build"}
```ts [server/api/files/[...pathname].get.ts]
import { blob } from '@vitehub/blob'

export default defineEventHandler(async (event) => {
  const pathname = getRouterParam(event, 'pathname') || ''
  return await blob.serve(event, pathname)
})
```
::

## Hosted providers

- For Cloudflare setup, see [Cloudflare](./providers/cloudflare).
- For Vercel setup, see [Vercel](./providers/vercel).

## Next steps

- Use [Usage](./usage) for common runtime methods.
- Use [Runtime API](./runtime-api) to review exports and config types.
