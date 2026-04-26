---
title: Store a blob
description: Write request bodies and uploaded files to Blob storage from Vite or Nitro routes.
navigation.title: Store a blob
navigation.group: Guides
navigation.order: 30
icon: i-lucide-upload
frameworks: [vite, nitro]
---

This guide focuses on the write path. It assumes Blob is already registered.

## Write Pattern

Every write route follows the same shape:

1. Read a request body or uploaded file.
2. Validate the input when it comes from a user.
3. Pick a pathname.
4. Call `blob.put(pathname, body, options)`.
5. Return the stored metadata.

## Store JSON Body Content

::fw{id="vite:dev vite:build"}
```ts [src/server.ts]
import { H3, readBody } from 'h3'
import { blob } from '@vitehub/blob'

const app = new H3()

app.put('/api/notes', async (event) => {
  const body = await readBody<{ pathname?: string, text?: string }>(event)

  return await blob.put(
    body.pathname || 'notes/example.txt',
    body.text || '',
    { contentType: 'text/plain; charset=utf-8' },
  )
})

export default app
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/api/notes.put.ts]
import { defineEventHandler, readBody } from 'h3'
import { blob } from '@vitehub/blob'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ pathname?: string, text?: string }>(event)

  return await blob.put(
    body.pathname || 'notes/example.txt',
    body.text || '',
    { contentType: 'text/plain; charset=utf-8' },
  )
})
```
::

## Store an Uploaded File

Use `readFormData()` for multipart uploads and validate the `Blob` before writing it.

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

  return await blob.put('avatar.png', file, {
    addRandomSuffix: true,
    prefix: 'avatars',
  })
})
```

## Add Metadata

Use `customMetadata` for small provider metadata attached to the object.

```ts
const stored = await blob.put('avatars/user-1.png', file, {
  contentType: file.type,
  customMetadata: {
    owner: 'user-1',
    source: 'profile-form',
  },
})
```

## Use Prefixes and Random Suffixes

`prefix` is prepended before storage. `addRandomSuffix` changes the final filename.

```ts
const stored = await blob.put('avatar.png', file, {
  addRandomSuffix: true,
  prefix: 'avatars/user-1',
})

return {
  pathname: stored.pathname,
}
```

Example final pathname:

```txt
avatars/user-1/avatar-a1b2c3d4.png
```

## Verify the Write

```bash
curl -X PUT http://localhost:3000/api/notes \
  -H 'content-type: application/json' \
  -d '{"pathname":"notes/example.txt","text":"hello world"}'
```

Expected response:

```json
{
  "pathname": "notes/example.txt",
  "contentType": "text/plain; charset=utf-8",
  "size": 11
}
```

## Avoid These Mistakes

| Mistake | Fix |
| --- | --- |
| Ignoring the returned pathname after using `addRandomSuffix` | Store or return `stored.pathname`. |
| Trusting client-provided content type without validation | Use `ensureBlob()` before `blob.put()`. |
| Putting provider tokens in route code | Put tokens, bindings, and bucket names in config or environment. |

## Related Pages

- [Usage](../usage)
- [Validate uploads](./validate-uploads)
- [Runtime API](../runtime-api)
