---
title: Store your first KV value
description: Save a theme setting in local KV, then read it through a separate API route.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

KV is a key-value store. You save a value under a name, called a key, and you read it back later by that key. Use it for small data such as settings, flags, or a cache.

In this tutorial, you save a theme setting under the key `settings` with one API route, and you read it with a second route.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run the commands from the root of the app. You need no account and no API key. On your computer, KV saves values in the `.vitehub/data/kv` folder.

::tutorial-step{title="Enable KV"}
## Enable KV

Install the KV package in the app:

```bash pm [commands/install-kv]
pnpm add @vite-hub/kv
```

Add `kv: true` to the ViteHub options in `nuxt.config.ts` or `vite.config.ts`. Keep your other plugins and options. The port settings below match the development script from Installation.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', kv: true },
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
  plugins: [vitehub({ host: 'node', kv: true }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ host: 'node', kv: true })],
})
```
::::
:::

::

::tutorial-step{title="Write one key"}
## Write one key

Create `server/api/settings.put.ts`. This file is the route `PUT /api/settings`. It saves the theme that you send.

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

- `kv.set('settings', settings)` saves the object under the key `settings`. A new write replaces the old value.
- `kv.set()` returns `[error, value]`. Check `error` for operation failures. Configuration errors can throw.

::

::tutorial-step{title="Read the stored value"}
## Read the stored value

Create `server/api/settings.get.ts`. This route only reads the value.

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

- `kv.get()` returns `[error, value]`. The type in `<...>` is the type of the saved value.
- When the key does not exist, `value` is `null`. That is not an error. Here, the route returns `404`.

A configuration error, such as an unknown store, throws. See [Limits and errors](/docs/kv/limits-and-errors).

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start or restart the app after the config change:

```bash [commands/start]
pnpm dev
```

Keep it running. Open a second terminal and save a theme:

```bash [commands/request]
curl -X PUT http://localhost:3000/api/settings \
  -H 'content-type: application/json' \
  -d '{"theme":"system"}'
```

Then read it back:

```bash [commands/read]
curl http://localhost:3000/api/settings
```

Both requests return:

```json [output/response.json]
{ "settings": { "theme": "system" } }
```

The value stays after a restart. To check it, stop the app, run `pnpm dev` again, and run only the read request. Send `{"theme":"dark"}` to replace the value.

::


## What happens when you deploy

On your computer, KV saves values in a local folder. A host with no persistent disk loses that folder. Use [Hosts](/docs/kv/hosts) to pick a shared store for your host.

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/kv/configure"}
Add named stores and choose a provider.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/kv/hosts"}
Move to a hosted store without a change to your KV code.
:::

:::card{title="Server API" icon="i-lucide-code-2" to="/docs/kv/server-api"}
Read every KV method and its result.
:::
::
