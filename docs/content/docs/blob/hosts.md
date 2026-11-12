---
title: Blob hosts
description: Set up host output, development access, Cloudflare R2, S3-compatible storage, and MinIO.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Host output

Nitro writes the host output. `hubBlob()` adds a Nitro plugin that picks the store and loads its driver. On a Cloudflare preset, it also adds the R2 bucket bindings to the generated `wrangler.json`. Put bucket names, tokens, and bindings in integration config or deployment setup. Your code keeps importing `blob` from `vite-hub/blob` when you switch providers.

## Read and write blobs during development

`vite dev` uses a local store unless the store sets `remote: true` or an explicit `driver`. Read [Use the real store in development](/docs/blob/configure#use-the-real-store-in-development).

`hubBlob()` adds the `vitehub blob` CLI commands. Start the dev server, then run them from another terminal.

```bash [Terminal]
pnpm vitehub blob list --prefix avatars/
pnpm vitehub blob head avatars/ada.png --json
pnpm vitehub blob put avatars/ada.png ./ada.png
pnpm vitehub blob get avatars/ada.png --output ./copy.png
pnpm vitehub blob delete avatars/ada.png
pnpm vitehub blob media avatars/ada.png
pnpm vitehub blob variants avatars/ada.png
```

`media` prints the [media record](/docs/blob/media) of a file, and `variants` lists its cached image variants. The commands use the same storage as the running app:

- Pass `--store <name>` for a named store.
- Write commands print what they changed.
- `get` writes the bytes unchanged to a file or stdout.
- `put` sends the file as base64 JSON, so `put` and `get` handle files up to 8 MiB.
- The commands do not print blob URLs.

Each command runs a `blob.*` operation through the Console RPC, on the dev server or on a deployed app with `--url`. The Console Blob page uses the same operations. Read [CLI](/docs/development/cli#read-and-write-blobs) for every option.

## Cloudflare R2 bucket

An R2 store uses its runtime binding when it exists. `binding` defaults to `BLOB`. With `bucketName`, ViteHub adds the R2 bucket binding to the generated `wrangler.json`.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    blob: {
      driver: 'cloudflare-r2',
      binding: 'BLOB',
      bucketName: 'assets',
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      blob: {
        driver: 'cloudflare-r2',
        binding: 'BLOB',
        bucketName: 'assets',
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      blob: {
        driver: 'cloudflare-r2',
        binding: 'BLOB',
        bucketName: 'assets',
      },
    }),
  ],
})
```
:::
::

### Jurisdictional buckets

Set `jurisdiction` to `eu`, `fedramp`, or `us` when the bucket uses a [Cloudflare R2 jurisdiction](https://developers.cloudflare.com/r2/reference/data-location/#jurisdictional-restrictions).

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    blob: {
      driver: 'cloudflare-r2',
      bucketName: 'assets',
      jurisdiction: 'eu',
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      blob: {
        driver: 'cloudflare-r2',
        bucketName: 'assets',
        jurisdiction: 'eu',
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      blob: {
        driver: 'cloudflare-r2',
        bucketName: 'assets',
        jurisdiction: 'eu',
      },
    }),
  ],
})
```
:::
::

ViteHub uses it in three places:

- The `r2_buckets` entry, so the Worker binding opens the right bucket.
- `vitehub provision run` sends the `cf-r2-jurisdiction` header when it lists and creates buckets. Without it, Cloudflare hides the bucket, and provisioning creates a second bucket with the same name in the default jurisdiction.
- HTTP fallback and `blob.sign()` use the jurisdiction S3 API host, `https://<account-id>.<jurisdiction>.r2.cloudflarestorage.com`.

You cannot change a bucket's jurisdiction after Cloudflare creates it. If your `wrangler` config has an `r2_buckets` entry with the same `binding` and another `jurisdiction`, the build fails. Set `jurisdiction` in the Blob config and remove that entry.

Without a runtime binding, ViteHub uses R2 over HTTP through its bundled Files SDK adapter. Set `accessKeyId` and `secretAccessKey` in runtime env, not app config. Values that are not secret, such as `bucketName`, can stay in config.

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
| `bucketName` | `bucketName` config, or `BLOB_BUCKET_NAME`, `CLOUDFLARE_R2_BUCKET_NAME`, `R2_BUCKET_NAME` read at build time for the generated `r2_buckets`. HTTP fallback can also read them from runtime env. |
| `jurisdiction` | `jurisdiction` config, or `R2_JURISDICTION`, `CLOUDFLARE_R2_JURISDICTION` read at build time. Runtime env does not change it. |

Install these packages only when you use HTTP fallback.

```bash [Terminal]
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
```

## S3-compatible object storage

Use `driver: 's3'` for production S3-compatible storage that has no driver of its own in ViteHub.

```bash [Terminal]
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
```

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    blob: {
      driver: 's3',
      bucket: 'app-assets',
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      publicBaseUrl: 'https://assets.example.com',
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      blob: {
        driver: 's3',
        bucket: 'app-assets',
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION,
        publicBaseUrl: 'https://assets.example.com',
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      blob: {
        driver: 's3',
        bucket: 'app-assets',
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION,
        publicBaseUrl: 'https://assets.example.com',
      },
    }),
  ],
})
```
:::
::

Keep S3 credentials in Server Env or the S3 SDK credential chain. Put `bucket`, `endpoint`, `region`, and `publicBaseUrl` in config. Without `credentials`, the SDK reads `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` at runtime. With `credentials` set from `process.env`, ViteHub writes only the variable names into the build output and reads the values at runtime. A literal credential fails the build with `BLOB_C0019`. Read [Credentials](/docs/blob/configure#credentials).

With an R2 binding or R2 HTTP credentials, use Cloudflare R2 instead. To test S3 behavior locally or in Docker Compose, use MinIO.

## MinIO object storage

Use MinIO to test real object storage, not a mounted folder, in Docker Compose or local staging.

```bash
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
```

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { blob: { driver: 'minio' } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ blob: { driver: 'minio' } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ blob: { driver: 'minio' } })],
})
```
:::
::

```env [.env]
MINIO_ENDPOINT=http://minio:9000
MINIO_ROOT_USER=minio
MINIO_ROOT_PASSWORD=password
BLOB_BUCKET_NAME=vitehub-blob
```

ViteHub reads MinIO credentials from runtime env and hides them in generated output. It accepts `MINIO_ACCESS_KEY_ID` and `MINIO_SECRET_ACCESS_KEY`, and Docker Compose names such as `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`. `driver: 'minio'` defaults to path-style requests, `us-east-1`, `http://localhost:9000`, and the `vitehub-blob` bucket. In production Docker, use managed `s3` or a production S3-compatible store, not a one-host Compose MinIO.

## Preview deployments

> [!WARNING]
> A Cloudflare Version URL uses the production resources of its Worker version, so it reads and writes production files ([Compare workflows](https://developers.cloudflare.com/workers/previews/compare-workflows/)).

A Cloudflare Preview uses only the bindings in the Wrangler `previews` block. Two Previews that bind the same `bucket_name` share files ([Resources and isolation](https://developers.cloudflare.com/workers/previews/resources/)). ViteHub does not write that block, so declare a preview bucket in `previews.r2_buckets` yourself.

For a separate preview Worker, set `BLOB_BUCKET_NAME` in its build and leave `bucketName` unset, or set `bucketName` to the preview bucket. `bucketName` wins over `BLOB_BUCKET_NAME`.

On Vercel, a preview uses the Blob store connected in the Preview environment ([Connecting a store to your projects](https://vercel.com/docs/vercel-blob#connecting-a-store-to-your-projects)). `vitehub provision run --provider vercel` connects one store to Production, Preview, and Development, so previews share production files. To separate them, connect a second store to Preview in the Vercel dashboard. Read [Preview deployments share data](/docs/development/provisioning#preview-deployments-share-data).

## Related guides

Read [Cloudflare R2](/docs/guides/cloudflare-r2) or
[private Vercel Blob storage](/docs/guides/vercel-blob) for setup and upload checks.
