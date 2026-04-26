---
title: When to use Blob
description: Decide when Blob is the right storage primitive compared with inline responses, KV, Queue, or provider-specific SDK calls.
navigation.title: When to use Blob
navigation.order: 2
icon: i-lucide-git-compare
frameworks: [vite, nitro]
---

Use Blob when the application needs to store file-like data and address it later by pathname.

Blob is not a database and not a background worker. It is object storage behind a portable server-side API.

## Choose Blob When

Blob is a good fit when:

- the value is a file, upload, generated asset, export, or other object body
- route code needs to list objects by prefix
- metadata and content type matter
- the app may move between local files, Cloudflare R2, and Vercel Blob
- files should be streamed back from a route with stable headers

Common examples:

- user avatars and document uploads
- generated PDFs, CSV exports, or images
- private files streamed through an authenticated route
- object listings for an asset browser or admin tool

## Prefer Inline Responses When

Inline responses are better when the value is generated once and does not need to be stored.

```ts [server/api/report.get.ts]
export default defineEventHandler(() => {
  return {
    status: 'ready',
    items: [],
  }
})
```

## Prefer KV When

Use KV for small keyed records that are read and updated as application state.

| Need | Primitive |
| --- | --- |
| Store file bodies, uploads, or generated assets | Blob |
| Store small JSON records by key | KV |
| List folder-like object paths | Blob |
| Update compact state values | KV |

## Prefer Queue When

Use Queue when storing the file is only one step in asynchronous work.

For example, a route can write an upload to Blob, then enqueue a background job to process it. Blob stores the object. Queue runs work after the response can finish.

## Prefer Provider SDKs When

Use the provider SDK directly when the app needs provider-specific features outside the Blob contract.

Blob intentionally documents a portable surface: writes, reads, metadata, listings, serving, deletes, and upload validation. Provider-specific lifecycle rules, object policies, signed URLs, or advanced access controls may belong in Cloudflare or Vercel SDK code.

## Decision Checklist

Choose Blob when all of these are true:

- The data is file-like or object-like.
- The app should address it by pathname later.
- The route needs portable storage calls.
- Provider-specific setup should stay out of business logic.

If the value is small structured state, start with KV. If work should happen later, combine Blob with Queue.

## Next Steps

- Start with [Quickstart](./quickstart) for a complete local setup.
- Use [Store a blob](./guides/store-a-blob) for upload and write patterns.
- Use [Serve a blob](./guides/serve-a-blob) for download routes.
