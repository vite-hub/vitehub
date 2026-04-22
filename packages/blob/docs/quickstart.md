---
title: Quickstart
description: Add Blob storage to a Vite or Nitro server app.
frameworks: [vite, nitro]
---

This quickstart keeps the example small: one route lists blobs and one route writes a blob with a default pathname and value.

::steps

### Install the package

```bash
pnpm add @vitehub/blob
```

### Register Blob

::fw{id="vite:dev vite:build"}
Register the Vite plugin:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubBlob } from '@vitehub/blob/vite'

export default defineConfig({
  plugins: [hubBlob()],
  blob: {},
})
```
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module:

```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/blob/nitro'],
  blob: {},
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

For provider-specific setup, continue with [Cloudflare](./providers/cloudflare) or [Vercel](./providers/vercel).
