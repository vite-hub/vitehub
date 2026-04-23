---
title: Blob runtime API
description: Reference for the Blob runtime handle, config types, and helper exports.
navigation.title: Runtime API
frameworks: [vite, nitro]
---

## Entry points

| Export | Purpose |
| --- | --- |
| `@vitehub/blob` | Runtime Blob handle, validation helper, and shared types. |
| `@vitehub/blob/nitro` | Nitro module for Blob runtime config and provider wiring. |
| `@vitehub/blob/vite` | Vite plugin returned by `hubBlob()`. |
| `virtual:@vitehub/blob/config` | Resolved Vite Blob config for server environments. Vite only. |

## Runtime export

```ts
import { blob, ensureBlob } from '@vitehub/blob'
```

### `blob.list(options?)`

Lists stored blobs. `BlobListOptions` supports:

- `prefix` to scope the listing
- `limit` to control page size
- `cursor` to resume a paged listing
- `folded` to return folder-style listings with `folders`

The result shape is `BlobListResult`:

- `blobs`
- `folders?`
- `cursor?`
- `hasMore`

### `blob.get(pathname)`

Returns a `Blob` or `null` when the pathname does not exist.

### `blob.head(pathname)`

Returns one `BlobObject`. Missing pathnames throw a `404`.

### `blob.put(pathname, body, options?)`

Writes one blob and returns its metadata. `body` accepts:

- `string`
- `Blob`
- `ArrayBuffer`
- `ArrayBufferView`
- `ReadableStream`

`BlobPutOptions` supports:

| Option | Purpose |
| --- | --- |
| `access` | Provider access hint. The current Vercel driver supports public writes only. |
| `addRandomSuffix` | Appends a short random suffix to the final filename. |
| `contentLength` | Passes through an explicit content length when the driver needs it. |
| `contentType` | Overrides the inferred content type. |
| `customMetadata` | Attaches driver-specific custom metadata. |
| `prefix` | Prepends a path prefix before the final pathname is written. |

### `blob.del(pathname | pathnames[])`

Deletes one blob or many blobs.

### `blob.delete(pathname | pathnames[])`

Alias for `blob.del(...)`.

### `blob.serve(event, pathname)`

Loads one blob body and returns a `ReadableStream`. It sets `Content-Length` and `Content-Type`, and it sets `etag` when the active driver exposes one. Cache policy and range requests are not yet documented as a package-level contract.

### `ensureBlob(blob, options)`

Validates one input `Blob` before storing it. `BlobEnsureOptions` supports:

- `maxSize`
- `types`

Set at least one option. Failing validation throws an `h3` `400`.

## Core types

```ts
type BlobDriver = 'cloudflare-r2' | 'fs' | 'vercel-blob'
```

### `BlobObject`

`BlobObject` contains:

- `pathname`
- `contentType`
- `size`
- `httpEtag`
- `uploadedAt`
- `httpMetadata`
- `customMetadata`
- optional `url`

### `BlobType`

The validation helper accepts broad type groups such as `image`, `video`, `audio`, `text`, and `pdf`, plus exact MIME types.

### `BlobSize`

`BlobSize` is a string union such as `1MB`, `8KB`, or `256B`.

## Config types

### `BlobModuleOptions`

The package accepts:

- `false` to disable Blob
- `{ driver: 'fs', base? }`
- `{ driver: 'cloudflare-r2', binding?, bucketName? }`
- `{ driver: 'vercel-blob', access?, token? }`

On Cloudflare hosting, you can also omit `driver` and pass `binding` or `bucketName` implicitly.

### `ResolvedBlobModuleOptions`

The resolved runtime shape is:

```ts
interface ResolvedBlobModuleOptions {
  store: ResolvedBlobStoreConfig
}
```

## Nitro module

```ts
import blobModule from '@vitehub/blob/nitro'
```

Register it with `modules: ['@vitehub/blob/nitro']` in `nitro.config.ts`.

## Vite Virtual Config

```ts
import config, { blob, hosting } from 'virtual:@vitehub/blob/config'
```

The virtual module exposes the resolved hosting hint and Blob store config used by the Vite plugin.

## Related pages

- [Overview](./index)
- [Quickstart](./quickstart)
- [Cloudflare](./providers/cloudflare)
- [Vercel](./providers/vercel)
