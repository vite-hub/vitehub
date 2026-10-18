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

  :::product-feature-item{title="Many storage services" icon="i-lucide-server" to="/docs/blob/configure#provider-options"}
  Use your disk, Cloudflare R2, Vercel Blob, Netlify Blobs, S3, and more. Your routes do not change.
  :::
::
