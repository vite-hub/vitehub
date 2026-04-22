---
title: Vercel Blob
description: Configure @vitehub/blob for Vercel using Vercel Blob storage.
navigation.title: Vercel
frameworks: vite
---

Use the Vercel path when your Vite app deploys to Vercel and Blob storage should resolve through `BLOB_READ_WRITE_TOKEN`.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubBlob } from '@vitehub/blob/vite'

export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    driver: 'vercel-blob',
  },
})
```

Required environment variable:

```bash [.env]
BLOB_READ_WRITE_TOKEN=<blob-read-write-token>
```

Notes:

- if you omit explicit config, Vercel hosting resolves `vercel-blob` automatically
- build output masks the token and the runtime rehydrates it from `BLOB_READ_WRITE_TOKEN`
- Vercel Blob files are public with this package release
