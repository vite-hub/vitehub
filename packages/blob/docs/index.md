---
title: Blob
description: Vite-first server Blob storage for local files, Cloudflare R2, and Vercel Blob.
navigation.order: 0
frameworks: vite
---

`@vitehub/blob` gives Vite server apps one Blob API that works across local files, Cloudflare R2, and Vercel Blob.

It starts with a Vite plugin that resolves Blob config for server environments and emits provider outputs for Cloudflare and Vercel builds.

## Drivers

- `fs` for local development, storing files in `.data/blob`
- `cloudflare-r2` for Cloudflare Workers and Pages via an R2 binding
- `vercel-blob` for Vercel deployments backed by `BLOB_READ_WRITE_TOKEN`

## Runtime Surface

- `blob.list()`
- `blob.get()`
- `blob.put()`
- `blob.head()`
- `blob.del()`
- `blob.delete()`
- `blob.serve()`
- `ensureBlob()`

Use the Vite plugin when you want Vite-owned provider output generation. This package does not ship Nitro or Nuxt adapters in this release.
