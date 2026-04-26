---
title: Blob troubleshooting
description: Diagnose disabled runtime config, missing Cloudflare R2 bindings, missing Vercel tokens, failed lookups, and upload validation errors.
navigation.title: Troubleshooting
navigation.order: 100
icon: i-lucide-wrench
frameworks: [vite, nitro]
---

Use this page by symptom. Each section gives the likely cause, the fix, and a quick verification step.

## `Blob runtime is disabled.`

**Cause:** Blob runtime config resolved to `false`, or the integration was not registered.

**Fix:** Register the Vite plugin or Nitro module and avoid setting `blob: false` unless you intentionally want to disable Blob.

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    driver: 'fs',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/blob/nitro'],
  blob: {
    driver: 'fs',
  },
})
```
::

**Verify:** Call a route that returns `await blob.list()`.

## `R2 binding "BLOB" not found`

**Cause:** Blob is using the Cloudflare R2 driver, but the runtime request environment does not include the configured binding.

**Fix:** Add an R2 binding named `BLOB`, or set `blob.binding` to the binding name you already use.

```ts
blob: {
  driver: 'cloudflare-r2',
  binding: 'FILES',
  bucketName: 'assets',
}
```

**Verify:** Call the route inside the Cloudflare runtime where the binding exists.

## Generated Cloudflare Output Has No R2 Bucket

**Cause:** Blob resolved Cloudflare R2, but no `bucketName` was available during config resolution.

**Fix:** Set `bucketName` in config, or set `BLOB_BUCKET_NAME` or `CLOUDFLARE_R2_BUCKET_NAME` before building.

```bash
BLOB_BUCKET_NAME=assets pnpm build
```

**Verify:** Inspect the generated Cloudflare output for an R2 bucket binding.

## `Missing runtime environment variable \`BLOB_READ_WRITE_TOKEN\` for Vercel Blob.`

**Cause:** Blob resolved `vercel-blob`, but the runtime did not provide `BLOB_READ_WRITE_TOKEN`.

**Fix:** Set the token in the environment where the app runs.

```bash
BLOB_READ_WRITE_TOKEN=<blob-read-write-token>
```

**Verify:** Restart the app or redeploy, then call a route that writes with `blob.put()`.

## `Cannot find package '@vercel/blob'`

**Cause:** The Vercel Blob driver imports the optional `@vercel/blob` peer dependency at runtime.

**Fix:** Install the provider SDK.

```bash
pnpm add @vercel/blob
```

**Verify:** Restart the app and retry the route.

## `Blob not found`

**Cause:** `blob.head()` did not find the pathname. Unlike `blob.get()`, `head()` throws a `404` for missing objects.

**Fix:** Use `blob.get()` when missing objects are part of normal control flow.

```ts
const file = await blob.get(pathname)

if (!file) {
  throw createError({ statusCode: 404, statusMessage: 'File not found' })
}
```

**Verify:** List the prefix that should contain the object and compare the returned `pathname` values.

## `File not found`

**Cause:** `blob.serve()` could not load the requested object body.

**Fix:** Validate the pathname passed to `serve()` and confirm the object exists with `blob.list()` or `blob.get()`.

**Verify:** Call `blob.get(pathname)` from the same route or runtime.

## `ensureBlob() requires at least one of maxSize or types to be set.`

**Cause:** `ensureBlob()` was called without validation rules.

**Fix:** Pass `maxSize`, `types`, or both.

```ts
ensureBlob(file, {
  maxSize: '1MB',
  types: ['image'],
})
```

**Verify:** Upload a valid file and confirm the route reaches `blob.put()`.

## Vercel Hosting Warns About `fs`

**Cause:** Vercel hosting requires Vercel Blob-backed storage, but Blob resolved the `fs` driver.

**Fix:** Set `BLOB_READ_WRITE_TOKEN` or configure `blob.driver` as `vercel-blob`.

```ts
blob: {
  driver: 'vercel-blob',
}
```

**Verify:** Restart or rebuild. The warning should disappear.

## Related Pages

- [Quickstart](./quickstart)
- [Cloudflare](./providers/cloudflare)
- [Vercel](./providers/vercel)
- [Runtime API](./runtime-api)
