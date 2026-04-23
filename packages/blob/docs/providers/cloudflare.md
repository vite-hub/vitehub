---
title: Cloudflare R2
description: Configure @vitehub/blob for Cloudflare Workers and Pages with R2 bindings on Vite or Nitro.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 10
icon: i-logos-cloudflare-icon
frameworks: [vite, nitro]
---

Use the Cloudflare path when your Vite or Nitro app deploys to Cloudflare and Blob storage should resolve through an R2 binding.

::callout{to="https://developers.cloudflare.com/workers/local-development/bindings-per-env/"}
Cloudflare local development runs through bindings. R2 is available in local simulation and remote-binding modes.
::

## Setup checklist

1. Create an R2 bucket in Cloudflare.
2. Bind that bucket to your Worker or Pages project.
3. Configure `blob` so ViteHub uses the same binding name and bucket metadata.

## Configure the provider

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

## Bindings and generated config

`binding` defaults to `BLOB`. Set `bucketName` when you want ViteHub to emit the R2 bucket into generated `wrangler.json` output for Cloudflare builds.

If you omit explicit Blob config, Cloudflare hosting still resolves `cloudflare-r2` automatically. Implicit `binding` and `bucketName` overrides are preserved when you pass them without a `driver`.

::fw{vite}
For build-time auto-resolution without inline config, set `BLOB_BUCKET_NAME` or `CLOUDFLARE_R2_BUCKET_NAME` in the environment used for `vite build`.
::

## Local development

Blob uses the Cloudflare binding model directly. The configured `binding` name is the runtime lookup key, and local development uses the same name that production output uses. By default, Wrangler simulates R2 locally; use remote bindings only when you want development requests to hit a real bucket.

## Related pages

- [Overview](../index)
- [Quickstart](../quickstart)
- [Runtime API](../runtime-api)
