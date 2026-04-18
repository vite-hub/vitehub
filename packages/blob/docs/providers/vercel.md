---
title: Vercel Blob
description: Configure @vitehub/blob for Vercel Blob.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 11
icon: i-simple-icons-vercel
---

Use this path when your Vercel deployment should store files in Vercel Blob.

## Configuration

Set `blob.driver` to `vercel-blob` when you want explicit config.

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
    driver: 'vercel-blob',
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

## Environment variables

Set the Vercel Blob read-write token in your deployment environment:

```bash
BLOB_READ_WRITE_TOKEN=<vercel-blob-read-write-token>
```

You can also pass `token` in config, but environment variables keep secrets out of build output.

## Runtime access

```ts
import { blob } from '@vitehub/blob'

const uploaded = await blob.put('images/example.txt', 'hello blob', {
  contentType: 'text/plain',
})
```

Vercel Blob currently uses public access in `@vitehub/blob`.

## Related

- [Overview](../index)
- [Quickstart](../quickstart)
- [Usage](../usage)
