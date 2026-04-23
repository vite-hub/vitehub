---
title: Blob quickstart
description: Read and write a first blob with the local filesystem driver.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-rocket
frameworks: [vite, nitro]
---

This quickstart uses the local `fs` driver so you can get Blob working with the least setup first. Files are stored in `.data/blob`.

::steps

### Install the package

```bash
pnpm add @vitehub/blob
```

### Register Blob

::fw{id="vite:dev vite:build"}
The Vite plugin is the Blob config primitive:

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
Register the Nitro module with the same local driver:

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

### Add a list route

::fw{id="vite:dev vite:build"}
```ts [src/server.ts]
import { H3, readBody } from 'h3'
import { blob } from '@vitehub/blob'

const app = new H3()

app.get('/api/blob', async () => await blob.list({ limit: 10 }))
app.put('/api/blob', async (event) => {
  const body = await readBody<{ pathname?: string, value?: string }>(event)
  return await blob.put(body?.pathname || 'notes/example.txt', body?.value || 'hello world')
})

export default app
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/api/blob.get.ts]
import { defineEventHandler } from 'h3'

import { blob } from '@vitehub/blob'

export default defineEventHandler(async () => await blob.list({ limit: 10 }))
```
::

### Add a write route

::fw{id="nitro:dev nitro:build"}
```ts [server/api/blob.put.ts]
import { defineEventHandler, readBody } from 'h3'

import { blob } from '@vitehub/blob'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ pathname?: string, value?: string }>(event)
  return await blob.put(body?.pathname || 'notes/example.txt', body?.value || 'hello world')
})
```
::

### Run the example

::fw{id="vite:dev vite:build"}
Start your Vite server and call the route:

```bash
pnpm vite
curl http://localhost:3000/api/blob
curl -X PUT http://localhost:3000/api/blob \
  -H 'content-type: application/json' \
  -d '{"pathname":"notes/example.txt","value":"hello world"}'
```
::

::fw{id="nitro:dev nitro:build"}
Start Nitro and call the routes:

```bash
pnpm nitro dev
curl http://localhost:3000/api/blob
curl -X PUT http://localhost:3000/api/blob \
  -H 'content-type: application/json' \
  -d '{"pathname":"notes/example.txt","value":"hello world"}'
```
::

::

## What to read next

- Use [Usage](./usage) for pagination, metadata, `blob.serve()`, and delete patterns.
- Use [Runtime API](./runtime-api) to review the shared handle, config shapes, and helper types.
- Use [Cloudflare](./providers/cloudflare) or [Vercel](./providers/vercel) when you want hosted Blob storage instead of local files.
