---
title: Blob
description: Blob storage for Vite and Nitro apps with local files, Cloudflare R2, and Vercel Blob.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-files
frameworks: [vite, nitro]
---

`@vitehub/blob` gives Vite and Nitro server apps one Blob API that works across local files, Cloudflare R2, and Vercel Blob.

## Start here

Start with [Quickstart](./quickstart) to get Blob working locally first. It uses the `fs` driver, stores files in `.data/blob`, and keeps the first routes small so you can verify reads and writes before choosing a hosted provider.

::fw{vite}
On Vite, the `hubBlob()` plugin owns Blob config resolution and emits provider-specific output for Cloudflare and Vercel builds.
::

::fw{nitro}
On Nitro, the `@vitehub/blob/nitro` module resolves Blob config into runtime storage and wires provider-specific bindings for Cloudflare and Vercel presets.
::

## Automatic configuration

ViteHub resolves Blob storage in this order:

1. Explicit `blob.driver` config wins.
2. Cloudflare hosting resolves `cloudflare-r2` and preserves implicit `binding` and `bucketName` overrides.
3. `BLOB_READ_WRITE_TOKEN` resolves `vercel-blob`.
4. Vercel hosting resolves `vercel-blob`.
5. Everything else falls back to `fs` at `.data/blob`.

This matches `normalizeBlobOptions`, so the docs and runtime behavior stay aligned.

## Supported provider paths

### Local / other

Use this path when you want the simplest development setup or when no higher-priority hosted configuration is present. The resolved driver is `fs`, and files are stored in `.data/blob`.

### Cloudflare R2

Use this path when your app deploys to Cloudflare or when you explicitly set `blob.driver = 'cloudflare-r2'`. Blob resolves storage through an R2 binding.

Read [Cloudflare](./providers/cloudflare) for bindings, `bucketName`, and local-development behavior.

### Vercel Blob

Use this path when your app deploys to Vercel or when `BLOB_READ_WRITE_TOKEN` is available. The resolved driver is `vercel-blob`.

Read [Vercel](./providers/vercel) for the runtime token requirement, current public-access support, and package setup.

## What stays portable

These pieces stay stable when you change providers:

- the top-level `blob` config key
- the runtime handle `blob`
- call sites that use `blob.list()`, `blob.get()`, `blob.put()`, `blob.head()`, `blob.del()`, `blob.delete()`, and `blob.serve()`
- input validation with `ensureBlob()`

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Get a first working local Blob setup.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Store, list, read, serve, and delete blobs.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exports, methods, and config types.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Cloudflare
  description: Configure Blob storage against a Cloudflare R2 binding.
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Configure Blob storage against Vercel Blob.
  to: ./providers/vercel
  ---
  :::
::
