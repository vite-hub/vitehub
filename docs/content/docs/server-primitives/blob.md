---
title: Blob
description: Store uploads, generated artifacts, binary objects, and metadata behind one object-storage surface.
navigation.order: 6
icon: i-lucide-files
---

Blob owns object storage. Use it for uploads, generated images, audio, video, PDFs, exports, and other file-shaped objects.

Blob is not Workspace. Blob Stores hold objects; Workspace owns file-tree behavior, Source ingestion, snapshots, diffs, and agent-visible file context.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/blob
```

### Configure

```ts [vite.config.ts]
import { hubBlob } from '@vite-hub/blob/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubBlob()],
})
```

### Start using it

```ts [server/api/files.post.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async () => {
  return blob.put('hello.txt', 'Hello from ViteHub')
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `blob` from `@vite-hub/blob` | Read and write the Default Blob Store or named Blob Stores. |
| `ensureBlob` from `@vite-hub/blob` or `@vite-hub/blob/ensure` | Validate upload size and content type. |
| `hubBlob` from `@vite-hub/blob/vite` | Register Blob runtime configuration and Provider Output. |
| `resolveBlobViteConfig` from `@vite-hub/blob/vite` | Resolve Blob Vite runtime config manually. |
| `@vite-hub/blob/drivers/*` | Import provider-specific Blob Driver Modules. |

All Blob driver, object, list, put, store, and module types are exported from `@vite-hub/blob`.

## Store configuration

Configure one default Blob Store directly, or configure named stores with `blob.stores`.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    stores: {
      default: { driver: 'fs' },
      reports: { driver: 'vercel-blob', access: 'private' },
    },
  },
})
```

| Shape | Description |
| --- | --- |
| `blob: false` | Disables Blob runtime configuration. |
| `blob: { driver: 'fs', base?: string }` | Uses local filesystem storage. Default `base`: `.data/blob`. |
| `blob: { driver: 'cloudflare-r2', binding?: string, bucketName?: string }` | Uses Cloudflare R2. Default `binding`: `BLOB`. HTTP credentials can provide fallback access when no runtime binding exists. |
| `blob: { driver: 'vercel-blob', token?, access? }` | Uses Vercel Blob. Runtime token can come from `BLOB_READ_WRITE_TOKEN`; access can be `private` or `public`. |
| `blob: { driver: 's3', bucket, endpoint?, region? }` | Uses production S3-compatible object storage. |
| `blob: { driver: 'minio', endpoint?: string, bucket?: string, region?: string }` | Uses MinIO for local or Docker Compose object storage. |
| `blob: { stores: Record<string, BlobStoreConfig> }` | Defines named Blob Stores. `stores.default` is required. |
| `blob: { serve: true }` | Generates an opt-in Nitro route at `/api/_vitehub/blob/**` for serving the Default Blob Store. |
| `blob: { serve: { route, store?, publicBaseUrl? } }` | Generates an opt-in Nitro route at `route/**` for an explicit public or app-owned path. |

## Providers

| Driver | Provider family |
| --- | --- |
| `fs` | Local filesystem. |
| `cloudflare-r2` | Cloudflare R2 binding. |
| `vercel-blob` | Vercel Blob. |
| `minio`, `s3`, `akamai`, `digitalocean-spaces`, `hetzner`, `storj` | S3-compatible storage. |
| `gcs`, `azure`, `supabase`, `netlify-blobs`, `uploadthing` | Hosted object storage services. |
| `google-drive`, `onedrive`, `dropbox`, `box` | File-provider-backed object storage. |

## Use it at runtime

Use the `blob` Runtime Helper from server code.

```ts [server/api/files.post.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ path: string, text: string }>(event)

  await blob.put(body.path, body.text, {
    contentType: 'text/plain',
    customMetadata: { source: 'api' },
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

## Serve blob-backed assets

Blob serving is opt-in. Set `serve` in the Blob config, or pass `hubBlob({ serve: true })`, to generate a Nitro route that serves Blob-backed assets through `blob.serve()`.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    driver: 'fs',
    serve: true,
  },
})
```

`serve: true` uses `/api/_vitehub/blob` as the route base. ViteHub chooses a namespaced API route by default so generated handlers avoid app routes, static assets, and framework asset directories. The default also mirrors server API route conventions.

Use an explicit `serve.route` for product-facing asset URLs.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    driver: 's3',
    bucket: 'app-assets',
    serve: { route: '/assets' },
  },
})
```

The generated Nitro route maps `${route}/**` to the selected Blob Store and delegates streaming to `blob.store(storeName).serve(event, pathname)`. The default route is a safe framework default. It is not a recommendation that every app expose public assets under `/api`.

## Runtime Helper

`blob` implements `BlobStorage`.

| Method | Description |
| --- | --- |
| `blob.put(pathname, body, options?)` | Stores text, bytes, streams, ArrayBuffers, or `Blob` objects. |
| `blob.get(pathname)` | Reads a `Blob` or returns `null`. |
| `blob.head(pathname)` | Reads object metadata. |
| `blob.list(options?)` | Lists objects with optional `prefix`, `limit`, `cursor`, and folded folders. |
| `blob.del(pathnames)` | Deletes one or more objects. |
| `blob.serve(event, pathname)` | Serves an object stream through an H3 event. |
| `blob.store(name)` | Selects a named Blob Store. |

## Write options

| Option | Type | Description |
| --- | --- | --- |
| `contentType` | `string` | Stored MIME type. |
| `contentLength` | `string` | Expected content length when the provider supports it. |
| `customMetadata` | `Record<string, string>` | Provider custom metadata. |
| `access` | `BlobPutOptions['access']` | Object access policy when the driver supports it. Values: `private`, `public`. |
| `addRandomSuffix` | `boolean` | Adds a random suffix when supported by the driver. |
| `prefix` | `string` | Provider path prefix when supported by the driver. |

## `ensureBlob(blob, options)`

Use `ensureBlob()` at upload boundaries.

| Option | Type | Description |
| --- | --- | --- |
| `maxSize` | `BlobSize` | Rejects blobs larger than the limit. Examples: `4MB`, `128KB`, `1GB`. |
| `types` | `BlobType[]` | Allows exact MIME types or broad types such as `image`, `video`, `audio`, `pdf`, and `text`. |

## Provider output

The Blob Package owns Default Blob Store behavior, named Blob Store selection, driver loading, and the Blob Driver Boundary. Provider-specific bucket names, tokens, and bindings belong in integration configuration and deployment setup.

Application code should keep importing `blob` from `@vite-hub/blob` when switching providers.

## Connect it to Agents

Direct Blob access is for server code. To let a model inspect or edit scoped object storage, attach the Blob Capability.

Blob Capability access should use narrow prefixes and explicit write policy. Use Workspace instead when the model needs file-tree semantics, diffs, snapshots, or source-backed context.

## Production boundaries

Store content types and metadata at write time. Avoid guessing object type later from path names.

Blob stores can back Workspace Stores, but that does not make Blob an agent-facing file tree. Workspace remains the boundary for file operations, rules, snapshots, and diffs.

Blob stores binary objects and small object metadata. Keep catalogs, indexes, permissions, search records, domain records, and richer metadata queries in KV, Database, or another NoSQL/catalog store next to Blob.

## Cloudflare R2 bucket

Cloudflare R2 Blob Stores use the configured runtime binding when it exists. `binding` defaults to `BLOB`, and `bucketName` lets ViteHub emit the matching Cloudflare R2 bucket binding in Provider Output.

```ts [vite.config.ts]
export default defineConfig({
  blob: {
    driver: 'cloudflare-r2',
    binding: 'BLOB',
    bucketName: 'assets',
  },
})
```

When no runtime binding exists, ViteHub falls back to R2 HTTP access through `files-sdk/r2`. Set `accessKeyId` and `secretAccessKey` with runtime env, not `vite.config.ts`; non-secret values such as `bucketName` can stay in config.

```env [.env]
R2_ACCOUNT_ID=account-id
R2_ACCESS_KEY_ID=access-key-id
R2_SECRET_ACCESS_KEY=secret-access-key
R2_BUCKET_NAME=assets
```

| Runtime value | Source |
| --- | --- |
| `accountId` | `R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_ACCOUNT_ID` |
| `accessKeyId` | `R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_ACCESS_KEY_ID` |
| `secretAccessKey` | `R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY` |
| `bucketName` | `bucketName` config, or `BLOB_BUCKET_NAME`, `CLOUDFLARE_R2_BUCKET_NAME`, `R2_BUCKET_NAME` read at config/build time for generated Cloudflare `r2_buckets`. HTTP fallback can also read these names from active runtime env. |

Install the optional R2 HTTP dependencies only when you rely on fallback access.

```bash [Terminal]
pnpm add files-sdk @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
```

## S3-compatible object storage

Use `driver: 's3'` for production S3-compatible object storage that is not one of ViteHub's provider-specific drivers.

```bash [Terminal]
pnpm add files-sdk @aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
```

```ts [vite.config.ts]
export default defineConfig({
  blob: {
    driver: 's3',
    bucket: 'app-assets',
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    publicBaseUrl: 'https://assets.example.com',
  },
})
```

Store S3 credentials in Server Env or the provider credential chain used by the S3 SDK. Put non-secret routing values such as `bucket`, `endpoint`, `region`, and `publicBaseUrl` in config.

Use Cloudflare R2 when the app runs with an R2 binding or R2 HTTP credentials. Use MinIO when local development or Docker Compose should exercise S3-compatible semantics.

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
