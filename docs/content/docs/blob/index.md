---
title: Blob
layout: landing
navigation.title: Overview
description: Save uploads and other files from your server, then read or serve them with the same code on every host.
navigation.order: 1
icon: i-lucide-files
---

::product-hero{tagline="Save uploads and other files from your server, then read or serve them on any host." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :hero-figure{name="blob"}
::

::code-tree{feature="blob"}
:::framework{name="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    // On Node, files are saved in .vitehub/data/blob
    blob: true,
  },
})
```
:::
:::framework{name="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      // On Node, files are saved in .vitehub/data/blob
      blob: true,
    }),
    nitro(),
  ],
})
```
:::
:::framework{name="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      // On Node, files are saved in .vitehub/data/blob
      blob: true,
    }),
  ],
})
```
:::

```ts [server/api/avatars.post.ts]
import { defineEventHandler } from 'h3'
import { blob } from 'vite-hub/blob'

// Check who may upload before this call
export default defineEventHandler(async (event) => {
  const [error, files] = await blob.handleUpload(
    event,
    {
      formKey: 'files',
      ensure: { maxSize: '8MB', types: ['image'] },
      put: { prefix: 'avatars', addRandomSuffix: true },
    },
  )
  if (error) throw error
  return files
})
```

```vue [app/pages/upload.vue]
<script setup lang="ts">
import { useUpload } from 'vite-hub/blob/vue'

// Send one file to the upload route
const upload = useUpload('/api/avatars', {
  multiple: false,
})

async function onChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = await upload(input)
  console.log(file?.pathname)
}
</script>

<template>
  <input
    type="file"
    accept="image/*"
    @change="onChange"
  >
</template>
```

```ts [server/api/notes.post.ts]
import { defineEventHandler } from 'h3'
import { blob } from 'vite-hub/blob'

// Save text as a file and return its details
export default defineEventHandler(async () => {
  const [error, file] = await blob.put(
    'notes/hello.txt',
    'Hello from ViteHub',
    { contentType: 'text/plain' },
  )
  if (error) throw error
  return file
})
```
::

::product-features
  :::product-feature-item{title="Save any file" icon="i-lucide-file-up" to="/docs/blob/server-api#use-it-at-runtime"}
  Save text, bytes, or streams with `blob.put()`, with a content type and your own metadata.
  :::

  :::product-feature-item{title="Uploads in one call" icon="i-lucide-shield-check" to="/docs/blob/server-api#upload-files"}
  `blob.handleUpload()` checks each file's size and type before it saves anything.
  :::

  :::product-feature-item{title="Upload from a Vue page" icon="i-lucide-upload" to="/docs/blob/server-api#upload-files"}
  `useUpload()` sends the files from an input to your upload route.
  :::

  :::product-feature-item{title="Large files in parts" icon="i-lucide-layers" to="/docs/blob/server-api#multipart-uploads"}
  Send a big file in parts. The server joins them at the end.
  :::

  :::product-feature-item{title="Links that expire" icon="i-lucide-link" to="/docs/blob/server-api#signed-requests"}
  `blob.sign()` makes a short-lived link to read or upload a private file.
  :::

  :::product-feature-item{title="Images with alt text, crops, and variants" icon="i-lucide-image" to="/docs/blob/media"}
  Media records, folders, `?w=640` variants, and `<picture>` art direction on every driver.
  :::

  :::product-feature-item{title="Many storage services" icon="i-lucide-server" to="/docs/blob/configure#provider-options"}
  Use your disk, Cloudflare R2, Vercel Blob, Netlify Blobs, S3, and more, with the same routes.
  :::
::

::agent-only{skill="blob"}
Use Blob for binary objects such as uploads, generated files, images, and exports. Turn Blob on with `vitehub add blob`, and pass `--option blob.driver=<driver>` where the host needs an explicit driver. Use the same Blob handle in application code when moving between local and hosted storage.

Keep object keys and authorization in application code. `serve` needs `public: true`, which sends every object of the served store to anyone, or `authorize: true`, which requires an authenticated session. `put()` has no per-object `access`. Treat filesystem Blob storage as one-host storage.

Prove upload, read, list, and delete with the selected driver. For hosted output, inspect the generated binding and verify access rules with a real request.
::
