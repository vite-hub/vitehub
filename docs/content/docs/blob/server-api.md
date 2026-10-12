---
title: Blob server API
description: Read, write, list, upload, sign, and validate objects from server code, and check production rules.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `blob` from `@vite-hub/blob` | Read and write the Default Blob Store or named Blob Stores. |
| `detectContentType` from `vite-hub/blob/content-type` or `@vite-hub/blob/content-type` | Classify common image and PDF signatures before storage. |
| `ensureBlob` from `@vite-hub/blob` or `@vite-hub/blob/ensure` | Validate upload size and content type. |
| `hubBlob` from `@vite-hub/blob/vite` | Register Blob runtime configuration and Provider Output. |
| `resolveBlobViteConfig` from `@vite-hub/blob/vite` | Resolve Blob Vite runtime config manually. |
| `@vite-hub/blob/drivers/*` | Import provider-specific Blob Driver Modules. |

All Blob driver, object, list, put, store, and module types are exported from `@vite-hub/blob`.

Blob writes preserve the metadata you provide. `detectContentType()` checks common leading signatures, but it doesn't validate the complete file or prove that the file is safe.

## Use it at runtime

Use the `blob` Runtime Helper from server code.

```ts [server/api/files.post.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ path: string, text: string }>(event)

  const [error] = await blob.put(body.path, body.text, {
    contentType: 'text/plain',
    customMetadata: { source: 'api' },
  })
  if (error) throw error

  return { ok: true }
})
```

```ts [server/api/files/[...path].get.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  const path = getRouterParam(event, 'path')!
  const [error, object] = await blob.get(path)
  if (error) throw error

  if (!object) {
    throw createError({ statusCode: 404 })
  }

  return object
})
```

Use named Blob Stores when configuration defines multiple stores.

```ts [server/reports.ts]
import { blob } from '@vite-hub/blob'

export const reports = blob.store('reports')
```

## Runtime helper

`blob` implements `BlobStorage`.

Every async method returns `[error, value]`. Expected provider and storage failures are `ViteHubError` values with `BLOB_*` codes, so application code can apply HTTP, retry, logging, or best-effort policy without `try/catch`. Invalid arguments, unknown stores, and unsupported signing capabilities still throw because they indicate API or configuration misuse. Generated serving routes unwrap `blob.serve()` and pass its error to H3.

| Method | Description |
| --- | --- |
| `blob.put(pathname, body, options?)` | Stores text, bytes, streams, ArrayBuffers, or `Blob` objects. |
| `blob.get(pathname)` | Reads a `Blob` or returns `null`. |
| `blob.head(pathname)` | Reads object metadata or returns `null`. |
| `blob.list(options?)` | Lists objects with optional `prefix`, `limit`, `cursor`, and folded folders. |
| `blob.del(pathnames)` | Deletes one or more objects. |
| `blob.sign(pathname, options)` | Signs a short-lived `GET` or `PUT` request for one object. |
| `blob.serve(event, pathname, options?)` | Serves an object stream through an H3 event, or `null` for a conditional `304` response. |
| `blob.handleUpload(event, options?)` | Stores the files of a `multipart/form-data` request. Read [Upload files](#upload-files). |
| `blob.createMultipartUpload(pathname, options?)` | Starts a multipart upload. Read [Multipart uploads](#multipart-uploads). |
| `blob.resumeMultipartUpload(pathname, uploadId)` | Continues a multipart upload in a later request. |
| `blob.handleMultipartUpload(event, options?)` | Serves the requests that the multipart client sends. |
| `blob.store(name)` | Selects a named Blob Store. |

Pass the cursor returned by `blob.list()` unchanged to the next list call on the same Blob Store. Keep `prefix` and `folded` unchanged. Netlify Blobs listings and folded files-sdk listings fail if they cannot decode the cursor.

## Serve a transformed object

Use `blob.serve()` in an application route when authorization or a database lookup decides which object to expose. It sets content headers and handles conditional GET and HEAD requests through h3. Responses default to `private, no-cache`; set `cacheControl` to choose another policy.

The optional `transform` receives the original `Blob` and returns the response `Blob`. ViteHub caches that result in the same store with its configured access under `_vitehub/derived/`, a namespace reserved from public writes, signed PUTs, and multipart uploads along with its `_vitehub` parent pathname. On filesystem stores, legacy files at either cache directory path are preserved; serving still returns fresh transforms, but caching requires moving those files out of the way. It validates the cached result against the source ETag, content type, and your transform key. Drivers without ETags use a hash of the source bytes. The filesystem driver uses content-based ETags and keeps cached hashes separate from content metadata. If source metadata changes while reading its bytes, ViteHub retries the read before transforming it. Stable ETags determine cache writes; provider timestamps do not.

Change the key when the transformation changes, and include any size or format variants in it. Each source and key has one cache object, which source updates replace on the next request. Distinct keys remain separate variants. `blob.del(originalPath)` removes the original and its cached variants; serving a missing source also clears its variants. Cleanup failures are logged without undoing deletion. Operators can inspect variants with `blob.list({ prefix: '_vitehub/derived/' })` and remove unused ones with `blob.del`. No background eviction runs.

Filesystem cache keys normalize dot segments and separators. Use consistent filename casing on case-insensitive filesystems; differently cased aliases can leave unused variants that require operator cleanup.

Configure a private store when originals and derived objects must be accessible only through your application. The transform does not change provider access settings. The original remains unchanged. Deleting it prevents serving the cached result, including a conditional `304`. An in-flight transform does not recreate its cache after the source is removed.

```ts [server/api/photos/[id].get.ts]
import { blob } from '@vite-hub/blob'
import { createPreview, resolvePhotoPath } from '../../utils/photos'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  // Validate access and resolve the private storage path before serving.
  const path = await resolvePhotoPath(event, id)
  const [error, response] = await blob.serve(event, path, {
    cacheControl: 'public, max-age=300, must-revalidate',
    transform: {
      key: 'preview-768-v1',
      run: createPreview,
    },
  })
  if (error) throw error
  return response
})
```

`createPreview` is application code that validates and transforms the image. Return a `Blob` with its response MIME type. Transform failures use the normal Blob error tuple. If storing the derived result fails, ViteHub logs the failure and serves the freshly transformed result. Concurrent requests in one runtime share the transformation.

The cache is best effort across runtimes. Concurrent source updates can evict a newer cache entry and cause another transformation. Fingerprint validation prevents returning an entry for the wrong source version. Drivers do not need distributed locks or conditional replacement support.

## Write options

| Option | Type | Description |
| --- | --- | --- |
| `contentType` | `string` | Stored MIME type. |
| `contentLength` | `string` | Expected content length when the provider supports it. |
| `customMetadata` | `Record<string, string>` | Provider custom metadata. |
| `access` | `BlobPutOptions['access']` | Object access policy when the driver supports it. Values: `private`, `public`. |
| `addRandomSuffix` | `boolean` | Adds a random suffix when supported by the driver. |
| `prefix` | `string` | Provider path prefix when supported by the driver. |

## Upload files

`blob.handleUpload()` reads a `multipart/form-data` request and calls `put()`
for each file. The file name, without any directory part, is the pathname.
It returns `[error, objects]`. A request without files, with too many files, or
with a file that fails `ensure` throws an H3 400 error before anything is
stored.

```ts [server/api/files.post.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  // Authorize the request here. The route decides who may upload.
  const [error, objects] = await blob.handleUpload(event, {
    formKey: 'files',
    ensure: { maxSize: '8MB', types: ['image'] },
    put: { prefix: 'avatars', addRandomSuffix: true },
  })
  if (error) throw error
  return objects
})
```

| Option | Default | Description |
| --- | --- | --- |
| `formKey` | `"files"` | Form field that holds the files. |
| `multiple` | `true` | Set `false` to accept one file. |
| `ensure` | none | Options for [`ensureBlob()`](#ensureblobblob-options), checked for each file. |
| `put` | none | [Write options](#write-options) for each `put()`. |

In Vue, `useUpload()` from `@vite-hub/blob/vue` sends the form. The Nuxt module
auto-imports it when `blob` is enabled.

```vue [app/components/AvatarUpload.vue]
<script setup lang="ts">
const upload = useUpload('/api/files', { multiple: false })

async function onChange(event: Event) {
  const object = await upload(event.target as HTMLInputElement)
  console.log(object?.pathname)
}
</script>

<template>
  <input type="file" accept="image/*" @change="onChange">
</template>
```

`useUpload()` accepts a `File`, a `FileList`, an array of files, or an element
with `files`. It resolves with serialized objects, where `uploadedAt` is an ISO
string. Pass `headers` or `fetch` to add authentication.

## Multipart uploads

Use multipart uploads for files that are too large for one request. The client
splits the file into parts, and the server stores each part until `complete()`
joins them. The `fs`, `cloudflare-r2` (with the R2 binding), and `vercel-blob`
drivers support it. Other drivers throw `BLOB_R0030`.

Create one route with `action` and `pathname` params:

```ts [server/api/files/multipart/[action]/[...pathname].ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  // Authorize the request here. The client chooses the pathname.
  const [error, result] = await blob.handleMultipartUpload(event)
  if (error) throw error
  return result
})
```

The route answers four requests:

| Action | Method | Request | Result |
| --- | --- | --- | --- |
| `create` | `POST` | JSON `{ contentType? }` | `{ action, pathname, uploadId }` |
| `upload` | `PUT` | `?uploadId=…&partNumber=…`, part bytes | `{ action, part }` |
| `complete` | `POST` | `?uploadId=…`, JSON `{ parts }` | `{ action, object }` |
| `abort` | `DELETE` | `?uploadId=…` | `{ action }` |

Pass `{ create: { contentType, prefix, addRandomSuffix } }` to set the create
options on the server. A `contentType` set here replaces the type that the
client sends.

In Vue, `useMultipartUpload()` sends the parts and tracks progress:

```vue [app/components/VideoUpload.vue]
<script setup lang="ts">
const uploadVideo = useMultipartUpload('/api/files/multipart', { concurrency: 2 })
const task = shallowRef<ReturnType<typeof uploadVideo>>()

async function onChange(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  task.value = uploadVideo(file)
  const object = await task.value.completed
  console.log(object?.pathname)
}
</script>

<template>
  <input type="file" accept="video/*" @change="onChange">
  <progress v-if="task" :value="task.progress.value" max="100" />
</template>
```

`partSize` defaults to 10 MiB. Vercel Blob and R2 need at least 5 MiB for every
part except the last. `task.abort()` stops the upload and sends the `abort`
request; `completed` then resolves with `undefined`.

Server code can also drive an upload directly:

```ts [server/utils/copy-large-file.ts]
import { blob } from '@vite-hub/blob'

const [createError, upload] = await blob.createMultipartUpload('exports/report.csv')
if (createError) throw createError
const [partError, part] = await upload.uploadPart(1, firstChunk)
if (partError) throw partError
const [completeError, object] = await upload.complete([part])
if (completeError) throw completeError
```

| Driver | Upload state | Notes |
| --- | --- | --- |
| `fs` | Parts under `<base>/.vitehub/multipart/<uploadId>/` | `complete()` checks each part's etag. `abort()` deletes the parts. |
| `cloudflare-r2` | R2 multipart upload | Requires the R2 binding. The HTTP fallback has no multipart support. |
| `vercel-blob` | Vercel multipart upload | The upload ID encodes the Vercel key. Access always comes from the store config. `abort()` does nothing; Vercel discards unfinished uploads. |

The framework-neutral client is `@vite-hub/blob/client`, with `uploadFiles()`
and `createMultipartUploader()`. The Vue composables use it.

## Signed requests

Use `blob.sign()` when a client or provider needs short-lived direct access to one private object. The result contains the URL, HTTP method, and every header that must be sent with the request.

```ts [server/api/uploads/presign.post.ts]
import { blob } from '@vite-hub/blob'

const [sourceError, source] = await blob.sign('users/user/jobs/job/source.mp3', {
  method: 'GET',
  expiresIn: 6 * 60 * 60,
})
if (sourceError) throw sourceError

const [uploadError, upload] = await blob.sign('users/user/jobs/job/source.mp3', {
  method: 'PUT',
  expiresIn: 15 * 60,
  contentType: 'audio/mpeg',
  createOnly: true,
})
if (uploadError) throw uploadError
```

Send `upload.headers` unchanged with the `PUT` body. `contentType` binds the upload MIME type into the signed request. `createOnly` binds a provider condition that rejects the upload when the object already exists; drivers that cannot enforce it throw instead of silently allowing an overwrite.

Cloudflare R2 signs through its S3-compatible HTTP credentials, including when normal reads and writes use a Workers binding. A binding alone cannot mint a presigned URL, so configure `accountId`, `accessKeyId`, `secretAccessKey`, and `bucketName` through runtime environment values. [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) accept expiries from 1 second through 7 days, and the [S3 compatibility contract](https://developers.cloudflare.com/r2/api/s3/api/) supports `If-None-Match` on `PutObject`.

## `ensureBlob(blob, options)`

Use `ensureBlob()` at upload boundaries.

| Option | Type | Description |
| --- | --- | --- |
| `maxSize` | `BlobSize` | Rejects blobs larger than the limit. Examples: `4MB`, `128KB`, `1GB`. |
| `types` | `BlobType[]` | Allows exact MIME types or broad types such as `image`, `video`, `audio`, `pdf`, and `text`. |

## Production checks

Store content types and metadata at write time. Avoid guessing object type later from path names.

Blob can store Workspace data, but it doesn't provide a file tree to an Agent. Workspace handles file operations, rules, snapshots, and diffs.

Blob stores binary objects and small object metadata. Keep catalogs, indexes, permissions, search records, domain records, and richer metadata queries in KV, Database, or another NoSQL/catalog store next to Blob.
