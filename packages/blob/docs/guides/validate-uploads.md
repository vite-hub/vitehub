---
title: Validate uploads
description: Validate uploaded Blob bodies by size and type before writing them to storage.
navigation.title: Validate uploads
navigation.group: Guides
navigation.order: 32
icon: i-lucide-shield-check
frameworks: [vite, nitro]
---

Validate user uploads before they cross the storage boundary. The route should pass a known-safe `Blob` to `blob.put()`.

## Validate a File Upload

```ts
import { createError, defineEventHandler, readFormData } from 'h3'
import { blob, ensureBlob } from '@vitehub/blob'

export default defineEventHandler(async (event) => {
  const form = await readFormData(event)
  const file = form.get('file')

  if (!(file instanceof Blob)) {
    throw createError({ statusCode: 400, statusMessage: 'Expected a file upload.' })
  }

  ensureBlob(file, {
    maxSize: '1MB',
    types: ['image'],
  })

  return await blob.put('upload.png', file, {
    addRandomSuffix: true,
    prefix: 'uploads',
  })
})
```

## Validate Exact MIME Types

Use broad groups for simple rules and exact MIME types for strict rules.

```ts
ensureBlob(file, {
  maxSize: '8MB',
  types: ['image/png', 'image/jpeg'],
})
```

PDF files can use either the broad `pdf` type or the exact MIME type:

```ts
ensureBlob(file, {
  maxSize: '4MB',
  types: ['pdf'],
})
```

## Size Values

`maxSize` accepts power-of-two size values with these units:

| Unit | Example |
| --- | --- |
| `B` | `256B` |
| `KB` | `8KB` |
| `MB` | `1MB` |
| `GB` | `1GB` |

## Customize the Route Error

`ensureBlob()` throws an H3 `400` error. Catch it only when the route needs a different message.

```ts
try {
  ensureBlob(file, { maxSize: '1MB', types: ['image'] })
}
catch {
  throw createError({
    statusCode: 400,
    statusMessage: 'Upload an image smaller than 1MB.',
  })
}
```

## Avoid These Mistakes

| Mistake | Fix |
| --- | --- |
| Calling `ensureBlob(file)` with no rules | Pass `maxSize`, `types`, or both. |
| Checking only the filename extension | Validate the uploaded `Blob.type`. |
| Writing the file before validation | Call `ensureBlob()` before `blob.put()`. |

## Related Pages

- [Store a blob](./store-a-blob)
- [Usage](../usage)
- [Runtime API](../runtime-api)
