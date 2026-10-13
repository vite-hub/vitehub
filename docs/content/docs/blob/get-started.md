---
title: Store your first Blob object
description: Write a local text file to Blob and inspect its stored metadata.
navigation.title: Tutorial
layout: tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Save `hello.txt` in a local object store and check that the response reports its path, content type, and size. Use Blob for file bodies such as uploads and generated documents. Use [KV](/docs/kv) when you only need a small JSON value.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. The local store writes to `.vitehub/data/blob` and needs no provider account. Choose a [hosted store](/docs/blob/hosts) when files must remain available across app instances.

::tutorial-step{title="Install and configure"}
## Install and configure

Install Blob and the CLI. Nitro serves the route used in the next step. Keep existing plugins when you add the configuration.

```bash [commands/install]
pnpm add @vite-hub/blob nitro h3
pnpm add -D @vite-hub/cli vite
```

Register Blob and select the local store:

```ts [vite.config.ts]
import { hubBlob } from '@vite-hub/blob/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  blob: {
    driver: 'fs',
    base: '.vitehub/data/blob',
  },
  plugins: [hubBlob(), nitro() as never],
})
```

::

::tutorial-step{title="Write one object"}
## Write one object

Every request writes the same text to `hello.txt`. `contentType` tells a reader how to interpret the stored bytes. The route returns metadata rather than the file body.

```ts [server/api/files.post.ts]
import { defineEventHandler } from 'h3'
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async () => {
  const [error, object] = await blob.put('hello.txt', 'Hello from ViteHub', {
    contentType: 'text/plain',
  })
  if (error) throw error
  return object
})
```

`blob.put()` returns `[error, object]`. The object includes its pathname,
content type, size, and upload timestamp.

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start Vite and send one request:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl -X POST http://localhost:5173/api/files
```

The example text is 18 bytes. The actual `httpEtag` depends on the stored object; the ellipsis below stands for that value.

```json [output/response.json]
{
  "pathname": "hello.txt",
  "contentType": "text/plain",
  "size": 18,
  "httpEtag": "..."
}
```

Use `pnpm vitehub blob head hello.txt --json` to inspect the same object from
the development server. Continue with [Server API](/docs/blob/server-api) for
uploads and reads, then [Hosts](/docs/blob/hosts) before choosing a hosted
store.
::
