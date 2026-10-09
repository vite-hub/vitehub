# @vite-hub/blob

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-config-646cff?style=flat-square">
  <img alt="Storage" src="https://img.shields.io/badge/Blob-stores-0f766e?style=flat-square">
</p>

`@vite-hub/blob` gives server code one object-storage API across local files and hosted blob providers.

## Install

```sh
pnpm add @vite-hub/blob h3
pnpm add -D vite
```

Add the SDK required by the driver you configure.

## Minimal API

```ts
// server/api/files.post.ts
import { blob } from "@vite-hub/blob"
import { defineEventHandler, readBody } from "h3"

export default defineEventHandler(async (event) => {
  const body = await readBody<{ path: string, text: string }>(event)

  const [writeError] = await blob.put(body.path, body.text, { contentType: "text/plain" })
  if (writeError) throw writeError

  const [readError, file] = await blob.get(body.path)
  if (readError) throw readError
  return file
})
```

```ts
// vite.config.ts
import { hubBlob } from "@vite-hub/blob/vite"
import { defineConfig } from "vite"

export default defineConfig({
  blob: {
    driver: "fs",
    base: ".vitehub/data/blob",
  },
  plugins: [hubBlob()],
})
```

## Vite Integration

Use `hubBlob()` in Vite to resolve blob config and expose the `blob` runtime helper to server code.

Core drivers include local `fs`, [Vercel Blob](https://vercel.com/docs/vercel-blob), [Cloudflare R2](https://developers.cloudflare.com/r2/), S3-compatible stores, and [files-sdk](https://files-sdk.dev/).
At config time, the `fs` driver uses `BLOB_FS_BASE` when `blob.base` is omitted, then defaults to `.vitehub/data/blob`.

Filesystem writes stage bytes under `<base>/.vitehub/blob-writes` and rename complete files into place. Each new payload inode has an immutable metadata sidecar prepared before the payload rename. Readers select that inode’s metadata and retry if the payload changes during the read, so replacements expose matching bytes, MIME types, size, and custom metadata. Legacy files and sidecars remain readable. Deletion removes metadata for the payload generation observed before deletion, preserving concurrent replacements that are still being prepared. Older generation sidecars and interrupted publications can leave small sidecars; deletion does not sweep these because a sweep could remove a concurrent writer’s metadata. These are internal metadata, not additional payload copies. Workspace history stores keep file MIME types in their immutable manifests.

A stopped process can leave staging files. After stopping every writer to the filesystem store, inspect this directory and remove it to reclaim unfinished writes. For the default base:

```sh
du -sh .vitehub/data/blob/.vitehub/blob-writes
rm -rf .vitehub/data/blob/.vitehub/blob-writes
```

This maintenance removes staging files. Published objects and their metadata remain in place. Do not run it while writers are active.

Configured Vercel Blob tokens that match `BLOB_READ_WRITE_TOKEN` are masked at build time and read from that variable again at runtime. Other configured tokens stay unchanged.

Set `blob.serve` to generate a Nitro route for serving Blob-backed assets. `serve: true` uses `/api/_vitehub/blob` as a safe namespaced API route. Use `serve.route` for product-facing paths such as `/assets`.
Objects from the served store receive an absolute URL when `serve.publicBaseUrl` is configured, or a route-relative URL otherwise.
Use `serve.headers` for static cache and security headers. Blob metadata remains authoritative for content headers such as `Content-Type`, `Content-Length`, and `ETag`.

Application routes can call `blob.serve(event, pathname, { cacheControl, transform: { key, run } })` after their own authorization or database lookup. `run` receives the original `Blob` and returns a response `Blob`. ViteHub stores the derived result in a reserved namespace in the same store, using the store's configured access, leaves the original unchanged, and invalidates the cache when the source or transform key changes. Source changes replace each cached variant on its next request; `blob.del(originalPath)` clears all its variants. Version the key when the transformation changes and include output variants such as size or format. The method handles conditional GET and HEAD requests and returns `null` for a `304` response. See [the server API](https://vitehub.dev/docs/blob/server-api#serve-a-transformed-object) for cache lifetimes, an example, and failure behavior.
The serve route is public by default. Set `serve.authorize: true` to require a signed-in `@vite-hub/auth` session through the Auth Vite plugin; the build fails without an Auth Definition. Export `authorize` (type `BlobServeAuthorize`) from `server/blob.ts` to decide each request with the Auth access signature. ViteHub runs the check before the store read and before conditional `304` handling. It returns `401` without a session, `403` for `false`, and a returned `Response` as-is. Authorized responses default to `Cache-Control: private, no-cache`.

Use `detectContentType()` when an application needs to classify leading bytes before storage. It returns a detected MIME type for common images and PDFs, or `undefined` when the signature is unknown. Storage `contentType` remains caller-provided metadata, and recognizing a signature does not prove that a complete file is valid or safe.

```ts
import { detectContentType } from "@vite-hub/blob/content-type"

const detected = detectContentType(new Uint8Array(await file.arrayBuffer()))
if (detected !== file.type) throw new Error("File content does not match its declared type")
```

```ts
// vite.config.ts
export default defineConfig({
  blob: {
    driver: "fs",
    serve: {
      route: "/assets",
      headers: {
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    },
  },
  plugins: [hubBlob()],
})
```

Blob stores binary objects and small object metadata. Keep catalogs, indexes, permissions, search records, domain records, and richer metadata queries in KV, Database, or another NoSQL/catalog store next to Blob.

Pass the cursor returned by `blob.list()` unchanged to the next list call on the same Blob Store. Keep `prefix` and `folded` unchanged. Netlify Blobs listings and folded files-sdk listings fail if they cannot decode the cursor.

## Uploads

`blob.handleUpload(event, options)` stores the files of a `multipart/form-data` request and returns `[error, objects]`. Options: `formKey` (default `"files"`), `multiple` (default `true`), `ensure` (checked with `ensureBlob()`), and `put` (write options). Request errors throw H3 400 errors before anything is stored.

`blob.handleMultipartUpload(event, options)` serves `create`, `upload`, `complete`, and `abort` requests from a route with `action` and `pathname` params, such as `server/api/files/multipart/[action]/[...pathname].ts`. `blob.createMultipartUpload()` and `blob.resumeMultipartUpload()` drive an upload from server code. The `fs`, `cloudflare-r2` (binding), and `vercel-blob` drivers support multipart uploads. Other drivers throw `BLOB_R0030`.

Upload routes accept client-chosen pathnames. Authorize each request in the route.

Browser clients:

- `@vite-hub/blob/client`: `uploadFiles()` and `createMultipartUploader()`, built only on `fetch`.
- `@vite-hub/blob/vue`: `useUpload()` and `useMultipartUpload()`, which add a progress ref. `vue` is an optional peer dependency.

## Signed requests

Use `blob.sign()` to grant short-lived access to one private object without routing its body through your server.

```ts
const [downloadError, download] = await blob.sign("private/audio.mp3", {
  method: "GET",
  expiresIn: 60 * 60,
})
if (downloadError) throw downloadError

const [uploadError, upload] = await blob.sign("private/audio.mp3", {
  method: "PUT",
  expiresIn: 15 * 60,
  contentType: "audio/mpeg",
  createOnly: true,
})
if (uploadError) throw uploadError

await fetch(upload.url, {
  method: upload.method,
  headers: upload.headers,
  body: file,
})
```

Blob operations return `[error, value]`. Missing objects return `[null, null]` from `get()` and `head()`, including when a serving route is configured. Provider and storage failures use `ViteHubError` with a stable `BLOB_*` code, operation/store details, and the provider failure in `cause`. Invalid arguments, unknown stores, and unsupported signing capabilities throw Nostics diagnostics with package-owned `BLOB_C####`, `BLOB_B####`, or `BLOB_R####` codes. Catch these defects by code. See [Errors and diagnostics](https://vitehub.dev/docs/reference/errors-diagnostics).

The returned headers are part of the request contract and must be sent unchanged. `createOnly` prevents overwriting an existing object when the driver can enforce a conditional upload.

## S3-compatible storage

Use `driver: "s3"` for production S3-compatible object storage. Use `driver: "minio"` for local or Docker Compose object storage, and use `driver: "cloudflare-r2"` for Cloudflare R2.

```sh
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
```

Cloudflare R2 HTTP fallback also requires:

```sh
pnpm add @aws-sdk/lib-storage
```

```ts
// vite.config.ts
export default defineConfig({
  blob: {
    driver: "s3",
    bucket: "app-assets",
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    publicBaseUrl: "https://assets.example.com",
  },
  plugins: [hubBlob()],
})
```

Store S3 credentials in Server Env or the provider credential chain used by the S3 SDK.

## MinIO

MinIO is the Docker-friendly S3-compatible path. Select it explicitly:

```sh
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
```

```ts
// vite.config.ts
export default defineConfig({
  blob: {
    driver: "minio",
  },
  plugins: [hubBlob()],
})
```

ViteHub reads common Docker Compose env names:

```env
MINIO_ENDPOINT=http://minio:9000
MINIO_ROOT_USER=minio
MINIO_ROOT_PASSWORD=password
BLOB_BUCKET_NAME=vitehub-blob
```

The Files SDK native `MINIO_ACCESS_KEY_ID` and `MINIO_SECRET_ACCESS_KEY` env names are also accepted.

You can also keep the config self-contained:

```ts
blob: {
  driver: "minio",
  accessKeyId: process.env.MINIO_ROOT_USER,
  bucket: "vitehub-blob",
  endpoint: "http://minio:9000",
  forcePathStyle: true,
  secretAccessKey: process.env.MINIO_ROOT_PASSWORD,
}
```

## CLI

`hubBlob()` contributes the `vitehub blob` CLI namespace: `list [--prefix] [--limit] [--cursor]`, `head <pathname>`, `get <pathname> [--output <file>]`, `put <pathname> <file> [--content-type]`, and `del <pathname>`. Each command accepts `--store <name>` and `--json`. Write commands print what they changed. The `created` and `deleted` labels are best-effort metadata observations before each mutation. They can be stale with eventual consistency or concurrent writers. Deletion is unconditional and can remove an object replaced concurrently. There is no `sign` command.

The commands call a guarded endpoint that exists only on the Vite Development Server. The endpoint forwards each operation into the Nitro dev environment, so it uses the same Blob storage as the running app. `get` returns the raw bytes. `put` sends the file as base64 JSON, so it accepts files up to 8 MiB. Nuxt and plain Vite do not run Nitro in the Vite process, so the endpoint returns status 501 there. `handleBlobDevRequest()` from `@vite-hub/blob/runtime/dev` is the Nitro handler; it is not a public runtime API.

Learn more at [vitehub.dev](https://vitehub.dev).
