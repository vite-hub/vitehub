---
title: Use Vercel Blob in a Vite app with ViteHub
description: Use Vercel Blob from a Vite app with ViteHub. Upload, read, list, and serve files with blob.put() and blob.get(), and move the same code to R2 or disk.
navigation.title: Vercel Blob
navigation.order: 15
navigation.group: Storage
icon: i-simple-icons-vercel
---

To use Vercel Blob from a Vite app, set `preset: 'vercel'` and `blob: true` in `vitehub()`, and connect a Blob store to the Vercel project. ViteHub then selects the `vercel-blob` driver, and server code reads and writes files with `blob` from `vite-hub/blob`. You do not install `@vercel/blob`. ViteHub bundles it in the driver.

## What Vercel Blob is

[Vercel Blob](https://vercel.com/docs/vercel-blob) is the object storage of the Vercel platform. It keeps files such as uploads, images, and exports in a store. A store is private or public, and you cannot change that after you create it. A public store gives each file a URL that anyone with the link can open. A private store needs a token for every read. Each store lives in one region. Vercel Blob is available on all plans.

ViteHub uses the Vercel SDK inside the `vercel-blob` driver. Your code calls the same `blob` API that it calls on Cloudflare R2, Netlify Blobs, S3, or the local disk.

## Set up Vercel Blob

### Enable Blob with the Vercel preset

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'vercel', blob: true })],
})
```

`blob: true` on the `vercel` preset selects `driver: 'vercel-blob'` with `access: 'public'`. For a private store, set the driver and the access mode yourself:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'vercel',
      blob: { driver: 'vercel-blob', access: 'private' },
    }),
  ],
})
```

Set `access` to the access mode of your Vercel store. Read [Vercel Blob options](/docs/blob/configure#vercel-blob) for `allowOverwrite`, `downloadTimeoutMs`, and `token`.

### Create the store and connect it

On Vercel, ViteHub authenticates with [OIDC](https://vercel.com/docs/vercel-blob#oidc-access-by-default). When you connect a store to a project, Vercel adds `BLOB_STORE_ID`, and each deployment gets a short-lived `VERCEL_OIDC_TOKEN`. The project needs no long-lived secret.

ViteHub picks credentials at runtime in this order:

1. A `token` that you set in the `vercel-blob` store config.
2. OIDC, when `BLOB_STORE_ID` is set. The Vercel SDK reads the OIDC token itself.
3. `BLOB_READ_WRITE_TOKEN`, for code that runs off Vercel, such as a CI job or another host. With `BLOB_STORE_ID` set and no OIDC token, the SDK also falls back to this token.

When neither `BLOB_STORE_ID` nor `BLOB_READ_WRITE_TOKEN` is set at runtime, ViteHub throws `BLOB_C0009`.

`vite dev` uses the local `fs` store when it infers Vercel Blob from these variables or from the Vercel preset, so development writes do not change the real store. To use the real store in `vite dev`, set `remote: true` on the store, or set `driver: 'vercel-blob'`, then run `vercel env pull` once. The SDK refreshes the OIDC token with your Vercel CLI login. Read [Use the real store in development](/docs/blob/configure#use-the-real-store-in-development).

Create the store in one of two ways:

- In the Vercel dashboard, open the project's **Storage** page and create a Blob store. Or run `vercel blob create-store <name> --access private --yes` from the linked project directory. See [Server uploads with Vercel Blob](https://vercel.com/docs/vercel-blob/server-upload).
- With ViteHub, run the Vercel Provision Step. It creates a store named `vitehub-blob` in `iad1` with your `access` mode, and connects it to the production, preview, and development environments of the project. The connection gives the project `BLOB_STORE_ID`. When an older connection has only `BLOB_READ_WRITE_TOKEN`, the step warns and keeps the connection. Reconnect the store in the Vercel dashboard to use OIDC.

```bash [Terminal]
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel --dry-run
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel
```

Add `VERCEL_TEAM_ID` or `VERCEL_ORG_ID` when the token needs a team scope. Read [Provisioning](/docs/development/provisioning).

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

`blob.handleUpload()` checks the size and type of each file, then saves it. Every Blob method returns `[error, value]`. On a public store, the saved object has a `url` that the browser can open. See [Blob server API](/docs/blob/server-api) for `put()`, `list()`, `del()`, and `head()`.

### Serve files from a private store

A private store has no public URL. Set `serve` to add a route that streams files through your app:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'vercel',
      blob: {
        driver: 'vercel-blob',
        access: 'private',
        serve: { route: '/files' },
      },
    }),
  ],
})
```

`/files/avatars/ada.png` now returns `avatars/ada.png` from the store. The serve route is public by default. Set `serve.authorize: true` to require a signed-in [Auth](/docs/auth) session. Read [Serve blob-backed assets](/docs/blob/configure#serve-blob-backed-assets) and [Protect served objects](/docs/blob/configure#protect-served-objects).

## How to use Vercel Blob locally

With the `vercel` preset, the dev server also uses Vercel Blob, so it needs the token. Link the app to the Vercel project, then copy the project variables to `.env.local`:

```bash [Terminal]
vercel link
vercel env pull
pnpm dev
```

Nitro loads `.env` and `.env.local` when the dev server starts. The store connection must include the **Development** environment, or `vercel env pull` does not write the token. The dev server reads and writes the real store, so use a separate store for development when you need test data.

While the dev server runs, read and write files from another terminal:

```bash [Terminal]
pnpm vitehub blob list --prefix avatars/
pnpm vitehub blob put avatars/ada.png ./ada.png
pnpm vitehub blob get avatars/ada.png --output ./copy.png
```

Read [Blob hosts](/docs/blob/hosts#read-and-write-blobs-during-development) for every command.

## Deploy to Vercel

Vercel deploys Vite and Nitro apps with [zero configuration](https://vercel.com/docs/frameworks/full-stack/vite-with-nitro). Connect the Git repository to a Vercel project, or run `vercel deploy` from the app root. ViteHub masks a configured token that matches `BLOB_READ_WRITE_TOKEN` at build time, and reads it from that variable again at runtime.

## Vercel Blob limits

Some limits come from Vercel, and some come from the ViteHub driver. Read [Vercel Blob pricing and limits](https://vercel.com/docs/vercel-blob/usage-and-pricing) and [Vercel Functions limits](https://vercel.com/docs/functions/limitations#request-body-size).

- A Vercel Function accepts a request body of at most 4.5 MB. `blob.handleUpload()` sends the file through your function, so keep `ensure.maxSize` under that limit. A larger request fails with `413`.
- The [multipart upload](/docs/blob/server-api#multipart-uploads) route also sends each part through your function. Vercel Blob needs parts of at least 5 MiB, except the last one. On Vercel, a file larger than 4.5 MB therefore cannot use this route either.
- The `vercel-blob` driver does not sign requests, so `blob.sign()` throws `BLOB_R0025`. ViteHub does not wrap Vercel client uploads.
- The driver rejects `customMetadata` with `BLOB_R0011`. [Media records](/docs/blob/media) still work, because ViteHub stores them as JSON objects in the same store.
- ViteHub sets `allowOverwrite: true` by default, so a write to an existing pathname replaces the file. The Vercel SDK rejects that write by default. Set `allowOverwrite: false` to keep the Vercel behavior.
- After an overwrite or a delete, the Vercel cache can serve the old file for up to 60 seconds.
- A file can be up to 5 TB. Vercel caches files up to 512 MB.
- Vercel limits operations per minute. Hobby allows 1,200 simple and 900 advanced operations. Pro allows 7,200 simple and 4,500 advanced operations. Each deleted file counts as one operation.

## Move the same code to another host

Routes that import `blob` from `vite-hub/blob` stay the same. Change the preset, and ViteHub selects the default store of the new host:

| Preset | Default Blob store |
| --- | --- |
| `cloudflare` | A Cloudflare R2 bucket named after the application, with binding `BLOB`. |
| `netlify` | Netlify Blobs. |
| `node` | Files in `.vitehub/data/blob` on the local disk. |

Run `vitehub provision run --provider cloudflare` to create the R2 bucket. Read [Blob hosts](/docs/blob/hosts) for R2, S3, and MinIO setup, and [Blob configuration](/docs/blob/configure#provider-options) for the options of each driver.
