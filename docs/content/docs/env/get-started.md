---
title: Read your first environment value
description: Declare an app name in your config and read it in a server route, with its type.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Env gives your app its settings, such as its name, URLs, and API keys. Declare each value once in your config. Then read it in your code with the correct type.

In this tutorial, you declare an app name, `Acme`, and return it from a server route.

> [!NOTE] Before you start
> Start with the app from [Installation](/docs/getting-started/installation) and run every command from the app root. You do not need an account or an API key.

::tutorial-step{title="Declare the value"}
## Declare the value

Add an `env` block to your config, under `vitehub({ env })` in Vite or `vitehub.env` in Nuxt. Keep your existing options.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    env: {
      public: {
        appName: env({ default: 'Acme', mode: 'build' }),
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    env: {
      public: {
        appName: env({ default: 'Acme', mode: 'build' }),
      },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    env: {
      public: {
        appName: env({ default: 'Acme', mode: 'build' }),
      },
    },
  })],
})
```
:::
::

- `public` holds values that browser code can read. Any visitor can see them, so never put a password or an API key here. Put secrets in `env.server`, and read them only in server code.
- `default: 'Acme'` is the value when no environment variable sets it. So this tutorial needs no environment variable.
- `mode: 'build'` reads the value once, when you build the app. The value is then part of the build output.

::

::tutorial-step{title="Read the value"}
## Read the value

Create `server/api/app-name.get.ts` to handle `GET /api/app-name`. It reads `appName` and returns it as JSON:

```ts [server/api/app-name.get.ts]
import { defineEventHandler } from 'h3'
import { usePublicEnv } from 'vite-hub/env'

export default defineEventHandler(() => {
  const { appName } = usePublicEnv()
  return { appName }
})
```

`usePublicEnv()` returns the typed Env values generated from your config. Run this route through the dev server or the built server output. Outside a ViteHub build, it throws `ENV_NOT_GENERATED`.

::

::tutorial-step{title="Run and verify"}
## Run and verify

Start or restart the app after the config change:

```bash [commands/start]
pnpm dev
```

Keep it running. Open a second terminal and call the route:

```bash [commands/request]
curl http://localhost:3000/api/app-name
```

The route returns:

```json [output/response.json]
{"appName":"Acme"}
```

Your code read the default value that you declared in your config.

::

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/env/configure"}
Add server values, secrets, and typed values, and read them from environment variables.
:::

:::card{title="Server API" icon="i-lucide-code" to="/docs/env/server-api"}
Read Server Env and secrets in your server code.
:::
::
