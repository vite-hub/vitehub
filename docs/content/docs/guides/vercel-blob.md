---
title: Use Vercel Blob in a Vite app with ViteHub
description: Use Vercel Blob from a Vite app with ViteHub. Upload, read, list, and serve files with blob.put() and blob.get(), and move the same code to R2 or disk.
navigation.title: Vercel Blob
navigation.order: 15
navigation.group: Storage
icon: i-simple-icons-vercel
---

Set `host: 'vercel'` and `blob: true` in `vitehub()`, and connect a Blob store to the Vercel project. ViteHub picks the `vercel-blob` driver, and server code reads and writes files with `blob` from `vite-hub/blob`. You do not install `@vercel/blob`; the driver bundles it.

## What Vercel Blob is

[Vercel Blob](https://vercel.com/docs/vercel-blob) is Vercel's file storage, on all plans, for uploads, images, exports, and more. Each store lives in one region and is public or private, which you cannot change later:

- A public store gives each file a URL that anyone with the link can open.
- A private store needs a token for every read.

Your code calls the same `blob` API as on Cloudflare R2, Netlify Blobs, S3, or local disk.

## Set up Vercel Blob

### Enable Blob with the Vercel host

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'vercel', blob: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'vercel', blob: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'vercel', blob: true })],
})
```
:::
::

On the `vercel` host, `blob: true` picks `driver: 'vercel-blob'` with `access: 'public'`. For a private store, set the driver and access mode yourself:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'vercel',
    blob: { driver: 'vercel-blob', access: 'private' },
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
      host: 'vercel',
      blob: { driver: 'vercel-blob', access: 'private' },
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
      host: 'vercel',
      blob: { driver: 'vercel-blob', access: 'private' },
    }),
  ],
})
```
:::
::

`access` must match your store. See [Vercel Blob options](/docs/blob/configure#vercel-blob) for `allowOverwrite`, `downloadTimeoutMs`, and `token`.

### Create the store and connect it

On Vercel, ViteHub signs in with [OIDC](https://vercel.com/docs/vercel-blob#oidc-access-by-default). When you connect a store, Vercel adds `BLOB_STORE_ID`, and each deployment gets a short-lived `VERCEL_OIDC_TOKEN`. You need no long-lived secret.

ViteHub picks credentials at runtime in this order:

1. A `token` in the `vercel-blob` store config.
2. OIDC, when `BLOB_STORE_ID` is set. The Vercel SDK reads the OIDC token itself.
3. `BLOB_READ_WRITE_TOKEN`, for code off Vercel, such as CI or another host. The SDK also uses it when `BLOB_STORE_ID` is set but there is no OIDC token.

When neither `BLOB_STORE_ID` nor `BLOB_READ_WRITE_TOKEN` is set at runtime, ViteHub throws `BLOB_C0009`.

`vite dev` uses the local `fs` store when it infers Vercel Blob from these variables or from the Vercel host, so development writes do not change the real store. To use the real store in `vite dev`, set `remote: true` on the store, or set `driver: 'vercel-blob'`, then run `vercel env pull` once. The SDK refreshes the OIDC token with your Vercel CLI login. Read [Use the real store in development](/docs/blob/configure#use-the-real-store-in-development).

Create the store in one of two ways:

- On the project's **Storage** page in the Vercel dashboard, or with `vercel blob create-store <name> --access private --yes` in the linked project folder. See [Server uploads with Vercel Blob](https://vercel.com/docs/vercel-blob/server-upload).
- With the ViteHub Vercel Provision Step. It creates a store named `vitehub-blob` in `iad1` with your `access` mode and connects it to the project's production, preview, and development environments, which adds `BLOB_STORE_ID`. If an older connection has only `BLOB_READ_WRITE_TOKEN`, the step warns and keeps it. Reconnect the store in the dashboard to use OIDC.

```bash [Terminal]
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel --dry-run
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel
```

Add `VERCEL_TEAM_ID` or `VERCEL_ORG_ID` if the token needs a team scope. See [Provisioning](/docs/development/provisioning).

### Upload and read files

```ts [server/api/avatars.post.ts]
import { defineEventHandler } from 'h3'
import { blob } from 'vite-hub/blob'

// Check who may upload before this call
export default defineEventHandler(async (event) => {
  const [error, files] = await blob.handleUpload(event, {
    formKey: 'files',
    ensure: { maxSize: '4MB', types: ['image'] },
    put: { prefix: 'avatars', addRandomSuffix: true },
  })
  if (error) throw error
  return files
})
```

```ts [server/api/avatars/[...path].get.ts]
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { blob } from 'vite-hub/blob'

export default defineEventHandler(async (event) => {
  const [error, file] = await blob.get(getRouterParam(event, 'path')!)
  if (error) throw error
  if (!file) throw createError({ statusCode: 404 })
  return file
})
```

`blob.handleUpload()` checks each file's size and type, then saves it. Every async Blob method except `serve()` returns `[error, value]`. On a public store, the saved object has a `url` the browser can open. See [Blob server API](/docs/blob/server-api) for `put()`, `list()`, `delete()`, and `head()`.

### Serve files from a private store

A private store has no public URL. Set `serve` to add a route that streams files through your app:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'vercel',
    blob: {
      driver: 'vercel-blob',
      access: 'private',
      serve: { route: '/files' },
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
      host: 'vercel',
      blob: {
        driver: 'vercel-blob',
        access: 'private',
        serve: { route: '/files' },
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
      host: 'vercel',
      blob: {
        driver: 'vercel-blob',
        access: 'private',
        serve: { route: '/files' },
      },
    }),
  ],
})
```
:::
::

`/files/avatars/ada.png` now returns `avatars/ada.png` from the store.

::warning
The serve route is public by default. Set `serve.authorize: true` to require a signed-in [Auth](/docs/auth) session.
::

See [Serve blob-backed assets](/docs/blob/configure#serve-blob-backed-assets) and [Protect served objects](/docs/blob/configure#protect-served-objects).

## How to use Vercel Blob locally

With the `vercel` host, the dev server also uses Vercel Blob and needs the token. Link the app to the project and copy its variables to `.env.local`:

```bash [Terminal]
vercel link
vercel env pull
pnpm dev
```

Nitro loads `.env` and `.env.local` at dev server start. The store connection must include the **Development** environment, or `vercel env pull` writes no token. The dev server uses the real store, so use a separate dev store for test data.

While the dev server runs, read and write files from another terminal:

```bash [Terminal]
pnpm vitehub blob list --prefix avatars/
pnpm vitehub blob put avatars/ada.png ./ada.png
pnpm vitehub blob get avatars/ada.png --output ./copy.png
```

See [Blob hosts](/docs/blob/hosts#read-and-write-blobs-during-development) for all commands.

## Deploy to Vercel

Vercel deploys Vite and Nitro apps with [zero configuration](https://vercel.com/docs/frameworks/full-stack/vite-with-nitro). Connect the Git repository to a Vercel project, or run `vercel deploy` from the app root. If your configured token matches `BLOB_READ_WRITE_TOKEN`, ViteHub masks it at build time and reads it from that variable at runtime.

## Vercel Blob limits

Some limits come from Vercel and some from the ViteHub driver. Read [Vercel Blob pricing and limits](https://vercel.com/docs/vercel-blob/usage-and-pricing) and [Vercel Functions limits](https://vercel.com/docs/functions/limitations#request-body-size).

- A Vercel Function accepts a request body of at most 4.5 MB. `blob.handleUpload()` sends the file through your function, so keep `ensure.maxSize` under that. A larger request fails with `413`, also in `vite dev` for Vercel. See [Blob limits](/docs/blob/limits-and-errors#limits).
- The [multipart upload](/docs/blob/server-api#multipart-uploads) route also sends each part through your function, and Vercel Blob needs parts of at least 5 MiB (except the last). So on Vercel, a file over 4.5 MB cannot use it either.
- The `vercel-blob` driver does not sign requests, so `blob.sign()` throws `BLOB_R0025`. ViteHub does not wrap Vercel client uploads.
- The driver rejects `customMetadata` with `BLOB_R0011`. [Media records](/docs/blob/media) still work, because they are JSON objects in the same store.
- ViteHub sets `allowOverwrite: true` by default, so a write to an existing pathname replaces the file. The Vercel SDK rejects it by default; set `allowOverwrite: false` to keep that.
- After an overwrite or delete, the Vercel cache can serve the old file for up to 60 seconds.
- A file can be up to 5 TB. Vercel caches files up to 512 MB.
- Operations per minute: Hobby allows 1,200 simple and 900 advanced, Pro 7,200 simple and 4,500 advanced. Each deleted file is one operation.

## Move the same code to another host

Routes that import `blob` stay the same. Change the host, and ViteHub picks the new host's default store:

| Host | Default Blob store |
| --- | --- |
| `cloudflare` | A Cloudflare R2 bucket named after the app, with binding `BLOB`. |
| `netlify` | Netlify Blobs. |
| `node` | Files in `.vitehub/data/blob` on the local disk. |

Run `vitehub provision run --provider cloudflare` to create the R2 bucket. See [Blob hosts](/docs/blob/hosts) for R2, S3, and MinIO setup, and [Blob configuration](/docs/blob/configure#provider-options) for each driver's options.
