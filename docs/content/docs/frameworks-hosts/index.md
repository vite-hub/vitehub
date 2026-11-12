---
title: Frameworks and hosts
description: Choose a framework integration and a deployment preset, and see what ViteHub builds for each host.
navigation.title: Overview
navigation.order: 40
navigation.group: Choose a target
icon: i-lucide-network
---

Pick one framework integration and one deployment preset (a named host
target). At build time, ViteHub finds your Definitions and writes the files and
bindings the host needs. Your code keeps ViteHub imports, not generated paths
or provider SDKs.

## Choose a framework

| Framework | Register | Guide |
| --- | --- | --- |
| Vite | `vitehub()` from `vite-hub`. It includes Nitro's Vite plugin. | [Installation](/docs/getting-started/installation) |
| Nuxt | The `vite-hub/nuxt` module | [Nuxt](/docs/frameworks-hosts/nuxt) |

Both build the server output with Nitro.
[Nitro and UnJS](/docs/frameworks-hosts/nitro-unjs) explains where ViteHub
packages register Nitro handlers. To move a Nuxt app off NuxtHub, read
[Migrate from NuxtHub](/docs/getting-started/migrate-from-nuxthub).

## Choose a preset

`preset` selects the host, the Nitro preset, and each feature's default
provider. Without it, ViteHub detects the host in this order:

1. `VITEHUB_HOSTING`
2. `NITRO_PRESET`, then `SERVER_PRESET`
3. The build variables the host sets, the same ones Nitro reads:
   `WORKERS_CI` (Cloudflare Workers Builds), `NETLIFY`, `NOW_BUILDER`,
   `VERCEL` or `VERCEL_ENV`, then `DENO_DEPLOY` or `DENO_DEPLOYMENT_ID`
4. `node` when none of them is set

Cloudflare Pages is not detected, because the `cloudflare` preset builds a
Worker. Use `detectHost()` from `vite-hub/runtime` to choose
host-specific options in your own config:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { detectHost } from "vite-hub/runtime";

const preset = detectHost() ?? "node";

export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  // The deno preset rejects Schedule.
  vitehub: { preset, schedule: preset !== "deno" },
});
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { vitehub } from "vite-hub";
import { detectHost } from "vite-hub/runtime";
import { defineConfig } from "vite";
import { nitro } from "nitro/vite";

const preset = detectHost() ?? "node";

export default defineConfig({
  // The deno preset rejects Schedule.
  plugins: [vitehub({ preset, schedule: preset !== "deno" }), nitro()],
});
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from "vite-hub";
import { detectHost } from "vite-hub/runtime";
import { defineConfig } from "vite";

const preset = detectHost() ?? "node";

export default defineConfig({
  // The deno preset rejects Schedule.
  plugins: [vitehub({ preset, schedule: preset !== "deno" })],
});
```
:::
::

`detectHost()` returns `undefined` when no variable names a host, so the
app picks its own default. Inside a Cloudflare Worker, it returns
`"cloudflare"`.

| Preset | Guide | Production output | Default providers | Rejected when enabled with `true` |
| --- | --- | --- | --- | --- |
| `node` | [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) | `.output/server/index.mjs` | Blob `fs`, KV `database` with Postgres or `fs-lite`, Queue `local`, Rate Limit `memory` | Realtime, Sandbox, Schedule |
| `cloudflare` | [Cloudflare](/docs/frameworks-hosts/cloudflare) | `.output/server/wrangler.json` | Blob R2, KV Workers KV, Queue, Rate Limit, and Sandbox on Cloudflare | None |
| `vercel` | [Vercel](/docs/frameworks-hosts/vercel) | `.vercel/output/**` | Blob Vercel Blob, KV Upstash Redis, Vercel Queues, Vercel Sandbox | Rate Limit, Realtime |
| `netlify` | [Netlify](/docs/frameworks-hosts/netlify) | `.netlify/**` | Blob Netlify Blobs | Agent, Queue, Rate Limit, Realtime, Sandbox |
| `deno` | [Deno](/docs/frameworks-hosts/deno) | `.output/server/index.mjs` | KV Deno KV | Blob, Queue, Rate Limit, Realtime, Sandbox, Schedule |

- A rejected feature fails the build. It does not fall back to another provider.
- On `node`, Schedule needs `schedule: { runtime: { driver: "process" } }` and
  Realtime needs `realtime: { authority: "memory" }`. On `netlify`, Agent needs
  `agent: { invocations: false }`.
- Browser and `email: true` require the `cloudflare` preset.
- Blob without an explicit store requires a preset with a Blob provider.
- KV without an explicit driver uses Upstash Redis on every preset except
  `deno` when `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set at build time.
- ViteHub sets the Nitro preset. The build fails when `nitro.preset`,
  `NITRO_PRESET`, or `SERVER_PRESET` names a different one.

The [support matrix](/docs/frameworks-hosts/support-matrix) lists every
primitive on every host, with explicit provider choices.

## Keep runtime imports stable

Import server APIs from documented ViteHub paths so the same code runs on
every preset. Do not import framework virtual modules or generated files
unless a reference page marks the path public.

```ts [server/settings.ts]
import { kv } from 'vite-hub/kv'

export async function saveSettings(settings: Record<string, unknown>) {
  const [error] = await kv.set('settings', settings)
  if (error) throw error
}
```

Libraries can register one `hubX()` integration from its `@vite-hub/*/vite`
package instead of `vitehub()`.

## Inspect the output

Development proves discovery and local generation. A production build writes
the output for the preset. List the generated host files with the CLI:

```bash [Terminal]
pnpm build
pnpm vitehub inspect output
```

## Next steps

- Read [Production deployment](/docs/frameworks-hosts/production) before you serve traffic.
- Use [Provider output](/docs/reference/provider-output) for generated host artifacts.
- Use [File conventions](/docs/reference/file-conventions) for discovery paths.
- Use [Local development](/docs/development) for local checks.
