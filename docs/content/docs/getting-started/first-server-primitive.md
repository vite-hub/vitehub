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

Save a theme setting and read it back in a server route. KV stores each value
under a key. This tutorial uses local files and needs no provider
account or credentials.

## Before you start

Complete [Installation](/docs/getting-started/installation), check
`/api/health`, and continue in that app with Node.js 22.22 or newer and pnpm.

::run-tutorial{to="/learn/first-server-primitive"}
::

::tutorial-step{title="Enable local KV"}
## Enable local KV

Install the KV package:

```bash [commands/install-kv]
pnpm add @vite-hub/kv
```

Turn on KV with the `fs-lite` driver, which stores values under
`.vitehub/data/kv`. Keep the other features in your config.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: "node",
    kv: { driver: "fs-lite", base: ".vitehub/data/kv" },
  },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from "vite"
import { nitro } from 'nitro/vite'
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({
      preset: "node",
      kv: { driver: "fs-lite", base: ".vitehub/data/kv" },
    }),
    nitro(),
  ],
})
```
::::

::::tabs-item{label="Vite"}
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
::::
:::

::

::tutorial-step{title="Write and read one value"}
## Write and read one value

Create `server/api/settings.post.ts`. Nitro and Nuxt serve it at
`POST /api/settings`. It saves the request body under the key `settings`,
reads it back, and returns it.

KV calls return `[error, value]`. Check the error before you use the value. A
write returns no value, so the route only checks `writeError`.

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

The H3 imports are explicit, so the example works without Nuxt auto-imports.

::

::tutorial-step{title="Check the stored setting"}
## Check the stored setting

Restart your app to load the new configuration:

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

The response is the read result, so it proves the write and the read. Send
`"theme":"dark"` to replace the setting.

To check the Vite app's production server, stop development, run the
Installation scripts, and repeat the request:

```bash [commands/build]
pnpm build
pnpm start
```

In Nuxt, run `pnpm build` and `node .output/server/index.mjs` instead.

::

## Continue with storage

Values survive a restart while `.vitehub/data/kv` exists. Do not commit it. A deployed server needs persistent storage or a hosted KV
provider. Changing the driver does not move existing data.

Read [KV configuration](/docs/kv/configure) to pick a hosted store or add a
named store. The [KV server API](/docs/kv/server-api) lists method results
and errors. For other data, try the
[Database tutorial](/docs/database/get-started) or
[Blob tutorial](/docs/blob/get-started).
