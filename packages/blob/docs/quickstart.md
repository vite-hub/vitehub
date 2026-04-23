---
title: Quickstart
description: Add Blob storage to a Vite server app.
frameworks: vite
---

Install the package:

```bash
pnpm add @vitehub/blob
```

Register the Vite plugin:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubBlob } from '@vitehub/blob/vite'

export default defineConfig({
  plugins: [hubBlob()],
  blob: {},
})
```

Use the runtime handle from your server app:

```ts [src/server.ts]
import { H3, readBody } from 'h3'
import { blob } from '@vitehub/blob'

const app = new H3()

app.put('/api/blob', async (event) => {
  const body = await readBody<{ pathname?: string, value?: string }>(event)
  return await blob.put(body?.pathname || 'notes/hello.txt', body?.value || 'hello world')
})

export default app
```

For provider-specific setup, continue with [Cloudflare](./providers/cloudflare) or [Vercel](./providers/vercel).
