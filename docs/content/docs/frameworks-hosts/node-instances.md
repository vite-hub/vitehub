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

## Define one Postgres Database

The Default Database is the shared store. Queue, Schedule, Workflow, KV, Rate
Limit, and Realtime find it and use its connection, so you set one URL.

```bash [Terminal]
pnpm add postgres
```

```ts [server/databases/config.ts]
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
Generate the first migration with `vitehub db generate`.

## Configure the app

Turn on the primitives that you use. The `node` preset picks a shared store for
each of them when the server starts.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
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
      preset: 'node',
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
      preset: 'node',
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

## What each primitive uses

| Primitive | Shared store | Variables |
| --- | --- | --- |
| Database | Postgres, from `connection.url` | `DATABASE_URL`, or the variable that your Definition reads |
| Migrations | Applied when each server starts, under a Postgres advisory lock | None |
| KV and cache | Redis with `REDIS_URL`, else the `vitehub_kv` table | `REDIS_URL` |
| Rate Limit | One atomic KV increment per request, so it follows KV | None |
| Queue | The `vitehub_queue_jobs` table. Every instance claims jobs with `FOR UPDATE SKIP LOCKED` | `QUEUE_POSTGRES_URL` overrides the Database |
| Schedule | One lease per occurrence in the `vitehub_leases` table, so one instance runs it | None |
| Workflow | OpenWorkflow in the `openworkflow` schema. Each server starts one worker | `OPENWORKFLOW_POSTGRES_URL` comes before the Database |
| Realtime | Each instance keeps its rooms in memory and shares them through Redis pub/sub with `REDIS_URL`, else Postgres `LISTEN`/`NOTIFY` | `REDIS_URL`, `REALTIME_POSTGRES_URL` |
| Blob | Not shared by default. Use `driver: 's3'` or another [S3-compatible driver](/docs/blob/hosts#s3-compatible-object-storage) | The driver's credentials |

Queue, Realtime, and Workflow do not read `DATABASE_URL` themselves. They use
the connection of the Default Database, whatever variable its Definition reads.

Give every instance the same environment. An instance without `REDIS_URL`
keeps KV and Realtime in Postgres while the others use Redis, so the data
splits. Each server prints the store it picked when it starts:

```txt
[vitehub] KV store "default" uses Redis, because REDIS_URL is set. Every server process needs the same REDIS_URL.
```

The primitive pages have the details:
[KV](/docs/kv/configure#node-picks-a-shared-store),
[Rate Limit](/docs/rate-limit/hosts#share-counts-on-node),
[Schedule](/docs/schedule/configure#run-on-more-than-one-server),
[Workflow](/docs/workflows/hosts#run-workflows-on-node), and
[Realtime](/docs/realtime/configure#share-rooms-across-node-instances).

## Migrations on start

A Node build with a Postgres Database applies pending migrations when the
server starts, before it accepts a request. The build puts the migrations in the
server output, so the image needs no migrations folder.

Instances that start together take turns. Each one takes
`pg_advisory_xact_lock(hashtext('vitehub:migrations'))` before it reads the
migrations table. The first one applies the migrations. An instance that finds
the lock taken logs that it waits, then finds nothing pending and starts. `vitehub db migrate` takes the
same lock. `drizzle-kit migrate` does not, so do not run it while instances
start.

When a migration fails, the server stops before it listens, with
`DATABASE_MIGRATION_FAILED`, and the database keeps none of the pending
migrations. A migration that loses data stops the server with
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
| `vitehub_leases` | Schedule leases |
| `vitehub_queue_jobs` | Queue |
| `vitehub_realtime_rooms`, `vitehub_realtime_messages` | Realtime on Postgres |
| The `openworkflow` schema | Workflow |
| `drizzle.__drizzle_migrations` | Migrations on start and `vitehub db migrate` |

`vitehub db generate` compares your schema with the last migration, so it does
not touch these tables. `drizzle-kit push` compares your schema with the
database, so it offers to drop the `vitehub_*` tables and the `openworkflow`
schema. If you use `push`, filter them out in your Drizzle config. The schema
file below is the one that ViteHub generates from your Definitions:

```ts [drizzle.config.ts]
export default {
  dialect: 'postgresql',
  schema: './.vitehub/database/schema/default.ts',
  dbCredentials: { url: process.env.DATABASE_URL! },
  schemaFilter: ['public'],
  tablesFilter: ['!vitehub_*'],
}
```

You need both filters. `tablesFilter` alone still drops the `openworkflow`
schema.

## Postgres connections

Each instance opens its own connections:

| Client | Connections per instance | Used by |
| --- | --- | --- |
| The Database pool | Up to 10, the postgres.js default | Your queries, KV, leases, Queue claims and jobs, Realtime saves and room opens, migrations on start |
| One `LISTEN` connection on the Database client | 1 | Queue wake-ups and Realtime messages share it |
| The OpenWorkflow pool | Up to 10 | Workflow runs |
| At start | Up to 2 more, for a short time | The OpenWorkflow schema setup |

So each instance can use about 21 connections. `REALTIME_POSTGRES_URL` adds a
pool of 6 and one `LISTEN` connection, and `QUEUE_POSTGRES_URL` adds a pool of
10 and one `LISTEN` connection. Postgres allows 100 connections by default,
which is enough for about four instances. For more instances, set
`max_connections` to about 25 per instance, plus your other clients. ViteHub does not let you change the pool sizes yet. Do not add `max`
to the URL: postgres.js reads it as text and opens only one connection.

A pooler in transaction mode, such as PgBouncer, does not keep a `LISTEN`
connection. Use Redis for Realtime behind it. The OpenWorkflow schema setup
needs two connections at once. When it gets no second connection in 10
seconds, for example behind a pooler with one server connection, the server
does not start the worker and reports `WORKFLOW_R0037`. Raise the pool size,
or set up the schema once through a direct connection and then set
`workflow: { postgres: { runMigrations: false } }`.

## Redis is optional

Postgres alone holds every shared store. Add Redis to move KV, the Nitro cache,
Rate Limit counters, and Realtime messages out of the Database. Queue, Schedule
leases, Workflow, and migrations stay in Postgres.

Set `REDIS_URL` on every instance. The server reads it when it starts, so one
build runs with or without Redis.

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
    preset: 'node',
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
      preset: 'node',
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
      preset: 'node',
      kv: { driver: 'redis', base: 'shop:kv' },
    }),
  ],
})
```
:::
::

An explicit `driver: 'redis'` turns off the Postgres fallback, so every
instance then needs `REDIS_URL`, and `vite dev` uses that Redis too.

Realtime keeps apps apart by itself. Its namespace is `realtime.namespace`,
else the `name` of `vitehub()`, else the `name` in your `package.json`. Two
deploys of one app, such as staging and production, have the same name. To run
them on one Redis or one Postgres, set `REALTIME_NAMESPACE` on each deploy,
such as `REALTIME_NAMESPACE=shop-staging`. KV needs its own Redis database or
`base` for each deploy too.

## Run three instances with Docker Compose

Build the app in a Dockerfile. The image needs only `.output`.

```dockerfile [Dockerfile]
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/.output .output
CMD ["node", ".output/server/index.mjs"]
```

Add `node_modules`, `.output`, `.nuxt`, and `.vitehub` to `.dockerignore`.
Build on the same CPU type as the server, because the build copies native
binaries for one platform only.

The compose file runs Postgres, Redis, three instances of one image, and Caddy.

```yaml [compose.yaml]
x-app: &app
  image: my-app
  build: .
  restart: unless-stopped
  environment:
    DATABASE_URL: postgres://app:app@postgres:5432/app
    # Optional. To keep every store in Postgres, remove this line,
    # the redis service, and redis under depends_on.
    REDIS_URL: redis://redis:6379
    VITEHUB_INSTANCES: "3"
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy

services:
  app1: *app
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
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
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

Start it, then open `http://localhost:8080`:

```bash [Terminal]
docker compose up --build
```

The three instances start together. One applies the migrations, and the
others wait for it or find nothing pending. Use real passwords and keep them in
[Server Env](/docs/env) or your secret store, not in the compose file.

## WebSockets behind Caddy

- Caddy forwards WebSocket upgrades without extra config.
- The load balancer needs no sticky sessions. Each instance keeps the rooms of
  its own clients and shares updates with the other instances.
- When Caddy reloads its config, it closes open WebSockets.
  `stream_close_delay 5m` keeps them open for 5 minutes after a reload.
- When an instance stops, its clients reconnect through Caddy to another
  instance and take their presence with them. Unsaved edits are lost only when
  every instance that has the room open stops.
- When an instance crashes, the other instances remove its clients' presence
  after 30 seconds.

## Client addresses behind Caddy

Each instance sees Caddy as the client. Without `key`, Rate Limit counts by
client address, so every client would share one count. Pass a `key`, such as
the user ID. Caddy replaces `X-Forwarded-For` with the address of the client,
so when only Caddy can reach the instances, its first value is the client
address. For Auth, set
[`advanced.trustedProxyHeaders`](/docs/auth/configure#behind-a-proxy-that-ends-tls).

## What stays in one process

- A local libSQL `file:` Database is safe for one process only.
  `@libsql/client` can lose writes when several processes write one file, so
  leases and Schedule claims on it are not safe. Use Postgres or remote libSQL.
- Blob `fs` and every folder under `dataDir` are on one host. That includes KV
  `fs-lite`, Agent State, the Agent Invocation journal, and Workspace files.
- Without a Postgres Default Database or `REDIS_URL`, KV uses `fs-lite`, Rate
  Limit and Realtime count and relay in memory, Queue keeps job files on one
  host, each instance runs every Schedule occurrence, and Workflow keeps runs
  in a SQLite file and logs that at boot. A `DATABASE_URL` alone does not
  change this.
- Queue `concurrency` counts the jobs of one process.
- `vite dev` stays local on purpose. KV, Queue, Realtime, and Workflow keep
  their state on your computer, and nothing migrates on start.

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
config. `VITEHUB_INSTANCES` wins over it. `vitehub durability list` prints the
same report for a running server.

## Next steps

- Read [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) for the
  `node` preset on one instance.
- Read [Production deployment](/docs/frameworks-hosts/production) before you
  serve traffic.
