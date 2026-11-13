---
title: Nuxt
description: Register ViteHub in a Nuxt application and see what the Nuxt module does differently from the Vite integration.
navigation.order: 41.5
navigation.group: Frameworks
icon: i-simple-icons-nuxt
---

The `vite-hub/nuxt` module installs the same Vite integrations as `vitehub()`
and passes their Nitro configuration through Nuxt's build. Server code uses
the same `vite-hub/*` imports as a Vite app.

## Install the module

Use Nuxt 5, which runs Nitro 3. Nuxt 5 is only in nightly builds for now: `pnpm add nuxt@npm:nuxt-nightly@5x`. Use pnpm 11.5 or newer; older versions can hang when they resolve this nightly alias. Nuxt has its own Nitro, so install only `vite-hub` and the packages of the features you enable. See [Add feature packages](/docs/getting-started/installation#add-feature-packages).

```bash [Terminal]
pnpm add vite-hub
```

Register the module with a [deployment host](/docs/frameworks-hosts#choose-a-host).
It takes the same options as `vitehub()`.

```ts [nuxt.config.ts]
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [
    [viteHubNuxt, { host: "node" }],
  ],
})
```

It also reads the top-level `vitehub` key in `nuxt.config.ts`. Inline module
options win.

## Build the application

Run Nuxt's normal commands. The module sets Nitro's preset from the ViteHub
host, so do not add `nitro()` or set another `nitro.preset`. A conflicting
`nitro.preset` fails module setup.

```bash [Terminal]
pnpm nuxt dev
pnpm nuxt build
```

## Server auto-imports

On Nuxt 5, the module auto-imports the server helpers of each feature that you
turn on, such as `kv`, `db`, `sendQueue`, and `requireRateLimit`. Server code
uses them without an import, and `nuxt typecheck` knows their types.

```ts [server/api/visits.get.ts] fragment
import { defineEventHandler } from 'nitro/h3'

export default defineEventHandler(async () => {
  const [error, visits] = await kv.get<number>('visits')
  if (error) throw error
  return { visits: visits ?? 0 }
})
```

They are on by default. To turn them off, set `nitro: { imports: false }` in
`nuxt.config.ts`. Then import each helper from its `vite-hub/*` path.

[Nuxt server folders and auto-imports](/docs/frameworks-hosts/nuxt-server-auto-imports)
lists each folder that the module scans and the auto-imports of each feature.

## Nuxt layers

ViteHub scans the server directory of the app and of every layer it extends.
A layer can own an Auth Definition, Database tables, Agents, or any other
Definition. The app needs no extra code to use them.

```txt [File tree]
app/
  nuxt.config.ts          # extends: ['../layers/accounts', '../layers/blog']
layers/
  accounts/
    server/auth.ts
    server/databases/default.ts   # users table
  blog/
    server/databases/default.ts   # posts table
```

The app wins over its layers:

- An Auth Definition in the app replaces the layer ones. Two layers with an
  Auth Definition fail discovery until the app defines one.
- Database Definitions with the same name merge into one database. See
  [Tables from Nuxt layers](/docs/database/configure#tables-from-nuxt-layers).
- Other Definitions keep one identity per name. Two layers, or a layer and the
  app, with the same identity fail discovery and list both files.

Run `pnpm vitehub inspect definitions` to see which file supplies each
Definition.

## Differences from the Vite integration

| Concern | Nuxt behavior |
| --- | --- |
| Generated types | The module adds the `.vitehub` declarations to the Nuxt and Nitro TypeScript configs, not to `tsconfig.json`. |
| Generated Agent files | Agent route handlers and wrappers go to `<buildDir>/vitehub/agent/**`, normally `.nuxt/vitehub/agent/**`, not `.vitehub/agent/**`. Discovery still uses `server/agents`. |
| Database on Cloudflare | With the `cloudflare` host, `database` defaults to `driver: 'd1'`: one D1 host resource that Nitro and Nuxt Content share. |
| Server auto-imports | On Nuxt 5, server code uses the helpers of each enabled feature without an import. See [Server auto-imports](#server-auto-imports). |
| Database tables from modules | A Nuxt module adds tables with the same Vite plugin as a Vite app. Push the plugin to `nuxt.options.vite.plugins` during setup. See [Contribute tables from a Nuxt module](/docs/database/configure#contribute-tables-from-a-nuxt-module). |
| Connections | As in Vite, `connections` turns on `database` and, without a Database Definition, adds the empty `default` Database. Production builds mount the management API only with `connections: { management: { actor } }`, behind your actor policy. |

## Env and Nuxt runtime config

Nuxt 5 can validate `runtimeConfig` itself. Put a Standard Schema as a
`runtimeConfig` value, and Nuxt applies `NUXT_*` variables, coerces them, and
checks them when the server starts. `useRuntimeConfig()` gets the types of the
schemas. Nuxt converts each schema to JSON Schema, so it checks types,
required keys, enums, objects, and arrays, but not formats, ranges, patterns,
refinements, or transforms.

Env does not read or write `runtimeConfig`. The two work side by side in one
application, so pick per value:

| You need | Use |
| --- | --- |
| A value that `useRuntimeConfig()` and other Nuxt modules read | Nuxt `runtimeConfig` |
| A secret that stays wrapped until code unseals it | `env.server` with `secret: true` |
| A browser value that is fixed during the build | `env.public` |
| A URL, range, pattern, refinement, or transform check on a server value | `env.server` with [`env.schemaFrom()`](/docs/env/configure#validate-server-env-with-your-own-schema) |
| Values from a secret manager | `env.server` with [`env.provider()`](/docs/env/server-api) |

Nuxt reads `runtimeConfig.public` again when the server starts. Env Public
values do not change after the build. Env checks Server Env when server code
reads it, not when the server starts.

## Inspect the output

Generated Agent files are in Nuxt's build directory. Other `.vitehub` files
and the production output use the same paths as a Vite app.

```bash [Terminal]
find .nuxt/vitehub -maxdepth 4 -type f | sort
pnpm vitehub inspect output
```

## Next steps

- Choose a host guide from [Frameworks and hosts](/docs/frameworks-hosts).
- Read [Generated files](/docs/development/generated-files) for the other generated paths.
- Read [Nuxt server folders and auto-imports](/docs/frameworks-hosts/nuxt-server-auto-imports) for each feature's helpers.
- Read [Import paths](/docs/reference/import-paths) for public imports.
