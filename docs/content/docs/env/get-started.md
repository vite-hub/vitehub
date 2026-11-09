---

title: Read your first environment value
description: Declare an app name in your Vite config and read it in your code, with its type.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Env gives your app its settings, such as its name, URLs, and API keys. You declare each value once in `vite.config.ts`. Then you read it in your code, with the correct type.

In this tutorial, you declare an app name, `Acme`, and print it from your code.

> [!NOTE] Before you start
> You need Node.js 22.18 or newer, pnpm, and a Vite app. Run the commands in the root folder of the app. You need no account and no API key.

::tutorial-step{title="Install and configure"}
## Install and configure

Add Env to your app:

```bash pm [commands/install]
pnpm add @vite-hub/env @vite-hub/runtime
pnpm add -D vite
```

Add `hubEnv()` and an `env` block to `vite.config.ts`. Keep the other plugins of your app.

```ts [vite.config.ts]
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv()],
  env: {
    public: {
      appName: env({ default: 'Acme', mode: 'build' }),
    },
  },
})
```

- `public` holds values that browser code can read. Every visitor can see them, so never put a password or an API key here. Put secrets in `env.server`, and read them only in server code.
- `default: 'Acme'` is the value when no environment variable sets it. So you need no environment variable for this tutorial.
- `mode: 'build'` reads the value once, when you build the app. The value is then part of the build output.

::

::tutorial-step{title="Read the value"}
## Read the value

Create `src/app.ts`. It reads `appName` and prints it:

```ts [src/app.ts]
import { usePublicEnv } from '#vitehub/env/public'

const publicEnv = usePublicEnv()
console.log(publicEnv.appName)
```

`#vitehub/env/public` is a module that Env makes from your config, so `appName` has a type. Only Vite can load this module. You cannot run this file with `node` alone.

::

::tutorial-step{title="Run and verify"}
## Run and verify

Create a script that loads `src/app.ts` through Vite:

```js [scripts/verify-env.mjs]
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true } })
try {
  await server.ssrLoadModule('/src/app.ts')
} finally {
  await server.close()
}
```

Run it in the root folder of the app:

```bash [commands/verify]
node scripts/verify-env.mjs
```

The terminal prints `Acme`. Your code read the value that you declared in `vite.config.ts`.

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
