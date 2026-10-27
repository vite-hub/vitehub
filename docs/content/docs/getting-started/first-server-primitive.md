---
title: First Server Primitive
navigation.title: First Server Primitive
description: Add local KV to your app, save a setting, and return the stored value from a route.
layout: tutorial
codePanel: true
navigation.order: 3
navigation.group: Get started
icon: i-lucide-server-cog
---

Save a theme setting and read it back through a server route. KV stores each
value under a key. This tutorial uses local files and needs no provider
account or credentials.

## Before you start

Complete [Installation](/docs/getting-started/installation) and check
`/api/health`. Continue in that app, with Node.js 24.15 or newer and pnpm.
The configuration below uses Vite and Nitro. In Nuxt, add the same `kv`
option to the ViteHub module config. The route works in both frameworks.

::tutorial-step{title="Enable local KV"}
## Enable local KV

Enable KV with the `fs-lite` driver. It stores values under
`.vitehub/data/kv`. Keep other features you already use in your config.

```ts [vite.config.ts]
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({
      preset: "node",
      kv: { driver: "fs-lite", base: ".vitehub/data/kv" },
    }),
  ],
})
```

::

::tutorial-step{title="Write and read one value"}
## Write and read one value

Create `server/api/settings.post.ts`. Nitro and Nuxt serve it at
`POST /api/settings`. The route writes the request body under the key
`settings`, reads it back, and returns the stored value.

KV calls return `[error, value]`. Check each error before using the result.
A write returns no value, so the route only checks `writeError`.

```ts [server/api/settings.post.ts]
import { defineEventHandler, readBody } from "h3"
import { kv } from "vite-hub/kv"

export default defineEventHandler(async (event) => {
  const settings = await readBody<{ theme: string }>(event)

  const [writeError] = await kv.set("settings", settings)
  if (writeError) throw writeError

  const [readError, storedSettings] = await kv.get("settings")
  if (readError) throw readError
  return { settings: storedSettings }
})
```

The H3 imports are explicit. The example works without Nuxt auto-imports.

::

::tutorial-step{title="Check the stored setting"}
## Check the stored setting

Restart your app after changing its configuration:

```bash [commands/dev]
pnpm dev
```

In another terminal, send the setting:

```bash [commands/request]
curl -X POST http://localhost:3000/api/settings \
  -H 'content-type: application/json' \
  -d '{"theme":"system"}'
```

You should receive:

```json [output/response.json]
{"settings":{"theme":"system"}}
```

The route returned the read result, so this checks both the write and the
read. Repeat the request with `"theme":"dark"` to replace the stored setting.

To check the Vite app's production server, stop development, run the scripts
from Installation, and repeat the request:

```bash [commands/build]
pnpm build
pnpm start
```

In Nuxt, run `pnpm build` and `node .output/server/index.mjs` instead.

::

## Continue with storage

Keep `.vitehub/data/kv` when you restart the server to retain the values.
Keep it out of version control. A deployed server needs persistent storage
or a hosted KV provider; changing the driver does not move existing data.

Read [KV configuration](/docs/kv/configure) to choose a hosted store or add a
named store. The [KV server API](/docs/kv/server-api) lists method results
and errors. For other kinds of data, try the
[Database tutorial](/docs/database/get-started) or
[Blob tutorial](/docs/blob/get-started).
