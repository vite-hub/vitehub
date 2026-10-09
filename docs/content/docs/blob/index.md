---
title: Blob
navigation.title: Overview
description: Store uploads, generated files, binary objects, and metadata with one object-storage API.
navigation.order: 1
icon: i-lucide-files
---

::product-hero{tagline="One object-storage import for uploads and generated files across local and hosted object stores." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::code-group
  ```ts [server/api/upload.post.ts]
  import { blob } from '@vite-hub/blob'

  export default defineEventHandler(async (event) => {
    // Authorize the request here. The route decides who may upload.
    const [error, objects] = await blob.handleUpload(event, {
      formKey: 'files',
      ensure: { maxSize: '8MB', types: ['image'] },
      put: { prefix: 'avatars', addRandomSuffix: true },
    })
    if (error) throw error
    return objects
  })
  ```

  ```ts [vite.config.ts]
  import { hubBlob } from '@vite-hub/blob/vite'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [hubBlob()],
    blob: {
      stores: {
        default: { driver: 'fs' },
        reports: { driver: 'vercel-blob', access: 'private' },
      },
    },
  })
  ```

  ```ts [server/agents/publisher.ts]
  import { defineAgent } from 'vite-hub/agent'
  import { blob } from 'vite-hub/agent/capabilities'

  export default defineAgent({
    capabilities: [
      blob({ assetPaths: ['artifacts'], mode: 'write', policy: 'deny' }),
    ],
  })
  ```

  ```bash [Terminal]
  pnpm vitehub blob list --prefix avatars/
  pnpm vitehub blob head avatars/ada.png --json
  pnpm vitehub blob put avatars/ada.png ./ada.png
  pnpm vitehub blob get avatars/ada.png --output ./copy.png
  pnpm vitehub blob del avatars/ada.png
  ```
  :::
::


::product-features
  :::product-feature-item{title="Every method returns an error and a value" icon="i-lucide-code-2" to="/docs/blob/server-api"}
  `put`, `get`, `head`, `list`, `del`, and `sign` return `[error, value]`.
  :::

  :::product-feature-item{title="Validate and store uploads in one call" icon="i-lucide-shield-check" to="/docs/blob/server-api#upload-files"}
  `blob.handleUpload()` checks size and type before anything is stored.
  :::

  :::product-feature-item{title="Pick a driver per store, keep the import" icon="i-lucide-sliders-horizontal" to="/docs/blob/configure"}
  Set `driver` for S3 or Azure; otherwise the host selects it.
  :::

  :::product-feature-item{title="An Agent can publish the files it creates" icon="i-lucide-bot" to="/docs/blob/agent-capability"}
  `assetPaths` publishes linked files and rewrites the links to public URLs.
  :::

  :::product-feature-item{title="Objects from a terminal" icon="i-lucide-terminal" to="/docs/blob/hosts"}
  Run Blob commands against the Vite Development Server.
  :::

  :::product-feature-item{title="Metadata travels with objects" icon="i-lucide-tag" to="/docs/blob/server-api"}
  Set content type and custom metadata while storing the object.
  :::
::
