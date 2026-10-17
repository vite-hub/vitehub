---
title: Netlify
description: Use the ViteHub package contracts that have explicit Netlify runtime or function output.
navigation.order: 45
navigation.group: Deployment hosts
icon: i-simple-icons-netlify
---

Use the `netlify` preset to deploy a ViteHub application to Netlify. Support is
package-specific: ViteHub provides Netlify behavior for Blob, generated Agent
HTTP routes, and static Schedule wake functions. Other primitives need an
explicit remote provider or are not available on this preset.

## Available boundaries

| Surface | Current contract |
| --- | --- |
| Blob | `hubBlob()` selects the `netlify-blobs` driver when the build reports Netlify hosting. Application code continues to use `vite-hub/blob`. |
| Agent routes | `hubAgent()` writes one `vitehub-agent` function when hosted Agent Definitions exist. It mounts the conventional chat dispatcher and webhook route; route-enabled Channels select which Agents answer chat requests. `routes.discordGateway` remains explicit. |
| Static schedules | `hubSchedule()` writes one scheduled Netlify function per discovered static Schedule Definition. |
| Local proof | The repository runs a real-project fixture through Netlify CLI in pull-request CI. |

Agent function output lives under `.netlify/v1/functions`, with its generated source wrapper under `.vitehub/agent/netlify-function.mjs`. The wrapper and deployed function are Provider Output, not public application imports.
In a Nuxt app, the source wrapper follows Nuxt's build directory and is normally `.nuxt/vitehub/agent/netlify-function.mjs`; the deployed function path is unchanged.

## Configure the preset

Each active package integration contributes only its owned Netlify output.
This example adds the Schedule integration directly with
`providerOutput: 'standalone'`, so each static Schedule Definition becomes a
Netlify scheduled function. Install its owner package first.

```bash [Terminal]
pnpm add @vite-hub/schedule
```

```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'netlify',
      agent: true,
      blob: true,
    }),
    hubSchedule({ providerOutput: 'standalone' }),
  ],
})
```

The `netlify` preset selects the Netlify Blobs driver and the Agent function output. Each static Schedule Definition generates a function such as `.netlify/v1/functions/vitehub-schedule-heartbeat.mjs`.

## Generated functions

A Netlify-shaped build writes the generated functions and wrappers to their provider-owned directories.

```bash [Terminal]
pnpm build
find .netlify/v1/functions -maxdepth 2 -type f | sort
find .vitehub/agent -maxdepth 2 -type f | sort
```

For Nuxt, replace the wrapper inspection command with `find .nuxt/vitehub/agent -maxdepth 2 -type f | sort`, or use the equivalent path under a custom `buildDir`.

## Features without a Netlify provider

ViteHub does not infer Netlify providers for Queue, Rate Limit, Sandbox, or Workflow. On the `netlify` preset, `queue: true`, `rateLimit: true`, and `sandboxTask: true` fail the build. Workflow stays off when only `agent` enables it; an explicit `workflow` option needs `workflow.provider`. Select an external provider only when it is valid from the Netlify runtime.

The ViteHub Provision CLI does not create Netlify resources. It currently accepts Cloudflare and Vercel plans only. Netlify Blobs stores need no provisioning; see [Resources without provisioning](/docs/development/provisioning#resources-without-provisioning).

Netlify-specific KV Provider Output is also not provided. Configure a remote KV driver explicitly for deployed state; do not rely on the local `fs-lite` fallback in a serverless deployment.

Workspace has no Netlify-specific hosted store. Select a durable remote Workspace store explicitly; the local filesystem fallback does not persist safely across serverless instances.

## Production proof

Pull-request CI exercises the Netlify output through Netlify CLI. ViteHub does not currently publish a deployed Netlify Live Smoke, so verify the generated functions in the target Netlify site before treating an application-specific combination as production-proven.

## Next steps

- [Runtime and host support](/docs/frameworks-hosts/support-matrix)
- [Provider output](/docs/reference/provider-output)
- [Import paths](/docs/reference/import-paths)
