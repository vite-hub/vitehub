---
title: Blob runtime API
description: Reference for Blob exports, storage methods, result shapes, validation helpers, config options, and Vite virtual config.
navigation.title: Runtime API
navigation.order: 90
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Use this page when you need exact names, signatures, and option fields. For a guided setup, start with [Quickstart](./quickstart).

## Imports

Most application code imports from `@vitehub/blob`:

```ts
import { blob, ensureBlob } from '@vitehub/blob'
```

::fw{id="vite:dev vite:build"}
Vite config imports the plugin from `@vitehub/blob/vite`:

```ts
import { hubBlob } from '@vitehub/blob/vite'
```
::

::fw{id="nitro:dev nitro:build"}
Nitro config registers the module by name:

```ts
export default defineNitroConfig({
  modules: ['@vitehub/blob/nitro'],
})
```
::

## Runtime API

### `blob.list(options?)`

Lists stored blobs.

```ts
const page = await blob.list({
  folded: true,
  limit: 20,
  prefix: 'avatars/',
})
```

`BlobListOptions` supports:

| Option | Type | Description |
| --- | --- | --- |
| `cursor` | `string` | Resume a paginated listing. |
| `folded` | `boolean` | Return folder-style listings with `folders`. |
| `limit` | `number` | Maximum number of blobs to return. Defaults to provider behavior or `1000` in built-in drivers. |
| `prefix` | `string` | Scope the listing to pathnames that start with this prefix. |

`BlobListResult` contains:

| Field | Type | Description |
| --- | --- | --- |
| `blobs` | `BlobObject[]` | Objects returned for the current page. |
| `cursor` | `string | undefined` | Cursor for the next page when available. |
| `folders` | `string[] | undefined` | Folder prefixes when `folded` is enabled. |
| `hasMore` | `boolean` | Whether another page is available. |

### `blob.put(pathname, body, options?)`

Writes one blob and returns its metadata.

```ts
const object = await blob.put('avatars/user-1.png', file, {
  contentType: 'image/png',
  customMetadata: { owner: 'user-1' },
})
```

`body` accepts:

| Type |
| --- |
| `string` |
| `Blob` |
| `ArrayBuffer` |
| `ArrayBufferView` |
| `ReadableStream` |

`BlobPutOptions` supports:

| Option | Type | Description |
| --- | --- | --- |
| `access` | `'private' | 'public'` | Provider access hint. Used by the Vercel Blob driver. |
| `addRandomSuffix` | `boolean` | Add a short random suffix to the final filename. |
| `contentLength` | `string` | Explicit content length hint for drivers that need it. |
| `contentType` | `string` | Override the inferred content type. |
| `customMetadata` | `Record<string, string>` | Driver-specific custom metadata. |
| `prefix` | `string` | Prefix prepended to the normalized pathname before writing. |

When `contentType` is omitted, Blob uses the input `Blob.type` when present, then guesses from the final pathname extension.

### `blob.get(pathname)`

Returns a `Blob` or `null` when the pathname does not exist.

```ts
const file = await blob.get('avatars/user-1.png')
const text = file ? await file.text() : null
```

### `blob.head(pathname)`

Returns one `BlobObject`. Missing pathnames throw an H3 `404` error.

```ts
const meta = await blob.head('avatars/user-1.png')
```

### `blob.del(pathname | pathnames[])`

Deletes one blob or many blobs.

```ts
await blob.del('avatars/user-1.png')
await blob.del(['avatars/user-2.png', 'avatars/user-3.png'])
```

### `blob.delete(pathname | pathnames[])`

Alias for `blob.del(...)`.

### `blob.serve(event, pathname)`

Loads one blob body and returns a `ReadableStream`.

```ts
return await blob.serve(event, 'avatars/user-1.png')
```

`serve()` sets:

| Header | Description |
| --- | --- |
| `Content-Length` | Byte length of the stored object body. |
| `Content-Type` | Stored content type or inferred pathname content type. |
| `etag` | Stored ETag when the active driver provides one. |

Missing pathnames throw an H3 `404` error with `File not found`.

## Validation API

### `ensureBlob(blob, options)`

Validates one input `Blob` before storage.

```ts
ensureBlob(file, {
  maxSize: '1MB',
  types: ['image', 'application/pdf'],
})
```

`BlobEnsureOptions` supports:

| Option | Type | Description |
| --- | --- | --- |
| `maxSize` | `BlobSize` | Maximum accepted size such as `1MB`, `8KB`, or `256B`. |
| `types` | `BlobType[]` | Accepted broad type groups or exact MIME types. |

`types` supports `audio`, `blob`, `image`, `pdf`, `text`, `video`, and exact MIME strings like `image/png`.

Set at least one option. Failing validation throws an H3 `400` error.

## Core Types

### `BlobObject`

| Field | Type | Description |
| --- | --- | --- |
| `pathname` | `string` | Stored object key. |
| `contentType` | `string | undefined` | Stored or inferred content type. |
| `size` | `number | undefined` | Object size in bytes when the driver provides it. |
| `httpEtag` | `string | undefined` | HTTP ETag when the driver provides it. |
| `uploadedAt` | `Date` | Upload timestamp. |
| `httpMetadata` | `Record<string, string>` | Driver HTTP metadata. |
| `customMetadata` | `Record<string, string>` | Driver custom metadata. |
| `url` | `string | undefined` | Provider URL when the driver provides it. |

### `BlobDriver`

```ts
type BlobDriver = 'cloudflare-r2' | 'fs' | 'vercel-blob'
```

## Config API

The top-level config key is `blob`.

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
      token: process.env.BLOB_READ_WRITE_TOKEN,
    }
    ```
  :::
::

### `BlobModuleOptions`

Blob accepts:

| Shape | Description |
| --- | --- |
| `false` | Disable Blob runtime setup. |
| `{ driver: 'fs', base? }` | Local filesystem storage. Defaults to `.data/blob`. |
| `{ driver: 'cloudflare-r2', binding?, bucketName? }` | Cloudflare R2 storage. `binding` defaults to `BLOB`. |
| `{ driver: 'vercel-blob', access?, token? }` | Vercel Blob storage. `access` defaults to `public`. |

On Cloudflare hosting, you can omit `driver` and pass `binding` or `bucketName`. Blob resolves those as Cloudflare R2 options.

## Vite Virtual Config

::fw{id="vite:dev vite:build"}
Vite server code can read the resolved config from the virtual module:

```ts
import config, { blob, hosting } from 'virtual:@vitehub/blob/config'
```

The virtual module exposes:

| Export | Type |
| --- | --- |
| `hosting` | `string | undefined` |
| `blob` | `false | ResolvedBlobModuleOptions` |
| `default` | `{ hosting, blob }` |
::

## Related Pages

- [Quickstart](./quickstart)
- [Usage](./usage)
- [Cloudflare](./providers/cloudflare)
- [Vercel](./providers/vercel)
