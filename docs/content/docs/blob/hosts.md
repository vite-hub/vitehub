---
title: Blob hosts
description: Set up provider output, development access, Cloudflare R2, S3-compatible storage, and MinIO.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Provider output

The Blob package selects the default or named store and loads its driver. Put provider bucket names, tokens, and bindings in integration configuration or deployment setup.

Application code keeps importing `blob` from `@vite-hub/blob` when you switch providers.

## Read and write blobs during development

`hubBlob()` contributes the `vitehub blob` CLI namespace. Start the Vite Development Server, then read and write blobs from another terminal.

```bash [Terminal]
pnpm vitehub blob list --prefix avatars/
pnpm vitehub blob head avatars/ada.png --json
pnpm vitehub blob put avatars/ada.png ./ada.png
pnpm vitehub blob get avatars/ada.png --output ./copy.png
pnpm vitehub blob del avatars/ada.png
```

The commands call the same Blob storage as the running app. Pass `--store <name>` for a named store. Each write command prints what it changed. `get` writes the bytes unchanged to a file or to stdout. `put` sends the file as base64 JSON through the dev endpoint, so it accepts files up to 8 MiB. The commands do not print blob URLs. The commands call a guarded endpoint that exists only on the Vite Development Server. Nuxt and plain Vite do not run Nitro in the Vite process, so the endpoint returns status 501 there. Read [CLI](/docs/development/cli#read-and-write-blobs) for every command and option.

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

When no runtime binding exists, ViteHub falls back to R2 HTTP access through its bundled Files SDK adapter. Set `accessKeyId` and `secretAccessKey` with runtime env, not `vite.config.ts`; non-secret values such as `bucketName` can stay in config.

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
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
```

## S3-compatible object storage

Use `driver: 's3'` for production S3-compatible object storage that is not one of ViteHub's provider-specific drivers.

```bash [Terminal]
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
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

Use Cloudflare R2 when the app runs with an R2 binding or R2 HTTP credentials. Use MinIO when local development or Docker Compose needs to exercise S3-compatible behavior.

## MinIO object storage

Use MinIO when you want Docker Compose or local staging to exercise object-storage semantics instead of a mounted filesystem.

```bash
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
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

ViteHub reads MinIO credentials from runtime env and masks them in generated provider output. It accepts the Files SDK names `MINIO_ACCESS_KEY_ID` and `MINIO_SECRET_ACCESS_KEY`, plus Docker Compose aliases such as `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`. `driver: 'minio'` defaults to path-style S3 requests, `us-east-1`, `http://localhost:9000`, and the `vitehub-blob` bucket. For production Docker deployments, use managed `s3` or a production S3-compatible store instead of a single-host Compose MinIO service.
