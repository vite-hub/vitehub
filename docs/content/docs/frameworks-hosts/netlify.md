---
title: Netlify
description: Use the ViteHub package contracts that have explicit Netlify runtime or function output.
navigation.order: 45
navigation.group: Deployment hosts
icon: i-simple-icons-netlify
---

Netlify support is package-specific. ViteHub currently provides Netlify-owned behaviour for Blob, generated Agent HTTP routes, and static Schedule wake functions; it does not expose a platform-wide Netlify provider for every primitive.

## Available boundaries

| Surface | Current contract |
| --- | --- |
| Blob | `hubBlob()` selects the `netlify-blobs` driver when the build reports Netlify hosting. Application code continues to use `@vite-hub/blob`. |
| Agent routes | `hubAgent()` writes one `vitehub-agent` function when hosted Agent Definitions exist. It mounts the conventional chat dispatcher and webhook route; route-enabled Channels select which Agents answer chat requests. `routes.discordGateway` remains explicit. |
| Static schedules | `hubSchedule()` writes one scheduled Netlify function per discovered static Schedule Definition. |
| Local proof | The repository runs a real-project fixture through Netlify CLI in pull-request CI. |

Agent function output lives under `.netlify/v1/functions`, with its generated source wrapper under `.vitehub/agent/netlify-function.mjs`. The wrapper and deployed function are Provider Output, not public application imports.
In a Nuxt app, the source wrapper follows Nuxt's build directory and is normally `.nuxt/vitehub/agent/netlify-function.mjs`; the deployed function path is unchanged.

## Package output composition

Each active package integration contributes only its owned Netlify output.

```ts [vite.config.ts]
import { hubAgent } from '@vite-hub/agent/vite'
import { hubBlob } from '@vite-hub/blob/vite'
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubBlob(),
    hubSchedule(),
    hubAgent(),
  ],
})
```

Netlify environment detection selects the Blob driver and Agent function output. Static Schedule Definitions generate Netlify functions alongside the other supported Schedule output families.

## Generated functions

A Netlify-shaped build writes the generated functions and wrappers to their provider-owned directories.

```bash [Terminal]
pnpm build
find .netlify/v1/functions -maxdepth 2 -type f | sort
find .vitehub/agent -maxdepth 2 -type f | sort
```

For Nuxt, replace the wrapper inspection command with `find .nuxt/vitehub/agent -maxdepth 2 -type f | sort`, or use the equivalent path under a custom `buildDir`.

## Unsupported inference

ViteHub does not infer native Netlify providers for Queue, Workflow, or Sandbox. Disable an unused preset integration or select an explicit supported provider only when that external provider is valid from the Netlify runtime.

The ViteHub Provision CLI does not create Netlify resources. It currently accepts Cloudflare and Vercel plans only.

Netlify-specific KV Provider Output is also not provided. Configure a remote KV driver explicitly for deployed state; do not rely on the local `fs-lite` fallback in a serverless deployment.

Workspace has no Netlify-specific hosted store. Select a durable remote Workspace store explicitly; the local filesystem fallback does not persist safely across serverless instances.

## Production proof

Pull-request CI exercises the Netlify output through Netlify CLI. ViteHub does not currently publish a deployed Netlify Live Smoke, so verify the generated functions in the target Netlify site before treating an application-specific combination as production-proven.

## Related pages

- [Runtime and host support](/docs/frameworks-hosts/support-matrix)
- [Provider output](/docs/reference/provider-output)
- [Import paths](/docs/reference/import-paths)
