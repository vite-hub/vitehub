---
title: Blob quickstart
description: Register Blob, write one local object, list stored objects, and verify the JSON result.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide creates two routes: one writes `notes/example.txt`, and one lists stored blobs. It uses the local `fs` driver so the first setup works without provider credentials.

Files are written under `.data/blob`. The route code stays the same when you later switch to Cloudflare R2 or Vercel Blob.

::code-collapse

```txt [Prompt]
Set up @vitehub/blob in this app.

- Install @vitehub/blob
- Register hubBlob() for Vite or @vitehub/blob/nitro for Nitro
- Configure blob.driver as fs with base .data/blob
- Add a PUT route that writes notes/example.txt with blob.put()
- Add a GET route that returns blob.list({ limit: 10 })
- Verify the PUT response and GET listing

Docs: /docs/vite/blob/quickstart or /docs/nitro/blob/quickstart
```

::

::steps

### Install Blob

```bash
pnpm add @vitehub/blob
```

### Register the Integration

::fw{id="vite:dev vite:build"}
Register the Vite plugin and choose the local filesystem driver:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubBlob } from '@vitehub/blob/vite'

export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    driver: 'fs',
    base: '.data/blob',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module and choose the local filesystem driver:

```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/blob/nitro'],
  blob: {
    driver: 'fs',
    base: '.data/blob',
  },
})
```
::

### Add the Routes

::fw{id="vite:dev vite:build"}
Add a Vite server entry with a write route and a list route:

```ts [src/server.ts]
import { H3, readBody } from 'h3'
import { blob } from '@vitehub/blob'

const app = new H3()

app.put('/api/blob', async (event) => {
  const body = await readBody<{ pathname?: string, value?: string }>(event)

  return await blob.put(
    body.pathname || 'notes/example.txt',
    body.value || 'hello world',
    { contentType: 'text/plain; charset=utf-8' },
  )
})

app.get('/api/blob', async () => {
  return await blob.list({ limit: 10 })
})

export default app
```
::

::fw{id="nitro:dev nitro:build"}
Add a Nitro route that writes one blob:

```ts [server/api/blob.put.ts]
import { defineEventHandler, readBody } from 'h3'
import { blob } from '@vitehub/blob'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ pathname?: string, value?: string }>(event)

  return await blob.put(
    body.pathname || 'notes/example.txt',
    body.value || 'hello world',
    { contentType: 'text/plain; charset=utf-8' },
  )
})
```

Add a second route that lists stored blobs:

```ts [server/api/blob.get.ts]
import { defineEventHandler } from 'h3'
import { blob } from '@vitehub/blob'

export default defineEventHandler(async () => {
  return await blob.list({ limit: 10 })
})
```
::

### Verify the Write

Start the app, then write a blob:

```bash
curl -X PUT http://localhost:3000/api/blob \
  -H 'content-type: application/json' \
  -d '{"pathname":"notes/example.txt","value":"hello world"}'
```

The route returns stored metadata:

```json
{
  "pathname": "notes/example.txt",
  "contentType": "text/plain; charset=utf-8",
  "size": 11,
  "httpEtag": "\"2aae6c35c94fcfb415dbe95f408b9ce91ee846ed\"",
  "uploadedAt": "2026-04-26T12:00:00.000Z",
  "httpMetadata": {
    "contentType": "text/plain; charset=utf-8"
  },
  "customMetadata": {}
}
```

### Verify the Listing

```bash
curl http://localhost:3000/api/blob
```

The route returns a page of blobs:

```json
{
  "blobs": [
    {
      "pathname": "notes/example.txt",
      "contentType": "text/plain; charset=utf-8",
      "size": 11
    }
  ],
  "hasMore": false
}
```

::

## What to Read Next

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Store a blob
  description: Write uploads, JSON bodies, metadata, prefixes, and randomized filenames.
  to: ./guides/store-a-blob
  ---
  :::
  :::u-page-card
  ---
  title: Serve a blob
  description: Return stored objects from H3 routes with content headers.
  to: ./guides/serve-a-blob
  ---
  :::
  :::u-page-card
  ---
  title: Cloudflare
  description: Switch the same route code to Cloudflare R2.
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Switch the same route code to Vercel Blob.
  to: ./providers/vercel
  ---
  :::
::
