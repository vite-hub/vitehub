---
title: Blob hosts
description: Set up host output, development access, Cloudflare R2, S3-compatible storage, and MinIO.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Host output

Nitro writes the host output. `hubBlob()` adds a Nitro plugin that selects the default or named store and loads its driver. On a Cloudflare preset, it also adds the R2 bucket bindings to Nitro's generated `wrangler.json`. Put provider bucket names, tokens, and bindings in integration configuration or deployment setup.

Application code keeps importing `blob` from `@vite-hub/blob` when you switch providers.

## Read and write blobs during development

`hubBlob()` contributes the `vitehub blob` CLI namespace. Start the Vite Development Server, then read and write blobs from another terminal.

```bash [Terminal]
pnpm vitehub blob list --prefix avatars/
pnpm vitehub blob head avatars/ada.png --json
pnpm vitehub blob put avatars/ada.png ./ada.png
pnpm vitehub blob get avatars/ada.png --output ./copy.png
pnpm vitehub blob del avatars/ada.png
pnpm vitehub blob media avatars/ada.png
pnpm vitehub blob variants avatars/ada.png
```

`media` prints the [media record](/docs/blob/media) of an object, and `variants` lists its cached image variants. The commands call the same Blob storage as the running app. Pass `--store <name>` for a named store. Each write command prints what it changed. `get` writes the bytes unchanged to a file or to stdout. `put` sends the file as base64 JSON, so it accepts files up to 8 MiB, and `get` returns files up to 8 MiB. The commands do not print blob URLs. Each command runs a `blob.*` operation through the Console RPC, on the dev server or on a deployed app with `--url`. The Console Blob page uploads and deletes objects with the same operations. Read [CLI](/docs/development/cli#read-and-write-blobs) for every command and option.

## Cloudflare R2 bucket

Cloudflare R2 Blob Stores use the configured runtime binding when it exists. `binding` defaults to `BLOB`, and `bucketName` lets ViteHub add the matching Cloudflare R2 bucket binding to Nitro's generated `wrangler.json`.

```ts [vite.config.ts]
export default defineConfig({
  blob: {
    driver: 'cloudflare-r2',
    binding: 'BLOB',
    bucketName: 'assets',
  },
})
```

### Jurisdictional buckets

Set `jurisdiction` when the bucket uses a [Cloudflare R2 jurisdiction](https://developers.cloudflare.com/r2/reference/data-location/#jurisdictional-restrictions). The values are `eu`, `fedramp`, and `us`.

```ts [vite.config.ts]
export default defineConfig({
  blob: {
    driver: 'cloudflare-r2',
    bucketName: 'assets',
    jurisdiction: 'eu',
  },
})
```

ViteHub uses the jurisdiction in three places:

- The generated `r2_buckets` entry gets `jurisdiction`, so the Worker binding opens the correct bucket.
- `vitehub provision run` sends the `cf-r2-jurisdiction` header when it lists and creates buckets. Without it, Cloudflare does not show the jurisdictional bucket, and provisioning creates a second bucket with the same name in the default jurisdiction.
- HTTP fallback and `blob.sign()` use the jurisdiction S3 API host, `https://<account-id>.<jurisdiction>.r2.cloudflarestorage.com`.

You cannot change the jurisdiction of a bucket after Cloudflare creates it. If your `wrangler` config already has an `r2_buckets` entry with the same `binding` and a different `jurisdiction`, the build fails. Set `jurisdiction` in the Blob config and remove the duplicate entry.

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
| `jurisdiction` | `jurisdiction` config, or `R2_JURISDICTION`, `CLOUDFLARE_R2_JURISDICTION` read at config/build time. Runtime env does not change it. |

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
