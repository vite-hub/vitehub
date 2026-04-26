---
title: Serve a blob
description: Stream stored objects from Vite or Nitro routes with provider-neutral headers.
navigation.title: Serve a blob
navigation.group: Guides
navigation.order: 31
icon: i-lucide-send
frameworks: [vite, nitro]
---

Use `blob.serve()` when a route should return a stored object body.

`serve()` loads the object through the active driver, sets content headers, and returns a `ReadableStream`.

## Route Pattern

Validate the requested pathname before passing it to Blob.

::fw{id="vite:dev vite:build"}
```ts [src/server.ts]
import { createError, getQuery, H3 } from 'h3'
import { blob } from '@vitehub/blob'

const app = new H3()

app.get('/api/files', async (event) => {
  const pathname = getQuery(event).pathname

  if (typeof pathname !== 'string' || pathname.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Missing pathname' })
  }

  return await blob.serve(event, pathname)
})

export default app
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/api/files.get.ts]
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
::

## Expected Headers

`blob.serve()` sets these headers:

| Header | Source |
| --- | --- |
| `Content-Length` | Stored body byte length. |
| `Content-Type` | Stored metadata, input `Blob.type`, or pathname inference. |
| `etag` | Driver metadata when available. |

Missing pathnames throw an H3 `404` with `File not found`.

## Verify the Route

First write a file, then request it:

```bash
curl -X PUT http://localhost:3000/api/blob \
  -H 'content-type: application/json' \
  -d '{"pathname":"notes/example.txt","value":"hello world"}'

curl -i 'http://localhost:3000/api/files?pathname=notes/example.txt'
```

Expected response body:

```txt
hello world
```

## Add Application Authorization

Blob does not authorize pathnames for you. Check the current user before serving private files.

```ts
const pathname = `users/${user.id}/avatar.png`
return await blob.serve(event, pathname)
```

## Use `get()` for Custom Responses

Use `blob.get()` when the route needs to transform the object before returning it.

```ts
const file = await blob.get('notes/example.txt')

if (!file) {
  throw createError({ statusCode: 404, statusMessage: 'File not found' })
}

return {
  text: await file.text(),
}
```

## Related Pages

- [Usage](../usage)
- [Runtime API](../runtime-api)
- [Troubleshooting](../troubleshooting)
