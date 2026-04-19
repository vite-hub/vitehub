---
title: Blob uploads
description: Receive form uploads and store files with blob.handleUpload().
navigation.title: Uploads
navigation.order: 3
icon: i-lucide-upload
---

Use `blob.handleUpload()` in a server route that receives `FormData`.

## Create an upload route

```ts [server/api/upload.ts]
import { blob } from '@vitehub/blob'

export default defineEventHandler(async (event) => {
  return await blob.handleUpload(event, {
    formKey: 'files',
    multiple: true,
    ensure: {
      maxSize: '4MB',
      types: ['image'],
    },
    put: {
      prefix: 'uploads',
    },
  })
})
```

The route accepts `POST`, `PUT`, or `PATCH`. It returns an array of `BlobObject` values.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `formKey` | `string` | `files` | Form field that contains uploaded files. |
| `multiple` | `boolean` | `true` | Whether more than one file is allowed. |
| `ensure` | `BlobEnsureOptions` | none | Validation rules passed to `ensureBlob()`. |
| `put` | `BlobPutOptions` | none | Options forwarded to `blob.put()`. |

## Single-file uploads

```ts
return await blob.handleUpload(event, {
  multiple: false,
  put: {
    prefix: 'avatars',
  },
})
```

When `multiple` is false, sending more than one file returns a 400 error.
