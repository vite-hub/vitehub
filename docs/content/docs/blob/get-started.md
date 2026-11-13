---
title: Upload your first Blob object
description: Upload a text file to local Blob storage, then retrieve its contents through an API route.
navigation.title: Get started
layout: tutorial
codePanel: true
navigation.order: 2
icon: i-lucide-rocket
---

Blob stores files, such as images, PDFs, or text files. You save a file under a name, and you read it back later by that name.

In this tutorial, you make one API route that uploads `hello.txt` and one that reads it back. The read returns `Hello from ViteHub`.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run the commands from the root of the app. You need no account and no API key. On your computer, Blob saves files in the `.vitehub/data/blob` folder.

::tutorial-step{title="Enable Blob"}
## Enable Blob

Install the Blob package in the app:

```bash pm [commands/install-blob]
pnpm add @vite-hub/blob
```

Add `blob: true` to the ViteHub options in `nuxt.config.ts` or `vite.config.ts`. Keep any other enabled features and plugins.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', blob: true },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ host: 'node', blob: true }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ host: 'node', blob: true })],
})
```
::::
:::

::

::tutorial-step{title="Accept a text upload"}
## Accept a text upload

Create `server/api/files.post.ts`. This file is the route `POST /api/files`. It saves the text of the request as `hello.txt`.

```ts [server/api/files.post.ts]
import { createError, defineEventHandler, readRawBody } from 'h3'
import { blob } from 'vite-hub/blob'

export default defineEventHandler(async (event) => {
  const text = await readRawBody(event)
  if (!text) {
    throw createError({ statusCode: 400, message: 'Send a text file in the request body.' })
  }

  const [error, object] = await blob.put('hello.txt', text, {
    contentType: 'text/plain',
  })
  if (error) throw error
  return {
    pathname: object.pathname,
    contentType: object.contentType,
    size: object.size,
  }
})
```

- `blob.put()` saves the file. If `hello.txt` exists, the new upload replaces it.
- `blob.put()` returns `[error, object]`. Check `error` for storage failures. Invalid arguments and configuration errors can throw.
- `object` describes the saved file. The route returns its name, type, and size.

::

::tutorial-step{title="Retrieve the file"}
## Retrieve the file

Create `server/api/files.get.ts`. This route reads `hello.txt` and returns its text.

```ts [server/api/files.get.ts]
import { createError, defineEventHandler, setResponseHeader } from 'h3'
import { blob } from 'vite-hub/blob'

export default defineEventHandler(async (event) => {
  const [error, file] = await blob.get('hello.txt')
  if (error) throw error
  if (file === null) {
    throw createError({ statusCode: 404, message: 'Upload hello.txt first.' })
  }

  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return file.text()
})
```

- `blob.get()` returns `[error, file]`. `file` is a standard `Blob`, or `null` when no file has that name.
- `file.text()` reads the content as text.
- When the file is missing, the route returns `404`.

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start or restart the app after the config change:

```bash [commands/start]
pnpm dev
```

Open a second terminal. Create a test file:

```bash [commands/file]
printf 'Hello from ViteHub' > hello.txt
```

Upload it:

```bash [commands/request]
curl -X POST http://localhost:3000/api/files \
  -H 'content-type: text/plain' \
  --data-binary @hello.txt
```

The response shows the name, the type, and the size of the saved file:

```json [output/response.json]
{ "pathname": "hello.txt", "contentType": "text/plain", "size": 18 }
```

Read the file back:

```bash [commands/read]
curl http://localhost:3000/api/files
```

The response is the text of the file:

```text [output/file.txt]
Hello from ViteHub
```

The file stays after a restart. To check it, restart `pnpm dev` and run only the read request again.

::


## Before you go live

These routes let anyone upload. Before real users can upload, add access checks and upload limits.

## Next steps

::card-group
:::card{title="Upload files" icon="i-lucide-upload" to="/docs/blob/server-api#upload-files"}
Accept form uploads and check file type and size.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/blob/hosts"}
Store files in R2 or S3, so that all app instances share them.
:::
::
