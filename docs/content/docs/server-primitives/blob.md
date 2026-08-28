---
title: Blob
description: Store uploads, generated files, binary objects, and metadata with one object-storage API.
navigation.order: 6
icon: i-lucide-files
---

Use Blob for uploads, generated media, PDFs, exports, and other objects that don't need a file tree.

Use [Workspace](/docs/server-primitives/workspace) when files need paths, snapshots, diffs, Source sync, or agent access. A Blob Store only keeps objects and their metadata.

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
  const [error, object] = await blob.put('hello.txt', 'Hello from ViteHub')
  if (error) throw error
  return object
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `blob` from `@vite-hub/blob` | Read and write the Default Blob Store or named Blob Stores. |
| `detectContentType` from `vite-hub/blob/content-type` or `@vite-hub/blob/content-type` | Classify common image and PDF signatures before storage. |
| `ensureBlob` from `@vite-hub/blob` or `@vite-hub/blob/ensure` | Validate upload size and content type. |
| `hubBlob` from `@vite-hub/blob/vite` | Register Blob runtime configuration and Provider Output. |
| `resolveBlobViteConfig` from `@vite-hub/blob/vite` | Resolve Blob Vite runtime config manually. |
| `@vite-hub/blob/drivers/*` | Import provider-specific Blob Driver Modules. |

All Blob driver, object, list, put, store, and module types are exported from `@vite-hub/blob`.

Blob writes preserve the metadata you provide. `detectContentType()` checks common leading signatures, but it doesn't validate the complete file or prove that the file is safe.

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
| `blob: BlobStoreConfig` | Configures one Default Blob Store with a `driver` and its provider options. Without a driver, ViteHub infers Cloudflare R2, Netlify Blobs, Vercel Blob, or local filesystem storage from the host and runtime env. |
| `blob: { stores: Record<string, BlobStoreConfig> }` | Defines named Blob Stores. `stores.default` is required. |
| `blob: { serve: false }` | Disables Blob route generation. This is the default. |
| `blob: { serve: true }` | Generates an opt-in Nitro route at `/api/_vitehub/blob/**` for serving the Default Blob Store. |
| `blob: { serve: { route?, store?, publicBaseUrl?, headers? } }` | Generates an opt-in Nitro route. `route` defaults to `/api/_vitehub/blob`, `store` defaults to `default`, `publicBaseUrl` changes generated public URLs, and `headers` adds static response headers. |

## Provider options

Every Blob Store config is a discriminated union selected by `driver`. Keep credentials in Server Env or provider-managed secrets; fields in these tables describe the exact public config shape, not a recommendation to commit secrets to Vite config.

### Local filesystem

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `driver` | `'fs'` | Required | Selects local filesystem storage. |
| `base` | `string` | `BLOB_FS_BASE` or `.vitehub/data/blob` | Sets the storage directory. |
| `defaultUrlExpiresIn` | `number` | Files SDK default | Sets the default generated URL lifetime in seconds. |
| `urlBaseUrl` | `string` | None | Sets the base URL returned by the filesystem adapter. |

Filesystem storage is for local or single-process use. It does not become durable shared storage on a serverless host.

### Cloudflare R2

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `driver` | `'cloudflare-r2'` | Required | Selects the Cloudflare R2 driver. |
| `binding` | `string` | `BLOB` | Names the runtime R2 binding. |
| `bucketName` | `string` | R2 or Blob bucket env | Names the bucket for Provider Output and HTTP fallback. |
| `accountId` | `string` | Cloudflare account env | Supplies the account id for HTTP fallback. |
| `accessKeyId` | `string` | R2 access-key env | Supplies the HTTP fallback access key. |
| `secretAccessKey` | `string` | R2 secret-key env | Supplies the HTTP fallback secret. |
| `defaultUrlExpiresIn` | `number` | Files SDK default | Sets the default signed URL lifetime in seconds. |
| `publicBaseUrl` | `string` | None | Uses a public or CDN base URL for objects instead of signed URLs when supported. |

The runtime binding takes precedence. HTTP credentials are used when no active binding exists.

### Vercel Blob

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `driver` | `'vercel-blob'` | Required | Selects Vercel Blob. |
| `access` | `'private' \| 'public'` | `'public'` | Sets the store-level access policy. A `blob.put()` call can override it. |
| `allowOverwrite` | `boolean` | `true` | Allows writes to replace an existing pathname. |
| `downloadTimeoutMs` | `number` | Provider default | Sets the download timeout in milliseconds. |
| `token` | `string` | `BLOB_READ_WRITE_TOKEN` | Supplies the Vercel Blob token. ViteHub resolves masked build-time values again at runtime. |

### Netlify Blobs

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `driver` | `'netlify-blobs'` | Required | Selects Netlify Blobs. |
| `name` | `string` | `vitehub-blob` | Names the Netlify Blob Store. |
| `consistency` | `'eventual' \| 'strong'` | Provider default | Selects the Netlify read-consistency mode. |
| `deployScoped` | `boolean` | Provider default | Scopes the store to the active deploy when enabled. |
| `siteID` | `string` | Netlify runtime env | Supplies the Netlify site id outside an injected runtime. |
| `token` | `string` | Netlify runtime env | Supplies the Netlify access token outside an injected runtime. |

### S3 and S3-compatible providers

The `s3`, `akamai`, `digitalocean-spaces`, `hetzner`, `storj`, and `minio` drivers share object-storage routing options. Their required fields differ.

| Driver | Required fields | ViteHub defaults |
| --- | --- | --- |
| `s3` | `bucket` | None |
| `akamai` | `bucket`, `region` | None |
| `digitalocean-spaces` | `bucket`, `region` | None |
| `hetzner` | `bucket`, `region` | None |
| `storj` | `bucket` | None |
| `minio` | None | Bucket `vitehub-blob`, endpoint `http://localhost:9000`, region `us-east-1`, and `forcePathStyle: true` |

| Option | Drivers | Type | Description |
| --- | --- | --- | --- |
| `driver` | All | provider literal | Selects one driver from the table above. |
| `bucket` | All | `string` | Names the object-storage bucket. It is optional only for `minio`. |
| `endpoint` | All | `string` | Overrides the provider endpoint. |
| `region` | All | `string` | Selects the provider region. It is required for Akamai, DigitalOcean Spaces, and Hetzner. |
| `forcePathStyle` | All | `boolean` | Uses path-style bucket URLs instead of virtual-hosted URLs. |
| `publicBaseUrl` | All | `string` | Uses a public or CDN base URL for objects. |
| `defaultUrlExpiresIn` | All | `number` | Sets the default signed URL lifetime in seconds. |
| `credentials` | `s3` | `{ accessKeyId, secretAccessKey, sessionToken? }` | Supplies an explicit AWS-compatible credential object. |
| `accessKeyId` | Provider-specific drivers and `minio` | `string` | Supplies the access key directly. |
| `secretAccessKey` | Provider-specific drivers and `minio` | `string` | Supplies the secret key directly. |

MinIO resolves credentials from `MINIO_ACCESS_KEY_ID`, `MINIO_ACCESS_KEY`, `MINIO_ROOT_USER`, or `AWS_ACCESS_KEY_ID`, with matching secret-key env aliases. Other S3-compatible adapters also support their provider or SDK credential sources.

### Google Cloud Storage

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `driver` | `'gcs'` | Yes | Selects Google Cloud Storage. |
| `bucket` | `string` | Yes | Names the bucket. |
| `credentials` | `{ client_email, private_key }` | No | Supplies service-account credentials inline. |
| `keyFilename` | `string` | No | Loads service-account credentials from a file. |
| `projectId` | `string` | No | Selects the Google Cloud project. |
| `defaultUrlExpiresIn` | `number` | No | Sets the default signed URL lifetime in seconds. |
| `publicBaseUrl` | `string` | No | Uses a public or CDN base URL for objects. |

### Azure Blob Storage

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `driver` | `'azure'` | Yes | Selects Azure Blob Storage. |
| `container` | `string` | Yes | Names the container. |
| `accountName` | `string` | No | Supplies the storage account name. |
| `accountKey` | `string` | No | Authenticates with the account key. |
| `connectionString` | `string` | No | Authenticates and configures the endpoint with an Azure connection string. |
| `sasToken` | `string` | No | Authenticates with a shared access signature. |
| `endpoint` | `string` | No | Overrides the Blob service endpoint. |
| `defaultUrlExpiresIn` | `number` | No | Sets the default signed URL lifetime in seconds. |
| `publicBaseUrl` | `string` | No | Uses a public or CDN base URL for objects. |

### Supabase Storage

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `driver` | `'supabase'` | Yes | Selects Supabase Storage. |
| `bucket` | `string` | Yes | Names the bucket. |
| `url` | `string` | No | Supplies the Supabase project URL. |
| `key` | `string` | No | Supplies the Supabase API key. |
| `public` | `boolean` | No | Treats the bucket as public. |
| `publicBaseUrl` | `string` | No | Overrides the public object URL base. |
| `defaultUrlExpiresIn` | `number` | No | Sets the default signed URL lifetime in seconds. |

### UploadThing

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `driver` | `'uploadthing'` | Yes | Selects UploadThing. |
| `token` | `string` | No | Supplies the UploadThing token. |
| `acl` | `'private' \| 'public-read'` | No | Sets the uploaded object ACL. |
| `region` | `string` | No | Selects the upload region. |
| `slug` | `string` | No | Selects the UploadThing route or file slug. |
| `downloadTimeoutMs` | `number` | No | Sets the download timeout in milliseconds. |
| `defaultUrlExpiresIn` | `number` | No | Sets the default generated URL lifetime in seconds. |

### Google Drive

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `driver` | `'google-drive'` | Yes | Selects Google Drive. |
| `credentials` | `{ client_email, private_key }` | No | Supplies service-account credentials inline. |
| `keyFilename` | `string` | No | Loads service-account credentials from a file. |
| `subject` | `string` | No | Selects the delegated Workspace user. |
| `driveId` | `string` | No | Selects a shared drive. |
| `rootFolderId` | `string` | No | Restricts objects to a root folder. |
| `fileIdCacheSize` | `number` | No | Limits the path-to-file-id cache. |
| `publicByDefault` | `boolean` | No | Makes newly written files public by default. |

### OneDrive

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `driver` | `'onedrive'` | Yes | Selects OneDrive or SharePoint-backed storage. |
| `accessToken` | `string` or async callback | No | Supplies or resolves a Microsoft Graph access token. |
| `clientCredentials` | `{ tenantId, clientId, clientSecret }` | No | Uses the OAuth client-credentials flow. |
| `oauth` | `{ clientId, clientSecret, refreshToken, tenantId? }` | No | Uses a refresh-token OAuth flow. |
| `driveId` | `string` | No | Selects a drive directly. |
| `siteId` | `string` | No | Selects a SharePoint site. |
| `userId` | `string` | No | Selects a user's drive. |
| `rootFolderPath` | `string` | No | Restricts objects to a root folder path. |
| `copyTimeoutMs` | `number` | No | Sets the asynchronous copy timeout in milliseconds. |
| `publicByDefault` | `boolean` | No | Makes newly written files public by default. |

### Dropbox

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `driver` | `'dropbox'` | Yes | Selects Dropbox. |
| `accessToken` | `string` or async callback | No | Supplies or resolves an access token. |
| `appKey` | `string` | No | Supplies the OAuth app key. |
| `appSecret` | `string` | No | Supplies the OAuth app secret. |
| `refreshToken` | `string` | No | Refreshes OAuth access with the app credentials. |
| `rootFolderPath` | `string` | No | Restricts objects to a root folder path. |
| `publicByDefault` | `boolean` | No | Creates shared links by default. |
| `publicBaseUrl` | `string` | No | Uses an app-owned public URL base. |
| `defaultUrlExpiresIn` | `number` | No | Sets the default generated URL lifetime in seconds. |

### Box

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `driver` | `'box'` | Yes | Selects Box. |
| `developerToken` | `string` | No | Authenticates with a Box developer token. |
| `ccg` | `{ clientId, clientSecret, enterpriseId?, userId? }` | No | Uses Box Client Credentials Grant authentication. |
| `jwt` | `{ configJsonString } \| { configFilePath }` | No | Uses a Box JWT application configuration. |
| `oauth` | `{ clientId, clientSecret, refreshToken }` | No | Uses an OAuth refresh-token flow. |
| `rootFolderId` | `string` | No | Restricts objects to a root folder. |
| `publicByDefault` | `boolean` | No | Creates shared links by default. |
| `publicBaseUrl` | `string` | No | Uses an app-owned public URL base. |
| `defaultUrlExpiresIn` | `number` | No | Sets the default generated URL lifetime in seconds. |

## Use it at runtime

Use the `blob` Runtime Helper from server code.

```ts [server/api/files.post.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ path: string, text: string }>(event)

  const [error] = await blob.put(body.path, body.text, {
    contentType: 'text/plain',
    customMetadata: { source: 'api' },
  })
  if (error) throw error

  return { ok: true }
})
```

```ts [server/api/files/[...path].get.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  const path = getRouterParam(event, 'path')!
  const [error, object] = await blob.get(path)
  if (error) throw error

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
    serve: {
      route: '/assets',
      headers: {
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  },
})
```

Use `serve.headers` for static cache and security policy. Blob metadata remains authoritative for content headers such as `Content-Type`, `Content-Length`, and `ETag`.

The generated Nitro route maps `${route}/**` to the selected Blob Store and delegates streaming to `blob.store(storeName).serve(event, pathname)`. The default route is a safe framework default. It is not a recommendation that every app expose public assets under `/api`.

Objects from the served store include a URL. With `serve.publicBaseUrl`, the URL is absolute. Without it, the URL is route-relative so request-aware consumers can resolve it against their own origin.

## Runtime helper

`blob` implements `BlobStorage`.

Every async method returns `[error, value]`. Expected provider and storage failures are `ViteHubError` values with `BLOB_*` codes, so application code can apply HTTP, retry, logging, or best-effort policy without `try/catch`. Invalid arguments, unknown stores, and unsupported signing capabilities still throw because they indicate API or configuration misuse. Generated serving routes unwrap `blob.serve()` and pass its error to H3.

| Method | Description |
| --- | --- |
| `blob.put(pathname, body, options?)` | Stores text, bytes, streams, ArrayBuffers, or `Blob` objects. |
| `blob.get(pathname)` | Reads a `Blob` or returns `null`. |
| `blob.head(pathname)` | Reads object metadata. |
| `blob.list(options?)` | Lists objects with optional `prefix`, `limit`, `cursor`, and folded folders. |
| `blob.del(pathnames)` | Deletes one or more objects. |
| `blob.sign(pathname, options)` | Signs a short-lived `GET` or `PUT` request for one object. |
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

## Signed requests

Use `blob.sign()` when a client or provider needs short-lived direct access to one private object. The result contains the URL, HTTP method, and every header that must be sent with the request.

```ts [server/api/uploads/presign.post.ts]
import { blob } from '@vite-hub/blob'

const [sourceError, source] = await blob.sign('users/user/jobs/job/source.mp3', {
  method: 'GET',
  expiresIn: 6 * 60 * 60,
})
if (sourceError) throw sourceError

const [uploadError, upload] = await blob.sign('users/user/jobs/job/source.mp3', {
  method: 'PUT',
  expiresIn: 15 * 60,
  contentType: 'audio/mpeg',
  createOnly: true,
})
if (uploadError) throw uploadError
```

Send `upload.headers` unchanged with the `PUT` body. `contentType` binds the upload MIME type into the signed request. `createOnly` binds a provider condition that rejects the upload when the object already exists; drivers that cannot enforce it throw instead of silently allowing an overwrite.

Cloudflare R2 signs through its S3-compatible HTTP credentials, including when normal reads and writes use a Workers binding. A binding alone cannot mint a presigned URL, so configure `accountId`, `accessKeyId`, `secretAccessKey`, and `bucketName` through runtime environment values. [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) accept expiries from 1 second through 7 days, and the [S3 compatibility contract](https://developers.cloudflare.com/r2/api/s3/api/) supports `If-None-Match` on `PutObject`.

## `ensureBlob(blob, options)`

Use `ensureBlob()` at upload boundaries.

| Option | Type | Description |
| --- | --- | --- |
| `maxSize` | `BlobSize` | Rejects blobs larger than the limit. Examples: `4MB`, `128KB`, `1GB`. |
| `types` | `BlobType[]` | Allows exact MIME types or broad types such as `image`, `video`, `audio`, `pdf`, and `text`. |

## Provider output

The Blob package selects the default or named store and loads its driver. Put provider bucket names, tokens, and bindings in integration configuration or deployment setup.

Application code keeps importing `blob` from `@vite-hub/blob` when you switch providers.

## Connect Blob to Agents

Direct Blob access is for server code. To let a model inspect or edit scoped object storage, attach the Blob Capability.

Give a Blob Capability the narrowest useful key prefix and configure write access deliberately. Use Workspace when the model needs a file tree, diffs, snapshots, or Source-backed context.

## Production checks

Store content types and metadata at write time. Avoid guessing object type later from path names.

Blob can store Workspace data, but it doesn't provide a file tree to an Agent. Workspace handles file operations, rules, snapshots, and diffs.

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

## Next steps

- Use [Workspace](/docs/server-primitives/workspace) for file-tree state.
- Use [Source](/docs/server-primitives/source) for read-only retrieval.
- Expose scoped model access through [Official capabilities](/docs/capabilities/official-capabilities).
