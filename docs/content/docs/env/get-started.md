---

title: Read your first environment value
description: Declare a safe application name and read it from the generated Public Env module.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You declare an app name in one place, then read it in your code. At the end, a small script prints `Acme`.

You need:

- Node.js 22.18 or newer
- pnpm
- a Vite app

You do not need a `.env` file or a cloud account. Run all commands from the app root.

::tutorial-step{title="Declare the value"}
## Declare the value

Install the packages:

```bash [commands/install]
pnpm add @vite-hub/env @vite-hub/runtime
pnpm add -D vite
```

`@vite-hub/env` reads and checks your values. `@vite-hub/runtime` holds shared ViteHub code that Env uses. `vite` builds the app.

Add the Env plugin and the value to `vite.config.ts`. Keep the other plugins that your app uses.

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

- `public` holds values that browser code can read. An app name is safe to show.
- `mode: 'build'` reads the value once, when Vite builds the app.
- `default: 'Acme'` is the value when no environment variable sets it. So you do not need to set one for this tutorial.

> [!NOTE]
> Public values go into the build output, so anyone can read them. Put passwords and API keys in `env.server`, and read them only in server code.

::

::tutorial-step{title="Read the value"}
## Read the value

Create `src/app.ts`:

```ts [src/app.ts]
import { usePublicEnv } from '#vitehub/env/public'

const publicEnv = usePublicEnv()
console.log(publicEnv.appName)
```

`#vitehub/env/public` is a module that the Env plugin makes from your config. `usePublicEnv()` gives you your public values, with types. TypeScript knows that `appName` is a string.

Only Vite knows this module. If you run `node src/app.ts` directly, Node.js cannot find `#vitehub/env/public`.

::

::tutorial-step{title="Run it"}
## Run it

Create `scripts/verify-env.mjs`. It starts Vite without a browser, and runs `src/app.ts` through Vite, so that Vite can make the module first:

```js [scripts/verify-env.mjs]
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true } })
try {
  await server.ssrLoadModule('/src/app.ts')
} finally {
  await server.close()
}
```

Run it:

```bash [commands/verify]
node scripts/verify-env.mjs
```

The terminal prints `Acme`. This proves that the Env plugin read your config and gave the value to your code.

::

## Next steps

- [Configure](/docs/env/configure#env-config-sections): learn the `public`, `server`, and `define` sections.
- [Server API](/docs/env/server-api#use-it-at-runtime): read server values, such as API keys, in server code.
- [App secret](/docs/env/app-secret): set one root secret, and let ViteHub make the other secrets that your app needs from it.
