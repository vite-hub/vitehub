---
title: Blob limits and errors
description: Know the host limits that Blob checks in production and during development, and the codes that it returns.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Handle Blob errors

Each Blob method returns `[error, value]`. `error.code` is `BLOB_CONFLICT`, `BLOB_NOT_FOUND`, `BLOB_OPERATION_FAILED`, or `BLOB_PATHNAME_TOO_LONG`. `error.details` names the operation and the store, and `error.cause` keeps the provider error. Invalid arguments and configuration errors throw instead. See [Server API](/docs/blob/server-api) for each method.

## Limits

ViteHub checks these host limits before the provider sees the request:

| Host | Limit | Result |
| --- | --- | --- |
| [Cloudflare R2](https://developers.cloudflare.com/r2/platform/limits/) | Object key of at most 1,024 bytes in UTF-8 | `BLOB_PATHNAME_TOO_LONG` |
| [Vercel Functions](https://vercel.com/docs/functions/limitations#request-body-size) | Request body of at most 4.5 MB | HTTP `413` |

A `cloudflare-r2` store checks the key in `put()`, `get()`, `head()`, `del()`, `serve()`, `sign()`, and multipart uploads, in production and in `vite dev`. Other drivers keep their own limits.

On Vercel, the platform answers a request body above 4.5 MB with `413 FUNCTION_PAYLOAD_TOO_LARGE`, before your function runs. `vite dev` has no such limit. When the build targets Vercel, with `vitehub({ preset: 'vercel' })` or the Vercel Nitro preset, `blob.handleUpload()` and the `upload` action of `blob.handleMultipartUpload()` in the dev server throw an H3 `413` error for a request above 4,500,000 bytes. A route that lets the error through answers `413`, as Vercel does. Read the [Vercel Blob guide](/docs/guides/vercel-blob#vercel-blob-limits) for uploads larger than this limit.

## Codes

### BLOB_CONFLICT

A media move found an object at the target pathname, or a folder removal found objects in the folder.

### BLOB_NOT_FOUND

The object does not exist. `statusCode` is `404`, so a route that lets the error through answers `404`.

### BLOB_OPERATION_FAILED

The provider failed. Read `error.cause` for the provider error.

### BLOB_PATHNAME_TOO_LONG

The pathname is longer than the store accepts. Cloudflare R2 accepts object keys of at most 1,024 bytes in UTF-8, after `prefix` and `addRandomSuffix`. A character outside ASCII takes two to four bytes. `error.cause.message` has the size. Use a shorter pathname.
