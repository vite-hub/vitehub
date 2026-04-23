---
title: Blob usage
description: Store, list, read, serve, and delete blobs from Vite or Nitro server routes.
navigation.title: Usage
frameworks: [vite, nitro]
---

## Import Blob

```ts
import { blob } from '@vitehub/blob'
```

## List blobs

```ts
import { blob } from '@vitehub/blob'

const page = await blob.list({
  folded: true,
  limit: 20,
  prefix: 'avatars/',
})
```

`blob.list()` returns `blobs`, optional `folders`, and `hasMore`. When `hasMore` is `true`, pass the returned `cursor` into the next call to continue the listing. Use `folded: true` when you want folder-style results instead of one flat list.

## Write a blob

```ts
import { blob } from '@vitehub/blob'

await blob.put('avatar.png', file, {
  addRandomSuffix: true,
  contentType: 'image/png',
  customMetadata: { owner: 'user-1' },
  prefix: 'avatars',
})
```

`blob.put()` normalizes the pathname, guesses `contentType` from the pathname when you omit it, prepends `prefix` when present, and can add a short random suffix to reduce collisions. `access` is part of the options shape, but the current Vercel path only supports public writes.

## Read metadata

```ts
import { blob } from '@vitehub/blob'

const file = await blob.head('avatars/user-1.txt')
```

`blob.head()` returns one `BlobObject` or throws a `404` when the pathname does not exist.

## Read body

```ts
import { blob } from '@vitehub/blob'

const file = await blob.get('avatars/user-1.txt')
const text = file ? await file.text() : null
```

Use `blob.get()` when you want the body. Unlike `head()`, it returns `null` for a missing pathname.

## Serve a blob

```ts
import { createError, defineEventHandler, getQuery } from 'h3'

import { blob } from '@vitehub/blob'

export default defineEventHandler(async (event) => {
  const pathname = getQuery(event).pathname
  if (typeof pathname !== 'string' || pathname.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Missing pathname' })
  }

  return await blob.serve(event, pathname)
})
```

`blob.serve()` is the small route helper for file delivery. It sets `Content-Length` and `Content-Type`, and it sets `etag` when the active driver provides one. Range requests and cache policy are not yet documented as a package-level contract.

## Delete a blob

```ts
import { blob } from '@vitehub/blob'

await blob.del('avatars/user-1.txt')
await blob.delete(['avatars/user-2.txt', 'avatars/user-3.txt'])
```

`blob.del()` and `blob.delete()` are aliases. Both accept one pathname or an array of pathnames.

## Validate before storing

```ts
import { ensureBlob } from '@vitehub/blob'

ensureBlob(file, {
  maxSize: '1MB',
  types: ['image'],
})
```

`ensureBlob()` throws an `h3` `400` error when the input does not match the declared size or type rules. Set at least one of `maxSize` or `types`.
