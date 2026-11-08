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

Use Nuxt 5, which runs Nitro 3. Nuxt 5 is only in nightly builds for now: `pnpm add nuxt@npm:nuxt-nightly@5x`. Use pnpm 11.5 or newer; older versions can hang when they resolve this nightly alias. Nuxt has its own Nitro, so install only `vite-hub`.

```bash [Terminal]
pnpm add vite-hub
```

Register the module with a [deployment preset](/docs/frameworks-hosts#choose-a-preset).
It takes the same options as `vitehub()`.

```ts [nuxt.config.ts]
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [
    [viteHubNuxt, { preset: "node" }],
  ],
})
```

It also reads the top-level `vitehub` key in `nuxt.config.ts`. Inline module
options win.

## Build the application

Run Nuxt's normal commands. The module sets Nitro's preset from the ViteHub
preset, so do not add `nitro()` or set another `nitro.preset`. A conflicting
`nitro.preset` fails module setup.

```bash [Terminal]
pnpm nuxt dev
pnpm nuxt build
```

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
    server/databases/config.ts   # users table
  blog/
    server/databases/config.ts   # posts table
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
| Database on Cloudflare | With the `cloudflare` preset, `database` defaults to `driver: 'd1'`: one D1 host resource that Nitro and Nuxt Content share. |
| Console | The Console runs as Nuxt pages. Install `@nuxt/ui`, `@iconify-json/lucide`, and `@iconify-json/ph`. Read [Console](/docs/development/console). |
| Server auto-imports | With Nitro auto-imports on, server code can use `kv` (with `kv`), `blob` (with `blob`), and `db` and `schema` (with `database`) without an import. Explicit `vite-hub/*` imports also work. A same-name entry from another source fails module setup. |
| Database tables from modules | A Nuxt module adds tables with the same Vite plugin as a Vite app. Push the plugin to `nuxt.options.vite.plugins` during setup. See [Contribute tables from a Nuxt module](/docs/database/configure#contribute-tables-from-a-nuxt-module). |
| Connections | As in Vite, `connections` turns on `database` and, without a Database Definition, adds the empty `default` Database. Production builds mount the management API only with `connections: { management: true }`, behind the Console sign-in. |

## Inspect the output

Generated Agent files are in Nuxt's build directory. Other `.vitehub` files
and the production output use the same paths as a Vite app.

```bash [Terminal]
find .nuxt/vitehub -maxdepth 4 -type f | sort
pnpm vitehub inspect provider-output
```

## Next steps

- Choose a host guide from [Frameworks and hosts](/docs/frameworks-hosts).
- Read [Generated files](/docs/development/generated-files) for the other generated paths.
- Read [Import paths](/docs/reference/import-paths) for public imports.
