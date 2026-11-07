---
title: Upload your first Blob object
description: Upload a text file to local Blob storage, then retrieve its contents through an API route.
navigation.title: Get started
layout: tutorial
codePanel: true
navigation.order: 2
icon: i-lucide-rocket
---

You add two API routes to your app. One saves a text file, and one reads it back. At the end, `curl` prints `Hello from ViteHub` from storage.

You need:

- Node.js 22.22 or newer
- pnpm
- the app from [Installation](/docs/getting-started/installation). Run all commands from its root folder.

You do not need a cloud account. On your computer, Blob saves files in the `.vitehub/data/blob` folder.

::tutorial-step{title="Enable Blob"}
## Enable Blob

Add `blob: true` to the `vitehub()` options in `vite.config.ts`. Keep the other features and plugins of your app.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ preset: 'node', blob: true })],
})
```

`preset: 'node'` tells ViteHub that the app runs on a Node.js server. With this preset, Blob keeps files on your disk.

If you use Nuxt, add `blob: true` to the options of the `vite-hub/nuxt` module. The routes below work in Nuxt too.

::

::tutorial-step{title="Accept a text upload"}
## Accept a text upload

Create `server/api/files.post.ts`. The file name makes it the `POST /api/files` route. The route saves the request body as `hello.txt`. A second upload replaces the first one.

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

`blob.put()` saves the file. It returns `[error, object]`. If the save fails, `error` is set. If it works, `object` describes the saved file: its path, type, and size. The route returns only these three fields.

::

::tutorial-step{title="Read the file"}
## Read the file

Create `server/api/files.get.ts`. It is the `GET /api/files` route, and it reads `hello.txt`.

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

`blob.get()` returns `[error, file]`. `file` is a standard `Blob`, and `.text()` reads its content as text. If no file has the name `hello.txt`, `file` is `null`, and the route sends a `404` response.

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start the app. If it already runs, restart it, so it reads the new config:

```bash [commands/start]
pnpm dev
```

In another terminal, create a text file. `printf` does not add a new line at the end, so the file is exactly 18 bytes:

```bash [commands/file]
printf 'Hello from ViteHub' > hello.txt
```

Send the file as the request body:

```bash [commands/request]
curl -X POST http://localhost:3000/api/files \
  -H 'content-type: text/plain' \
  --data-binary @hello.txt
```

You see:

```json [output/response.json]
{ "pathname": "hello.txt", "contentType": "text/plain", "size": 18 }
```

This proves that Blob saved all 18 bytes as `hello.txt`. Now read the file:

```bash [commands/read]
curl http://localhost:3000/api/files
```

You see:

```text [output/file.txt]
Hello from ViteHub
```

This proves that the second request reads the file from storage. The file stays on disk when you stop the app. Restart `pnpm dev` and send only the GET request to check it.

> [!NOTE]
> Anyone who can reach these routes can upload and read files. Before real users can upload, add access checks and size limits.

::

## Next steps

- [Upload files](/docs/blob/server-api#upload-files): accept file uploads from an HTML form.
- [Hosts](/docs/blob/hosts): keep files in cloud storage, such as Cloudflare R2 or S3, so every copy of your app sees the same files.
