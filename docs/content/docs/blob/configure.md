---
title: Blob configuration
description: Configure Blob Stores, the opt-in serve route, and provider options.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

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
| `blob: { serve: { route?, store?, publicBaseUrl?, headers?, authorize? } }` | Generates an opt-in Nitro route. `route` defaults to `/api/_vitehub/blob`, `store` defaults to `default`, `publicBaseUrl` changes generated public URLs, and `headers` adds static response headers. `authorize: true` requires a signed-in Auth session. |

### Protect served objects

The serve route is public by default. Set `serve.authorize: true` to require a signed-in [Auth](/docs/auth) session before ViteHub reads the store. The app must enable Auth and define `server/auth.ts`, or the build fails with `BLOB_B0002`.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    auth: true,
    blob: { serve: { route: '/photos', authorize: true } },
  })],
})
```

To decide each request, export `authorize` from `server/blob.ts`. It uses the Auth access signature: it receives `{ request, session, user }` and returns `true`, `false`, or a `Response`.

```ts [server/blob.ts]
import type { BlobServeAuthorize } from 'vite-hub/blob'

export const authorize: BlobServeAuthorize = ({ request, user }) =>
  new URL(request.url).pathname.startsWith(`/photos/${user.id}/`)
```

A request without a session returns JSON `401`. A `false` result returns `403`, and a `Response` is returned as-is. ViteHub checks access before the store read and before conditional `304` handling, so a cached `ETag` does not bypass the check. Browsers send the same-origin session cookie with `<img src>`, so image tags work without extra headers. Authorized responses use `Cache-Control: private, no-cache` unless `serve.headers` sets `Cache-Control`. If `server/blob.ts` exports `authorize` while `serve.authorize` is not `true`, the build fails with `BLOB_B0001`. Restart the dev server after you add or remove `server/blob.ts`.

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

Configured Vercel Blob tokens that match `BLOB_READ_WRITE_TOKEN` are masked at build time and read from that variable again at runtime. Other configured tokens stay unchanged.

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
