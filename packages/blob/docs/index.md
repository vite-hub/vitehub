---
title: Blob
description: Store and serve files through one shared server-side runtime handle.
navigation.title: Overview
icon: i-lucide-file-archive
---

`@vitehub/blob` gives server code a single `blob` handle for uploads, reads, metadata, lists, serving, and deletes. The Vite plugin scopes Blob to server environments, the Nitro module wires runtime config, and the Nuxt module installs the Nitro adapter.

## Getting started

Start with [Quickstart](./quickstart) and choose a hosted provider. Blob does not expose a public local filesystem driver in this stack, so runtime usage needs either Cloudflare R2 or Vercel Blob.

## Automatic configuration

ViteHub resolves Blob providers in this order:

1. Explicit `blob.driver` config wins.
2. Cloudflare hosting defaults to `cloudflare-r2`.
3. Vercel hosting or `BLOB_READ_WRITE_TOKEN` defaults to `vercel-blob`.
4. Everything else leaves Blob disabled.

This mirrors `normalizeBlobOptions`, so the docs match runtime behavior.

## Supported provider paths

### Cloudflare R2

Use this path when Cloudflare hosting is detected or when you explicitly set `blob.driver = 'cloudflare-r2'`. The binding defaults to `BLOB`.

Read [Cloudflare](./providers/cloudflare) for binding and bucket configuration.

### Vercel Blob

Use this path when your deployment has a Vercel Blob read-write token. The resolved driver is `vercel-blob`.

Read [Vercel](./providers/vercel) for the required env var and configuration.

## What stays portable

These pieces stay stable when you change providers:

- the top-level `blob` config key
- the runtime handle `blob`
- `ensureBlob()`
- route code that uses `blob.put()`, `blob.get()`, `blob.list()`, `blob.serve()`, `blob.del()`, or `blob.handleUpload()`

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Configure Blob and upload a first file.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Use the Blob runtime handle like an SDK.
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
  description: Configure the Cloudflare R2 path.
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Configure Vercel Blob.
  to: ./providers/vercel
  ---
  :::
::
