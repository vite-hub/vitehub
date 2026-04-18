---
title: Blob runtime API
description: Reference for blob, ensureBlob(), and core Blob types.
navigation.title: Runtime API
navigation.order: 4
icon: i-lucide-braces
---

## Exports

| Export | Description |
| --- | --- |
| `blob` | Active server-side storage handle. |
| `ensureBlob(blob, options?)` | Validates size and content type. |
| `BlobStorage` | Runtime storage handle type. |
| `BlobPutOptions` | Write options. |
| `BlobListOptions` | List and pagination options. |
| `BlobEnsureOptions` | Validation options. |
| `BlobObject` | Stored object metadata. |
| `BlobModuleOptions` | Top-level module config type. |

`@vitehub/blob/client` is reserved for a future client package. It intentionally exports no composables in this stack.

## Methods

| Method | Description |
| --- | --- |
| `blob.put(pathname, body, options?)` | Stores a blob and returns metadata. |
| `blob.get(pathname)` | Reads a blob body or returns `null`. |
| `blob.head(pathname)` | Reads metadata or throws 404. |
| `blob.list(options?)` | Lists metadata. |
| `blob.serve(event, pathname)` | Streams the body and sets response headers. |
| `blob.del(pathnameOrPathnames)` | Deletes one or more blobs. |
| `blob.handleUpload(event, options?)` | Reads `FormData`, validates files, and stores them. |

## Provider config

```ts
type BlobModuleOptions =
  | { driver: 'cloudflare-r2', binding?: string, bucketName?: string, jurisdiction?: string }
  | { driver: 'vercel-blob', access?: 'public', token?: string }
  | false
```

Cloudflare defaults `binding` to `BLOB`. Vercel defaults `access` to `public` and reads `BLOB_READ_WRITE_TOKEN` at runtime.
