---
title: Vercel Blob
description: Configure @vitehub/blob for Vercel using Vercel Blob storage on Vite or Nitro.
navigation.title: Vercel
frameworks: [vite, nitro]
---

Use the Vercel path when your Vite or Nitro app deploys to Vercel and Blob storage should resolve through `BLOB_READ_WRITE_TOKEN`.

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

Required environment variable:

```bash [.env]
BLOB_READ_WRITE_TOKEN=<blob-read-write-token>
```

Notes:

- if you omit explicit config, Vercel hosting resolves `vercel-blob` automatically
- build output masks the token and the runtime rehydrates it from `BLOB_READ_WRITE_TOKEN`
- Vercel Blob files are public with this package release
