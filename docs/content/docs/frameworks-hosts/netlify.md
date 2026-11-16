---
title: Netlify
description: Use the ViteHub package contracts that have explicit Netlify runtime or function output.
navigation.order: 45
navigation.group: Deployment hosts
icon: i-simple-icons-netlify
---

The `netlify` host deploys your app to Netlify. Support depends on the
package. ViteHub has Netlify output for Blob, generated Agent HTTP routes, and
static Schedule wake functions. Other primitives need an explicit remote
provider or are not available.

## Available boundaries

| Surface | Current contract |
| --- | --- |
| Blob | `hubBlob()` selects the `netlify-blobs` driver when the build reports Netlify hosting. Your code still uses `vite-hub/blob`. |
| Agent routes | `hubAgent()` writes one `vitehub-agent` function when hosted Agent Definitions exist. It mounts the standard chat dispatcher and webhook route. Route-enabled Channels pick which Agents answer chat requests. `routes.discordGateway` stays explicit. |
| Static schedules | `hubSchedule()` writes one scheduled Netlify function per static Schedule Definition. |
| Local proof | Pull-request CI runs a real-project fixture through Netlify CLI. |

The Agent function goes to `.netlify/v1/functions`, and its source wrapper to `.vitehub/agent/netlify-function.mjs`. Both are Provider Output (generated host files), not public imports.
In Nuxt, the wrapper follows Nuxt's build directory, normally `.nuxt/vitehub/agent/netlify-function.mjs`. The deployed function path does not change.

## Configure the host

Each package writes only its own Netlify output. This example adds the
Schedule integration with `providerOutput: 'standalone'`, so each static
Schedule Definition becomes a Netlify scheduled function. Install the package
first.

```bash [Terminal]
pnpm add @vite-hub/schedule
```

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'netlify',
    agent: { invocations: false },
    blob: true,
  },
  vite: {
    plugins: [hubSchedule({ providerOutput: 'standalone' })],
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'netlify',
      agent: { invocations: false },
      blob: true,
    }),
    nitro(),
    hubSchedule({ providerOutput: 'standalone' }),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'netlify',
      agent: { invocations: false },
      blob: true,
    }),
    hubSchedule({ providerOutput: 'standalone' }),
  ],
})
```
:::
::

The `netlify` host selects the Netlify Blobs driver and the Agent function output. Each static Schedule Definition becomes a function such as `.netlify/v1/functions/vitehub-schedule-heartbeat.mjs`.

The standalone Agent function does not install an app-wide Invocation journal. Set `agent.invocations: false` and configure `invocations` on each Agent Definition when records are needed. An omitted or configured app-wide journal fails with `VITE_HUB_R0132`.

## Generated functions

The build writes generated functions and wrappers to Netlify's directories.

The server function comes from Nitro's `netlify` preset, and ViteHub follows Nitro's output directory:

- Nitro 3.0.261029-rc and later write `.netlify/v1/functions/server`. Netlify finds it without `netlify.toml` function settings or redirects.
- Earlier Nitro betas write `.netlify/functions-internal/server`. ViteHub adds `.netlify/functions/server.mjs` so Netlify finds it.

Either way, `.netlify/deployment.json` records the server entry.

```bash [Terminal]
pnpm build
find .netlify/v1/functions -maxdepth 2 -type f | sort
find .vitehub/agent -maxdepth 2 -type f | sort
```

In Nuxt, inspect the wrapper with `find .nuxt/vitehub/agent -maxdepth 2 -type f | sort`, or the same path under a custom `buildDir`.

## Features without a Netlify provider

- **Queue, Rate Limit, Sandbox, Workflow:** ViteHub picks no Netlify provider. `queue: true`, `rateLimit: true`, and `sandboxTask: true` fail the build. `sandboxTask: { provider: 'vercel' }` uses Vercel Sandbox with Vercel credentials. Workflow stays off when only `agent` turns it on. An explicit `workflow` option needs `workflow.provider`. Pick an external provider only when it works from the Netlify runtime.
- **Provisioning:** The ViteHub Provision CLI does not create Netlify resources. It accepts only Cloudflare and Vercel plans. Netlify Blobs stores need no provisioning; see [Resources without provisioning](/docs/development/provisioning#resources-without-provisioning).
- **KV:** There is no Netlify KV output. Set a remote KV driver for deployed state. Do not rely on the local `fs-lite` fallback in a serverless deployment.
- **Workspace:** There is no Netlify hosted store. Set a durable remote Workspace store. The local filesystem fallback does not persist safely across serverless instances.

## Production proof

Netlify is [Experimental](/docs/frameworks-hosts/support-matrix#test-status). CI on `main` builds one Agent app and sends one chat request to it through Netlify CLI. No CI run calls a primitive on Netlify, and there is no live Netlify test. Check the generated functions on your Netlify site before you call your setup production-ready.

## Next steps

- [Runtime and host support](/docs/frameworks-hosts/support-matrix)
- [Provider output](/docs/reference/provider-output)
- [Import paths](/docs/reference/import-paths)
