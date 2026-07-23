---
title: Frameworks and hosts
description: Separate Vite integration, application runtime imports, and package-specific host output.
navigation.title: Overview
navigation.order: 40
icon: i-lucide-network
---

ViteHub separates build integration from runtime hosting. Vite Integrations discover Definitions and prepare package-owned output, while application code uses stable Runtime Helpers that do not expose generated file paths.

Host support remains package-specific. A host can support one primitive without supporting every ViteHub package, and a Runtime Helper can work without a ViteHub-generated deployment bundle.

## Follow the right boundary

| Need | Open |
| --- | --- |
| Compare current host coverage and proof maturity | [Runtime and host support](/docs/frameworks-hosts/support-matrix) |
| Generate Cloudflare Worker output and bindings | [Cloudflare](/docs/frameworks-hosts/cloudflare) |
| Generate Vercel Build Output | [Vercel](/docs/frameworks-hosts/vercel) |
| Use package-specific Netlify functions and Blob runtime | [Netlify](/docs/frameworks-hosts/netlify) |
| Run Agent routes, schedules, or KV on Deno | [Deno](/docs/frameworks-hosts/deno) |
| Understand package-owned Nitro bridges | [Nitro and UnJS](/docs/frameworks-hosts/nitro-unjs) |
| Mount supported helpers in a Node-shaped server | [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) |

## Vite integration responsibilities

| Vite Integration responsibility | Boundary |
| --- | --- |
| Discover Definitions | File conventions produce Discovered Definitions and Discovery Identity. |
| Generate Runtime Registries | App code uses Stable ViteHub Import Paths instead of generated files. |
| Resolve Integration Options | Provider Selection and build-time options become Runtime Config or Provider Output. |
| Write Provider Output | A package generates host artifacts only for the providers it supports. |

## Compose integrations

Use `vite-hub` when the application wants the canonical framework
distribution. Queue remains opt-in, and application APIs stay separated by
intentional feature subpaths.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: "node" })],
})
```

Register individual `hubX()` integrations from their `@vite-hub/*/vite` owner
packages instead when a library or advanced integration needs direct package
control.

## Keep runtime imports stable

Application code should import Runtime Helpers and generated surfaces through ViteHub-owned import paths.
Do not import framework virtual modules or generated files unless a package reference marks that path public.

```ts [server/settings.ts]
import { kv } from 'vite-hub/kv'

export async function saveSettings(settings: Record<string, unknown>) {
  const [error] = await kv.set('settings', settings)
  if (error) throw error
}
```

## Vite output boundary

Vite dev proves discovery and generated local files. Provider-shaped builds prove deployable output, while Netlify local development can also materialise functions for Netlify CLI.

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
