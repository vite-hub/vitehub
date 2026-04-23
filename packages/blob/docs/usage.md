---
title: Usage
description: Store, read, serve, and delete blobs from a Vite server app.
frameworks: vite
---

## List blobs

```ts
const { blobs } = await blob.list({ limit: 10, prefix: 'avatars/' })
```

## Write a blob

```ts
await blob.put('avatars/user-1.txt', 'hello world', {
  contentType: 'text/plain; charset=utf-8',
})
```

## Read metadata

```ts
const file = await blob.head('avatars/user-1.txt')
```

## Read body

```ts
const file = await blob.get('avatars/user-1.txt')
const text = file ? await file.text() : null
```

## Serve a blob

```ts
import { createError } from 'h3'

export default eventHandler(async (event) => {
  const pathname = getQuery(event).pathname
  if (typeof pathname !== 'string' || pathname.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Missing pathname' })
  }

  return await blob.serve(event, pathname)
})
```

## Delete a blob

```ts
await blob.del('avatars/user-1.txt')
```

## Validate before storing

```ts
ensureBlob(file, {
  maxSize: '1MB',
  types: ['image'],
})
```
