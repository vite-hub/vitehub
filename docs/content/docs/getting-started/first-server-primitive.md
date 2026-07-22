---
title: First Server Primitive
description: Add local KV to a small Vite server and return one stored value.
navigation.order: 3
icon: i-lucide-server-cog
---

Server Primitives give application code stable APIs for infrastructure. This
quickstart adds an explicit local KV store to a small H3 server, then proves the
integration with one request.

::note
You need Node.js 24 or newer and `pnpm`. The first result runs locally without
an account or credential.
::

## Install KV

Create an empty project and install ViteHub with Vite and H3.

```bash [Terminal]
mkdir vitehub-kv-start
cd vitehub-kv-start
pnpm init
pnpm pkg set type=module
pnpm add vite-hub h3 vite
```

## Configure the Vite Integration

Register `vitehub()` and select the file-backed local KV driver. The explicit
configuration stores values under `.data/kv`.

```ts [vite.config.ts]
import { resolve } from "node:path"

import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  root: import.meta.dirname,
  appType: "custom",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
      output: { entryFileNames: "server.js" },
    },
    ssr: true,
  },
  plugins: [
    vitehub({
      preset: "node",
      agent: false,
      blob: false,
      database: false,
      env: false,
      kv: { driver: "fs-lite", base: ".data/kv" },
      workflow: false,
      workspace: false,
    }),
  ],
})
```

## Write and read one value

Create one H3 route. H3 owns HTTP behavior, while the `kv` Runtime Helper owns
the application-facing storage API.

```ts [src/server.ts]
import { createServer } from "node:http"

import { H3, readBody } from "h3"
import { toNodeHandler } from "h3/node"
import { kv } from "vite-hub/kv"

const app = new H3().post("/settings", async (event) => {
  const settings = await readBody<{ theme: string }>(event)

  await kv.set("settings", settings)

  return { settings: await kv.get("settings") }
})

const port = Number(process.env.PORT || 5173)

createServer(toNodeHandler(app)).listen(port, () => {
  console.log(`ViteHub KV tutorial listening on http://localhost:${port}`)
})
```

## Run the server

Build and start the generated Node.js entry.

```bash [Terminal]
pnpm vite build
node dist/server.js
```

Send a value from another terminal.

```bash [Terminal]
curl -X POST http://localhost:5173/settings \
  -H 'content-type: application/json' \
  -d '{"theme":"system"}'
```

The response proves that the route wrote and read through ViteHub:

```json [Response]
{"settings":{"theme":"system"}}
```

Changing providers belongs in `vite.config.ts`. Server code keeps importing
`kv` from `vite-hub/kv` when you move to a supported hosted store.

## Next steps

- Follow the longer [Server Primitives tutorial](/blog/server-primitives) for the full boundary explanation.
- Read [KV](/docs/server-primitives/kv) for named stores and hosted drivers.
- Read [Runtime Helpers and stable imports](/docs/concepts/runtime-helpers-and-stable-imports) for the provider boundary.
