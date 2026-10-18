---
title: Env
navigation.title: Overview
description: Declare your settings and secrets once, then read them as typed values in browser and server code.
navigation.order: 1
icon: i-lucide-key-round
---

::product-hero{tagline="Declare your settings and secrets once, then read them as typed values in browser and server code." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::product-files
  ```ts [vite.config.ts]
  import { env, hubEnv } from '@vite-hub/env/vite'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [hubEnv()],
    env: {
      // Safe to show in the browser
      public: {
        appName: env({ default: 'Acme', mode: 'build' }),
      },
      // Only server code can read these
      server: {
        github: {
          token: env({
            secret: true,
            source: env.source('GITHUB_TOKEN'),
          }),
        },
        dryRun: env.boolean({ default: true }),
      },
    },
  })
  ```

  ```ts [src/app.ts]
  import { usePublicEnv } from '#vitehub/env/public'

  // Public values work in browser code
  const { appName } = usePublicEnv()
  document.title = appName
  ```

  ```ts [server/api/issues.get.ts]
  import { defineEventHandler } from 'h3'
  import { useServerEnv } from '#vitehub/env/server'

  export default defineEventHandler(async () => {
    const { github } = useServerEnv()

    // A secret stays hidden until you unseal it
    const token = github.token.unseal()
    const response = await fetch(
      'https://api.github.com/issues',
      { headers: { authorization: `Bearer ${token}` } },
    )
    return response.json()
  })
  ```

  ```ts [server/api/publish.post.ts]
  import { defineEventHandler } from 'h3'
  import { useServerEnv } from '#vitehub/env/server'

  export default defineEventHandler(() => {
    // dryRun is a boolean, not the text "true"
    const { dryRun } = useServerEnv()
    if (dryRun) return { published: false }

    return { published: true }
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="Browser or server" icon="i-lucide-split" to="/docs/env/configure#env-config-sections"}
  Public values can appear in the browser. Server values stay in server code.
  :::

  :::product-feature-item{title="Typed values" icon="i-lucide-sliders-horizontal" to="/docs/env/configure#typed-values"}
  Turn text from the host into a boolean, a number, or one of a list of choices. A wrong value fails with a clear error.
  :::

  :::product-feature-item{title="Secrets stay hidden" icon="i-lucide-shield-check" to="/docs/env/server-api#use-it-at-runtime"}
  A secret prints as hidden text until you call `unseal()`.
  :::

  :::product-feature-item{title="Clear variable names" icon="i-lucide-tag" to="/docs/env/configure#variable-names"}
  `env.server.github.token` reads `VITEHUB_GITHUB_TOKEN` first, then the name you give in `env.source()`.
  :::

  :::product-feature-item{title="Load secrets from your own store" icon="i-lucide-database" to="/docs/env/server-api#read-external-env-storage"}
  Read values from an outside secret store. Each `loadServerEnv()` call gets fresh values.
  :::

  :::product-feature-item{title="Change a secret without a redeploy" icon="i-lucide-key-round" to="/docs/env/bridge#replace-a-credential"}
  Env Bridge lets an admin replace a stored value while the app runs.
  :::
::
