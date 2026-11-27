---
title: Several Node instances
description: Run one ViteHub app on several Node instances behind a load balancer, with Postgres as the shared store and Redis as an option.
navigation.order: 47.5
navigation.group: Deployment hosts
icon: i-lucide-server
---

One ViteHub app can run on several Node instances behind one load balancer.
Postgres holds the state that the instances share. Redis is optional. This page
builds the app once, runs three instances with Docker Compose, and puts Caddy in
front of them.

Start with a ViteHub app from [Installation](/docs/getting-started/installation).
Follow [Add feature packages](/docs/getting-started/installation#add-feature-packages)
for KV, Queue, Rate Limit, Realtime, Schedule, and Workflow before
you turn them on. Use package versions that match your `vite-hub` release.

## Define one Postgres Database

The Default Database is the shared store. Queue, Schedule, Workflow, KV, Rate
Limit, and Realtime can use its connection, so you set one URL. Install the
Database package, the Postgres client, Drizzle ORM for the schema, and Drizzle
Kit for generating migrations. Use a matching pair of Drizzle versions supported
by your ViteHub release; for example:

```bash [Terminal]
pnpm add @vite-hub/database postgres drizzle-orm@1.0.0-rc.5
pnpm add -D drizzle-kit@1.0.0-rc.5
```

```ts [server/databases/default.ts]
import { pgTable, serial, text } from 'drizzle-orm/pg-core'
import { defineDatabase } from 'vite-hub/database'

export default defineDatabase({
  dialect: 'postgresql',
  connection: { url: process.env.DATABASE_URL },
  schema: {
    notes: pgTable('notes', {
      id: serial('id').primaryKey(),
      title: text('title').notNull(),
    }),
  },
})
```

The server reads `DATABASE_URL` when it starts. The build does not need it.

## Configure the app

Turn on the primitives you use. A build in the Dockerfile below defaults to
the `node` host. With this config, KV selects Postgres at build time. Realtime
selects its store at startup.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    database: true,
    kv: true,
    cache: { driver: 'kv' },
    queue: true,
    rateLimit: true,
    realtime: true,
    schedule: { runtime: { driver: 'process' } },
    workflow: true,
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
      database: true,
      kv: true,
      cache: { driver: 'kv' },
      queue: true,
      rateLimit: true,
      realtime: true,
      schedule: { runtime: { driver: 'process' } },
      workflow: true,
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
      database: true,
      kv: true,
      cache: { driver: 'kv' },
      queue: true,
      rateLimit: true,
      realtime: true,
      schedule: { runtime: { driver: 'process' } },
      workflow: true,
    }),
  ],
})
```
:::
::

After you turn on Database, generate the first migration with
`pnpm exec vitehub database generate`. Keep the generated files in
`server/databases/default/migrations/` so the build can include them.

## What each primitive uses

| Primitive | Shared store | Variables |
| --- | --- | --- |
| Database | Postgres, from `connection.url` | `DATABASE_URL`, or the variable that your Definition reads |
| Migrations | Applied when each server starts, under a Postgres advisory lock | None |
| KV and cache | The `vitehub_kv` table, or Redis when you configure `kv: { driver: 'redis' }` | `REDIS_URL` for the Redis driver |
| Rate Limit | One atomic KV increment per request, so it follows KV | None |
| Queue | The `vitehub_queue_jobs` table. Every instance claims jobs with `FOR UPDATE SKIP LOCKED` | `QUEUE_POSTGRES_URL` overrides the Database |
| Schedule | A lease in the `vitehub_leases` table lets one instance run an occurrence at a time. Keep handlers idempotent in case a lease expires. | None |
| Workflow | OpenWorkflow in the `openworkflow` schema. Each server with discovered Workflows or Agents starts a worker | `OPENWORKFLOW_POSTGRES_URL` comes before the Database |
| Realtime | Each instance keeps its rooms in memory and shares them through Redis pub/sub with `REDIS_URL`, else Postgres `LISTEN`/`NOTIFY` | `REDIS_URL`, `REALTIME_POSTGRES_URL` |
| Blob | Not shared by default. Use `driver: 's3'` or another [S3-compatible driver](/docs/blob/hosts#s3-compatible-object-storage) | The driver's credentials |

Queue, Realtime, and Workflow do not use `DATABASE_URL` to select Postgres.
They can use the connection of the Default Database, whatever variable its
Definition reads.

Share a Postgres database among the instances of one deployment, not across
apps or environments. For example, give staging and production separate
databases even when they run on the same Postgres server. Otherwise they can
claim jobs or Workflow runs from the same tables. A Redis key prefix or a
Realtime namespace does not isolate those tables.

Give every instance the same store configuration and environment. If only
some instances receive `REDIS_URL`, Realtime can split between Redis and
Postgres. Check each server's durability report at startup to confirm the
drivers match.

The primitive pages have the details:
[KV](/docs/kv/configure#node-picks-a-shared-store),
[Rate Limit](/docs/rate-limit/hosts#share-counts-on-node),
[Schedule](/docs/schedule/configure#run-on-more-than-one-server),
[Workflow](/docs/workflows/hosts#run-workflows-on-node), and
[Realtime](/docs/realtime/configure#share-rooms-across-node-instances).

## Agents

A production Node build with Agents and a Postgres Default Database uses
Postgres for the default Invocation journal unless you override it. Postgres
also coordinates recovery and process host Leases. It does not store Agent
State or local Workspace files.

| Agent store | With a Postgres Default Database | Share it |
| --- | --- | --- |
| Invocation journal | The [default journal](/docs/agents/invocation-storage#use-the-default-journal) uses the shared Postgres tables `vitehub_default_agent_invocations` and `vitehub_default_agent_invocations_observations` unless overridden. | Keep the Postgres default, or set `agent.invocations.databaseUrl` to a remote libSQL URL. `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` takes precedence over both. A `file:` URL stays on one host. `dataDir` supplies a default file URL but does not replace an explicit URL. |
| Recovery | One server at a time [sweeps the journal](/docs/agents/invocation-storage#recover-interrupted-invocations) on a 15-second timer, under the Lease `agent-recovery:<agent>`. | Keep the journal shared so that the sweep can see records from other servers. |
| Process hosts | Shared. One server at a time [runs the host](/docs/agents/process-hosts#run-one-host-across-servers) of each Agent, under the Lease `agent-process-host:<agent>`. Another server takes over in about 30 seconds. | Nothing to set. The files that a host writes below `dataDir`, such as provider sessions, stay on the server that ran it. |
| Resumable web chat streams | With `resumable.scope: 'process'`, streams stay in the memory of one process. | Set [`resumable.scope: 'shared'`](/docs/agents/channels#resume-a-web-chat) on the route and use a shared SQL journal. Streams use the database of the selected journal: Postgres with the Postgres default, or remote libSQL if the journal uses that override. |
| Agent State | Not in Postgres. `VITEHUB_AGENT_STATE_URL` selects SQLite or libSQL. A `file:` URL keeps State on one host. | Set `VITEHUB_AGENT_STATE_URL` to the same remote libSQL server on every instance. If the server requires authentication, also set `VITEHUB_AGENT_STATE_AUTH_TOKEN`. See [History and sessions](/docs/agents/chat-history-sessions). |
| Workspaces | Local is the fallback, with files under `.vitehub/workspaces/<name>` by default. A Workspace Definition without a `store` or `root` can infer Vercel Blob from credentials. | Use the [Blob + Database Store](/docs/workspace/configure#share-one-workspace-across-instances) with a shared Blob store such as S3 and the Postgres history schema. GitHub and Vercel Blob are also available as direct [Workspace Store drivers](/docs/workspace/configure#store-drivers). |

If your build selects the Postgres default journal, run `vitehub database generate`
again after adding Agents. The Database migrations create the journal tables
and the `vitehub_agent_chat_streams` and `vitehub_agent_chat_stream_chunks` tables
used by shared chat streams on that journal. The stores do not create tables on Postgres.

The durability report uses these names where applicable: `agent-invocations`,
`agent-recovery`, `agent-process-host`, `agent-chat-streams`, `agent-state`,
and `workspace`. For example, `agent-process-host` only appears when process
hosts are configured, and each Workspace Definition gets a named `workspace`
entry. The `agent-chat-streams` line shows where streams with
`scope: 'shared'` go. A route with `scope: 'process'` keeps its streams in one
process, whatever the line says. With `VITEHUB_INSTANCES` above 1, a server
whose Agent State or Workspace is not shared stops at boot with
`RUNTIME_R0017`.

A run does not move to another server. In a shared journal, the periodic sweep
marks eligible interrupted inline Invocations `failed` after their claims
expire. A claim lasts 30 seconds from its last renewal; the record is updated
on a later sweep, not at expiry. The sweep does not retry turns or handle
Invocations that a persisted delivery will retry. A Node server at startup can
retry an interrupted inline Channel chat as a new run.

The Workflow and its recovery run own the outcome of a Workflow-backed
Invocation. A Workflow-backed turn runs its Driver at most once. See
[Recover interrupted Invocations](/docs/agents/invocation-storage#recover-interrupted-invocations)
and [Host recovery limits](/docs/agents/invocation-storage#host-recovery-limits).

## Migrations on start

A Node build with a Postgres Database applies pending migrations when the
server starts, before it accepts a request. The build puts the migrations in the
server output, so the image needs no migrations folder.

Instances that start together take turns. Each one takes an advisory lock on
`hashtext('vitehub:migrations')` before it reads the migrations table. The lock
is `pg_advisory_xact_lock`, held by the migration transaction. When a pending
file starts with `-- vitehub:no-transaction`, the run holds a session lock with
`pg_advisory_lock` on one connection instead. The first instance applies the
migrations. An instance that finds the lock taken logs that it waits, then finds
nothing pending and starts. `vitehub database migrate` takes the same lock.
`drizzle-kit migrate` does not, so do not run it while instances start.

When a migration fails, the server stops before it listens, with
`DATABASE_MIGRATION_FAILED`. Without a `-- vitehub:no-transaction` file, the
pending migrations run in one transaction, so the database keeps none of them.
A run with such a file commits each stretch of migrations, and each statement
of the marked file, on its own. The database then keeps the migrations that ran
before the failed one, and `error.why` lists them. See
[Run a Postgres migration outside a transaction](/docs/database/configure#run-a-postgres-migration-outside-a-transaction).
A migration that loses data stops the server with
`DATABASE_MIGRATION_DATA_LOSS`, until you set
`database: { migrateOnStart: { allowDataLoss: true } }`. Set
`database: { migrateOnStart: false }` to migrate only from a deploy step. See
[Migrate when the server starts](/docs/database/configure#migrate-when-the-server-starts).

## Tables that ViteHub creates

The primitives create their tables in the Default Database when the server
first uses them, not with Drizzle migrations:

| Table | Created by |
| --- | --- |
| `vitehub_kv` | KV with the `database` driver |
| `vitehub_leases` | Schedule leases, and the Agent process host and recovery Leases |
| `vitehub_queue_jobs` | Queue |
| `vitehub_realtime_rooms`, `vitehub_realtime_messages` | Realtime on Postgres |
| The `openworkflow` schema | Workflow |
| `drizzle.__drizzle_migrations` | Migrations on start and `vitehub database migrate` |

`vitehub database generate` compares your schema with the last migration, so it does
not touch these tables.

On this database, change the schema only with `vitehub database generate` and
the migrations that the servers or `vitehub database migrate` apply. Do not run
`drizzle-kit push` against it. `push` changes tables without writing a row to
`drizzle.__drizzle_migrations`, so the next migration that makes the same change
fails, and an instance that starts after it stops with
`DATABASE_MIGRATION_FAILED`. `push` also compares your schema with the whole
database, so it offers to drop the `vitehub_*` tables and the `openworkflow`
schema. Use `push` only on a separate development database that never runs
these migrations.

## Postgres connections

Each instance opens its own connections:

| Client | Connections per instance | Used by |
| --- | --- | --- |
| The Database pool | Up to 10, the postgres.js default | Your queries, KV, leases, Queue claims and jobs, Realtime data, migrations on start |
| One `LISTEN` connection on the Database client | 1 | Queue wake-ups and Realtime messages share it |
| The Realtime room lock pool, when using Postgres | Up to 3 | Locks held while rooms open and save |
| The OpenWorkflow pool | Up to 10 | Workflow runs |
| At start | Up to 2 more, for a short time | The OpenWorkflow schema setup |

Budget for up to 24 connections per instance with all stores on the Default
Database, plus the temporary setup connections. `REALTIME_POSTGRES_URL` adds a
pool of 6 and a dedicated `LISTEN` connection, and `QUEUE_POSTGRES_URL` adds a
pool of 10 and a dedicated `LISTEN` connection. Leave room for other clients
and for Postgres's reserved connections. Do not add `max` to the URL to size
the postgres.js pool: postgres.js reads it as text and opens only one connection.

A pooler in transaction mode, such as PgBouncer, does not keep a `LISTEN`
connection. Use Redis for Realtime behind it. The OpenWorkflow schema setup
needs two connections at once. If the second connection is unavailable, the
server reports the setup failure and retries before starting the worker. Raise
the pool size, or set up the schema once through a direct connection and then
set `workflow: { postgres: { runMigrations: false } }`.

## Redis is optional

Postgres alone can serve every shared store in this example. Setting `REDIS_URL`
on every instance moves Realtime to Redis without rebuilding. It does not move
KV, the Nitro cache, or Rate Limit counters. To move those too, set the `redis`
KV driver and rebuild. Queue, Schedule leases, Workflow, and migrations stay
in Postgres.

KV keys use the prefix `vitehub:kv:<store>`, which has no app name. Two
ViteHub apps on one Redis database share `vitehub:kv:default`, and with it the
Nitro cache and the Rate Limit counts. Give each app its own Redis database in
the URL, such as `redis://redis:6379/1`, or set its own `base`:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    kv: { driver: 'redis', base: 'shop:kv' },
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
      kv: { driver: 'redis', base: 'shop:kv' },
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
      kv: { driver: 'redis', base: 'shop:kv' },
    }),
  ],
})
```
:::
::

An explicit `driver: 'redis'` requires `REDIS_URL` on every production instance.
It also uses Redis in development, so give development its own Redis URL.

Realtime keeps apps apart by itself. Its namespace is `realtime.namespace`,
else the `name` of `vitehub()`, else the `name` in your `package.json`. Two
deploys of one app, such as staging and production, have the same name. To run
them on one Redis or one Postgres, set `REALTIME_NAMESPACE` on each deploy,
such as `REALTIME_NAMESPACE=shop-staging`. KV needs its own Redis database or
`base` for each deploy too.

## Run three instances with Docker Compose

Build the app in a Dockerfile. Commit `pnpm-lock.yaml` and set `packageManager`
in `package.json` to the pnpm version you use locally so Corepack uses the
same version in the build. The runtime image needs only `.output`.

```dockerfile [Dockerfile]
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/.output .output
CMD ["node", ".output/server/index.mjs"]
```

Add this `.dockerignore` to keep local state and secrets out of the build context.
Pass secrets at runtime instead.

```text [.dockerignore]
.git
.env
.env.*
node_modules
.output
.nuxt
.vitehub
```

Build on the same CPU type as the server, because the build copies native
binaries for one platform only.

The compose file runs Postgres, Redis, three instances of one image, and Caddy.

```yaml [compose.yaml]
x-app: &app
  image: my-app
  pull_policy: never
  restart: unless-stopped
  environment:
    DATABASE_URL: postgres://app:app@postgres:5432/app
    # Optional with kv: true. To run without Redis, remove this line,
    # the redis service, and redis under depends_on.
    REDIS_URL: redis://redis:6379
    VITEHUB_INSTANCES: "3"
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy

services:
  app1:
    <<: *app
    build: .
  app2: *app
  app3: *app

  caddy:
    image: caddy:2
    ports:
      - "8080:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
    depends_on: [app1, app2, app3]

  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    volumes:
      - postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "app", "-d", "app"]
      interval: 2s
      retries: 30

  redis:
    image: redis:7
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      retries: 30

volumes:
  postgres:
```

Caddy sends each request to the next instance. When an instance does not
answer, Caddy tries another one for up to 5 seconds.

```txt [Caddyfile]
:80 {
	reverse_proxy app1:3000 app2:3000 app3:3000 {
		lb_policy round_robin
		lb_try_duration 5s
		stream_close_delay 5m
	}
}
```

Build the image once, then start the three instances and open `http://localhost:8080`:

```bash [Terminal]
docker compose build app1
docker compose up --no-build
```

The Postgres health check uses TCP so the app instances do not start while
Postgres is still initializing and only accepts local socket connections.
One instance applies the migrations, and the others wait for it or find nothing
pending. Check `docker compose logs app1 app2 app3` for the durability report
from each instance. Use real passwords and keep them in
[Server Env](/docs/env) or your secret store, not in the compose file.

## WebSockets behind Caddy

- Caddy forwards WebSocket upgrades without extra config.
- The load balancer needs no sticky sessions. Each instance keeps the rooms of
  its own clients and shares updates with the other instances.
- When Caddy reloads its config, it closes open WebSockets.
  `stream_close_delay 5m` keeps them open for 5 minutes after a reload.
- When an instance stops, its clients reconnect through Caddy to another
  instance and take their presence with them. Unsaved edits live in memory and
  are lost if every instance that has the room open stops. An
  [interrupted normalizing save](/docs/realtime/server-api#interrupted-normalizing-saves)
  can also reset the room while another instance is still running.
- When an instance crashes, the other instances remove its clients' presence
  after 30 seconds.

## Client addresses behind Caddy

By default, each instance sees Caddy as the client. Rate Limit counts by
client address unless you pass a `key`, such as the user ID. To count by the
original client address, keep the Node ports private and set `trustProxy: true`
in the app's ViteHub options. Caddy sets `X-Forwarded-For` at the public edge,
and ViteHub uses the last address in that header for Rate Limit and
[Auth rate limiting](/docs/auth/configure#rate-limiting). Do not enable proxy
trust if clients can reach Node directly.

## What stays in one process

- A local libSQL `file:` Database is safe for one process only.
  `@libsql/client` can lose writes when several processes write one file, so
  leases and Schedule claims on it are not safe. Use Postgres or remote libSQL.
- Blob `fs` and every folder under `dataDir` are on one host. That includes KV
  `fs-lite`, a `file:` Agent State, local Workspace files, and the files of
  Agent process hosts. `dataDir` also supplies the default file for the Agent
  Invocation journal unless you override its URL. See [Agents](#agents).
- Without a Postgres Default Database or other shared stores, KV uses `fs-lite`
  and Rate Limit counters that use KV are local too. Realtime rooms stay in
  memory, Queue keeps job files on one host, each instance runs every Schedule
  occurrence, and Workflow normally keeps runs in a SQLite file. If
  `DATABASE_URL` contains a Postgres URL but no Workflow store is selected,
  OpenWorkflow reports `WORKFLOW_OPENWORKFLOW_DATABASE_URL_IGNORED` instead of
  falling back to SQLite. Set a Postgres Default Database or
  `OPENWORKFLOW_POSTGRES_URL` to share Workflow runs.
- Queue `concurrency` counts the jobs of one process.
- With the default config above, `vite dev` keeps KV, Queue, Realtime, and
  Workflow state on your computer and does not migrate the Database on start.

## Check durability

Each Node server prints where each primitive keeps its state when it starts. It
prints one line per primitive, with its store and its scope: `shared`, `host`,
or `process`.

```txt
[vitehub] Durability (3 instances, from VITEHUB_INSTANCES):
```

Set `VITEHUB_INSTANCES` to the number of instances, as the compose file does.
When it is greater than 1 and a primitive keeps its state on one host or in one
process, the server stops at boot with `RUNTIME_R0017`. The error names each
primitive and how to share it. So a store that would split fails the deploy,
and does not lose jobs later. You can also set `node: { instances: 3 }` in the
config. `VITEHUB_INSTANCES` wins over it. See [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted)
for how to read the report from the CLI.

## Next steps

- Read [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) for the
  `node` host on one instance.
- Read [Production deployment](/docs/frameworks-hosts/production) before you
  serve traffic.
