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

The module needs Nitro 3. Use one of these Nuxt versions:

- **Nuxt 4.7** or a newer 4.x release, with the `nitro` package: `pnpm add nuxt@^4.7.0 nitro`. Nuxt 4.7 builds the server with Nitro 3 and H3 2 only when the app lists `nitro`.
- **Nuxt 5**, which always runs Nitro 3. It is only in nightly builds for now: `pnpm add nuxt@npm:nuxt-nightly@5x`. Use pnpm 11.5 or newer; older versions can hang when they resolve this nightly alias.

On Nuxt 4.7 without `nitro`, or on a Nuxt version before 4.7, module setup stops with [`VITE_HUB_B0023`](/docs/development/diagnostics/vite_hub_b0023). The message gives the command to run.

Nuxt runs Nitro for you, so do not add `nitro()`. Install `vite-hub` and the packages of the features you enable. See [Add feature packages](/docs/getting-started/installation#add-feature-packages).

```bash [Terminal]
pnpm add vite-hub
```

Register the module. It takes the same options as `vitehub()`. ViteHub
detects the [deployment host](/docs/frameworks-hosts#choose-a-host) from the build.

```ts [nuxt.config.ts]
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [viteHubNuxt],
})
```

It also reads the top-level `vitehub` key in `nuxt.config.ts`, from the app
and from each layer. ViteHub merges the two forms one option at a time. Where
both set the same option, the inline value wins. An array replaces the other
array. A feature set to `true`, such as `kv: true`, turns the feature on and
keeps the options that the other form sets:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: [
    ["vite-hub/nuxt", { kv: true }],
  ],
  // KV uses Redis: `kv: true` does not remove these options.
  vitehub: { kv: { driver: "redis" } },
})
```

## Build the application

Run Nuxt's normal commands. The module sets Nitro's preset from the ViteHub
host, so do not add `nitro()`. Without `host`, the module takes the host from
`nitro.preset`, such as `cloudflare-module`. A `nitro.preset` for a different
host than `host` fails module setup.

```bash [Terminal]
pnpm nuxt dev
pnpm nuxt build
```

## Server auto-imports

The module follows Nuxt's server auto-imports. When Nuxt auto-imports the
Nitro and H3 helpers, the module also auto-imports the ViteHub helpers of each
feature that you turn on, such as `kv`, `db`, `sendQueue`, and
`requireRateLimit`, and `nuxt typecheck` knows their types.

- **Nuxt 4.7:** server auto-imports are on by default. Nuxt 4.7 turns on its
  `nitroLegacy` layer, which keeps them, unless `future.compatibilityVersion`
  is 5. Set `experimental: { nitroAutoImports: false }` to turn them off.
- **Nuxt 5:** server auto-imports are off by default. Server code imports
  ViteHub helpers from their `vite-hub/*` paths.

Explicit imports from `vite-hub/*` work on both versions. On Nuxt 5, turn on
Nuxt's own switch to auto-import the helpers. Install `@vite-hub/kv` for this
example.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: [['vite-hub/nuxt', { kv: true }]],
  experimental: { nitroAutoImports: true },
})
```

```ts [server/api/visits.get.ts] fragment
export default defineEventHandler(async () => {
  const [error, visits] = await kv.get<number>('visits')
  if (error) throw error
  return { visits: visits ?? 0 }
})
```

When the app or another module already gives a name, such as `db` from
`server/utils/db.ts`, that source wins and ViteHub logs one warning.

[Nuxt server folders and auto-imports](/docs/frameworks-hosts/nuxt-server-auto-imports)
lists each folder that the module scans and the auto-imports of each feature.

## Vue auto-imports

The module also auto-imports the Vue composables of each feature that you turn
on, such as `useCollection`, `useChat`, and `useUserSession`. They have no
prefix.

When the app gives the same name, the app wins. This is true for a file in
`composables/` or `utils/` of the app or a layer, and for an entry in
`imports.imports`, an import preset, or another module. ViteHub skips its
composable and logs one warning per name, with the source Nuxt selects and the
ViteHub import path. For example, `composables/useChat.ts`
replaces the ViteHub `useChat`. Import the ViteHub composable from its
`vite-hub/*` path where you need it.

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
| Database on Cloudflare | With the `cloudflare` host, `database` defaults to `driver: 'cloudflare'`: one D1 host resource that Nitro and Nuxt Content share. |
| Server auto-imports | On by default on Nuxt 4.7, off by default on Nuxt 5. When they are on, server code uses the helpers of each enabled feature without an import. See [Server auto-imports](#server-auto-imports). |
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
