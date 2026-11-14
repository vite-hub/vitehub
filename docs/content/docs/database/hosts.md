---
title: Database hosts
description: Pick local SQLite, hosted libSQL, Cloudflare D1, or Postgres, see what each host output holds, and check production rules.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Providers

| Provider or runtime | Configure with | Notes |
| --- | --- | --- |
| Local SQLite | `connection.url` or no connection config | Default for local development and generated Drizzle files. |
| Hosted libSQL (for example Turso) | `connection.url` and optional `connection.authToken` | Keep secret URLs and tokens in Server Env. |
| Cloudflare D1 | `cloudflare` Definition options or top-level `database.driver: 'd1'` | Uses a D1 binding on Cloudflare. Local development uses D1 only with `remote: true` or `cloudflare.http`. Vercel uses D1 only with `cloudflare.http`. |
| Postgres (for example Neon) | `dialect: 'postgresql'` with `connection.url` and optional `cloudflare.hyperdriveId` | Uses a Hyperdrive binding on Cloudflare and `connection.url` elsewhere. See [Use Postgres](#use-postgres). |

### Use the real D1 database in development

`vite dev` uses local SQLite for every Database by default. Set `remote: true` on a Definition to query its real D1 database instead. The development server sends each query over HTTP to Cloudflare's D1 API, with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from Server Env, like `cloudflare.http: true`. A local D1 binding does not replace it.

```ts [server/databases/default/index.ts] fragment
import { defineDatabase } from 'vite-hub/database'

import { notes } from './schema'

export default defineDatabase({
  cloudflare: {
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
  },
  remote: true,
  schema: { notes },
})
```

::warning
Writes from `vite dev` then change real data. The development server prints `Database "default" is remote` on the first query, and `vitehub inspect definitions --kind database` shows `Development: Remote`.
::

The database id comes from `cloudflare.databaseId` or from `vitehub provision run`. ViteHub development never creates a cloud resource. `remote` changes only `vite dev`: builds ignore it, so Cloudflare output keeps its D1 binding and Node output keeps local SQLite. `vitehub database migrate` follows `cloudflare.http`, not `remote`, so it still migrates the local SQLite file.

`cloudflare.http` already makes `vite dev` remote, so `remote: true` is not needed with it. To send queries through a D1 proxy in development, set `cloudflare.http: { url, authToken }`. `remote: false` with `cloudflare.http` fails with [`DATABASE_REMOTE_CONFLICT`](/docs/database/limits-and-errors#database_remote_conflict).

### Use Cloudflare D1 over HTTP

Use one D1 database in local development and on other hosts. Cloudflare output still prefers the binding. Set `cloudflare.http: true` to call Cloudflare's D1 raw API with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from Server Env.

```ts [server/databases/default/index.ts] fragment
import { defineDatabase } from 'vite-hub/database'

import { notes } from './schema'

export default defineDatabase({
  cloudflare: {
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    databaseName: process.env.CLOUDFLARE_D1_DATABASE_NAME,
    http: true,
  },
  schema: { notes },
})
```

Set `cloudflare.http: { url, authToken }` to send the same raw queries to an authenticated HTTP(S) proxy. Both values are required at runtime. The proxy never falls back to `CLOUDFLARE_API_TOKEN`.

```ts [server/databases/default/index.ts] fragment
import { defineDatabase } from 'vite-hub/database'

import { notes } from './schema'

export default defineDatabase({
  cloudflare: {
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    http: {
      authToken: process.env.D1_HTTP_TOKEN,
      url: process.env.D1_HTTP_URL,
    },
  },
  schema: { notes },
})
```

Production Nuxt builds with only D1 HTTP do not bundle libSQL or native SQLite. A Cloudflare build bundles libSQL only when a Database has a remote libSQL connection URL, a URL from the environment, or a Definition that the build cannot read. Local SQLite development keeps its local driver.

D1 HTTP also writes Drizzle Kit `d1-http` credentials. `vitehub database migrate` applies D1 HTTP migrations without Drizzle Kit and records them in Wrangler's `d1_migrations` table, so `wrangler d1 migrations apply` sees them too. With `http: true`, migrations call Cloudflare's API with `CLOUDFLARE_ACCOUNT_ID`, the database id, and `CLOUDFLARE_API_TOKEN`. An object `http` uses its proxy `url` and `authToken`. Drizzle Kit inspection commands use the Cloudflare API credentials. ViteHub never puts these credentials in generated output.

::warning
Cloudflare says its D1 REST API is best for admin use, because the global Cloudflare API rate limit applies. For steady app traffic, use a proxy Worker with narrow auth that checks which queries or tables it allows. See Cloudflare's [D1 proxy Worker guide](https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1/).
::

Outside Cloudflare output, ViteHub keeps local SQLite and hosted libSQL without `cloudflare.http`, even when `cloudflare.databaseId` is set.

### Read from D1 replicas

D1 keeps one primary database in one region, so a far-away Worker waits on each query. Set `readReplication: true` to read from [D1 read replicas](https://developers.cloudflare.com/d1/best-practices/read-replication/) near the Worker.

```ts [server/databases/default/index.ts] fragment
import { defineDatabase } from 'vite-hub/database'

import { notes } from './schema'

export default defineDatabase({
  cloudflare: { readReplication: true },
  schema: { notes },
})
```

In Nuxt, or for every Definition that uses the top-level resource, set it at the top level: `database: { driver: 'd1', readReplication: true }`.

ViteHub then opens one D1 session per request, with the [Sessions API](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession):

| Request | Session starts on | After the request |
| --- | --- | --- |
| `GET`, `HEAD`, or `OPTIONS` | The replica that the client's bookmark cookie names, or any replica | No cookie |
| Any other method | The primary database | A `vitehub-d1-bookmark-<binding>` cookie with the session's bookmark |

With the cookie, a client's next read sees its own writes. Other clients can read a replica without those writes yet. Code that must read the latest data of all clients must run in a request that can write, such as a `POST` handler.

All queries of one request use the same session. Work outside a request, such as a Schedule or a Queue consumer, uses the primary database.

`vitehub provision run --provider cloudflare` turns on replication for D1 databases that set `readReplication`. When it is off, the plan shows `update  cloudflare-d1  <name>  read replication: disabled -> auto`. A database that already replicates shows `exists` and is not changed. Provision never turns replication off. For a database that ViteHub does not provision, turn it on in the Cloudflare dashboard, or call `PATCH /accounts/<account_id>/d1/database/<database_id>` with `{ "read_replication": { "mode": "auto" } }`. Without replication on the database, every session uses the primary.

`vitehub inspect definitions --kind database` shows `Read replication` for each database that uses it. D1 over HTTP, libSQL, and local SQLite ignore the option.

### Use Postgres

A Postgres Definition uses [postgres.js](https://github.com/porsager/postgres) through Drizzle. For each query, ViteHub picks the connection:

1. With a Cloudflare Hyperdrive binding, `env.<binding>.connectionString`.
2. Else `connection.url`.
3. Outside a Cloudflare request with an empty URL, postgres.js reads `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` (or `PGUSERNAME`), and `PGPASSWORD`.
4. In development and app tests, with none of these, [PGlite](/docs/database/configure#run-postgres-locally-with-pglite). Production output has no PGlite.

Use the PG* variables on Node and container hosts that give separate credentials, not a URL. Workers ignore them, and Vercel still needs `connection.url`.

A Worker cannot use a socket from one request in another. So inside a Cloudflare request, ViteHub creates one client and reuses it for all queries of that request. Hyperdrive keeps the pool of origin connections, so a new client per request is cheap. Each client opens at most 5 connections, inside the Workers connection limit. On Node, Vercel, and local development, one client pool serves the process.

ViteHub finds the request through a request scope:

- Vite Cloudflare output runs each request in its own scope.
- Nitro 3 apps, including Nuxt 5, get a generated middleware that does the same.

```ts [server/databases/default/index.ts] fragment
import { defineDatabase } from 'vite-hub/database'

import { notes } from './schema'

export default defineDatabase({
  dialect: 'postgresql',
  cloudflare: { hyperdriveId: process.env.CLOUDFLARE_HYPERDRIVE_ID },
  connection: { url: process.env.DATABASE_URL },
  schema: { notes },
})
```

Create a Hyperdrive config for your Postgres database, such as Neon, with `wrangler hyperdrive create`. Set `cloudflare.hyperdriveId` to its id. Cloudflare output then has a `hyperdrive` binding named `HYPERDRIVE`, or `HYPERDRIVE_<NAME>` for a named database. It replaces a Nitro Wrangler binding with the same name. Without `cloudflare.hyperdriveId`, add the binding to your Wrangler config yourself, or the Worker connects directly with `connection.url`.

`vitehub database generate` writes Drizzle Kit migrations with `dialect: 'postgresql'` next to the Definition, without a database connection. `vitehub database migrate` applies them with `connection.url`, or the PG* variables when the URL is empty. Drizzle Kit then needs `PGHOST` and `PGDATABASE`. With neither, it applies them to the local PGlite folder, like a SQLite Database with an empty URL uses its local file. Run migrations from a deployment workflow, not the Worker, and set the URL there.

For `wrangler dev`, set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` to a local Postgres URL. See Cloudflare's [Hyperdrive local development guide](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).

### Select a hosted database for Vercel

Keep only tables in the Definition, and set the hosted libSQL connection in the `database` option. Runtime env declarations make the output read the Vercel Marketplace variables at runtime, so credentials are not built in.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    database: {
      connection: {
        url: env({ source: env.source('TURSO_DATABASE_URL') }),
        authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      database: {
        connection: {
          url: env({ source: env.source('TURSO_DATABASE_URL') }),
          authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
        },
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
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      database: {
        connection: {
          url: env({ source: env.source('TURSO_DATABASE_URL') }),
          authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
        },
      },
    }),
  ],
})
```
:::
::

This connection is a default. A Definition can still set its own `connection.url` or `connection.authToken`, which win for that database.

## Host output

Nitro writes all host output. The Database package finds Definitions, generates the Drizzle runtime and schema files, and adds host bindings to the Nitro config. Your code names a database by `default` or its name, never by a provider binding.

Put D1 bindings, hosted libSQL URLs, and Nuxt host resources in Database config or host setup. Route code keeps the generated Drizzle imports.

Run `vitehub inspect definitions --kind database` to list the Definitions that ViteHub found.

A Vite app with the Nitro Vite plugin and a Cloudflare host gets each Definition's `cloudflare` binding in `nitro.cloudflare.wrangler.d1_databases`, so you do not repeat it in Nitro config. The Definition's binding replaces one with the same name there. Other bindings stay. A Definition is added only when it has a `databaseName` and a D1 id from `databaseId` or provision state. Its migration SQL is copied next to the generated Wrangler config.

Cloudflare Nuxt output also copies D1 migration SQL next to the Wrangler config, so `.output/server` can apply migrations without the sources.

A project `wrangler.json`, `wrangler.jsonc`, or `wrangler.toml` can still declare a D1 binding that ViteHub also writes, for example one kept from NuxtHub. Nitro merges that file into the generated config. ViteHub then keeps one entry per binding name, at the top level and in each `env`:

- ViteHub's entry wins. The project entry only fills missing fields, such as `preview_database_id` or `migrations_table`.
- An all-zero `database_id` or `preview_database_id`, such as `00000000-0000-4000-8000-000000000000` in a Deploy to Cloudflare template, names no database. A real id from either side replaces it. A primary `database_id` that stays all-zero is left out, so Wrangler provisions the database on deploy.
- An unresolved `preview_database_id` is kept, so remote development does not fall back to production. Replace it with a real preview database ID before you use remote development.
- ViteHub keeps its own `migrations_dir` and ignores the project's `migrations_dir` and `migrations_pattern`, because the staged migrations live there.
- A different `database_id`, `database_name`, or `preview_database_id` fails the build with [`DATABASE_WRANGLER_BINDING_CONFLICT`](/docs/database/limits-and-errors#database_wrangler_binding_conflict).

The simplest setup removes the binding from the project file.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    database: {
      driver: 'd1',
      databaseName: 'app-content',
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'cloudflare',
      database: {
        driver: 'd1',
        databaseName: 'app-content',
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
      host: 'cloudflare',
      database: {
        driver: 'd1',
        databaseName: 'app-content',
      },
    }),
  ],
})
```
:::
::

Run `vitehub provision run --provider cloudflare` to write the D1 id to `.vitehub/provision.json`. A Cloudflare production build fails before deployment when it finds no id in provision state, `database.databaseId`, or a complete matching Nitro Wrangler binding.

::note
In Nuxt, `vitehub.database` declares one D1 Database Host Resource. It keeps Nuxt Content and Cloudflare `wrangler.d1_databases` in sync. Discovered Database Definitions still own the Drizzle Runtime Surface. For Cloudflare and Vercel builds, `vite-hub/nuxt` writes the hosted runtime, schema modules, and Definition defaults before Nitro resolves their imports. Explicit Nitro aliases take precedence.
::

## Nuxt Content

When a Nuxt app uses `@nuxt/content` and sets no `content.database`, a production build gives Content the default Database, as Content's NuxtHub preset does:

| Default Database | Content `database` |
| --- | --- |
| `dialect: 'postgresql'` with `connection.url` | `{ type: 'postgresql', url }` |
| SQLite with a remote or env `connection.url`, such as Turso | `{ type: 'libsql', url, authToken }` |
| Local SQLite file, D1, or PGlite | Not changed. Content keeps its own SQLite file or D1 binding. |

Content stores its tables in that database next to yours. Content's Postgres connector uses `pg`, so install it with `pnpm add pg`. Content's libSQL connector uses `@libsql/client`.

A URL or token from `process.env.NAME` or `env()` is not built in. The build writes an empty string, and the server reads the variable when it starts. `NUXT_CONTENT_DATABASE_URL` and `NUXT_CONTENT_DATABASE_AUTH_TOKEN` still win. A string literal in the Definition is built in, as it is for your own queries.

In `nuxt dev`, Content reads its local SQLite file, so nothing changes. On Cloudflare, Content keeps its D1 rule: set `content.database` or add a D1 binding named `DB`. Content keeps one database client for the whole Worker, and a Worker cannot reuse a Postgres socket across requests, so Content does not use Hyperdrive. To use another database for Content, set `content.database` yourself.

## Preview deployments

> [!WARNING]
> A Cloudflare Version URL uses the production resources of its Worker version, so it reads and writes production rows ([Compare workflows](https://developers.cloudflare.com/workers/previews/compare-workflows/)).

A Cloudflare Preview uses only the bindings in the Wrangler `previews` block. Two Previews that bind the same `database_id` share rows ([Resources and isolation](https://developers.cloudflare.com/workers/previews/resources/)). ViteHub does not write that block, so declare a preview database in `previews.d1_databases` yourself. Apply its migrations with a separate Wrangler migration config before you deploy, as [Preview deployments share data](/docs/development/provisioning#preview-deployments-share-data) shows.

For a separate preview Worker, read `cloudflare.databaseName` from an env declaration and provision it in that build's CI job. Leave `cloudflare.databaseId` unset to use the provisioned id, or set it to the preview id. A configured `cloudflare.databaseId` wins over provision state. Changing only `cloudflare.databaseName` does not override it.

## Production checks

- The schema in code can differ from the live schema when migrations have not run or an Agent can change the schema.
- A Definition has one dialect. Local SQLite, hosted libSQL, and D1 use SQLite-compatible SQL. A `postgresql` Definition uses Postgres SQL on every host.
- The Console database browser and the Agent `db_query` guard are written for SQLite. With Postgres, the Agent tools run statements through Drizzle `execute()` and read the schema from `information_schema`.
- Keep provider credentials in Server Env. Direct D1 HTTP sends `CLOUDFLARE_API_TOKEN` only as the Cloudflare Bearer credential. A proxy gets only its `cloudflare.http.authToken`.
- Run migrations, backups, and hosted database lifecycle in deployment workflows, not route code.

## Related guides

Read the [Turso](/docs/guides/turso), [Neon Postgres](/docs/guides/neon-postgres),
and [Cloudflare D1](/docs/guides/cloudflare-d1) guides for setup and checks.
