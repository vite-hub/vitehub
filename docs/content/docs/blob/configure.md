---
title: Blob configuration
description: Set up Blob Stores, the optional route that serves files, and the options for each storage provider.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Store configuration

A Blob Store is one place where files are saved. Configure one default store, or several named stores with `blob.stores`.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    blob: {
      stores: {
        default: { driver: 'fs' },
        reports: { driver: 'vercel-blob', access: 'private' },
      },
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
        stores: {
          default: { driver: 'fs' },
          reports: { driver: 'vercel-blob', access: 'private' },
        },
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
        stores: {
          default: { driver: 'fs' },
          reports: { driver: 'vercel-blob', access: 'private' },
        },
      },
    }),
  ],
})
```
:::
::

| Shape | Description |
| --- | --- |
| `blob: false` | Turns Blob off. |
| `blob: BlobStoreConfig` | One default store with a `driver` and its provider options. Without a driver, ViteHub picks Cloudflare R2, Netlify Blobs, Vercel Blob, or the local filesystem from the host and runtime env. In `vite dev`, an inferred store stays local unless it sets `remote: true`. See [Use the real store in development](#use-the-real-store-in-development). |
| `blob: { stores: Record<string, BlobStoreConfig> }` | Named stores. `stores.default` is required. |
| `blob: { serve: false }` | No serve route. This is the default. |
| `blob: { serve: true }` | Adds a Nitro route at `/api/_vitehub/blob/**` that serves the default store. |
| `blob: { serve: { route?, store?, publicBaseUrl?, headers?, authorize?, anonymous? } }` | Adds a Nitro route. `route` defaults to `/api/_vitehub/blob` and `store` to `default`. `publicBaseUrl` changes the public URLs. `headers` adds static response headers. `authorize: true` requires a signed-in Auth session. `anonymous: true` also sends signed-out requests to the `authorize` export. |

> [!WARNING]
> The serve route sends each file from the app origin with the content type that the uploader sent. It serves HTML, SVG, XML, and multipart types in a CSP sandbox, so they run no script. A middleware `Content-Security-Policy` does not remove the sandbox. When users who are not fully trusted can upload, set `publicBaseUrl` to an origin that has no app cookies, and limit [`ensure.types`](/docs/blob/server-api#ensureblobblob-options) to the types that your app needs. Read [Serve a transformed object](/docs/blob/server-api#serve-a-transformed-object).

### Use the real store in development

`vite dev` keeps Blob local by default. When ViteHub infers Vercel Blob for a store without a `driver`, from `BLOB_STORE_ID`, `BLOB_READ_WRITE_TOKEN`, or the Vercel preset, `vite dev` uses the local `fs` driver in `.vitehub/data/blob` instead. On the Cloudflare preset, a store without a `driver` uses the R2 binding of the dev runner when it has one, because that binding is a local emulation. Without a binding, for example on Nitro's default Node dev runner, it uses the local `fs` driver.

Set `remote: true` to use the real store in `vite dev`:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { blob: { remote: true } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ blob: { remote: true } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ blob: { remote: true } })],
})
```
:::
::

::warning
Writes from `vite dev` then change real data. On first use, the dev server prints `Blob store "default" is remote`, and `vitehub inspect definitions --kind blob` shows `Development: Remote`.
::

`remote` changes only `vite dev`. Builds ignore it. A store with an explicit `driver` uses that driver in `vite dev`, with or without `remote`, because you selected it. On a `cloudflare-r2` store, `remote: true` makes `vite dev` use the real bucket through the R2 API and the HTTP credentials, not the local binding. In `blob.stores`, set `remote` on each named store. A value that is not a boolean fails with `BLOB_C0017`. `remote: true` on a store that uses the local `fs` driver fails with `BLOB_C0018`.

### Protect served objects

The serve route is public by default. Set `serve.authorize: true` to require a signed-in [Auth](/docs/auth) session before ViteHub reads the store. Enable Auth and define `server/auth.ts`, or the build fails with `BLOB_B0002`.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
    blob: { serve: { route: '/photos', authorize: true } },
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
  plugins: [vitehub({
    auth: true,
    blob: { serve: { route: '/photos', authorize: true } },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    auth: true,
    blob: { serve: { route: '/photos', authorize: true } },
  })],
})
```
:::
::

To decide each request yourself, export `authorize` from `server/blob.ts`. It gets `{ request, session, user }` and returns `true`, `false`, or a `Response`.

```ts [server/blob.ts]
import type { BlobServeAuthorize } from 'vite-hub/blob'

export const authorize: BlobServeAuthorize = ({ request, user }) =>
  new URL(request.url).pathname.startsWith(`/photos/${user.id}/`)
```

The callback results:

- No session: JSON `401`.
- `false`: `403`.
- A `Response`: that response, unchanged.

ViteHub checks access before it reads the store and before it answers `304`, so a cached `ETag` cannot skip the check. Browsers send the session cookie with `<img src>`, so image tags need no extra headers. Allowed responses use `Cache-Control: private, no-cache` unless `serve.headers` sets `Cache-Control`.

If `server/blob.ts` exports `authorize` but `serve.authorize` is not `true`, the build fails with `BLOB_B0001`. Restart the dev server after you add or remove `server/blob.ts`.

### Share objects with signed-out readers

To share a file with anyone who has its link, set `serve.anonymous: true` with `serve.authorize: true`. Signed-out requests then reach `authorize` too, with `session` and `user` set to `null`. Type the export as `BlobServeAnonymousAuthorize` so TypeScript makes you check `user` first.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
    blob: { serve: { route: '/files', authorize: true, anonymous: true } },
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
  plugins: [vitehub({
    auth: true,
    blob: { serve: { route: '/files', authorize: true, anonymous: true } },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    auth: true,
    blob: { serve: { route: '/files', authorize: true, anonymous: true } },
  })],
})
```
:::
::

```ts [server/blob.ts]
import type { BlobServeAnonymousAuthorize } from 'vite-hub/blob'

export const authorize: BlobServeAnonymousAuthorize = ({ request, user }) => {
  const pathname = new URL(request.url).pathname
  if (pathname.startsWith('/files/public/')) return true
  return user !== null && pathname.startsWith(`/files/${user.id}/`)
}
```

`false` returns JSON `401` when signed out and `403` when signed in. A `Response` is returned unchanged. Without this option, signed-out requests never reach the callback, so a callback written for `authorize: true` can expect a user. `anonymous: true` without `authorize: true` fails with `BLOB_C0016`. Without an `authorize` export, the build fails with `BLOB_B0006`.

## Serve blob-backed assets

Set `serve` to add a Nitro route that sends stored files to the browser through `blob.serve()`. It is off by default.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { blob: { driver: 'fs', serve: true } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ blob: { driver: 'fs', serve: true } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ blob: { driver: 'fs', serve: true } })],
})
```
:::
::

`serve: true` uses `/api/_vitehub/blob`. This path does not collide with your routes, static assets, or framework asset folders. For URLs that your users see, set `serve.route`.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
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
        serve: {
          route: '/assets',
          headers: {
            'Cache-Control': 'public, max-age=300',
            'X-Content-Type-Options': 'nosniff',
          },
        },
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
        serve: {
          route: '/assets',
          headers: {
            'Cache-Control': 'public, max-age=300',
            'X-Content-Type-Options': 'nosniff',
          },
        },
      },
    }),
  ],
})
```
:::
::

Use `serve.headers` for cache and security headers. Content headers such as `Content-Type`, `Content-Length`, and `ETag` always come from Blob metadata.

When your own middleware checks access before the serve route, use `private, no-cache`, not `no-store`:

- `no-cache`: the browser keeps its copy and asks again on each use. Your check runs on every request, and an unchanged file answers `304` with no body.
- `no-store`: the browser keeps nothing and downloads the full file on every visit.

The generated Nitro route maps `${route}/**` to the selected Blob Store. It is a Fetchable route, `{ fetch(request) }`. Nitro supplies the raw pathname after `${route}`, also when the app has a `baseURL`, and the route returns the `Response` of `blob.store(storeName).serve(request, pathname)` as it is. The default route is a safe framework default. It is not a recommendation that every app expose public assets under `/api`.

The `304` needs an `ETag` from the driver. A file without one downloads in full each time.

The route also serves [image variants](/docs/blob/media#image-variants), such as `${route}/posts/cover.jpg?w=640&fmt=webp`.

Files from the served store include a URL. With `serve.publicBaseUrl`, it is absolute. Without it, it is relative to the route, so callers can add their own origin.

## Image variants

`images` sets how the serve route makes image variants. Without it, the `auto` transformer uses the Cloudflare Images binding when the Worker has one, sharp when it is installed, and the original otherwise.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    blob: {
      driver: 'fs',
      serve: true,
      images: { transformer: 'sharp', sizes: [320, 640, 1280, 1920], quality: 70 },
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
        driver: 'fs',
        serve: true,
        images: { transformer: 'sharp', sizes: [320, 640, 1280, 1920], quality: 70 },
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
        driver: 'fs',
        serve: true,
        images: { transformer: 'sharp', sizes: [320, 640, 1280, 1920], quality: 70 },
      },
    }),
  ],
})
```
:::
::

| Option | Type | Description |
| --- | --- | --- |
| `transformer` | `'auto' \| 'sharp' \| 'photon' \| 'cloudflare-images' \| 'passthrough'` | Defaults to `auto`. `sharp` fails the build without sharp. `photon` uses `@cf-wasm/photon` on Workers and Node and fails the build without it. `cloudflare-images` adds the Worker `images` binding. |
| `binding` | `string` | Cloudflare Images binding name. Defaults to `IMAGES`. |
| `sizes` | `number[]` | Widths and heights that variants snap to. Defaults to 16 through 3840. |
| `quality` | `number` | Default quality for lossy formats, 1 to 100. Defaults to 75. |

Set `images: false` to always serve originals. `images` applies to every store.

## Provider options

A driver is the storage service a store uses. `driver` selects which options apply.

> [!WARNING]
> Keep credentials in Server Env or provider secrets. The tables show every config field, but do not commit secrets to Vite config.

### Credentials

ViteHub writes the resolved Blob config into the server bundle. It never writes a credential there. A credential is an option such as `secretAccessKey`, `token`, `accountKey`, `connectionString`, `sasToken`, `key`, or `credentials.private_key`, and also the access key id that goes with a secret key. ViteHub also treats these values as credentials:

- A URL option with a user name, password, or query, such as an Azure `endpoint` with a SAS token.
- An option that the driver tables below do not show, such as Google OAuth fields in `credentials` or `oauth`.

Give a credential in one of two ways:

- Leave the option out, and set the env variable that the driver reads at runtime. For example, `s3` uses the AWS SDK credential chain, which reads `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
- Set the option to an env variable with `process.env`. ViteHub finds the variable that holds the value at build time, writes only its name into the output, and reads it again when the store starts. Set the variable for the build and for the server. On Cloudflare Workers, ViteHub reads the Worker env first, so a Worker secret works without `process.env`.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    blob: {
      stores: {
        default: { driver: 'fs' },
        media: {
          driver: 's3',
          bucket: 'media',
          region: 'eu-west-1',
          credentials: {
            accessKeyId: process.env.MEDIA_S3_ACCESS_KEY_ID!,
            secretAccessKey: process.env.MEDIA_S3_SECRET_ACCESS_KEY!,
          },
        },
      },
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
        stores: {
          default: { driver: 'fs' },
          media: {
            driver: 's3',
            bucket: 'media',
            region: 'eu-west-1',
            credentials: {
              accessKeyId: process.env.MEDIA_S3_ACCESS_KEY_ID!,
              secretAccessKey: process.env.MEDIA_S3_SECRET_ACCESS_KEY!,
            },
          },
        },
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
        stores: {
          default: { driver: 'fs' },
          media: {
            driver: 's3',
            bucket: 'media',
            region: 'eu-west-1',
            credentials: {
              accessKeyId: process.env.MEDIA_S3_ACCESS_KEY_ID!,
              secretAccessKey: process.env.MEDIA_S3_SECRET_ACCESS_KEY!,
            },
          },
        },
      },
    }),
  ],
})
```

:::
::

A literal credential, or a value that no env variable holds, fails `vite dev` and the build with [`BLOB_C0019`](/docs/blob/diagnostics/blob_c0019). At build time, ViteHub looks only in `process.env`. A value that `loadEnv()` reads from a `.env` file is not there, so set the variable in the shell or CI, or copy the `loadEnv()` result into `process.env` first. A variable that the build used but the server does not have fails when the store starts, with [`BLOB_R0044`](/docs/blob/diagnostics/blob_r0044). ViteHub reads the variable as it is: a value that the config changes, such as a private key with `\n` replaced by line breaks, does not match. Put the final value in the variable, or use `keyFilename` for Google Cloud Storage.

The value must be in exactly one env variable at build time. When two variables hold the same value, ViteHub cannot tell which one the config reads, and `vite dev` and the build fail with [`BLOB_C0020`](/docs/blob/diagnostics/blob_c0020). This also applies when two options, such as a MinIO user and password, have the same value. Give each variable a different value, or remove the other variable from the build environment.

### Local filesystem

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `driver` | `'fs'` | Required | Local filesystem storage. |
| `base` | `string` | `BLOB_FS_BASE` or `.vitehub/data/blob` | Storage folder. |
| `defaultUrlExpiresIn` | `number` | Files SDK default | Default URL lifetime in seconds. |
| `urlBaseUrl` | `string` | None | Base URL that the filesystem adapter returns. |

Use filesystem storage on one machine with one process. On a serverless host, it is not durable or shared.

### Cloudflare R2

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `driver` | `'cloudflare-r2'` | Required | Cloudflare R2. |
| `binding` | `string` | `BLOB` | Runtime R2 binding name. |
| `bucketName` | `string` | R2 or Blob bucket env | Bucket for the generated R2 binding and HTTP fallback. |
| `jurisdiction` | `'eu' \| 'fedramp' \| 'us'` | `R2_JURISDICTION` or `CLOUDFLARE_R2_JURISDICTION` env | Bucket [R2 jurisdiction](/docs/blob/hosts#jurisdictional-buckets) for the binding, provisioning, and the S3 API host. |
| `accountId` | `string` | Cloudflare account env | Account id for HTTP fallback. |
| `accessKeyId` | `string` | R2 access-key env | HTTP fallback access key. |
| `secretAccessKey` | `string` | R2 secret-key env | HTTP fallback secret. |
| `defaultUrlExpiresIn` | `number` | Files SDK default | Default signed URL lifetime in seconds. |
| `publicBaseUrl` | `string` | None | Public or CDN base URL for objects, instead of signed URLs when supported. |

The runtime binding takes precedence. HTTP credentials are used when no active binding exists. ViteHub reads them only for HTTP access and signed URLs, so a server with the binding does not need the HTTP credential variables. In `vite dev`, a store that the Cloudflare preset infers uses the local `fs` driver instead of the HTTP credentials. See [Use the real store in development](#use-the-real-store-in-development).

### Vercel Blob

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `driver` | `'vercel-blob'` | Required | Vercel Blob. |
| `access` | `'private' \| 'public'` | `'public'` | Store access policy. A `blob.put()` call can override it. |
| `allowOverwrite` | `boolean` | `true` | Allows writes to replace an existing pathname. |
| `downloadTimeoutMs` | `number` | Provider default | Download timeout in milliseconds. |
| `token` | `string` | OIDC with `BLOB_STORE_ID`, then `BLOB_READ_WRITE_TOKEN` | Vercel Blob read-write token. Without it, ViteHub uses Vercel OIDC when `BLOB_STORE_ID` is set, else `BLOB_READ_WRITE_TOKEN`. |

A configured token that matches `BLOB_READ_WRITE_TOKEN` is hidden at build time and read from that variable at runtime. A configured token from another env variable is read from that variable. A configured token always wins over OIDC. See [Credentials](#credentials). Read [Vercel Blob credentials](/docs/guides/vercel-blob#create-the-store-and-connect-it).

### Netlify Blobs

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `driver` | `'netlify-blobs'` | Required | Netlify Blobs. |
| `name` | `string` | `vitehub-blob` | Netlify store name. |
| `consistency` | `'eventual' \| 'strong'` | Provider default | Netlify read consistency. |
| `deployScoped` | `boolean` | Provider default | Limits the store to the active deploy. |
| `siteID` | `string` | Netlify runtime env | Netlify site id, when the runtime does not inject one. |
| `token` | `string` | Netlify runtime env | Netlify access token, when the runtime does not inject one. |

### S3 and S3-compatible providers

The `s3` and `minio` drivers share options. Their required fields differ.

| Driver | Required fields | ViteHub defaults |
| --- | --- | --- |
| `s3` | `bucket` | None |
| `minio` | None | Bucket `vitehub-blob`, endpoint `http://localhost:9000`, region `us-east-1`, and `forcePathStyle: true` |

| Option | Drivers | Type | Description |
| --- | --- | --- | --- |
| `driver` | All | provider literal | One driver from the table above. |
| `bucket` | All | `string` | Bucket name. Optional only for `minio`. |
| `endpoint` | All | `string` | Overrides the provider endpoint. |
| `region` | All | `string` | Provider region. |
| `forcePathStyle` | All | `boolean` | Uses path-style bucket URLs instead of virtual-hosted URLs. |
| `publicBaseUrl` | All | `string` | Public or CDN base URL for objects. |
| `defaultUrlExpiresIn` | All | `number` | Default signed URL lifetime in seconds. |
| `credentials` | `s3` | `{ accessKeyId, secretAccessKey, sessionToken? }` | AWS-compatible credential object. |
| `accessKeyId` | `minio` | `string` | Access key. |
| `secretAccessKey` | `minio` | `string` | Secret key. |

MinIO reads credentials from `MINIO_ACCESS_KEY_ID`, `MINIO_ACCESS_KEY`, `MINIO_ROOT_USER`, or `AWS_ACCESS_KEY_ID`, and the matching secret-key variables. The `s3` driver also reads the SDK credential sources. Set `credentials`, `accessKeyId`, and `secretAccessKey` only from env variables. See [Credentials](#credentials).

### Google Cloud Storage

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `driver` | `'gcs'` | Yes | Google Cloud Storage. |
| `bucket` | `string` | Yes | Bucket name. |
| `credentials` | `{ client_email, private_key }` | No | Service-account credentials. |
| `keyFilename` | `string` | No | File with service-account credentials. |
| `projectId` | `string` | No | Google Cloud project. |
| `defaultUrlExpiresIn` | `number` | No | Default signed URL lifetime in seconds. |
| `publicBaseUrl` | `string` | No | Public or CDN base URL for objects. |

### Azure Blob Storage

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `driver` | `'azure'` | Yes | Azure Blob Storage. |
| `container` | `string` | Yes | Container name. |
| `accountName` | `string` | No | Storage account name. |
| `accountKey` | `string` | No | Account key. |
| `connectionString` | `string` | No | Azure connection string. Sets auth and the endpoint. |
| `sasToken` | `string` | No | Shared access signature. |
| `endpoint` | `string` | No | Overrides the Blob service endpoint. |
| `defaultUrlExpiresIn` | `number` | No | Default signed URL lifetime in seconds. |
| `publicBaseUrl` | `string` | No | Public or CDN base URL for objects. |
