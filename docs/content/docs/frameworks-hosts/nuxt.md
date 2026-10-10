---
title: Nuxt
description: Register ViteHub in a Nuxt application and see what the Nuxt module does differently from the Vite integration.
navigation.order: 41.5
navigation.group: Frameworks
icon: i-simple-icons-nuxt
---

Use this page to add ViteHub to a Nuxt application. The `vite-hub/nuxt` module
installs the same Vite integrations as `vitehub()` and carries their Nitro
configuration through Nuxt's build. Server code uses the same `vite-hub/*`
imports as a Vite application.

## Install the module

Use Nuxt 4.5.2 or newer. Nuxt provides its own Nitro integration, so install
only `vite-hub`.

```bash [Terminal]
pnpm add vite-hub
```

Register the module with a [deployment preset](/docs/frameworks-hosts#choose-a-preset).
The module accepts the same options as `vitehub()`.

```ts [nuxt.config.ts]
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [
    [viteHubNuxt, { preset: "node" }],
  ],
})
```

The module also reads options from the top-level `vitehub` key in
`nuxt.config.ts`. Inline module options take precedence.

## Build the application

Run Nuxt's normal commands. The module sets Nitro's preset from the ViteHub
preset, so do not add `nitro()` or set a different `nitro.preset`. A conflicting
`nitro.preset` fails during module setup.

```bash [Terminal]
pnpm nuxt dev
pnpm nuxt build
```

## Differences from the Vite integration

| Concern | Nuxt behavior |
| --- | --- |
| Generated types | The module adds the `.vitehub` declarations to the Nuxt and Nitro TypeScript configs. You do not add them to `tsconfig.json`. |
| Generated Agent files | Agent route handlers and wrappers are written under `<buildDir>/vitehub/agent/**`, normally `.nuxt/vitehub/agent/**`, instead of `.vitehub/agent/**`. Agent discovery still uses `server/agents`. |
| Database on Cloudflare | With the `cloudflare` preset, `database` defaults to `driver: 'd1'`. This configures one D1 host resource that Nitro and Nuxt Content share. |
| Console | The Console runs as Nuxt pages. Install `@nuxt/ui`, `@iconify-json/lucide`, and `@iconify-json/ph`. Read [Console](/docs/development/console). |
| Server auto-imports | When Nitro auto-imports are on, server code can use `kv` (with `kv`), `blob` (with `blob`), and `db` and `schema` (with `database`) without an import. Explicit `vite-hub/*` imports also work. An entry with the same name from another source fails module setup. |
| Connections | Not supported by the Nuxt module yet. `connections` fails during module setup. Use the Vite integration for Connections. |

## Inspect the output

Inspect generated Agent files in Nuxt's build directory. Other `.vitehub` files
and the preset's production output use the same paths as a Vite application.

```bash [Terminal]
find .nuxt/vitehub -maxdepth 4 -type f | sort
pnpm vitehub inspect provider-output
```

## Next steps

- Choose a host guide from [Frameworks and hosts](/docs/frameworks-hosts).
- Read [Generated files](/docs/development/generated-files) for the other generated paths.
- Read [Import paths](/docs/reference/import-paths) for public imports.
