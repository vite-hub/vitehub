---
title: Blob
description: Store uploads, generated artifacts, binary objects, and metadata behind one object-storage surface.
navigation.order: 6
icon: i-lucide-files
---

Blob is direct object storage. Use it for uploads, generated images, audio, video, PDFs, exports, and other file-shaped objects.

Blob is not Workspace. Blob stores objects. Workspace owns a file tree, source ingestion, snapshots, diffs, and agent-visible file context.

## Install and configure

```bash
pnpm add @vite-hub/blob
```

```ts [vite.config.ts]
import { hubBlob } from '@vite-hub/blob/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubBlob()],
})
```

## Write and read objects

```ts [server/api/files.post.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ path: string; text: string }>(event)
  await blob.put(body.path, body.text, {
    contentType: 'text/plain',
  })

  return { ok: true }
})
```

```ts [server/api/files/[...path].get.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  const path = getRouterParam(event, 'path')!
  const object = await blob.get(path)

  if (!object) {
    throw createError({ statusCode: 404 })
  }

  return object
})
```

## Metadata and content types

Store the content type and relevant metadata when the object is written. Avoid guessing later.

```ts
await blob.put('reports/q1.pdf', file, {
  contentType: 'application/pdf',
  metadata: {
    report: 'q1',
  },
})
```

## Cloudflare R2 bucket

Cloudflare object storage maps to R2. Configure the binding and bucket near the integration.

```ts [vite.config.ts]
export default defineConfig({
  blob: {
    driver: 'cloudflare-r2',
    binding: 'BLOB',
    bucketName: 'app-artifacts',
  },
})
```

## Vercel Blob token

Vercel Blob uses the Blob token from the deployment environment.

```env [.env]
BLOB_READ_WRITE_TOKEN=<blob-read-write-token>
```

```ts [vite.config.ts]
export default defineConfig({
  blob: {
    driver: 'vercel-blob',
  },
})
```

## MinIO object storage

Use MinIO when you want Docker Compose or local staging to exercise object-storage semantics instead of a mounted filesystem.

```bash
pnpm add files-sdk @aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
```

```ts [vite.config.ts]
export default defineConfig({
  blob: {
    driver: 'minio',
  },
})
```

```env [.env]
MINIO_ENDPOINT=http://minio:9000
MINIO_ROOT_USER=minio
MINIO_ROOT_PASSWORD=password
BLOB_BUCKET_NAME=vitehub-blob
```

`driver: 'minio'` defaults to path-style S3 requests, `us-east-1`, `http://localhost:9000`, and the `vitehub-blob` bucket when those values are not provided. Production Docker deployments should use managed `s3` or a production-grade S3-compatible store rather than relying on a single-host Compose MinIO service.

## Blob and agents

Attach the Blob Capability only when a model should inspect or edit object storage. Keep prefixes narrow and make write behavior explicit.
