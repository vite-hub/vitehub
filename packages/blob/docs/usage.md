---
title: Using the Blob SDK
description: Store, read, list, validate, serve, and delete files with @vitehub/blob.
navigation.title: Usage
navigation.order: 2
icon: i-lucide-code
---

Use `@vitehub/blob` from server code. This stack does not ship Vue or React composables.

## Import the runtime handle

```ts
import { blob, ensureBlob } from '@vitehub/blob'
```

## Upload a blob

```ts
const object = await blob.put('documents/report.txt', 'hello blob', {
  contentType: 'text/plain',
  customMetadata: { source: 'api' },
})
```

`blob.put()` returns a `BlobObject` with metadata such as `pathname`, `contentType`, `size`, and provider URL when the provider exposes one.

## Read a blob body

```ts
const file = await blob.get('documents/report.txt')
const text = await file?.text()
```

`blob.get()` returns a `Blob` or `null`.

## Read metadata

```ts
const metadata = await blob.head('documents/report.txt')
```

`blob.head()` throws a 404 error when the object does not exist.

## List blobs

```ts
const { blobs, hasMore, cursor } = await blob.list({
  prefix: 'documents/',
  limit: 100,
})
```

Use `cursor` to continue listing when `hasMore` is true.

## Serve a blob

```ts
export default defineEventHandler(async (event) => {
  return await blob.serve(event, 'documents/report.txt')
})
```

`blob.serve()` sets `Content-Type`, `Content-Length`, and `ETag` when metadata is available.

## Delete blobs

```ts
await blob.del('documents/report.txt')
await blob.del(['documents/one.txt', 'documents/two.txt'])
```

## Validate uploads

```ts
ensureBlob(file, {
  maxSize: '1MB',
  types: ['image', 'application/pdf'],
})
```

`ensureBlob()` checks the `Blob` size and MIME type before you store it.
