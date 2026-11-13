---
title: Generated files
description: Find and inspect the files ViteHub generates, without importing them in your app.
navigation.order: 36
navigation.group: Build state
icon: i-lucide-file-cog
---

ViteHub writes these files in development and builds. They show how it
resolved Definitions, Runtime Registries, stable imports, and Provider Output
(the files built for your host). Your app code uses documented ViteHub imports,
not these files.

## Common generated paths

| Path | Owner | Purpose |
| --- | --- | --- |
| `.vitehub/types.d.ts` | ViteHub Framework | Entry that references every declaration file under `.vitehub`. |
| `.vitehub/env/public.mjs` | Env Package | Public Env runtime module. |
| `.vitehub/env/server.mjs` | Env Package | Server Env runtime module. |
| `.vitehub/types/env.d.ts` | Env Package | Public Env and Server Env types. |
| `.vitehub/types/blob.d.ts` | Blob Package | Blob store names from `blob.stores`. |
| `.vitehub/types/browser.d.ts` | Browser Package | Browser Definition names and input/result module types. |
| `.vitehub/types/email.d.ts` | Email Package | Exact module declarations for discovered `#vitehub/emails/<name>` imports. |
| `.vitehub/types/workspace.d.ts` | Workspace Package | Workspace name types. |
| `.vitehub/types/source/collections.d.ts` | Source Package | Collection names and definitions. |
| `.vitehub/email/templates/*.mjs` | Email Package | Bundled Markdown email templates used by provider builds. |
| `.vitehub/rate-limit/manifest.json` | Rate Limit Package | Sorted Rate Limit IDs, resolved providers, and inspectable driver capabilities. |
| `.vitehub/nitro/realtime/registry.mjs` | Realtime Package | Registry of discovered Realtime Definitions. |
| `.vitehub/nitro/realtime/handler.ts` | Realtime Package | WebSocket, save, refresh, and checkpoint route handler. |
| `.vitehub/agent/chat-webhook-route.ts` | Agent Package | Chat Webhook Route handler for chat-capable Agents. |
| `.vitehub/agent/discord-gateway-plugin.ts` | Agent Package | Nitro process lifecycle for Discord Gateway listeners on the Node preset. |
| `.vitehub/agent/discord-gateway-route.ts` | Agent Package | Nitro route handler that wakes the Discord Gateway listener for Discord Agents. |
| `.vitehub/agent/registry-dev-plugin.ts` | Agent Package | `vite dev` only. Nitro plugin that gives the Agent package the generated Agent registry, and the KV package when KV is configured. |
| `.vitehub/nitro/connections/registry-dev-plugin.ts` | Connections Package | `vite dev` only. Nitro plugin that gives the Connections package the generated Connection registry. |
| `.vitehub/nitro/dev-defines.mjs` | ViteHub Framework | `vite dev` only. Nitro plugin that sets the `__VITEHUB_*__` build constants as globals for packages that Node loads. |
| `.vitehub/agent/deno-server.ts` | Agent Package | Standalone Deno server for Agent chat and webhook routes. Written only when the Agent integration sets `runtime: 'deno'`. The `deno` preset serves Agent routes from Nitro instead. |
| `.vitehub/schedule/deno-cron.mjs` | Schedule Package | Deno `Deno.cron` wake output for Static Schedule Definitions. |
| `.vitehub/nitro/schedule/*` | Schedule Package | Narrow Nitro bridge for Schedule Provider Wake. |
| `.vitehub/provision.json` | ViteHub CLI | Non-secret Provision State read by Vite Integrations. |
| `.output/server/index.mjs` | Provider Output | Server entry for the `node`, `cloudflare`, and `deno` presets. |
| `.output/server/wrangler.json` | Provider Output | Cloudflare Worker config written by a `cloudflare` preset build. |
| `.vercel/output/**` | Provider Output | Vercel Build Output written by a `vercel` preset build. |
| `.netlify/v1/functions/**` | Provider Output | Netlify Agent and static Schedule functions from their package integrations. |

In `vite dev`, Node loads the Agent, Workspace, Connections, and runtime packages straight from `node_modules`. Vite transforms only your code, generated modules, and other ViteHub packages. Those Node-loaded packages cannot read Vite virtual modules or `define` constants, so the `vite dev` only plugins give them these values at Nitro start and after each reload. Builds bundle the packages and skip these plugins.

Nuxt puts the `.vitehub/agent/**` files in its build directory instead, under `<buildDir>/vitehub/agent/**` (normally `.nuxt/vitehub/agent/**`). Agent discovery still uses the project and server directories.

## Inspect generation

After a production build, the CLI lists the host output: which files the
packages and preset write, and if each exists. It hides secrets.

```bash [Terminal]
pnpm build
pnpm vitehub inspect output
```

List the files in `.vitehub` after Vite starts or builds. The set depends on
your features and preset.

```bash [Terminal]
find .vitehub -maxdepth 4 -type f | sort
```

For Nuxt, list its own directory:

```bash [Terminal]
find .nuxt/vitehub -maxdepth 4 -type f | sort
```

Check Rate Limit guarantees before you deploy. The manifest uses `schemaVersion: 2` and has sorted `rateLimits` entries with `name`, `provider`, and `capabilities`. It is for agents and tools, not an application import.

```bash [Terminal]
cat .vitehub/rate-limit/manifest.json
```

Read env values through the stable import paths, not the files behind them.

```ts [server/config.ts]
import { useServerEnv } from 'vite-hub/env'

const env = useServerEnv()
```

## Include generated types

For a Vite app, extend `vite-hub/tsconfig`. It includes `.vitehub/types.d.ts`,
which references the types of your enabled features. Use TypeScript 5.5 or
newer. Keep your compiler options.

```json [tsconfig.json]
{
  "extends": ["vite-hub/tsconfig"],
  "include": ["server/**/*.ts", "src/**/*.ts", "vite.config.ts"]
}
```

Generate the types after install and before a separate type check:

```bash [commands/prepare-types]
pnpm vitehub types prepare
```

Once the ViteHub config exists, add `"postinstall": "vitehub types prepare"`
to your scripts so later installs refresh types. Vite config resolution and
builds also refresh the entry. If you set `files`, add `.vitehub/types.d.ts`,
because `files` replaces the inherited list.

In Nuxt, keep its generated TypeScript config. The ViteHub module adds its
types during Nuxt prepare.

## Regenerate after edits

Packages refresh generated files at dev start, on hot updates, or in build
hooks. If a file does not match your Definitions, restart the dev server.

```bash [Terminal]
pnpm dev
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Stable import does not resolve | Types are missing, or the Vite integration did not run. | Extend `vite-hub/tsconfig`, run `pnpm vitehub types prepare`, and restart Vite. Check that your `files` list includes `.vitehub/types.d.ts`. For Nuxt, run `pnpm nuxt prepare`. |
| Generated registry is empty | The file path does not match the package convention. | Check [File conventions](/docs/reference/file-conventions). |
| Provider output is stale | The build skipped provider output in dev or e2e mode. | Run a production build. |
| Provision ids are missing | Provision State was never written, or env vars override it. | Run `vitehub provision run --dry-run`, then apply with credentials if needed. |

## Next steps

- [Import paths](/docs/reference/import-paths): public imports.
- [Provider output](/docs/reference/provider-output): host files.
- [Runtime and host support](/docs/frameworks-hosts/support-matrix): tested hosts.
- [File conventions](/docs/reference/file-conventions): discovery rules.
