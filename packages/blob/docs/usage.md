---
title: Usage
description: Store, read, serve, and delete blobs from a Vite or Nitro server app.
frameworks: [vite, nitro]
---

## List blobs

```ts
import { blob } from '@vitehub/blob'

const { blobs } = await blob.list({ limit: 10, prefix: 'avatars/' })
```

## Write a blob

```ts
import { blob } from '@vitehub/blob'

await blob.put('avatars/user-1.txt', 'hello world', {
  contentType: 'text/plain; charset=utf-8',
})
```

## Read metadata

```ts
import { blob } from '@vitehub/blob'

const file = await blob.head('avatars/user-1.txt')
```

## Read body

```ts
import { blob } from '@vitehub/blob'

const file = await blob.get('avatars/user-1.txt')
const text = file ? await file.text() : null
```

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

## Delete a blob

```ts
import { blob } from '@vitehub/blob'

await blob.del('avatars/user-1.txt')
```

## Validate before storing

```ts
import { ensureBlob } from '@vitehub/blob'

ensureBlob(file, {
  maxSize: '1MB',
  types: ['image'],
})
```
