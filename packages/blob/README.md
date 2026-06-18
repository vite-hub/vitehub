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

  await blob.put(body.path, body.text, { contentType: "text/plain" })

  return blob.get(body.path)
})
```

```ts
// vite.config.ts
import { hubBlob } from "@vite-hub/blob/vite"
import { defineConfig } from "vite"

export default defineConfig({
  blob: {
    driver: "fs",
    base: ".data/blob",
  },
  plugins: [hubBlob()],
})
```

## Vite Integration

Use `hubBlob()` in Vite to resolve blob config and expose the `blob` runtime helper to server code.

Core drivers include local `fs`, [Vercel Blob](https://vercel.com/docs/vercel-blob), [Cloudflare R2](https://developers.cloudflare.com/r2/), S3-compatible stores, and [files-sdk](https://files-sdk.dev/).

## MinIO

MinIO is the Docker-friendly S3-compatible path. Select it explicitly:

```sh
pnpm add files-sdk @aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
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

You can also keep the config self-contained:

```ts
blob: {
  driver: "minio",
  bucket: "vitehub-blob",
  endpoint: "http://minio:9000",
  forcePathStyle: true,
}
```

Learn more at [vitehub.dev](https://vitehub.dev).
