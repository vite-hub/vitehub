---
title: Env
description: Declare build-time and runtime environment variables with typed access for Vite and Nitro.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-key-round
frameworks: [vite, nitro]
---

`@vite-hub/env` gives Vite and Nitro apps one place to declare environment variables, defaults, sources, and secret boundaries.

Use Env when configuration needs to be explicit and typed instead of scattered across `process.env`, `import.meta.env`, and provider dashboards.

::code-group
```ts [vite.config.ts]
import { env, envVite } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [envVite({ prefix: 'VITEHUB_' })],
  env: {
    define: {
      __APP_VERSION__: env({
        mode: 'build',
        source: env.packageJson('version'),
      }),
    },
    public: {
      appName: env({
        default: 'ViteHub Env',
        mode: 'build',
      }),
    },
  },
})
```

```ts [nitro.config.ts]
import { env, envNitro } from '@vite-hub/env/nitro'
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: [envNitro()],
  env: {
    auth: {
      token: env({ secret: true }),
    },
  },
})
```
::

## What Env solves

Environment values have different safety rules depending on when and where they are exposed.

::card-group
  :::card
  ---
  icon: i-lucide-lock-keyhole
  title: Secret boundaries
  ---
  Mark runtime values as secret so diagnostics mask them and Cloudflare required secrets are generated.
  :::

  :::card
  ---
  icon: i-lucide-file-code-2
  title: Public Env
  ---
  Expose browser-safe values through `#vitehub/env/public`.
  :::

  :::card
  ---
  icon: i-lucide-server
  title: Server Env
  ---
  Resolve Nitro server values through `#vitehub/env/server`.
  :::

  :::card
  ---
  icon: i-lucide-list-checks
  title: Validation
  ---
  Validate declarations with string defaults, zod-like schemas, or Standard Schema-compatible validators.
  :::
::

## Two configuration paths

::fw{id="vite:dev vite:build"}
Vite handles build-time values. Use `env.public` for values read from `#vitehub/env/public`, and `env.define` for compile-time replacements.
::

::fw{id="nitro:dev nitro:build"}
Nitro handles server Runtime Env values. Use nested `env` declarations, then read the resolved object with `useServerEnv()`.
::

## Source model

Each `env()` declaration can read from:

- an inferred environment variable name
- an explicit environment variable through `env.source(name)`
- `package.json` through `env.packageJson(path)`
- git branch or commit metadata
- a custom build-only resolver

Runtime declarations must be serializable. Custom sources and custom runtime schemas are build-only.

## Start here

Start with [Quickstart](./quickstart) for a Vite public build value and a Nitro runtime secret. Use [Usage](./usage) when you need prefixes, nested config, custom sources, or diagnostics.

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Configure build and runtime env declarations and verify both outputs.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Use defaults, optional variables, sources, schemas, diagnostics, and secret config.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exports, declaration shapes, generated import paths, and runtime helpers.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Troubleshooting
  description: Fix missing values, invalid schemas, async validation, and generated type issues.
  to: ./troubleshooting
  ---
  :::
::
