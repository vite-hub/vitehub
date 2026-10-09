---
title: Node and self-hosted
description: Build a Node.js server with the node preset and choose storage that survives restarts.
navigation.order: 47
navigation.group: Deployment hosts
icon: i-lucide-server-cog
---

Use the `node` preset to run a ViteHub application as a Node.js server on your
own machine, a container, or a virtual machine. Nitro builds one server entry at
`.output/server/index.mjs`. Server code uses the same Runtime Helpers as on
hosted presets.

## Configure the preset

Select the `node` preset and enable the features the application uses. This
example stores KV values in local files.

```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
      kv: {
        driver: 'fs-lite',
        base: '.vitehub/data/kv',
      },
    }),
    // SAFETY: Nitro's Vite plugin is runtime-compatible with this Vite version despite its prerelease type identity.
    nitro() as never,
  ],
})
```

Server code calls the Runtime Helper. The store choice stays in the config.

```ts [server/settings.ts]
import { kv } from 'vite-hub/kv'

export async function saveSettings(settings: Record<string, unknown>) {
  const [error] = await kv.set('settings', settings)
  if (error) throw error
}
```

## Build and start the server

Build the application, then start the generated entry with Node.js. Nitro reads
`PORT` and `HOST`, or `NITRO_PORT` and `NITRO_HOST`.

```bash [Terminal]
pnpm build
PORT=3000 node .output/server/index.mjs
```

Copy the whole `.output` directory to the deployment host. Build on the same
operating system and CPU type as the deployment host when the application uses
a built-in coding provider, because the build packages only the build host's
native binaries.

## Defaults on the node preset

| Feature | Default provider | Durability |
| --- | --- | --- |
| Blob | `fs` under `.vitehub/data/blob` | Local files on one host. |
| KV | `fs-lite` | Local files on one host. Upstash Redis when `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set during the build. |
| Rate Limit | `memory` | One process. Counters reset on restart. |
| Queue | None | `queue: true` fails the build. |
| Sandbox | None | `sandbox: true` fails the build. |

Set `dataDir` in `vitehub()` to put local state in one persistent directory, for
example `dataDir: '/var/lib/app'`. ViteHub then stores KV `fs-lite` data, Blob
`fs` data, the Agent State database, the Console journal, and Workspace files
under that directory. `dataDir` works only with the `node` preset.

## Mount a server handler

Some packages expose a stable handler that any Node framework can mount. The Auth
handler accepts a Web `Request` and returns a `Promise<Response>`.

```ts [server/manual-auth-handler.ts]
import { defineAuth } from 'vite-hub/auth'
import { createAuthHandler } from 'vite-hub/auth/server'

const definition = defineAuth({
  appName: 'Acme',
  route: false,
})

export const handleAuth = createAuthHandler(definition)
```

Adapt the handler at the framework boundary. Do not import a generated Nitro
route.

## Production notes

Local files and memory belong to one process on one host. Two replicas with the
same configuration do not share them. Use a persistent volume for `dataDir`, or
select remote stores when you run more than one process.

Keep runtime secrets in [Server Env](/docs/env). Verify the
deployed application by starting the built server, not only by typechecking
package code.

## Next steps

- Read [Production deployment](/docs/frameworks-hosts/production) before you serve traffic.
- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for remote providers on Node.
- Use [Config options](/docs/reference/config-options) for local and hosted providers.
