---
title: Vercel Sandbox
description: Configure Vercel Sandbox and run isolated sandboxes on Vercel.
icon: i-simple-icons-vercel
navigation.title: Vercel
---

Vercel Sandbox fits Vercel-hosted apps that want isolated execution without adding a second platform. ViteHub keeps the public sandbox API stable and forwards runtime settings to Vercel where they matter.

## Before you start

Install the Vercel SDK alongside `@vitehub/sandbox`.

```bash [Terminal]
pnpm add https://pkg.pr.new/vite-hub/vitehub/@vitehub/sandbox@main @vercel/sandbox
```

Set Vercel sandbox credentials in the runtime environment when the provider cannot inherit them automatically.

```bash [.env]
VERCEL_TOKEN=your-token
VERCEL_TEAM_ID=your-team-id
VERCEL_PROJECT_ID=your-project-id
```

ViteHub reads these values from `process.env`. Vite also accepts `VITE_SANDBOX_TOKEN`, `VITE_SANDBOX_TEAM_ID`, and `VITE_SANDBOX_PROJECT_ID`. Nitro and Nuxt also accept `NITRO_SANDBOX_TOKEN`, `NITRO_SANDBOX_TEAM_ID`, `NITRO_SANDBOX_PROJECT_ID`, `NUXT_SANDBOX_TOKEN`, `NUXT_SANDBOX_TEAM_ID`, and `NUXT_SANDBOX_PROJECT_ID`. Nuxt, Nitro, Vite, or your process manager must load `.env` before startup.

## Configure Vercel

::fw{#vite}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubSandbox } from '@vitehub/sandbox/vite'

export default defineConfig({
  plugins: [hubSandbox()],
  sandbox: {
    runtime: 'node22',
  },
})
```
::
::fw{#nitro}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/sandbox/nitro'],
  sandbox: {
    runtime: 'node22',
  },
})
```
::
::fw{#nuxt}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/sandbox/nuxt'],
  sandbox: {
    runtime: 'node22',
  },
})
```
::

On Vercel hosting, ViteHub uses the Vercel sandbox provider automatically. Set app-wide defaults in top-level `sandbox` config.

If you use the shipped sandbox examples, they also accept `SANDBOX_PROVIDER=vercel` so you can switch providers without editing the example config.

## What changes on Vercel

| Concern | Behavior |
| --- | --- |
| Runtime defaults | Configure app-wide defaults such as `runtime`, `timeout`, `cpu`, and `ports` in top-level `sandbox` config. |
| Provider options | Set `cpu`, `ports`, `source`, and `networkPolicy` in the top-level `sandbox` config, not in the definition file. Keep top-level provider config separate from definition-level options. |
| Credentials | ViteHub resolves credentials in this order: explicit config, Nitro/Nuxt alias env vars, generic `VERCEL_*`, then automatic platform inheritance when available. |
| Execution model | ViteHub resolves the named sandbox and asks Vercel to run it inside Vercel's sandbox runtime. |

## Related pages

- [Quickstart](../quickstart)
- [Run a sandbox](../guides/run-a-sandbox)
- [Troubleshooting](../troubleshooting)
