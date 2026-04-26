---
title: Blob
description: Store, list, read, serve, and delete files from Vite and Nitro server code with one provider-neutral Blob API.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-files
frameworks: [vite, nitro]
---

`@vitehub/blob` gives Vite and Nitro apps one server-side Blob API for local files, Cloudflare R2, and Vercel Blob.

Use Blob when routes need to accept user files, write generated assets, list stored objects, or stream a stored file back through the application.

::code-group
```ts [server/api/avatar.put.ts]
import { createError, defineEventHandler, readFormData } from 'h3'
import { blob, ensureBlob } from '@vitehub/blob'

export default defineEventHandler(async (event) => {
  const form = await readFormData(event)
  const file = form.get('file')

  if (!(file instanceof Blob)) {
    throw createError({ statusCode: 400, statusMessage: 'Expected a file upload.' })
  }

  ensureBlob(file, { maxSize: '1MB', types: ['image'] })

  return await blob.put('avatar.png', file, {
    addRandomSuffix: true,
    prefix: 'avatars',
  })
})
```

```json [Response]
{
  "pathname": "avatars/avatar-a1b2c3d4.png",
  "contentType": "image/png",
  "size": 8421,
  "httpEtag": "\"6f1d...\"",
  "uploadedAt": "2026-04-26T12:00:00.000Z",
  "httpMetadata": {
    "contentType": "image/png"
  },
  "customMetadata": {}
}
```
::

## What Blob Solves

Object storage APIs differ by platform. Blob keeps route code focused on pathnames, bodies, metadata, and streams while the active driver handles provider details.

::card-group
  :::card
  ---
  icon: i-lucide-upload
  title: Portable writes
  ---
  Store strings, `Blob`s, `ArrayBuffer`s, typed arrays, or streams with the same `blob.put()` call.
  :::

  :::card
  ---
  icon: i-lucide-folder-search
  title: Listings and metadata
  ---
  Page through objects with `prefix`, `limit`, `cursor`, and folded folder-style listings.
  :::

  :::card
  ---
  icon: i-lucide-send
  title: Route streaming
  ---
  Serve stored files from H3 routes with content headers set by `blob.serve()`.
  :::

  :::card
  ---
  icon: i-lucide-shield-check
  title: Upload checks
  ---
  Reject files by MIME type or size before they reach storage with `ensureBlob()`.
  :::
::

## One Portable Flow

The same shape works across supported runtimes:

1. Install `@vitehub/blob`.
2. Register `hubBlob()` for Vite or `@vitehub/blob/nitro` for Nitro.
3. Choose a storage driver or let hosting inference pick one.
4. Use `blob.put()`, `blob.list()`, `blob.get()`, `blob.head()`, `blob.del()`, and `blob.serve()` from server routes.
5. Move provider-specific tokens, bindings, and bucket names into config or environment.

::callout{icon="i-lucide-info" color="info"}
Blob is a server-side API. Import `blob` from server routes, handlers, or build-generated server entries, not from browser code.
::

## Storage Resolution

ViteHub resolves Blob storage in this order:

1. Explicit `blob.driver` config wins.
2. Cloudflare hosting resolves `cloudflare-r2`.
3. `BLOB_READ_WRITE_TOKEN` resolves `vercel-blob`.
4. Vercel hosting resolves `vercel-blob`.
5. Everything else falls back to `fs` at `.data/blob`.

## Supported Storage Paths

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Local filesystem
  description: Use the fs driver for local development and non-hosted server storage.
  icon: i-lucide-hard-drive
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Cloudflare R2
  description: Store blobs through an R2 binding on Cloudflare Workers or Pages.
  icon: i-simple-icons-cloudflare
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel Blob
  description: Store blobs through Vercel Blob with BLOB_READ_WRITE_TOKEN.
  icon: i-simple-icons-vercel
  to: ./providers/vercel
  ---
  :::
::

## Start Here

Start with [Quickstart](./quickstart) for a local `fs` setup. Use the [primitive comparison](../compare) when you are choosing between Blob, KV, Queue, Sandbox, and inline response data.

## Next Steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Register Blob, write one object, list it, and verify the JSON result.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Use pathnames, metadata, pagination, serving, deletes, and upload validation.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Store a blob
  description: Accept an upload or JSON body and write it through the portable runtime API.
  to: ./guides/store-a-blob
  ---
  :::
  :::u-page-card
  ---
  title: Serve a blob
  description: Stream stored files from routes with provider-neutral headers.
  to: ./guides/serve-a-blob
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exports, method signatures, option fields, and config types.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Troubleshooting
  description: Fix disabled runtime config, missing R2 bindings, Vercel tokens, and failed lookups.
  to: ./troubleshooting
  ---
  :::
::
