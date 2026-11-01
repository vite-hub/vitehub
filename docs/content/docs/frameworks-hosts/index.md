---
title: Frameworks and hosts
description: Choose a framework integration and a deployment preset, and see what ViteHub builds for each host.
navigation.title: Overview
navigation.order: 40
navigation.group: Choose a target
icon: i-lucide-network
---

Use this section to choose where your application runs. You select one
framework integration and one deployment preset. ViteHub then discovers your
Definitions during the build and writes the files and bindings that the host
needs. Application code keeps using ViteHub imports instead of generated paths
or provider SDKs.

## Choose a framework

| Framework | Register | Guide |
| --- | --- | --- |
| Vite | `vitehub()` from `vite-hub`. It includes Nitro's Vite plugin. | [Installation](/docs/getting-started/installation) |
| Nuxt | The `vite-hub/nuxt` module | [Nuxt](/docs/frameworks-hosts/nuxt) |

Both integrations use Nitro to build the server output.
[Nitro and UnJS](/docs/frameworks-hosts/nitro-unjs) explains where ViteHub
packages register Nitro handlers.

To move a Nuxt application from NuxtHub, read
[Migrate from NuxtHub](/docs/getting-started/migrate-from-nuxthub).

## Choose a preset

`preset` selects the host, the Nitro preset, and the provider that each
enabled feature uses by default. When you omit it, ViteHub detects the host
in this order:

1. `VITEHUB_HOSTING`
2. `NITRO_PRESET`, then `SERVER_PRESET`
3. The variables that the host sets during its build, the same ones Nitro
   reads: `WORKERS_CI` (Cloudflare Workers Builds), `NETLIFY`, `NOW_BUILDER`,
   `VERCEL` or `VERCEL_ENV`, then `DENO_DEPLOY` or `DENO_DEPLOYMENT_ID`
4. `node` when none of them is set

Cloudflare Pages is not detected, because the `cloudflare` preset builds a
Worker. Use `detectPreset()` from `vite-hub/deployment` to choose
host-specific options in your own config:

```ts
// vite.config.ts
import { vitehub } from "vite-hub";
import { detectPreset } from "vite-hub/deployment";
import { defineConfig } from "vite";

const preset = detectPreset() ?? "node";

export default defineConfig({
  // The deno preset rejects Schedule.
  plugins: [vitehub({ preset, schedule: preset !== "deno" })],
});
```

`detectPreset()` returns `undefined` when no variable names a host, so the
app picks its own default.

| Preset | Guide | Production output | Default providers | Rejected when enabled with `true` |
| --- | --- | --- | --- | --- |
| `node` | [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) | `.output/server/index.mjs` | Blob `fs`, KV `fs-lite`, Rate Limit `memory` | Queue, Sandbox |
| `cloudflare` | [Cloudflare](/docs/frameworks-hosts/cloudflare) | `.output/server/wrangler.json` | Blob R2, KV Workers KV, Queue, Rate Limit, and Sandbox on Cloudflare | None |
| `vercel` | [Vercel](/docs/frameworks-hosts/vercel) | `.vercel/output/**` | Blob Vercel Blob, KV Upstash Redis, Vercel Queues, Vercel Sandbox | Rate Limit |
| `netlify` | [Netlify](/docs/frameworks-hosts/netlify) | `.netlify/**` | Blob Netlify Blobs | Queue, Rate Limit, Sandbox |
| `deno` | [Deno](/docs/frameworks-hosts/deno) | `.output/server/index.mjs` | KV Deno KV | Blob, Queue, Rate Limit, Sandbox, Schedule |

A rejected feature fails the build. It does not fall back to another provider.
Browser and `email: true` require the `cloudflare` preset. Blob without an
explicit store also requires a preset with a Blob provider. When KV has no
explicit driver, every preset except `deno` selects Upstash Redis if
`KV_REST_API_URL` and `KV_REST_API_TOKEN` are set during the build.

ViteHub sets the Nitro preset. The build fails when `nitro.preset`,
`NITRO_PRESET`, or `SERVER_PRESET` selects a different one. The
[support matrix](/docs/frameworks-hosts/support-matrix) lists every primitive
for every host, including explicit provider choices.

## Keep runtime imports stable

Import server APIs through documented ViteHub paths. The same code runs on every
preset. Do not import framework virtual modules or generated files unless a
reference page marks the path public.

```ts [server/settings.ts]
import { kv } from 'vite-hub/kv'

export async function saveSettings(settings: Record<string, unknown>) {
  const [error] = await kv.set('settings', settings)
  if (error) throw error
}
```

Libraries and focused integrations can register an individual `hubX()`
integration from its `@vite-hub/*/vite` package instead of `vitehub()`.

## Inspect the output

Vite development proves discovery and local generation. A production build
writes the output for the selected preset. List the generated host files with
the CLI.

```bash [Terminal]
pnpm build
pnpm vitehub inspect provider-output
```

## Next steps

- Read [Production deployment](/docs/frameworks-hosts/production) before you serve traffic.
- Use [Provider output](/docs/reference/provider-output) for generated host artifacts.
- Use [File conventions](/docs/reference/file-conventions) for discovery paths.
- Use [Local development](/docs/development) for local checks.
