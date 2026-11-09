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

"Several instances" means two or more Node processes behind one load balancer,
on one host or on many. Today most Node defaults keep state in one process or on
one disk, so they do not work across several instances.

| Primitive | Node default | Works across several instances today |
| --- | --- | --- |
| Blob | `fs` under `.vitehub/data/blob` | Only with the `s3` driver, or one shared volume. |
| KV | `fs-lite` under `.vitehub/data/kv`. Upstash Redis when `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set during the build. | Only with Upstash. |
| Cache | `fs-lite` under `.vitehub/data/cache` | Only with `cache: { driver: 'kv' }` and KV on Upstash. |
| Database | SQLite file `file:.vitehub/data/database/sqlite.db` | Only with a remote database, such as Postgres or remote libSQL. |
| Database `migrateOnStart` | Off. It applies migrations only to a local SQLite `file:` URL, and fails the build for Postgres. | No. Run `vitehub db migrate` once from the deploy step. |
| Queue | The `local` provider. Jobs are files under `.vitehub/data/queue` and survive a restart. Each process keeps its job list and running jobs in memory. | No. Two instances read the same jobs and can run a job twice. |
| Rate Limit | `memory`. Counters reset on restart. The only other driver is `cloudflare`. | No. Each instance counts alone. |
| Realtime | None. A build needs `realtime: { authority: 'memory' }`, which keeps rooms in memory. | No. Peers on other instances do not see the room. |
| Schedule | None. A build needs `schedule: { runtime: { driver: 'process' } }`, or `providerOutput: false` to wake Schedules yourself. | No. The Process Runtime has no distributed lock, so every instance runs each Schedule. |
| Workflow | `vercel`, which runs inline in the request off Vercel. Set `workflow.postgres.url` or `workflow.sqlite.path` to select OpenWorkflow. | Only with OpenWorkflow and `postgres.url`. |
| Sandbox | None | `sandboxTask: true` fails the build. |

A multi-instance deploy today needs one instance that owns Queue, Rate Limit,
Realtime, and Schedule. Run those on that one instance, or run the whole app as
one instance.

Set `dataDir` in `vitehub()` to put local state in one persistent directory, for
example `dataDir: '/var/lib/app'`. ViteHub then stores KV `fs-lite` data, Blob
`fs` data, the Agent State database, the Agent Invocation journal, and Workspace files
under that directory. `dataDir` works only with the `node` preset.

## Mount a server handler

Some packages expose a stable handler that any Node framework can mount. The Auth
handler accepts a Web `Request`, an optional host context with `clientAddress`, and
returns a `Promise<Response>`.

```ts [server/manual-auth-handler.ts]
import { defineAuth } from 'vite-hub/auth'
import { createAuthHandler } from 'vite-hub/auth/server'

const definition = defineAuth({
  appName: 'Acme',
  route: false,
})

export const handleAuth = createAuthHandler(definition)
```

At the framework boundary, pass the peer address from Node's
`incomingMessage.socket.remoteAddress`:

```ts fragment
const response = await handleAuth(webRequest, {
  clientAddress: incomingMessage.socket.remoteAddress,
})
```

Use the address supplied by the host, never a request header sent by the client.
Auth uses it for per-client rate limiting and `session.ipAddress`. A plain Web
`Request` has no peer address; without the host context, those requests share an
addressless rate-limit bucket. Requests from srvx already carry their host address
as `ip`. Behind a trusted proxy, configure
[`advanced.trustedProxyHeaders`](/docs/auth/configure#behind-a-proxy-that-ends-tls).
Do not import a generated Nitro route.

## Production notes

Local files and memory belong to one process on one host. Two replicas with the
same configuration do not share them. Use a persistent volume for `dataDir`, or
select remote stores when you run more than one process. The
[table above](#defaults-on-the-node-preset) shows which primitives have a remote
store today.

Keep runtime secrets in [Server Env](/docs/env). Verify the
deployed application by starting the built server, not only by typechecking
package code.

## Next steps

- Read [Production deployment](/docs/frameworks-hosts/production) before you serve traffic.
- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for remote providers on Node.
- Use [Config options](/docs/reference/config-options) for local and hosted providers.
