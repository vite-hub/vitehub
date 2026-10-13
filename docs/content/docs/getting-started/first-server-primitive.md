---
title: First Server Primitive
navigation.title: First Server Primitive
description: Add local KV to a small Vite server and return one stored value.
layout: tutorial
navigation.order: 3
icon: i-lucide-server-cog
---

Build a route that saves a theme setting and reads it back. KV stores a value
under a key, so your server can retrieve the setting on a later request.
This tutorial uses local files and needs no provider account or credentials.

You need Node.js 24.15 or newer and `pnpm`. You will create a small H3 server,
configure ViteHub, and check the result with `curl`.

::tutorial-step{title="Create the project"}
## Create the project

Create a folder and install the dependencies. Vite builds the server, and H3
handles HTTP requests. Set `type=module` so Node.js can use the generated
server's `import` syntax.

```bash [commands/setup]
mkdir vitehub-kv-start
cd vitehub-kv-start
pnpm init
pnpm pkg set type=module
pnpm add vite-hub h3 vite
```

::

::tutorial-step{title="Configure the Vite integration"}
## Configure the Vite integration

Register `vitehub()` with the `node` preset and enable KV with the file-backed
`fs-lite` driver. Values are stored under `.vitehub/data/kv`. `blob: false` and
`env: false` keep the build to KV only. Vite builds `src/server.ts` into
`dist/server.js`.

```ts [vite.config.ts]
import { resolve } from "node:path"

import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  root: import.meta.dirname,
  appType: "custom",
  build: {
    outDir: "dist",
    rolldownOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
      output: { entryFileNames: "server.js" },
    },
    ssr: true,
  },
  plugins: [
    vitehub({
      preset: "node",
      blob: false,
      env: false,
      kv: { driver: "fs-lite", base: ".vitehub/data/kv" },
    }),
  ],
})
```

::

::tutorial-step{title="Write and read one value"}
## Write and read one value

Create `src/server.ts`. The `/settings` route takes a JSON body, stores it
under the key `settings`, then reads the same key. H3 returns that stored
value as JSON.

KV calls return an `[error, value]` pair. Check the error before using the
value. The write has no value to return, so it only checks `writeError`.

```ts [src/server.ts]
import { createServer } from "node:http"

import { H3, readBody } from "h3"
import { toNodeHandler } from "h3/node"
import { kv } from "vite-hub/kv"

const app = new H3().post("/settings", async (event) => {
  const settings = await readBody<{ theme: string }>(event)

  const [writeError] = await kv.set("settings", settings)
  if (writeError) throw writeError

  const [readError, storedSettings] = await kv.get("settings")
  if (readError) throw readError
  return { settings: storedSettings }
})

const port = Number(process.env.PORT || 5173)

createServer(toNodeHandler(app)).listen(port, () => {
  console.log(`ViteHub KV tutorial listening on http://localhost:${port}`)
})
```

::

::tutorial-step{title="Run the server"}
## Run the server

Build and start the generated Node.js entry. The server listens on port `5173`
unless you set `PORT`.

```bash [commands/build]
pnpm vite build
node dist/server.js
```

Send a value from another terminal.

```bash [commands/request]
curl -X POST http://localhost:5173/settings \
  -H 'content-type: application/json' \
  -d '{"theme":"system"}'
```

You should receive the setting you sent. This confirms that both the write
and the read reached the configured KV store:

```json [output/response.json]
{"settings":{"theme":"system"}}
```

To move to a hosted store, change the preset or the KV driver in
`vite.config.ts`. The server route keeps importing `kv` from `vite-hub/kv`.

::

## Continue with KV

The local store keeps files under `.vitehub/data/kv`. Keep that directory
when you restart the server to retain the data. Do not commit it to your
repository.

Read [KV configuration](/docs/kv/configure) to choose a hosted store or add a
named store. The [KV server API](/docs/kv/server-api) documents the return
values and errors for each method.
