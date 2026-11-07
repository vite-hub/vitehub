---
title: Store your first KV value
description: Save a theme setting in local KV, then read it through a separate API route.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You save a theme setting with one API request, then read it back with a second request. KV (key-value) storage keeps a value under a name, the key. Here the key is `settings`.

You need:

- the working app from [Installation](/docs/getting-started/installation), with its Node.js, pnpm, Vite, Nitro, and H3 setup

You do not need to install a package or make a cloud account. KV is part of `vite-hub`, and the data goes in files on your computer. Run all commands from the app root.

::tutorial-step{title="Turn on KV"}
## Turn on KV

Add `kv: true` to the `vitehub()` options in `vite.config.ts`. Keep your other plugins and options. The port settings match the `dev` script from Installation.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ preset: 'node', kv: true })],
})
```

With `preset: 'node'`, KV keeps its data in files in `.vitehub/data/kv`.

If you chose Nuxt in Installation, add `kv: true` to the options of the `vite-hub/nuxt` module. The files below are the same for Nuxt.

::

::tutorial-step{title="Save a value"}
## Save a value

Create `server/api/settings.put.ts`. Nitro uses the file name to make the route `PUT /api/settings`.

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

The route checks the theme. Then `kv.set()` saves it under the `settings` key. A new save replaces the old value.

`kv.set()` does not throw when the save fails. It returns `[error, value]`. Check `error` before you tell the caller that the save worked.

::

::tutorial-step{title="Read the value"}
## Read the value

Create `server/api/settings.get.ts`. This route only reads, so you can also use it after a restart to see that the value is still there.

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

`kv.get()` also returns `[error, value]`. If the key does not exist, the value is `null`, and this route sends a `404`. A config mistake, such as a store name that does not exist, throws. See [Limits and errors](/docs/kv/limits-and-errors).

::

::tutorial-step{title="Run it"}
## Run it

Start the app. If it already runs, restart it, because you changed `vite.config.ts`.

```bash [commands/start]
pnpm dev
```

Keep it running. In a second terminal, save a theme:

```bash [commands/request]
curl -X PUT http://localhost:3000/api/settings \
  -H 'content-type: application/json' \
  -d '{"theme":"system"}'
```

Then read it:

```bash [commands/read]
curl http://localhost:3000/api/settings
```

Both requests return:

```json [output/response.json]
{ "settings": { "theme": "system" } }
```

The GET request found the value that the PUT request saved.

Now stop the app and run `pnpm dev` again. Send only the GET request. You get the same response, so KV kept the value on disk. If you send a PUT with `{"theme":"dark"}`, it replaces the value.

> [!NOTE]
> KV keeps the data in local files. If you deploy this store, the server needs a disk that keeps its files. For storage that more than one server can share, see [Hosts](/docs/kv/hosts).

::

## Next steps

- [Configure](/docs/kv/configure): use more than one store, and choose a provider.
- [Hosts](/docs/kv/hosts): use hosted KV storage when you deploy.
