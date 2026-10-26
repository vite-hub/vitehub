---
title: Upload your first Blob object
description: Upload a text file to local Blob storage, then retrieve its contents through an API route.
navigation.title: Get started
layout: tutorial
codePanel: true
navigation.order: 2
icon: i-lucide-rocket
---

Upload `hello.txt`, then fetch its contents in a separate request. The upload returns object metadata. The read returns `Hello from ViteHub` from storage.

Start with the working app from [Installation](/docs/getting-started/installation). Use its Node.js, pnpm, Vite, Nitro, and H3 setup, and run commands from the app root. The Node preset uses the local `fs` driver under `.vitehub/data/blob`. No provider account is required.

::tutorial-step{title="Enable Blob"}
## Enable Blob

Add `blob: true` to the existing `vitehub()` options in `vite.config.ts`. Keep any other enabled features and plugins.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ preset: 'node', blob: true })],
})
```

If you chose Nuxt in Installation, add `blob: true` to the options of the existing `vite-hub/nuxt` module. The routes below also work there. They use explicit H3 imports and upload a plain text request body.

::

::tutorial-step{title="Accept a text upload"}
## Accept a text upload

Create `server/api/files.post.ts`. Nitro maps it to `POST /api/files`. This tutorial stores a UTF-8 text body at the fixed pathname `hello.txt`; another upload replaces it.

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

`blob.put()` returns `[error, object]`. The object describes the stored bytes. This route returns just the fields used in the check below.

::

::tutorial-step{title="Retrieve the file"}
## Retrieve the file

Create `server/api/files.get.ts` to read `hello.txt` without writing it again.

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

`blob.get()` returns `[error, Blob | null]`. The `Blob` holds the file body, and `.text()` reads it as UTF-8. A missing object returns `null`; the route turns it into a `404` response.

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start or restart the app after the config change:

```bash [commands/start]
pnpm dev
```

In another terminal, create a file without a trailing newline:

```bash [commands/file]
printf 'Hello from ViteHub' > hello.txt
```

Upload it as the request body:

```bash [commands/request]
curl -X POST http://localhost:3000/api/files \
  -H 'content-type: text/plain' \
  --data-binary @hello.txt
```

The response reports the stored pathname, content type, and 18-byte size:

```json [output/response.json]
{ "pathname": "hello.txt", "contentType": "text/plain", "size": 18 }
```

Retrieve the bytes through the GET route:

```bash [commands/read]
curl http://localhost:3000/api/files
```

The response body is:

```text [output/file.txt]
Hello from ViteHub
```

The local store keeps the object after a restart. Repeat only the GET request after restarting `pnpm dev` to check it.

These routes are open local examples. Before exposing uploads to users, add access checks and upload limits. Continue with [Server API](/docs/blob/server-api#upload-files) for form uploads and [Hosts](/docs/blob/hosts) for storage shared across app instances.
::
