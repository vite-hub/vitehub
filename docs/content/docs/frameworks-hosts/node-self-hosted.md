---
title: Node and self-hosted
description: Build a Node.js server with the node host and choose storage that survives restarts.
navigation.order: 47
navigation.group: Deployment hosts
icon: i-lucide-server-cog
---

The `node` host runs your app as a Node.js server on your own machine, a
container, or a virtual machine. Nitro builds one server entry at
`.output/server/index.mjs`. Server code uses the same Runtime Helpers as on
the hosted platforms.

## Configure the host

Select the `node` host and turn on the features you use. This example stores
KV values in local files.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
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
      host: 'node',
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
      host: 'node',
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

## Run the server with systemd

A production build on the `node` host also writes a systemd unit to
`.output/<name>.service`. The name is the deployment name: `vitehub({ name })`,
else the `package.json` name.

```ini [.output/my-app.service]
[Unit]
Description=my-app (ViteHub)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/srv/my-app
ExecStart=/usr/bin/env node .output/server/index.mjs
EnvironmentFile=-/srv/my-app/.env
Environment="NODE_ENV=production"
SyslogIdentifier=my-app
KillMode=mixed
TimeoutStopSec=30
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target default.target
```

The unit starts the server in the project root of the build, so relative data
paths such as `.vitehub/data` stay where they were. It reads `.env` from that
directory when the file exists. `node` comes from the unit's `PATH`, so a
Node.js upgrade does not make the unit stale. On stop, systemd sends `SIGTERM`
and ViteHub [drains Agent work](/docs/agents/process-hosts#drain-agent-work-on-stop-signals).
`TimeoutStopSec` is the `agent.shutdown.drainMs` budget (0 by default) plus 30 seconds, which
covers the 15-second settle time, the 10-second close hooks, and 5 seconds more.

Link the unit and start it:

```bash [Terminal]
sudo systemctl link /srv/my-app/.output/my-app.service
sudo systemctl enable --now my-app
```

`systemctl restart my-app` drains the old process before it starts the new one.
After a new build, run `sudo systemctl daemon-reload` before the restart, so
systemd reads the new file. As a user service, use `systemctl --user` with the
same commands; the unit then starts at login, or at boot with
`loginctl enable-linger`.

Set the deploy path, the system user, and fixed variables in `vitehub()`. Use
`systemd: false` to write no unit:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      agent: { shutdown: { drainMs: 45_000 } },
      systemd: {
        user: 'app',
        workingDirectory: '/srv/my-app',
        environment: { PORT: '3000' },
      },
    }),
  ],
})
```

Each build replaces the unit, so put other settings in a drop-in. A drop-in
stays when the unit changes:

```bash [Terminal]
sudo systemctl edit my-app
```

```ini [/etc/systemd/system/my-app.service.d/override.conf]
[Service]
Environment="PATH=/opt/node/bin:/usr/bin"
MemoryMax=2G
```

Set `TimeoutStopSec` in a drop-in when you set `VITEHUB_SHUTDOWN_DRAIN_MS` in
`.env`, because the build cannot read that file.

## Defaults on the node host

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
| Rate Limit | `kv` when KV is on, else `memory`. | Yes when KV uses Postgres, Redis, or Upstash. `memory`, or `kv` on `fs-lite`, counts in one process and resets on restart. See [Share counts on Node](/docs/rate-limit/hosts#share-counts-on-node). |
| Realtime | None. A build needs `realtime: { authority: 'memory' }`, which keeps rooms in memory. | No. Peers on other instances do not see the room. |
| Schedule | None. A build needs `schedule: { runtime: { driver: 'process' } }`, or `providerOutput: false` to wake Schedules yourself. | No. The Process Runtime has no distributed lock, so every instance runs each Schedule. |
| Workflow | `vercel`, which runs inline in the request off Vercel. Set `workflow.postgres.url` or `workflow.sqlite.path` to select OpenWorkflow. | Only with OpenWorkflow and `postgres.url`. ViteHub does not start the OpenWorkflow worker, so runs stay `queued` until you call [`startOpenWorkflowWorker()`](https://github.com/vite-hub/vitehub/tree/main/packages/workflow#run-an-openworkflow-worker) in a server plugin. |
| Sandbox | None | `sandboxTask: true` fails the build. |

A multi-instance deploy today needs one instance that owns Queue, Realtime,
and Schedule. Run those on that one instance, or run the whole app as
one instance.

Set `dataDir` in `vitehub()`, for example `dataDir: '/var/lib/app'`, to keep
local state in one persistent directory. It holds KV `fs-lite` data, Blob `fs`
data, the Agent State database, the Agent Invocation journal, and Workspace files.
`dataDir` works only with the `node` host.

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

## Durability and instances

When the server starts, it prints one line for each enabled primitive. The
line shows the store and where its state lives.

```txt [Terminal]
[vitehub] Durability (1 instance. Set VITEHUB_INSTANCES when you run more):
  kv          fs-lite  host     Files in .vitehub/data/kv on this host.
  rate-limit  memory   process  Counters live in the memory of this process. Each instance counts on its own.
```

| Scope | Meaning |
| --- | --- |
| `shared` | All instances read and write the same store, such as Postgres or Upstash Redis. |
| `host` | Files on this host. They survive a restart, but another host or container does not see them. |
| `process` | Memory of this process. A restart loses it, and other processes do not see it. |

Each primitive reports the driver that it uses in this server, so a driver
that an environment variable or the Default Database selects at boot shows
correctly. Agent state, the Agent Invocation journal, and Workspace files
report too. Run
`vitehub durability list` to read the same report from the dev server. It is
the `durability.list` [operation](/docs/development/operations). On a
deployment, `--url` works when the app enables the Console, with credentials
for the `durability` section. Server code can read the report with
`getDurabilityReport()` from `vite-hub/runtime/durability`.

Tell the server how many instances run this build. Set `VITEHUB_INSTANCES`
where you start the server, or set `node.instances` in `vitehub()`.
`VITEHUB_INSTANCES` wins. The default is 1.

```bash [Terminal]
VITEHUB_INSTANCES=3 node .output/server/index.mjs
```

When the count is greater than 1 and a primitive is `host` or `process`
scoped, the server does not start. The error (`RUNTIME_R0017`) lists each
primitive and how to make it shared. For example, the default `fs-lite` KV store
fails with 3 instances. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN` at build
time to use Upstash Redis.

## Production notes

Local files and memory belong to one process on one host. Replicas do not
share them. Use a persistent volume for `dataDir`, or remote stores when you
run more than one process. Set `VITEHUB_INSTANCES` so the server checks this
at boot.
The [table above](#defaults-on-the-node-host) shows which features have a
remote store today.

The Schedule Process Runtime runs each occurrence on one server when the app has
a Postgres or remote libSQL Default Database. The servers claim each occurrence in the
`vitehub_leases` table. See [Run on more than one server](/docs/schedule/configure#run-on-more-than-one-server).

Keep runtime secrets in [Server Env](/docs/env). Verify the
deployed application by starting the built server, not only by typechecking
package code.

## Next steps

- Read [Production deployment](/docs/frameworks-hosts/production) before you serve traffic.
- See [Runtime and host support](/docs/frameworks-hosts/support-matrix) for remote providers on Node.
- See [Config options](/docs/reference/config-options) for local and hosted providers.
