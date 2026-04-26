---
title: Cloudflare R2
description: Configure @vitehub/blob to store objects through Cloudflare R2 bindings.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 10
icon: i-simple-icons-cloudflare
frameworks: [vite, nitro]
---

Use the Cloudflare provider when Blob storage should resolve through a Cloudflare R2 bucket.

Cloudflare needs two pieces: an R2 bucket bound to the runtime and Blob config that uses the same binding name.

::steps{level="2"}

## Create and Bind an R2 Bucket

Create an R2 bucket in Cloudflare, then bind it to the Worker or Pages project that runs your app.

ViteHub looks for a binding named `BLOB` by default.

## Configure Blob

::fw{id="vite:dev vite:build"}
Register the Vite plugin and set `blob.driver` to `cloudflare-r2`:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubBlob } from '@vitehub/blob/vite'

export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    driver: 'cloudflare-r2',
    binding: 'BLOB',
    bucketName: 'assets',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module and set `blob.driver` to `cloudflare-r2`:

```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/blob/nitro'],
  blob: {
    driver: 'cloudflare-r2',
    binding: 'BLOB',
    bucketName: 'assets',
  },
})
```
::

## Use a Different Binding Name

Set `binding` when your R2 binding does not use the default `BLOB` name.

```ts
blob: {
  driver: 'cloudflare-r2',
  binding: 'FILES',
  bucketName: 'assets',
}
```

At runtime, the Cloudflare driver reads that binding from the active request environment. If the binding is missing, Blob throws:

```txt
R2 binding "FILES" not found
```

## Generate Cloudflare Output

When `bucketName` is set, ViteHub can emit the R2 bucket binding into generated Cloudflare output.

::fw{id="vite:build"}
Vite builds write a generated `wrangler.json` for the Cloudflare output. The R2 binding is included when Blob resolves a Cloudflare R2 store with `bucketName`.
::

::fw{id="nitro:build"}
The Nitro module adds the R2 bucket to `nitro.options.cloudflare.wrangler.r2_buckets` when Blob resolves a Cloudflare R2 store with `bucketName`.
::

You can also provide the bucket name with an environment variable during config resolution:

```bash
BLOB_BUCKET_NAME=assets
```

`CLOUDFLARE_R2_BUCKET_NAME` is also supported.

## Use Hosting Inference

On Cloudflare hosting, Blob resolves `cloudflare-r2` automatically when no explicit `driver` is configured.

```ts
blob: {
  binding: 'BLOB',
  bucketName: 'assets',
}
```

Cloudflare hosting takes precedence over Vercel Blob environment inference.

::

## Verify the Provider

Call a route that writes a known object:

```bash
curl -X PUT http://localhost:3000/api/blob \
  -H 'content-type: application/json' \
  -d '{"pathname":"notes/cloudflare.txt","value":"stored in r2"}'
```

A successful response includes the R2 object pathname:

```json
{
  "pathname": "notes/cloudflare.txt",
  "contentType": "text/plain; charset=utf-8",
  "size": 12
}
```

## Common Failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `R2 binding "BLOB" not found` | The runtime request environment does not include the configured R2 binding. | Add the binding in Cloudflare or set `blob.binding` to the existing binding name. |
| Generated output has no R2 bucket binding | Blob resolved Cloudflare R2 without `bucketName`. | Set `blob.bucketName`, `BLOB_BUCKET_NAME`, or `CLOUDFLARE_R2_BUCKET_NAME`. |
| Local development writes to `.data/blob` instead of R2 | Hosting inference did not detect Cloudflare. | Set `blob.driver` to `cloudflare-r2` explicitly. |

## Related Pages

- [Quickstart](../quickstart)
- [Store a blob](../guides/store-a-blob)
- [Troubleshooting](../troubleshooting)
