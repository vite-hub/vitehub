---
title: Blob
description: Store uploads, generated artifacts, binary objects, and metadata behind one object-storage surface.
navigation.order: 6
icon: i-lucide-files
---

Blob owns object storage. Use it for uploads, generated images, audio, video, PDFs, exports, and other file-shaped objects.

Blob is not Workspace. Blob Stores hold objects; Workspace owns file-tree behavior, Source ingestion, snapshots, diffs, and agent-visible file context.

## Configure Blob

Install the package and register the Vite Integration.

```bash [Terminal]
pnpm add @vite-hub/blob
```

```ts [vite.config.ts]
import { hubBlob } from '@vite-hub/blob/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubBlob()],
})
```

Choose a provider in configuration when the app needs hosted object storage.

```ts [vite.config.ts]
import { hubBlob } from '@vite-hub/blob/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    driver: 'cloudflare-r2',
    binding: 'BLOB',
    bucketName: 'app-artifacts',
  },
})
```

## Use it at runtime

Use the `blob` Runtime Helper from server code.

```ts [server/api/files.post.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ path: string, text: string }>(event)

  await blob.put(body.path, body.text, {
    contentType: 'text/plain',
    metadata: { source: 'api' },
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

Use named Blob Stores when configuration defines multiple stores.

```ts [server/reports.ts]
import { blob } from '@vite-hub/blob'

export const reports = blob.store('reports')
```

## Provider output

The Blob Package owns Default Blob Store behavior, named Blob Store selection, driver loading, and the Blob Driver Boundary. Provider-specific bucket names, tokens, and bindings belong in integration configuration and deployment setup.

Application code should keep importing `blob` from `@vite-hub/blob` when switching providers.

## Connect it to Agents

Direct Blob access is for server code. To let a model inspect or edit scoped object storage, attach the Blob Capability.

Blob Capability access should use narrow prefixes and explicit write policy. Use Workspace instead when the model needs file-tree semantics, diffs, snapshots, or source-backed context.

## Production boundaries

Store content types and metadata at write time. Avoid guessing object type later from path names.

Blob stores can back Workspace Stores, but that does not make Blob an agent-facing file tree. Workspace remains the boundary for file operations, rules, snapshots, and diffs.

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

MinIO credentials are read from runtime env and stay masked in generated provider output. ViteHub accepts the Files SDK native `MINIO_ACCESS_KEY_ID` and `MINIO_SECRET_ACCESS_KEY` names plus Docker Compose aliases like `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`. `driver: 'minio'` defaults to path-style S3 requests, `us-east-1`, `http://localhost:9000`, and the `vitehub-blob` bucket when those values are not provided. Production Docker deployments should use managed `s3` or a production-grade S3-compatible store rather than relying on a single-host Compose MinIO service.

## Next steps

- Use [Workspace](/docs/server-primitives/workspace) for file-tree state.
- Use [Source](/docs/server-primitives/source) for read-only retrieval.
- Expose scoped model access through [Official capabilities](/docs/capabilities/official-capabilities).
