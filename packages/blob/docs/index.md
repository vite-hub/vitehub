---
title: Blob
description: Blob storage for Vite and Nitro apps with local files, Cloudflare R2, and Vercel Blob.
navigation.order: 0
frameworks: [vite, nitro]
---

`@vitehub/blob` gives Vite and Nitro server apps one Blob API that works across local files, Cloudflare R2, and Vercel Blob.

::fw{vite}
On Vite, it starts with a plugin that resolves Blob config for server environments and emits provider outputs for Cloudflare and Vercel builds.
::

::fw{nitro}
On Nitro, it starts with a module that resolves Blob config into runtime storage and wires provider-specific bindings for Cloudflare and Vercel presets.
::

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

::fw{vite}
Use the Vite plugin when you want Vite-owned provider output generation.
::

::fw{nitro}
Use the Nitro module when you want Blob config resolved through `nitro.config.ts` and runtime access from server routes.
::
