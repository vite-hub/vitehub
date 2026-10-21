---

title: Read your first environment value
description: Declare a safe application name and read it from the generated Public Env module.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Declare an application name once and read it from the generated Public Env module. The verification script will print `Acme`. This first example uses a safe value that can appear in browser code.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. Public Env values are part of the build output. Put credentials in `env.server` and read them only in server code.

::tutorial-step{title="Install and configure"}
## Install and configure

Install Env, then add its plugin and declaration to your existing Vite config. Keep any other plugins your app uses.

```bash [commands/install]
pnpm add @vite-hub/env @vite-hub/runtime
pnpm add -D vite
```

`mode: 'build'` resolves this public value during the build. The default supplies `Acme`, so you need no environment variable for this run.

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

::

::tutorial-step{title="Read the value"}
## Read the value

The generated alias gives the app a typed `appName` value. Import it through Vite; Node alone cannot resolve `#vitehub/env/public`.

```ts [src/app.ts]
import { usePublicEnv } from '#vitehub/env/public'

const publicEnv = usePublicEnv()
console.log(publicEnv.appName)
```

::

::tutorial-step{title="Run and verify"}
## Run and verify

Create a verification script that loads the example through Vite. Vite generates
the Env module and resolves the alias before it executes `src/app.ts`.

```js [scripts/verify-env.mjs]
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true } })
try {
  await server.ssrLoadModule('/src/app.ts')
} finally {
  await server.close()
}
```

Run it from the app root:

```bash [commands/verify]
node scripts/verify-env.mjs
```

The terminal prints `Acme`. This confirms that the generated Public Env module
contains the declared value.

::
