---
title: Node and self-hosted
description: Build a Node.js server with the node preset and choose storage that survives restarts.
navigation.order: 47
navigation.group: Deployment hosts
icon: i-lucide-server-cog
---

The `node` preset runs your app as a Node.js server on your own machine, a
container, or a virtual machine. Nitro builds one server entry at
`.output/server/index.mjs`. Server code uses the same Runtime Helpers as on
hosted presets.

## Configure the preset

Select the `node` preset and turn on the features you use. This example stores
KV values in local files.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
    kv: {
      driver: 'fs-lite',
      base: '.vitehub/data/kv',
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
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
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
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
  ],
})
```
:::
::

Server code calls the Runtime Helper. The config picks the store.

```ts [server/settings.ts]
import { kv } from 'vite-hub/kv'

export async function saveSettings(settings: Record<string, unknown>) {
  const [error] = await kv.set('settings', settings)
  if (error) throw error
}
```

## Build and start the server

Build the app, then start the generated entry with Node.js. Nitro reads `PORT`
and `HOST`, or `NITRO_PORT` and `NITRO_HOST`.

```bash [Terminal]
pnpm build
PORT=3000 node .output/server/index.mjs
```

Copy the whole `.output` directory to the server. With a built-in coding
provider, build on the server's operating system and CPU type, because the
build packages only the build machine's native binaries.

## Defaults on the node preset

"Several instances" means two or more Node processes behind one load balancer,
on one host or on many. Today most Node defaults keep state in one process or on
one disk, so they do not work across several instances.

| Primitive | Node default | Works across several instances today |
| --- | --- | --- |
| Blob | `fs` under `.vitehub/data/blob` | With a shared remote store, such as `s3`, or one shared volume. |
| KV | `database` with a Postgres Default Database, else `fs-lite` under `.vitehub/data/kv`. Upstash Redis when `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set during the build. | Yes with Postgres, Redis, or Upstash. Redis requires `kv: { driver: 'redis' }`, with the same `REDIS_URL` on every server. `fs-lite` keeps local files on one host. See [Node picks a shared store](/docs/kv/configure#node-picks-a-shared-store). |
| Cache | `fs-lite` under `.vitehub/data/cache` | Only with `cache: { driver: 'kv' }` and a shared KV store, such as Postgres, Redis, or Upstash. |
| Database | SQLite file `file:.vitehub/data/database/sqlite.db` | Only with a remote database, such as Postgres or remote libSQL. |
| Database `migrateOnStart` | On for Postgres. `true` also migrates local SQLite files; `false` turns it off. | Yes for Postgres. An advisory lock lets one instance migrate while the others wait. For SQLite, migrate once before starting several processes. See [Startup migrations](/docs/database/configure#migrate-when-the-server-starts). |
| Queue | The `local` provider. Jobs are files under `.vitehub/data/queue` and survive a restart. Each process keeps its job list and running jobs in memory. | No. With a separate directory per instance, a job runs only on the instance that accepted it. If that instance stops, its jobs wait on its disk until it starts again, and they are lost with that disk. With one shared volume, there is no lock between processes, so two instances can run the same job. |
| Rate Limit | `memory`. Counters reset on restart. The only other driver is `cloudflare`. | No. Each instance counts alone. |
| Realtime | None. A build needs `realtime: { authority: 'memory' }`, which keeps rooms in memory. | No. Peers on other instances do not see the room. |
| Schedule | None. A build needs `schedule: { runtime: { driver: 'process' } }`, or `providerOutput: false` to wake Schedules yourself. | No. The Process Runtime has no distributed lock, so every instance runs each Schedule. |
| Workflow | `vercel`, which runs inline in the request off Vercel. Set `workflow.postgres.url` or `workflow.sqlite.path` to select OpenWorkflow. | Only with OpenWorkflow and `postgres.url`. ViteHub does not start the OpenWorkflow worker, so runs stay `queued` until you call [`startOpenWorkflowWorker()`](https://github.com/vite-hub/vitehub/tree/main/packages/workflow#run-an-openworkflow-worker) in a server plugin. |
| Sandbox | None | `sandboxTask: true` fails the build. |

A multi-instance deploy today needs one instance that owns Queue, Rate Limit,
Realtime, and Schedule. Run those on that one instance, or run the whole app as
one instance.

Set `dataDir` in `vitehub()`, for example `dataDir: '/var/lib/app'`, to keep
local state in one persistent directory. It holds KV `fs-lite` data, Blob `fs`
data, the Agent State database, the Agent Invocation journal, and Workspace files.
`dataDir` works only with the `node` preset.

## Mount a server handler

Some packages export a stable handler that any Node framework can mount. The
Auth handler takes a Web `Request` and an optional host context with
`clientAddress`, and returns a `Promise<Response>`.

```ts [server/manual-auth-handler.ts]
import { defineAuth } from 'vite-hub/auth'
import { createAuthHandler } from 'vite-hub/auth/server'

const definition = defineAuth({
  appName: 'Acme',
  route: false,
})

export const handleAuth = createAuthHandler(definition)
```

Pass the peer address from Node's `incomingMessage.socket.remoteAddress`:

```ts fragment
const response = await handleAuth(webRequest, {
  clientAddress: incomingMessage.socket.remoteAddress,
})
```

::warning
Use the address from the host, never a request header from the client. Auth
uses it for per-client rate limiting and `session.ipAddress`.
::

A plain Web `Request` has no peer address. Without the host context, those
requests share one rate-limit bucket. Requests from srvx already carry the
host address as `ip`. Behind a trusted proxy, configure
[`advanced.trustedProxyHeaders`](/docs/auth/configure#behind-a-proxy-that-ends-tls).
Do not import a generated Nitro route.

## Production notes

Local files and memory belong to one process on one host. Replicas do not
share them. Use a persistent volume for `dataDir`, or remote stores when you
run more than one process.
The [table above](#defaults-on-the-node-preset) shows which features have a
remote store today.

Keep runtime secrets in [Server Env](/docs/env). Check the deployed app by
starting the built server, not only by typechecking.

## Next steps

- Read [Production deployment](/docs/frameworks-hosts/production) before you serve traffic.
- See [Runtime and host support](/docs/frameworks-hosts/support-matrix) for remote providers on Node.
- See [Config options](/docs/reference/config-options) for local and hosted providers.
