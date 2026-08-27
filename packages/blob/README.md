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
pnpm add @vite-hub/blob
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

Set `blob.serve` to generate a Nitro route for serving Blob-backed assets. `serve: true` uses `/api/_vitehub/blob` as a safe namespaced API route. Use `serve.route` for product-facing paths such as `/assets`.
Objects from the served store receive an absolute URL when `serve.publicBaseUrl` is configured, or a route-relative URL otherwise.
Use `serve.headers` for static cache and security headers. Blob metadata remains authoritative for content headers such as `Content-Type`, `Content-Length`, and `ETag`.

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

Blob operations return `[error, value]`. Provider and storage failures use `ViteHubError` with a stable `BLOB_*` code, operation/store details, and the provider failure in `cause`. Invalid arguments, unknown stores, and unsupported signing capabilities still throw because they are configuration or API misuse rather than an operational result.

The returned headers are part of the request contract and must be sent unchanged. `createOnly` prevents overwriting an existing object when the driver can enforce a conditional upload.

## S3-compatible storage

Use `driver: "s3"` for production S3-compatible object storage. Use `driver: "minio"` for local or Docker Compose object storage, and use `driver: "cloudflare-r2"` for Cloudflare R2.

```sh
pnpm add @aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
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
pnpm add @aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
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

Learn more at [vitehub.dev](https://vitehub.dev).
