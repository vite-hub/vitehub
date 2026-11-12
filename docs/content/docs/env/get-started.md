---
title: Read your first environment value
description: Declare an app name in your config and read it in a server route, with its type.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Env gives your app its settings, such as its name, URLs, and API keys. You declare each value once in your config. Then you read it in your code, with the correct type.

In this tutorial, you declare an app name, `Acme`, and return it from a server route.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run the commands from the root of the app. You need no account and no API key.

::tutorial-step{title="Declare the value"}
## Declare the value

Add an `env` block to your config. In Vite, it goes in `vitehub({ env })`. In Nuxt, it goes in `vitehub.env`. Keep the other options of your app.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
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
    preset: 'node',
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
    preset: 'node',
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

- `public` holds values that browser code can read. Every visitor can see them, so never put a password or an API key here. Put secrets in `env.server`, and read them only in server code.
- `default: 'Acme'` is the value when no environment variable sets it. So you need no environment variable for this tutorial.
- `mode: 'build'` reads the value once, when you build the app. The value is then part of the build output.

::

::tutorial-step{title="Read the value"}
## Read the value

Create `server/api/app-name.get.ts`. This file is the route `GET /api/app-name`. It reads `appName` and returns it:

```ts [server/api/app-name.get.ts]
import { defineEventHandler } from 'h3'
import { usePublicEnv } from '#vitehub/env/public'

export default defineEventHandler(() => {
  const { appName } = usePublicEnv()
  return { appName }
})
```

`#vitehub/env/public` is a module that Env makes from your config, so `appName` has a type. Only the dev server and the build can load this module. You cannot run this file with `node` alone.

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

Your code read the value that you declared in your config.

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
