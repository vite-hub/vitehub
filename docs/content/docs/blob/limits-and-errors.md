---
title: Blob limits and errors
description: The host limits that Blob checks in production and in development, and the error codes it returns.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Handle Blob errors

Each Blob method returns `[error, value]`. On success, `error` is `undefined`. When `error` is set, `error.code` is `BLOB_CONFLICT`, `BLOB_NOT_FOUND`, `BLOB_OPERATION_FAILED`, or `BLOB_PATHNAME_TOO_LONG`. `error.why` tells what went wrong and names the operation and the store, `error.fix` tells what to do, `error.docs` links to the code on this page, and `error.cause` keeps the provider error. Invalid arguments and configuration errors throw instead. See [Server API](/docs/blob/server-api) for each method.

```ts [server/api/notes.post.ts]
import { defineEventHandler } from 'h3'
import { blob } from 'vite-hub/blob'

export default defineEventHandler(async () => {
  const [error, object] = await blob.put('notes/hello.txt', 'Hello')
  if (error) {
    console.error(error.code, error.why, error.cause)
    throw error
  }
  return { pathname: object.pathname }
})
```

`JSON.stringify(error)` includes only `name`, `code`, `why`, `fix`, and `docs`. It does not include `cause` or `stack`, because provider errors can contain credentials or private data.

## See cache failures in logs

Some Blob failures do not fail the operation: a cache read or write, the cleanup of derived files, a media record write, and the metadata and hash files of the `fs` driver. With the evlog Nitro module, added through `vitehub({ observability })` or by hand, Blob logs each one with a `blob` field:

```json
{ "level": "warn", "blob": { "op": "transform-cache-write", "store": "photos", "driver": "cloudflare", "code": "ECONNRESET" } }
```

| Field | Meaning |
| --- | --- |
| `op` | `transform-cache-read`, `transform-cache-write`, `derived-cache-cleanup`, `media-record-write`, `fs-hash-cache-write`, or `fs-metadata-rekey`. |
| `store`, `driver` | The store and its driver. The `fs` driver operations have no store. |
| `code` | The `code` of the error, such as `ENOSPC`, else its class name. |

A failure in `serve()` goes on the wide event of its request. Other failures do not know their request, so each one is its own evlog event, `{ action: "blob", message, blob }`. The fields never hold a pathname or file contents. Without evlog, Blob prints the failure to the server console.

## Limits

ViteHub checks these host limits before the provider sees the request:

| Host | Limit | Result |
| --- | --- | --- |
| [Cloudflare R2](https://developers.cloudflare.com/r2/platform/limits/) | Object key of at most 1,024 bytes in UTF-8 | `BLOB_PATHNAME_TOO_LONG` |
| [Vercel Functions](https://vercel.com/docs/functions/limitations#request-body-size) | Request body of at most 4.5 MB | HTTP `413` |

A `cloudflare` store checks the key in `put()`, `get()`, `head()`, `delete()`, `serve()`, `sign()`, and multipart uploads, in production and `vite dev`. `serve()` answers such a key with a `400` response. Other drivers keep their own limits.

On Vercel, a request body above 4.5 MB gets `413 FUNCTION_PAYLOAD_TOO_LARGE` before your function runs. `vite dev` has no such limit, so when the build targets Vercel (`vitehub({ host: 'vercel' })` or the Vercel Nitro preset), the dev server copies it. `blob.handleUpload()` and the `upload` action of `blob.handleMultipartUpload()` throw an H3 `413` above 4,500,000 bytes, and the route answers `413`. For larger uploads, use [direct uploads](/docs/blob/server-api#direct-uploads), which send the file straight to storage. Read the [Vercel Blob guide](/docs/guides/vercel-blob#vercel-blob-limits).

## Codes

### BLOB_CONFLICT

`blob.copy()` or a media move found a file at the target pathname, or a folder removal found files in the folder. Pass `{ overwrite: true }` to replace the file.

### BLOB_NOT_FOUND

The file does not exist. The error has `statusCode: 404`, but H3 answers the status of a thrown error only for its own `HTTPError`, so a route that rethrows it answers `500`. Map the code in the route: `if (error?.code === 'BLOB_NOT_FOUND') throw createError({ statusCode: 404 })`.

### BLOB_OPERATION_FAILED

The provider failed. Read `error.cause` for the provider error.

### BLOB_PATHNAME_TOO_LONG

The pathname is too long for the store. Cloudflare R2 accepts keys of at most 1,024 bytes in UTF-8, after `prefix` and `addRandomSuffix`. A non-ASCII character takes two to four bytes. `error.cause.message` has the size. Use a shorter pathname.
