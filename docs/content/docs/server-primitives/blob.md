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

## Blob and agents

Attach the Blob Capability only when a model should inspect or edit object storage. Keep prefixes narrow and make write behavior explicit.
