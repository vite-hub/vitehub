---
title: Cloudflare R2
description: Configure @vitehub/blob for Cloudflare Workers and Pages with R2 bindings on Vite or Nitro.
navigation.title: Cloudflare
frameworks: [vite, nitro]
---

Use the Cloudflare path when your Vite or Nitro app deploys to Cloudflare and Blob storage should resolve through an R2 binding.

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubBlob } from '@vitehub/blob/vite'

export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    driver: 'cloudflare-r2',
    binding: 'BLOB',
    bucketName: '<bucket-name>',
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
    driver: 'cloudflare-r2',
    binding: 'BLOB',
    bucketName: '<bucket-name>',
  },
})
```
::

Notes:

- `binding` defaults to `BLOB`
- `bucketName` is used to emit `r2_buckets` in generated `wrangler.json` on Vite and Nitro Cloudflare output
- if you omit explicit config, Cloudflare hosting resolves `cloudflare-r2` automatically

::fw{vite}
For build-time auto-resolution without inline config, set `BLOB_BUCKET_NAME` in the environment used for `vite build`.
::
