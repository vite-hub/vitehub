---
title: Env
navigation.title: Overview
description: Declare public, build-time, server runtime, and secret values behind typed ViteHub accessors.
navigation.order: 1
icon: i-lucide-key-round
---

::product-hero{tagline="Declare public, build-time, server, and secret values in the Vite config, and read them through generated typed imports." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::code-group
  ```ts [vite.config.ts]
  import { env, hubEnv } from '@vite-hub/env/vite'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [hubEnv()],
    env: {
      server: {
        github: {
          token: env({ secret: true, source: env.source('GITHUB_TOKEN') }),
        },
        labeller: {
          dryRun: env.boolean({ default: true }),
          minConfidence: env.number({ default: 0.6 }),
          mode: env.enum(['draft', 'send'], { default: 'draft' }),
        },
      },
    },
  })
  ```

  ```ts [Server]
  import { useServerEnv } from '#vitehub/env/server'

  export async function listIssues() {
    const { github } = useServerEnv()

    return fetch('https://api.github.com/issues', {
      headers: {
        authorization: `Bearer ${github.token.unseal()}`,
      },
    })
  }
  ```

  ```bash [CLI]
  pnpm vitehub env inspect [--stage <name>] [--json]
  pnpm vitehub env check [--stage <name>] [--json]
  ```
  :::
::


::product-features
  :::product-feature-item{title="Host strings become typed values" icon="i-lucide-sliders-horizontal" to="/docs/env/configure"}
  `env.boolean()`, `env.number()`, and `env.enum()` parse each value.
  :::

  :::product-feature-item{title="Secrets stay on the server, redacted" icon="i-lucide-shield-check" to="/docs/env/server-api"}
  Secret Env stays redacted in Server Env until `unseal()`.
  :::

  :::product-feature-item{title="Read credentials from external storage" icon="i-lucide-database" to="/docs/env/server-api#read-external-env-storage"}
  Each `loadServerEnv()` call reads a fresh snapshot from an Env provider.
  :::

  :::product-feature-item{title="Check a stage without printing values" icon="i-lucide-terminal" to="/docs/development/cli#inspect-server-env"}
  `env check` exits `1` when Server Env would not load.
  :::

  :::product-feature-item{title="Replace a credential without a redeploy" icon="i-lucide-key-round" to="/docs/env/bridge"}
  A secret store with per-key grants and a durable activity log.
  :::

  :::product-feature-item{title="Secrets resolve at runtime" icon="i-lucide-lock-keyhole" to="/docs/env/server-api"}
  Keep secret values out of generated client and provider output.
  :::
::
