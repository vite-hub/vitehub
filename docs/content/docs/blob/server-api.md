---
title: Blob server API
description: Read, write, list, upload, sign, and validate files from server code, and check production rules.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `blob` from `vite-hub/blob` | Read and write the default or named Blob Stores. |
| `image`, `file` from `vite-hub/blob` | Validate Blob references and describe them as JSON Schema for pickers. |
| `blob.media` from `vite-hub/blob` | Store and edit [media records](/docs/blob/media), folders, crops, and image variants. |
| `responsiveImage`, `parseImageVariant`, `imageVariantUrl`, `probeImage` from `vite-hub/blob/media` | Image helpers that also run in the browser. `vite-hub/blob` re-exports them. |
| `detectContentType` from `vite-hub/blob`, or from `vite-hub/blob/client` in browser code | Classify common image and PDF signatures before storage. |
| `ensureBlob` from `vite-hub/blob` | Validate upload size and content type. |
| `hubBlob` from `@vite-hub/blob/vite` | Register Blob runtime config and its Nitro plugin. |
| `resolveBlobViteConfig` from `@vite-hub/blob/vite` | Resolve Blob runtime config yourself. |
| `@vite-hub/blob/drivers/*` | Provider-specific driver modules. |

`vite-hub/blob` exports all driver, object, list, put, store, and module types.

Writes keep the metadata you give. `detectContentType()` checks the first bytes of a file. It does not validate the whole file or prove that it is safe.

## Use it at runtime

Use `blob` in server code.

```ts [server/api/files.post.ts]
import { defineEventHandler, readValidatedBody } from 'h3'
import * as v from 'valibot'
import { blob } from 'vite-hub/blob'

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, v.parser(v.object({ path: v.string(), text: v.string() })))

  const [error] = await blob.put(body.path, body.text, {
    contentType: 'text/plain',
    customMetadata: { source: 'api' },
  })
  if (error) throw error

  return { ok: true }
})
```

```ts [server/api/files/[...path].get.ts]
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { blob } from 'vite-hub/blob'

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

Select a named store:

```ts [server/reports.ts]
import { blob } from 'vite-hub/blob'

export const reports = blob.store('reports')
```

ViteHub writes the keys of `blob.stores` to `.vitehub/types/blob.d.ts`. Then a store name that is not in `blob.stores` is a type error in `blob.store()`, `file()`, and `image()`. A name in a `string` variable is also a type error. Check the name, then pass it as `BlobStoreName`. Before ViteHub writes the file, any name type checks. At runtime, an unknown name throws [`BLOB_R0027`](/docs/blob/diagnostics/blob_r0027) with the configured names.

### Read-only handles

Pass `{ mode: 'read' }` to `blob.store()` when code only reads. The handle has `get()`, `head()`, `list()`, `serve()`, `sign()` for `GET`, and `media.get()`, `media.list()`, and `media.variants()`. It has no `put()`, `delete()`, upload, or multipart methods, in types or at runtime. For the default store, use `blob.store('default', { mode: 'read' })`.

```ts [server/api/reports/[...path].get.ts]
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { blob } from 'vite-hub/blob'

const reports = blob.store('reports', { mode: 'read' })

export default defineEventHandler(async (event) => {
  const [error, file] = await reports.get(getRouterParam(event, 'path')!)
  if (error) throw error
  // reports.put() is a type error.
  return file ?? createError({ statusCode: 404 })
})
```

`mode` defaults to `'write'`. Another value throws `BLOB_R0038`. `sign()` with `method: 'PUT'` throws `BLOB_R0037`.

> [!WARNING]
> The mode limits this API, not the host. The R2 binding, the Vercel token, and other credentials keep full access, and code can still import `blob`. It is not a security boundary. Use it to show intent and keep writes out of code that only reads.

`media.get()` stores a missing media record, and `serve()` with a `transform` or `variant` stores cached variants. These writes go under the reserved `_vitehub/` prefix and never change your files.

## Runtime helper

`blob` implements `BlobStorage`.

Every async method except `serve()` returns a `Result` from `vite-hub/runtime`: `[error, undefined]` on failure, `[undefined, value]` on success. Expected provider and storage failures are errors with a `BLOB_*` code, `why`, `fix`, and `docs`, so application code can apply HTTP, retry, logging, or best-effort policy without `try/catch`. Read [Blob limits and errors](/docs/blob/limits-and-errors) for each code. Invalid arguments, unknown stores, and unsupported signing capabilities still throw because they indicate API or configuration misuse. `blob.serve()` returns a `Response` for every expected outcome, including `400` and `404`, and throws a storage failure to the host.

| Method | Description |
| --- | --- |
| `blob.put(pathname, body, options?)` | Stores text, bytes, streams, ArrayBuffers, or `Blob` objects. |
| `blob.get(pathname)` | Reads a `Blob` or returns `null`. |
| `blob.head(pathname)` | Reads metadata or returns `null`. |
| `blob.list(options?)` | Lists files with optional `prefix`, `limit`, `cursor`, and folded folders. |
| `blob.copy(from, to, options?)` | Copies a file in the same store, with its content type and custom metadata. Read [Copy a file](#copy-a-file). |
| `blob.delete(pathnames)` | Deletes one or more files. |
| `blob.sign(pathname, options)` | Signs a short-lived `GET` or `PUT` request for one file. |
| `blob.serve(request, pathname, options?)` | Answers a `GET` or `HEAD` `Request` for one object with a `Response`: `200`, `206` or `416` for a range, `304`, `400` for an unsafe pathname, or `404`. |
| `blob.handleUpload(event, options?)` | Stores the files of a `multipart/form-data` request. Read [Upload files](#upload-files). |
| `blob.createMultipartUpload(pathname, options?)` | Starts a multipart upload. Read [Multipart uploads](#multipart-uploads). |
| `blob.resumeMultipartUpload(pathname, uploadId)` | Continues a multipart upload in a later request. |
| `blob.handleMultipartUpload(event, options?)` | Serves the requests that the multipart client sends. |
| `blob.store(name, options?)` | Selects a named store. `{ mode: 'read' }` returns a [read-only handle](#read-only-handles). |

Methods decode a URL-encoded `pathname` once and remove leading slashes. A pathname that is empty, has a control character, or has a `.` or `..` segment (split on `/` or `\`) throws `BLOB_R0034` with `statusCode: 400`. `serve()` returns a `400` response for it instead. The decoded pathname also must not contain `%` followed by two hex digits, such as `x%41.txt`. A second decode would change it, so this rule makes sure that each pathname that `put()` or `list()` returns targets the same object when you pass it back. `50% off.txt` is valid. `put()` and `createMultipartUpload()` check the final pathname after `prefix` and `addRandomSuffix`. A `cloudflare-r2` store returns [`BLOB_PATHNAME_TOO_LONG`](/docs/blob/limits-and-errors#blob_pathname_too_long) for a pathname above 1,024 bytes. `list()` checks `prefix` the same way and accepts a trailing slash.

### Copy a file

`blob.copy(from, to)` copies a file in the same store and returns the new `BlobObject`. The copy keeps the content type and the custom metadata of the source. `to` follows the pathname rules of `put()`.

```ts [server/api/reports/[id]/archive.post.ts] fragment
const [error, archived] = await blob.copy(`reports/${id}.pdf`, `archive/${id}.pdf`)
if (error?.code === 'BLOB_NOT_FOUND') throw createError({ statusCode: 404 })
if (error) throw error
```

A missing source returns [`BLOB_NOT_FOUND`](/docs/blob/limits-and-errors#blob_not_found). A file at `to` returns [`BLOB_CONFLICT`](/docs/blob/limits-and-errors#blob_conflict), as in `media.move()`. Pass `{ overwrite: true }` to replace it. ViteHub checks `to` before it copies, so two calls at the same time can both write. To move a file, call `blob.delete(from)` after the copy. Use [`media.move()`](/docs/blob/media) for a file that has a media record.

| Driver | How it copies |
| --- | --- |
| `fs` | Copies the file and writes the metadata of the source for it. |
| `cloudflare-r2` | Reads the object from the binding and streams it into the new key. Without a binding, R2 copies on the server through the S3 API. |
| `s3`, `minio`, `gcs`, `azure` | The provider copies the object on the server. |
| `vercel-blob` | Vercel copies the object on the server. ViteHub reads the source first to keep its content type. |
| `netlify-blobs` | Reads the object and writes it again. |

Pass the cursor from `blob.list()` unchanged to the next call on the same store, with the same `prefix` and `folded`. Netlify Blobs listings fail if they cannot decode the cursor.

With `folded: true`, the files-sdk drivers (S3 and S3-compatible stores, R2, GCS, and Azure) ask the provider for folders, so each page is one request. A page holds at most `limit` blobs and folders together.

With a partial prefix such as `docs/re`, a page can be empty while `hasMore` is true. Continue with the cursor to reach the matches.

The `fs` driver sorts keys by UTF-16 code unit, so `B.txt` comes before `a.txt`. Its cursor holds the last listed key, so a key added between pages does not repeat or skip another key. It reads only the directories on the `prefix` path and the directories that the page reaches.

## Serve a transformed object

Use `blob.serve()` in an application route when authorization or a database lookup decides which object to expose. Pass the `Request`: the `request` of a Fetchable route, or `event.req` in an H3 or Nitro handler. It returns a `Response` with the final status and headers, so the route returns it as it is. It handles conditional GET and HEAD requests. Responses default to `private, no-cache`; set `cacheControl` to choose another policy. `headers` adds more headers to a response that serves the object, including `206`, `304`, and `416`. Error responses do not get them.

In a Nitro 3 or H3 2 handler:

```ts [server/routes/files/[...pathname].get.ts]
import { blob } from '@vite-hub/blob'
import { defineEventHandler, getRouterParam } from 'h3'

export default defineEventHandler((event) => {
  const pathname = getRouterParam(event, 'pathname')
  if (pathname === undefined) return Response.json({ error: 'Blob not found.' }, { status: 404 })
  return blob.serve(event.req, pathname)
})
```

`serve()` answers `400` with a JSON body `{ error }` when the decoded pathname is unsafe or malformed: empty, a control character, a `%XX` sequence, a `.` or `..` segment such as `dir/..%2F..%2Fpackage.json`, or a key above the store limit. It answers `404` with `{ "error": "Blob not found." }` for a missing object and for a path that ViteHub reserves on every driver: `_vitehub`, `_vitehub/derived/`, `_vitehub/media/`, and `.vitehub/`, where the `fs` driver keeps its metadata. A storage failure throws its `ViteHubError`.

HEAD responses keep the same status and headers as GET, with no body.

Every response that serves an object sends `X-Content-Type-Options: nosniff`. A browser opens some types as a page that can run script: `text/html`, `application/xhtml+xml`, `image/svg+xml`, `text/xml`, `application/xml`, `text/xsl`, `text/rdf`, every other `+xml` type, and every `multipart/*` type. For these types, and for a content type that names one of them in a list, `serve()` also sends `Content-Security-Policy: sandbox`. The browser then shows the file but runs no script and gives it no access to the app origin. An `<img>` tag still shows an SVG. When the `headers` option has a `Content-Security-Policy`, `serve()` adds `sandbox` to it as a second policy. A `304` for a `transform` always sends the sandbox, because the type of the result is not known before the transform runs.

Set `download` to send `Content-Disposition: attachment`, so the browser saves the file and does not open it. `download: true` uses the last segment of the pathname as the file name. A string sets the file name. ViteHub keeps only the last path segment of the name and removes control characters.

```ts [server/routes/exports/[...pathname].get.ts]
import { blob } from '@vite-hub/blob'
import { defineEventHandler, getRouterParam } from 'h3'

export default defineEventHandler((event) => {
  const pathname = getRouterParam(event, 'pathname')
  if (pathname === undefined) return Response.json({ error: 'Blob not found.' }, { status: 404 })
  return blob.serve(event.req, `exports/${pathname}`, { download: true })
})
```

> [!WARNING]
> A stored file has the content type that the uploader sent. When users who are not fully trusted can upload, serve their files from another origin with `serve.publicBaseUrl`, or with `download`. Limit `ensure.types` to the types that your app needs.

In an H3 app, headers that middleware set on `event.res.headers` before the route replace the same headers of the returned `Response`, and they do not reach `4xx` responses. A middleware `Content-Security-Policy` therefore replaces the sandbox of an app route that returns `blob.serve()`. For that route, do not set the policy in middleware. Pass it in the `headers` option of `serve()`. The generated Blob serve route preserves those middleware headers on `4xx` responses and keeps the Blob response headers when both set the same name. For a type that gets the sandbox, the generated route always writes the final `Content-Security-Policy`: the middleware policy, when it is not empty, and the Blob policy as two policies. Middleware cannot remove the sandbox.

`blob.serve()` answers byte-range requests, so `<video>` and `<audio>` can seek and Safari can play the file. Responses without a `transform` send `Accept-Ranges: bytes`.

- One `Range: bytes=start-end`, `bytes=start-`, or `bytes=-length` on GET or HEAD gets `206` with `Content-Range` and only those bytes.
- A range that starts past the end gets `416` with `Content-Range: bytes */<size>` and an empty body.
- Several ranges, a malformed header, or an `If-Range` that is not the current `ETag` get the whole file.
- Transformed responses ignore `Range`.

For a resized or cropped image, pass `variant`, or let the serve route read it from the query string. Read [Image variants](/docs/blob/media#image-variants).

The optional `transform` gets the original `Blob` and returns the response `Blob`. ViteHub caches the result in the same store, with the same access, under `_vitehub/derived/`. Public writes, signed PUTs, multipart uploads, and the serve route cannot use `_vitehub/derived/`, `_vitehub/media/`, `.vitehub/`, or the `_vitehub` pathname itself. On filesystem stores, old files at either cache path are kept. Transforms still work, but caching starts only after you move those files.

ViteHub checks the cached result against the source ETag, content type, and your transform key. Drivers without ETags use a hash of the source bytes. The filesystem driver uses content-based ETags and keeps cached hashes apart from content metadata. If source metadata changes during the read, ViteHub reads again before it transforms. Stable ETags decide cache writes, not provider timestamps.

Change the key when the transform changes, and put any size or format in it. Each source and key has one cache entry, replaced after the source changes. Different keys are separate variants. `blob.delete(originalPath)` removes the original and its variants. Serving a missing source also clears its variants. A failed cleanup is logged and does not undo the delete. Nothing evicts old entries in the background: list them with `blob.list({ prefix: '_vitehub/derived/' })` and remove them with `blob.delete`.

Filesystem cache keys merge repeated slashes. On case-insensitive filesystems, keep filename casing consistent, or other casings leave unused variants.

Use a private store to keep originals and variants reachable only through your app. The transform changes neither provider access nor the original. A deleted original stops the cached result, including a `304`. A running transform does not recreate its cache after the source is gone.

```ts [server/api/photos/[id].get.ts] fragment
import { blob } from 'vite-hub/blob'
import { createPreview, resolvePhotoPath } from '../../utils/photos'

export default {
  async fetch(request: Request) {
    const id = new URL(request.url).pathname.split('/').at(-1)!
    // Validate access and resolve the private storage path before serving.
    const path = await resolvePhotoPath(request, id)
    return blob.serve(request, path, {
      cacheControl: 'public, max-age=300, must-revalidate',
      transform: {
        key: 'preview-768-v1',
        run: createPreview,
      },
    })
  },
}
```

`createPreview` is application code that validates and transforms the image. Return a `Blob` with its response MIME type. A transform failure throws a `BLOB_OPERATION_FAILED` error without the detail of the failure. If storing the derived result fails, ViteHub logs the failure and serves the freshly transformed result. Concurrent requests in one runtime share the transformation.

Across runtimes, the cache is best effort. Source updates at the same time can remove a newer entry and cause another transform. The fingerprint check never returns an entry for the wrong source version. Drivers need no distributed locks or conditional writes.

## Write options

| Option | Type | Description |
| --- | --- | --- |
| `contentType` | `string` | Stored MIME type. |
| `contentLength` | `string` | Expected content length, when the provider supports it. |
| `customMetadata` | `Record<string, string>` | Provider custom metadata. |
| `addRandomSuffix` | `boolean` | Adds a random suffix, when the driver supports it. |
| `prefix` | `string` | Path prefix, when the driver supports it. |

## Upload files

`blob.handleUpload()` reads a `multipart/form-data` request and calls `put()`
for each file. The file name, without folders, is the pathname. ViteHub does
not URL-decode it, so a file named `..%2Fevil.txt` stays inside `prefix`.
It replaces the `%` of each `%XX` sequence with `_`, so `Q3 100%25.pdf` is
stored as `Q3 100_25-<uuid>.pdf`. Renamed files get a fresh UUID suffix before the extension to avoid overwriting a different file.
It returns `[error, objects]`. No files, too many files, or a file that fails
`ensure` throws an H3 400 error before anything is stored. Each file keeps the
content type that the client sent. Use `ensure.types` to limit it.

With `multiple: false` and `ensure.maxSize`, a request whose `Content-Length`
is more than `maxSize` plus 64 KB for the form framing gets a 413 error before
the body is read. With more than one file, the total has no limit, so the body
is read before `ensure` runs. Limit the request body on your host too.

`event` is the event of a Nitro, H3, or `nuxt/server` handler, or a web
`Request`. `handleMultipartUpload()` also reads `context.params`, so it needs
the event.

```ts [server/api/files.post.ts]
import { defineEventHandler } from 'h3'
import { blob } from 'vite-hub/blob'

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
| `onBeforeUpload` | none | Runs for each file before anything is stored, with `{ pathname, contentType, size, request }`. Throw to reject the file. Return `{ pathname }` to store it under another pathname. `put.prefix` and `put.addRandomSuffix` still apply. |
| `onCompleted` | none | Runs with `(object, request)` after each file is stored. |
| `direct` | `false` | Also accept [direct uploads](#direct-uploads). |

In Vue, `useUpload()` from `vite-hub/blob/vue` sends the form. Nuxt
auto-imports it when `blob` is on.

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
with `files`. It resolves with plain objects, where `uploadedAt` is an ISO
string. Pass `headers` or `fetch` to add auth.

## Direct uploads

A form sends the file through your server, so the request body limit of the
host applies. A Vercel Function accepts at most 4.5 MB. With a direct upload,
the browser sends the file straight to storage. Your route only signs the
upload and checks the result.

Add `direct: true` to the upload route. The route still accepts a form.

```ts [server/api/files.post.ts]
import { defineEventHandler } from 'h3'
import { blob } from 'vite-hub/blob'

export default defineEventHandler(async (event) => {
  // Authorize the request here. The route decides who may upload.
  const [error, result] = await blob.handleUpload(event, {
    direct: true,
    ensure: { maxSize: '1GB', types: ['video'] },
    onBeforeUpload: ({ pathname }) => ({ pathname: `videos/${pathname}` }),
    onCompleted: async (object, request) => {
      // Save the upload in your database.
    },
  })
  if (error) throw error
  return result
})
```

In Vue, pass `direct: true` to `useUpload()`. The rest of the API does not
change.

```vue [app/components/VideoUpload.vue]
<script setup lang="ts">
const progress = ref(0)
const upload = useUpload('/api/files', {
  direct: true,
  multiple: false,
  onProgress: (percent) => { progress.value = percent },
})

async function onChange(event: Event) {
  const object = await upload(event.target as HTMLInputElement)
  console.log(object?.pathname)
}
</script>

<template>
  <input type="file" accept="video/*" @change="onChange">
  <progress :value="progress" max="100" />
</template>
```

For each file, the client sends three requests:

| Step | Request | Server |
| --- | --- | --- |
| `sign` | JSON `{ action: 'sign', name, contentType, size }` to the route | Checks `ensure` with the declared type and size, runs `onBeforeUpload`, and returns `{ action: 'sign', pathname, request, ticket }`. |
| `PUT` | `request.method`, `request.url`, and `request.headers`, with the file | The storage provider stores the file. The app headers, such as `authorization`, are not sent. |
| `complete` | JSON `{ action: 'complete', ticket }` to the route | Reads the object with `head()`, checks `ensure` again, runs `onCompleted`, and returns `[object]`. |

The server chooses the pathname. The client sends only the file name. The
`ticket` binds the selected store, pathname, and route URL path, so a client cannot
complete a file in another store or on another route.
`complete` checks what the store holds, not what the client declared. When
the stored size or type fails `ensure`, it deletes the object and throws a
400 error.

> [!WARNING]
> The client reports the completion. When the client stops after the `PUT`,
> for example because the user closed the tab, the file stays in the store and
> `onCompleted` does not run. Clean up files without a database row later, for
> example with a scheduled task. A client can also send `complete` again with
> the same ticket, so make `onCompleted` idempotent.

The signed `PUT` must start within 10 minutes. The ticket for `complete` is
valid for 24 hours. Direct uploads need `VITEHUB_SECRET`, which signs the
ticket. A direct upload cannot set `put.access`, `put.contentLength`, or
`put.customMetadata`, so they throw `BLOB_R0046`. `put.contentType`,
`put.prefix`, and `put.addRandomSuffix` apply.

| Driver | Direct upload | Notes |
| --- | --- | --- |
| `fs` | Signed link to the app | The link binds `ensure.maxSize`, so the route answers `413` for a larger body. The file still goes through the app. |
| `cloudflare-r2` | R2 presigned URL | Needs the S3 HTTP credentials. R2 cannot bind `maxSize`, so `complete` checks the size. |
| `s3`, `minio`, `gcs`, `azure` | Provider presigned URL | Through files-sdk. The provider cannot bind `maxSize`, so `complete` checks the size. |
| `vercel-blob` | Vercel client token | Vercel checks the pathname, the type, and `ensure.maxSize`. Needs `BLOB_READ_WRITE_TOKEN`. A store that only uses Vercel OIDC cannot sign. |
| `netlify-blobs` | No | Netlify Blobs has no presigned upload. The route answers `{ action: 'form' }`, and the client sends the files as a form, through the app. |

A browser sends a `PUT` to another origin only when the bucket allows it. Add
a CORS rule to an R2, S3, GCS, or Azure bucket that allows `PUT` from your app
origin with the `Content-Type` header. For example, for R2 or S3:

```json [cors.json]
[
  {
    "AllowedOrigins": ["https://app.example"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

ViteHub does not set CORS when it provisions a bucket. The Vercel Blob API and
the signed links of `fs` stores need no CORS rule.

The client for any framework is `uploadFiles(apiBase, files, { direct: true })`
from `@vite-hub/blob/client`. Pass `onProgress` to get the progress of the
`PUT` requests from 0 to 100.

## Multipart uploads

Use multipart uploads for files too large for one request. The client splits
the file into parts. The server stores each part until `complete()` joins them.
The `fs`, `cloudflare-r2` (with the R2 binding), and `vercel-blob` drivers
support it. Other drivers throw `BLOB_R0030`.

Create one route with `action` and `pathname` params:

```ts [server/api/files/multipart/[action]/[...pathname].ts]
import { defineEventHandler } from 'h3'
import { blob } from 'vite-hub/blob'

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
| `create` | `POST` | JSON `{ contentType?, size? }` | `{ action, pathname, uploadId }` |
| `upload` | `PUT` | `?uploadId=…&partNumber=…`, part bytes | `{ action, part }` |
| `complete` | `POST` | `?uploadId=…`, JSON `{ parts }` | `{ action, object }` |
| `abort` | `DELETE` | `?uploadId=…` | `{ action }` |

Pass `{ create: { contentType, prefix, addRandomSuffix } }` to set create
options on the server. This `contentType` replaces the one the client sends.

Pass `ensure` to limit the upload, with the same options as
[`ensureBlob()`](#ensureblobblob-options). The client chooses the pathname and
the content type, so set it when users who are not fully trusted can upload:

```ts [server/api/files/multipart/[action]/[...pathname].ts]
import { defineEventHandler } from 'h3'
import { blob } from 'vite-hub/blob'

export default defineEventHandler(async (event) => {
  // Authorize the request here. The client chooses the pathname.
  const [error, result] = await blob.handleMultipartUpload(event, {
    ensure: { maxSize: '1GB', types: ['video'] },
  })
  if (error) throw error
  return result
})
```

- `create` checks `types` against the content type. It also checks `maxSize`
  against the `size` that the client declares.
- `upload` rejects a part that is larger than `maxSize`. A `Content-Length`
  above `maxSize` gets a 413 error before the part is read.
- `complete` deletes the joined object and throws a 400 error when it is larger
  than `maxSize` or its stored content type fails `types`.

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
part except the last. `task.abort()` stops the upload and sends `abort`. Then
`completed` resolves with `undefined`.

Server code can also run an upload directly:

```ts [server/utils/copy-large-file.ts] fragment
import { blob } from 'vite-hub/blob'

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
| `vercel-blob` | Vercel multipart upload | The upload ID encodes the Vercel key. Access always comes from the store config. `abort()` does nothing. Vercel discards unfinished uploads. |

The client for any framework is `@vite-hub/blob/client`, with `uploadFiles()`
and `createMultipartUploader()`. The Vue composables use it. Pass `onProgress`
to `uploadFiles()` to get progress from 0 to 100. The files then go through
XMLHttpRequest, because `fetch` cannot report progress. With progress, the
browser sends a CORS preflight (`OPTIONS`) even for a simple multipart POST, so a
cross-origin upload route must answer it.

## Signed requests

Use `blob.sign()` to give a client or provider short-lived direct access to one private file. The result has the URL, the HTTP method, and every header to send.

```ts [server/api/uploads/presign.post.ts]
import { blob } from 'vite-hub/blob'

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

Send `upload.headers` unchanged with the `PUT` body. `contentType` locks the MIME type into the signed request. `createOnly` makes the provider reject the upload when the file already exists. Drivers that cannot enforce it throw, so they never allow an overwrite silently. `maxSize`, such as `'8MB'`, limits the size of the body. Only the `fs` and `vercel-blob` drivers bind it, and the other drivers fail the request.

The `fs` driver, the `cloudflare-r2` driver, the files-sdk drivers (`s3`, `minio`, `gcs`, `azure`, and the others that use files-sdk), and the `vercel-blob` driver sign requests. The `vercel-blob` driver signs a `PUT` only. It returns a request to the Vercel Blob API with a client token, as `@vercel/blob/client` uploads a file. The token binds the pathname, `contentType`, `maxSize`, `createOnly`, and the expiry, and it needs `BLOB_READ_WRITE_TOKEN`. A files-sdk driver signs a `GET` only when its provider gives a URL that expires after exactly `expiresIn` seconds. It signs a `PUT` only when its provider gives a direct upload URL. These drivers cannot bind `createOnly`. When the provider cannot sign, `blob.sign()` returns `BLOB_OPERATION_FAILED`, and `cause` says why. It never returns a permanent public link instead.

Cloudflare R2 signs with its S3-compatible HTTP credentials, even when reads and writes use a Workers binding. A binding alone cannot make a presigned URL, so set `accountId`, `accessKeyId`, `secretAccessKey`, and `bucketName` in runtime env. [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) expire after 1 second to 7 days. The [S3 compatibility contract](https://developers.cloudflare.com/r2/api/s3/api/) supports `If-None-Match` on `PutObject`.

### Signed links of `fs` stores

A file on disk has no URL of its own, so an `fs` store signs a link to the app: `/_vitehub/blob/signed/<store>/<pathname>`. ViteHub adds this route only when a store uses the `fs` driver, also for the local store of `vite dev`. The route checks the link. Then a `GET` reads the file through `blob.serve()`, with the same headers as the serve route, and a `PUT` writes it with `blob.put()`. Set `urlBaseUrl` on the store, such as `https://app.example`, to get an absolute URL. Without it, the URL starts with `/_vitehub/blob/signed/` on the current origin. When the app has a base URL, such as Nitro `baseURL: '/app'`, the route is under it, so add it to `urlBaseUrl`: `https://app.example/app`.

The link is signed with HMAC-SHA256. The key comes from `VITEHUB_SECRET`, or `NUXT_APP_SECRET`, through `deriveSecret('vitehub:blob:sign')`. The signature covers the method, the store, the pathname, the expiry, and the `contentType` and `maxSize` of a `PUT`. The route rejects a request that does not match its link:

| Request | Status | Code |
| --- | --- | --- |
| The link expired. | `403` | `BLOB_R0042` |
| The URL, the method, or the `Content-Type` changed, or another secret signed the link. | `403` | `BLOB_R0041` |
| The method is not `GET` or `PUT`. | `405` | `BLOB_R0041` |
| The body is larger than `maxSize`. | `413` | `BLOB_R0043` |

Without a root secret of at least 32 characters, `blob.sign()` returns `BLOB_OPERATION_FAILED` with `BLOB_R0040` in `cause`. Set `VITEHUB_SECRET` for `vite dev` too: the secret that ViteHub generates in development does not sign these links. The `fs` driver cannot bind `createOnly`.

> [!NOTE]
> A link works on another instance only when that instance has the same `VITEHUB_SECRET` and reads the same folder, such as a shared volume. Each instance derives the key from the secret, so a restart keeps the links valid.

## Blob reference schemas

A record that points at a stored file, such as a post cover, keeps a Blob reference: the pathname, plus the content type and size from upload.

```ts
interface BlobReference {
  pathname: string
  contentType?: string
  size?: number
}
```

`image()` and `file()` from `vite-hub/blob` return validators for that shape. [Content](/docs/content/configure#fields) re-exports them from `vite-hub/content`. A reference has no URL, because signed and served URLs expire or depend on routes. Serve or sign the pathname when you read the record. It has no alt text or dimensions: read them from the [media record](/docs/blob/media#media-in-content) with `blob.media.get(reference)`. It has no store name either. The schema's `store` option names the store.

```ts [server/api/profile/avatar.put.ts] fragment
import { image } from 'vite-hub/blob'

const avatar = image({ maxSize: '2MB' })

export default defineEventHandler(async (event) => {
  const result = avatar['~standard'].validate(await readBody(event))
  if (result.issues) {
    throw createError({ statusCode: 400, message: result.issues[0]!.message })
  }
  await saveAvatar(event, result.value) // { pathname, contentType, size }
})
```

The validators accept a `BlobObject` from `blob.put()` or `blob.handleUpload()`, or its JSON form, and return only `pathname`, `contentType`, and `size`. They check:

- The value is an object with a string `pathname`.
- The pathname is relative to its store. It has no leading slash, backslash, control character, or empty, `.`, or `..` segment. It is not under `_vitehub/derived/` or `_vitehub/media/`, which `blob.put()` also rejects.
- `contentType` matches `accept`, ignoring case and parameters such as `; charset=utf-8`. With `accept`, `contentType` is required.
- `size`, when present, is a non-negative integer no larger than `maxSize`.

A failed check returns every issue at once, with a `path` such as `['pathname']`. The validators do not read the store. They do not prove that the file exists, and they compare `maxSize` only with the recorded `size`. Enforce upload limits with [`ensureBlob()`](#ensureblobblob-options) or `handleUpload({ ensure })`.

| Option | Type | Description |
| --- | --- | --- |
| `store` | `BlobStoreName` | Store that holds the file. Defaults to `default`. |
| `accept` | `string \| string[]` | MIME types or patterns, such as `image/png`, `image/*`, or `*/*`. `image()` defaults to `image/*`. `file()` accepts every type by default. |
| `maxSize` | `BlobSize` | Largest recorded `size`, such as `512KB` or `8MB`. |

Invalid options throw when the schema is defined.

### JSON Schema and pickers

Both validators implement [Standard Schema](https://standardschema.dev) and Standard JSON Schema. `['~standard'].jsonSchema.input({ target })` and `.output({ target })` return a schema for `draft-2020-12`, `draft-07`, or `openapi-3.0`, and throw for other targets. Forms read its `x-vitehub-blob` keyword to show an image or file picker for the right store. The input schema for `image({ store: 'media', maxSize: '8MB' })`, without property descriptions:

```json
{
  "type": "object",
  "properties": {
    "pathname": { "type": "string", "minLength": 1 },
    "contentType": { "type": "string", "minLength": 1 },
    "size": { "type": "integer", "minimum": 0, "maximum": 8388608 }
  },
  "required": ["pathname", "contentType"],
  "x-vitehub-blob": { "kind": "image", "store": "media", "accept": ["image/*"], "maxSize": "8MB" }
}
```

The output schema also sets `additionalProperties: false`, because validation drops extra fields. `accept` and `maxSize` appear in the hint only when they limit the value.

### Use with other schema libraries

Pass `image()` or `file()` to anything that reads a Standard Schema, such as an Agent tool `inputSchema`, or call `['~standard'].validate()` yourself.

They cannot be fields inside a Zod 4 or Valibot object yet. `z.object({ cover: image() })` throws `Invalid element at key "cover": expected a Zod schema`, and a Valibot `v.object()` with an `image()` entry fails when it parses.

## `ensureBlob(blob, options)`

Use `ensureBlob()` where uploads enter your app.

| Option | Type | Description |
| --- | --- | --- |
| `maxSize` | `BlobSize` | Rejects larger blobs. Examples: `4MB`, `128KB`, `1GB`. |
| `types` | `BlobType[]` | Exact MIME types, or broad types such as `image`, `video`, `audio`, `pdf`, and `text`. A broad type does not accept a type that a browser opens as a page, such as `image/svg+xml` or `text/html`. List that type exactly, for example `['image', 'image/svg+xml']`. |

## Production checks

- Store content types and metadata when you write. Do not guess the type later from the pathname.
- Blob can store Workspace data, but it gives an Agent no file tree. Workspace handles file operations, rules, snapshots, and diffs.
- Blob stores files and small metadata. Keep catalogs, indexes, permissions, search records, domain records, and metadata queries in KV, Database, or another NoSQL or catalog store.
