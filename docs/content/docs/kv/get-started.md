---
title: Store your first KV value
description: Save a theme setting in local KV, then read it through a separate API route.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Save a theme setting under `settings`, then read it in a second request. Both routes return `{ "settings": { "theme": "system" } }`.

Start with the working app from [Installation](/docs/getting-started/installation). Use its Node.js, pnpm, Vite, Nitro, and H3 setup, and run commands from the app root. The Node preset uses a local `fs-lite` store under `.vitehub/data/kv`. No provider account is required.

::tutorial-step{title="Enable KV"}
## Enable KV

Add `kv: true` to the existing `vitehub()` options in `vite.config.ts`. Keep your other plugins and options. The port settings below match the development script from Installation.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ preset: 'node', kv: true })],
})
```

If you chose Nuxt in Installation, add `kv: true` to the options of the existing `vite-hub/nuxt` module. Use the same server files below. They import H3 helpers explicitly.

::

::tutorial-step{title="Write one key"}
## Write one key

Create `server/api/settings.put.ts`. Nitro maps this file to `PUT /api/settings`. Each write replaces the value at the same key.

```ts [server/api/settings.put.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { kv } from 'vite-hub/kv'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ theme?: unknown }>(event)
  const theme = body?.theme
  if (theme !== 'system' && theme !== 'light' && theme !== 'dark') {
    throw createError({ statusCode: 400, message: 'Use system, light, or dark for theme.' })
  }

  const settings = { theme }
  const [error] = await kv.set('settings', settings)
  if (error) throw error
  return { settings }
})
```

`kv.set()` returns `[error, value]`. A successful write has no return value. Check the error before reporting success.

::

::tutorial-step{title="Read the stored value"}
## Read the stored value

Create a separate `GET /api/settings` route. It only reads, so it can also check the value after a server restart.

```ts [server/api/settings.get.ts]
import { createError, defineEventHandler } from 'h3'
import { kv } from 'vite-hub/kv'

export default defineEventHandler(async () => {
  const [error, settings] = await kv.get<{ theme: string }>('settings')
  if (error) throw error
  if (settings === null) {
    throw createError({ statusCode: 404, message: 'Save a theme first.' })
  }
  return { settings }
})
```

`kv.get()` returns `[error, value]`. A missing key is a successful read with a `null` value. This route turns it into a `404` response. Configuration errors, such as an unknown store, throw. See [Limits and errors](/docs/kv/limits-and-errors).

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start or restart the app after the config change:

```bash [commands/start]
pnpm dev
```

Keep it running. In another terminal, write a theme:

```bash [commands/request]
curl -X PUT http://localhost:3000/api/settings \
  -H 'content-type: application/json' \
  -d '{"theme":"system"}'
```

Then read it without another write:

```bash [commands/read]
curl http://localhost:3000/api/settings
```

Both requests return:

```json [output/response.json]
{ "settings": { "theme": "system" } }
```

Stop the app, run `pnpm dev` again, and repeat only the GET request. The same response confirms that the local store kept the value on disk. A later PUT with `{"theme":"dark"}` replaces it.

Use [Configuration](/docs/kv/configure) for named stores and [Hosts](/docs/kv/hosts) for shared hosted storage. A local file store needs persistent disk when you deploy it.
::
