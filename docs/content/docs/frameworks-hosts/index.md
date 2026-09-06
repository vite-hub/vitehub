---
title: Frameworks and hosts
description: See what ViteHub configures for each framework and deployment host.
navigation.title: Overview
navigation.order: 40
navigation.group: Choose a target
icon: i-lucide-network
---

ViteHub discovers definitions during the Vite build, then prepares the files and
bindings required by the selected host. Application code keeps using ViteHub
imports instead of generated paths or provider SDKs.

Host support remains package-specific. A host can support one primitive without supporting every ViteHub package, and a Runtime Helper can work without a ViteHub-generated deployment bundle.

## Choose a host

| Need | Open |
| --- | --- |
| Compare current host coverage and proof maturity | [Runtime and host support](/docs/frameworks-hosts/support-matrix) |
| Generate Cloudflare Worker output and bindings | [Cloudflare](/docs/frameworks-hosts/cloudflare) |
| Generate Vercel Build Output | [Vercel](/docs/frameworks-hosts/vercel) |
| Use package-specific Netlify functions and Blob runtime | [Netlify](/docs/frameworks-hosts/netlify) |
| Run Agent routes, schedules, or KV on Deno | [Deno](/docs/frameworks-hosts/deno) |
| Understand package-owned Nitro bridges | [Nitro and UnJS](/docs/frameworks-hosts/nitro-unjs) |
| Mount supported helpers in a Node-shaped server | [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) |

## What the Vite integration does

| Step | Result |
| --- | --- |
| Discover definitions | Finds named Agents, Workspaces, queues, workflows, and other configured resources. |
| Generate registries | Lets server code load discovered definitions by name. |
| Resolve options | Applies the host and provider choices from `vite.config.ts`. |
| Write host output | Generates only the bindings, routes, functions, or config supported by that package. |

## Compose integrations

Use `vite-hub` in applications. Queue remains opt-in, and each feature keeps its
own public import.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: "node" })],
})
```

Register an individual `hubX()` integration from its `@vite-hub/*/vite` package
when a library or focused integration needs direct control.

## Keep runtime imports stable

Import server APIs through documented ViteHub paths. Do not import framework
virtual modules or generated files unless a reference page marks the path public.

```ts [server/settings.ts]
import { kv } from 'vite-hub/kv'

export async function saveSettings(settings: Record<string, unknown>) {
  const [error] = await kv.set('settings', settings)
  if (error) throw error
}
```

## Inspect the output

Vite development proves discovery and local generation. A production build
creates the output for the selected host. Netlify development can also create
functions for the Netlify CLI.

```bash [Terminal]
pnpm dev
find .vitehub -maxdepth 4 -type f | sort
pnpm build
```

## Next steps

- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) before making a portability claim.
- Use [File conventions](/docs/reference/file-conventions) for discovery paths.
- Use [Provider output](/docs/reference/provider-output) for generated host artifacts.
- Use [Local development](/docs/development) for proof paths.
