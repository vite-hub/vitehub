---
title: Vercel Blob
description: Configure @vitehub/blob to store objects through Vercel Blob.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 20
icon: i-simple-icons-vercel
frameworks: [vite, nitro]
---

Use the Vercel provider when Blob storage should resolve through Vercel Blob.

Vercel needs a `BLOB_READ_WRITE_TOKEN` available at runtime.

::steps{level="2"}

## Install Blob

```bash
pnpm add @vitehub/blob files-sdk
```

## Add the Runtime Token

Set the token in the environment where the app runs:

```bash [.env]
BLOB_READ_WRITE_TOKEN=<blob-read-write-token>
```

ViteHub masks this value in generated build output and rehydrates it from `BLOB_READ_WRITE_TOKEN` at runtime.

## Configure Blob

::fw{id="vite:dev vite:build"}
Register the Vite plugin and set `blob.driver` to `vercel-blob`:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubBlob } from '@vitehub/blob/vite'

export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    driver: 'vercel-blob',
    access: 'public',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module and set `blob.driver` to `vercel-blob`:

```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/blob/nitro'],
  blob: {
    driver: 'vercel-blob',
    access: 'public',
  },
})
```
::

## Use Hosting or Token Inference

If `BLOB_READ_WRITE_TOKEN` is available, Blob resolves `vercel-blob` automatically. Vercel hosting also resolves `vercel-blob` when no higher-priority Cloudflare hosting signal is present.

You can keep config minimal:

```ts
blob: {}
```

Or omit the `blob` key after registering the integration.

## Configure Access

`access` defaults to `public`.

```ts
blob: {
  driver: 'vercel-blob',
  access: 'private',
}
```

Use `access: 'private'` when the connected store requires private writes.

::

## Verify the Provider

Call a route that writes a known object:

```bash
curl -X PUT http://localhost:3000/api/blob \
  -H 'content-type: application/json' \
  -d '{"pathname":"notes/vercel.txt","value":"stored in vercel blob"}'
```

A successful response includes the Vercel Blob pathname and may include a provider URL:

```json
{
  "pathname": "notes/vercel.txt",
  "contentType": "text/plain; charset=utf-8",
  "size": 21,
  "url": "https://..."
}
```

## Common Failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Missing runtime environment variable \`BLOB_READ_WRITE_TOKEN\` for Vercel Blob.` | The build config resolved Vercel Blob, but the runtime token is missing. | Set `BLOB_READ_WRITE_TOKEN` and restart or redeploy. |
| Vercel hosting warns that `fs` is configured | Vercel hosting requires Vercel Blob-backed storage. | Remove explicit `fs` config or set `blob.driver` to `vercel-blob`. |

## Related Pages

- [Quickstart](../quickstart)
- [Store a blob](../guides/store-a-blob)
- [Troubleshooting](../troubleshooting)
