---
title: Blob usage
description: Practical patterns for pathnames, writes, metadata, listings, serving, deletes, and upload validation.
navigation.title: Usage
navigation.order: 3
icon: i-lucide-workflow
frameworks: [vite, nitro]
---

After the quickstart works, most Blob code falls into six patterns: write a body, validate uploads, list by prefix, read metadata, stream a response, and delete stale objects.

## Import the Runtime Handle

```ts
import { blob, ensureBlob } from '@vitehub/blob'
```

Use this import from server-side code. Provider setup belongs in Vite or Nitro config.

## Write Stable Pathnames

`blob.put()` normalizes leading slashes and decodes URL-encoded pathnames once before the active driver receives them.

```ts
const stored = await blob.put('avatars/user-1.png', file, {
  contentType: 'image/png',
  customMetadata: {
    owner: 'user-1',
  },
})
```

The returned `BlobObject` includes the final `pathname`. Read that value when you use `prefix` or `addRandomSuffix`.

```ts
const stored = await blob.put('avatar.png', file, {
  addRandomSuffix: true,
  prefix: 'avatars',
})

return { pathname: stored.pathname }
```

## Validate Uploads Before Writing

Use `ensureBlob()` when user-provided files must match a size or type rule.

```ts
ensureBlob(file, {
  maxSize: '1MB',
  types: ['image'],
})
```

`types` accepts broad groups such as `image`, `video`, `audio`, `text`, and `pdf`, or exact MIME types such as `image/png`.

::callout{icon="i-lucide-alert-triangle" color="warning"}
`ensureBlob()` requires at least one of `maxSize` or `types`. It throws an H3 `400` error when validation fails.
::

## List by Prefix

Use `prefix` to scope results and `limit` to control page size.

```ts
const firstPage = await blob.list({
  limit: 20,
  prefix: 'avatars/',
})
```

When `hasMore` is true, pass the returned `cursor` into the next call:

```ts
const nextPage = await blob.list({
  cursor: firstPage.cursor,
  limit: 20,
  prefix: 'avatars/',
})
```

Use `folded: true` when UI code needs folder-style groupings:

```ts
const page = await blob.list({
  folded: true,
  prefix: 'assets/',
})

return {
  folders: page.folders || [],
  blobs: page.blobs,
}
```

## Read Metadata and Bodies

Use `head()` when you only need metadata:

```ts
const meta = await blob.head('avatars/user-1.png')
```

`head()` throws a `404` when the pathname does not exist. Use `get()` when missing objects should return `null`:

```ts
const file = await blob.get('avatars/user-1.png')
const bytes = file ? await file.arrayBuffer() : null
```

## Serve Stored Files

`blob.serve()` loads the body, sets `Content-Length`, sets `Content-Type`, and sets `etag` when the active driver provides one.

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

## Delete One or Many Objects

`del()` and `delete()` are aliases.

```ts
await blob.del('avatars/user-1.png')

await blob.delete([
  'avatars/user-2.png',
  'avatars/user-3.png',
])
```

## Keep Routes Provider-Neutral

The route should not know whether local files, Cloudflare R2, or Vercel Blob is active.

```ts
const stored = await blob.put(pathname, file)
const page = await blob.list({ prefix: 'avatars/' })
```

Provider details belong in config:

::tabs{sync="provider"}
  :::tabs-item{label="Local" icon="i-lucide-hard-drive" class="p-4"}
    ```ts
    blob: {
      driver: 'fs',
      base: '.data/blob',
    }
    ```
  :::

  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts
    blob: {
      driver: 'cloudflare-r2',
      binding: 'BLOB',
      bucketName: 'assets',
    }
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
    ```ts
    blob: {
      driver: 'vercel-blob',
      access: 'public',
    }
    ```
  :::
::

## Next Steps

- Use [Store a blob](./guides/store-a-blob) for upload and JSON-body examples.
- Use [Serve a blob](./guides/serve-a-blob) for file delivery routes.
- Use [Validate uploads](./guides/validate-uploads) before writing user files.
- Use [Runtime API](./runtime-api) for exact method and option names.
