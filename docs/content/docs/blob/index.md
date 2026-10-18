---
title: Blob
navigation.title: Overview
description: Save uploads and other files from your server, then read or serve them with the same code on every host.
navigation.order: 1
icon: i-lucide-files
---

::product-hero{tagline="Save uploads and other files from your server, then read or serve them on any host." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::product-files
  ```ts [vite.config.ts]
  import { nitro } from 'nitro/vite'
  import { defineConfig } from 'vite'
  import { vitehub } from 'vite-hub'

  export default defineConfig({
    plugins: [
      // On Node, files are saved in .vitehub/data/blob
      vitehub({ preset: 'node', blob: true }),
      nitro() as never,
    ],
  })
  ```

  ```bash [Terminal]
  pnpm vitehub blob list --prefix avatars/
  pnpm vitehub blob head avatars/ada.png --json
  pnpm vitehub blob put avatars/ada.png ./ada.png
  pnpm vitehub blob get avatars/ada.png --output ./copy.png
  pnpm vitehub blob del avatars/ada.png
  pnpm vitehub blob media avatars/ada.png
  ```
  :::
::

::product-features
  :::product-feature-item{title="Save any file" icon="i-lucide-file-up" to="/docs/blob/server-api#use-it-at-runtime"}
  Save text, bytes, or streams with `blob.put()`. Add a content type and your own metadata.
  :::

  :::product-feature-item{title="Uploads in one call" icon="i-lucide-shield-check" to="/docs/blob/server-api#upload-files"}
  `blob.handleUpload()` checks the size and type of each file before it saves anything.
  :::

  :::product-feature-item{title="Upload from a Vue page" icon="i-lucide-upload" to="/docs/blob/server-api#upload-files"}
  `useUpload()` sends the files from an input to your upload route.
  :::

  :::product-feature-item{title="Large files in parts" icon="i-lucide-layers" to="/docs/blob/server-api#multipart-uploads"}
  Send a big file in parts. The server joins them when the upload is complete.
  :::

  :::product-feature-item{title="Links that expire" icon="i-lucide-link" to="/docs/blob/server-api#signed-requests"}
  `blob.sign()` makes a short-lived link to read or upload one private file.
  :::

  :::product-feature-item{title="Images with alt text, crops, and variants" icon="i-lucide-image" to="/docs/blob/media"}
  Media records, folders, `?w=640` variants, and `<picture>` art direction on every driver.
  :::

  :::product-feature-item{title="Metadata travels with objects" icon="i-lucide-tag" to="/docs/blob/server-api"}
  Set content type and custom metadata while storing the object.
  :::
::
