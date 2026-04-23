---
title: Vercel Blob
description: Configure @vitehub/blob for Vercel using Vercel Blob storage on Vite or Nitro.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 20
icon: i-simple-icons-vercel
frameworks: [vite, nitro]
---

Use the Vercel path when your Vite or Nitro app deploys to Vercel and Blob storage should resolve through `BLOB_READ_WRITE_TOKEN`.

::callout{to="https://vercel.com/docs/vercel-blob"}
Vercel Blob is a hosted object store. Create or connect a Blob store in Vercel first, then provide `BLOB_READ_WRITE_TOKEN` at runtime.
::

## Install the SDK

```bash
pnpm add @vitehub/blob @vercel/blob
```

## Configure the provider

Set the runtime token in your environment:

```bash [.env]
BLOB_READ_WRITE_TOKEN=<blob-read-write-token>
```

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubBlob } from '@vitehub/blob/vite'

export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    driver: 'vercel-blob',
  },
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

## Runtime token behavior

If you omit explicit Blob config, Vercel hosting still resolves `vercel-blob` automatically. Build output masks the token, and the runtime rehydrates it from `BLOB_READ_WRITE_TOKEN`. If the env var is missing at runtime, Blob throws an explicit error instead of silently using the masked placeholder.

## Access model

ViteHub currently documents and supports the public-write Vercel Blob path. `blob.put(..., { access: 'private' })` is not yet supported by the current driver and throws.

Blob still preserves the portable API surface:

- pathnames may include `/` to model folders in listings
- `list()` supports `prefix`, pagination, and folded listings
- `get()`, `head()`, and `serve()` work through the active Vercel Blob store

## Related pages

- [Overview](../index)
- [Quickstart](../quickstart)
- [Runtime API](../runtime-api)
