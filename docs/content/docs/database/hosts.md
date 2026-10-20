---
title: Database hosts
description: Select local SQLite, hosted libSQL, Cloudflare D1, or Postgres, read what each host output contains, and check production rules.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Providers

| Provider or runtime | Configure with | Notes |
| --- | --- | --- |
| Local SQLite | `connection.url` or no connection config | Default for local development and generated Drizzle artifacts. |
| Hosted libSQL (for example Turso) | `connection.url` and optional `connection.authToken` | Keep URLs and tokens in Server Env when they are secrets. |
| Cloudflare D1 | `cloudflare` Definition options or integration-level `database.driver: 'd1'` | Uses a D1 binding on Cloudflare. Local development and hosted Vercel output use D1 only when you set `cloudflare.http`. |
| Postgres (for example Neon) | `dialect: 'postgresql'` with `connection.url` and optional `cloudflare.hyperdriveId` | Uses a Cloudflare Hyperdrive binding on Cloudflare and `connection.url` on other hosts. See [Use Postgres](#use-postgres). |

### Use Cloudflare D1 over HTTP

A Database Definition can use the same D1 database during local development and from hosted providers. Cloudflare output prefers the configured binding. Set `cloudflare.http: true` to call Cloudflare's D1 raw API with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from Server Env.

```ts [server/databases/config.ts]
import { defineDatabase } from '@vite-hub/database'

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

Set `cloudflare.http: { url, authToken }` to send the same raw query wire format to an authenticated HTTP(S) proxy. Both values are required at runtime. Proxy authentication never falls back to `CLOUDFLARE_API_TOKEN`.

```ts [server/databases/config.ts]
import { defineDatabase } from '@vite-hub/database'

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

Production Nuxt builds that use only D1 HTTP do not bundle libSQL or native SQLite libraries. Local SQLite development keeps its local driver.

D1 HTTP also generates Drizzle Kit `d1-http` credentials. Migration and inspection commands call Cloudflare's API with `CLOUDFLARE_ACCOUNT_ID`, the database id, and `CLOUDFLARE_API_TOKEN`. ViteHub never embeds these credentials in generated output.

::warning
Cloudflare describes its built-in D1 REST API as best suited to administrative use because the global Cloudflare API rate limit applies. For sustained application traffic, use a narrowly authenticated proxy Worker and validate which queries or tables it may access. See Cloudflare's [D1 proxy Worker guide](https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1/).
::

If you omit `cloudflare.http`, ViteHub keeps local SQLite and the hosted libSQL selection, even when `cloudflare.databaseId` is set.

### Use Postgres

A Postgres Definition uses [postgres.js](https://github.com/porsager/postgres) through Drizzle. ViteHub selects the connection for each query:

1. When the Cloudflare Hyperdrive binding is present, ViteHub uses `env.<binding>.connectionString`.
2. Otherwise it uses `connection.url`.

Cloudflare Workers cannot use a socket from one request in a different request. Inside a Cloudflare request, ViteHub creates one client for that request and reuses it for all queries in the request. Hyperdrive keeps the pool of origin connections, so a new client per request is cheap. Each client opens at most 5 connections, which keeps a request inside the Workers connection limit. On Node, Vercel, and local development, one client pool serves the process.

ViteHub finds the request through a request scope:

- Direct Vite Cloudflare output runs each request in its own scope.
- Nitro 3 apps, including Nuxt apps on Nitro 3, get a generated middleware that runs each request in its own scope.
- Nitro 2 apps, such as Nuxt 4, cannot wrap the request. The Nuxt bridge installs a new env object for each request, and ViteHub uses it as the scope. Concurrent requests in one isolate can replace that object before a query starts. Use Nitro 3 for high-concurrency Postgres traffic on Workers.

```ts [server/databases/config.ts]
import { defineDatabase } from '@vite-hub/database'

import { notes } from './schema'

export default defineDatabase({
  dialect: 'postgresql',
  cloudflare: { hyperdriveId: process.env.CLOUDFLARE_HYPERDRIVE_ID },
  connection: { url: process.env.DATABASE_URL },
  schema: { notes },
})
```

Create the Hyperdrive configuration for your Neon or other Postgres database with `wrangler hyperdrive create`. Set `cloudflare.hyperdriveId` to its id. Cloudflare output then contains a `hyperdrive` binding named `HYPERDRIVE`, or `HYPERDRIVE_<NAME>` for a Named Database. A generated binding replaces a Nitro Wrangler binding with the same name. Without `cloudflare.hyperdriveId`, add the binding to your Wrangler config yourself, or the Worker connects directly with `connection.url`.

`vitehub db generate` writes Drizzle Kit migrations with `dialect: 'postgresql'` next to the Definition. It does not need a database connection. `vitehub db migrate` applies them with `connection.url`. Run migrations from a deployment workflow, not from the Worker.

For `wrangler dev`, set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` to a local Postgres URL. See Cloudflare's [Hyperdrive local development guide](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).

### Select a hosted database for Vercel

Keep the Database Definition limited to tables, then select its hosted libSQL connection in the Vite Integration. Runtime Env declarations keep the Vercel Marketplace environment variable lookup in generated output instead of embedding credentials at build time.

```ts [vite.config.ts]
import { hubDb } from '@vite-hub/database/vite'
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubEnv(),
    hubDb({
      connection: {
        url: env({ source: env.source('TURSO_DATABASE_URL') }),
        authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
      },
    }),
  ],
})
```

This connection is a deployment default. A Database Definition can still declare its own `connection.url` or `connection.authToken`. Those values take precedence for that database.

## Host output

Nitro is the only host output. The Database Package discovers Database Definitions, generates the Drizzle Runtime Surface and schema artifacts, and adds host bindings to the Nitro config. Provider bindings are integration details. The public database identity is the Default Database or Named Database name.

Put Cloudflare D1 bindings, hosted libSQL URLs, and Nuxt host resources in Database configuration or host setup. Route code keeps using the generated Drizzle imports.

Run `vitehub inspect definitions --kind database` to list the Definitions that ViteHub discovered.

A Vite app that builds with the Nitro Vite plugin and a Cloudflare preset gets each Database Definition's resolved `cloudflare` binding in `nitro.cloudflare.wrangler.d1_databases`. You do not repeat it in Nitro config. A binding with the same name in Nitro config is replaced by the Definition's binding; other bindings stay. A Definition is added only when it has a `databaseName` and a D1 id from `databaseId` or provision state. Its migration SQL is copied beside the generated Wrangler config.

Cloudflare Nuxt output copies discovered D1 migration SQL beside the generated Wrangler config, so `.output/server` can apply migrations without the source checkout.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vite-hub/database/nuxt'],
  database: {
    driver: 'd1',
    databaseName: 'app-content',
  },
})
```

Run `vitehub provision run --provider cloudflare` to resolve the D1 id into `.vitehub/provision.json`. A Cloudflare production build fails before deployment when it cannot get the id from provision state, `database.databaseId`, or an existing complete matching Nitro Wrangler binding.

::note
`@vite-hub/database/nuxt` is a narrow Nuxt lifecycle bridge for one D1 Database Host Resource. Its main use is to keep Nuxt Content and Cloudflare `wrangler.d1_databases` in sync. Discovered Database Definitions still own the Drizzle Runtime Surface. For Cloudflare and Vercel builds, the module writes the hosted runtime, schema modules, and Definition defaults before Nitro resolves their imports. Explicit Nitro aliases take precedence.
::

## Production checks

- The Database Table Schema is the schema in code. The live schema can differ when migrations have not run or when an Agent has schema write permission.
- A Definition has one dialect. Local SQLite, hosted libSQL, and Cloudflare D1 use SQLite-compatible SQL. A `postgresql` Definition uses Postgres SQL on every host.
- The Console database browser and the Agent `db_query` guard are written for SQLite. With Postgres, the Agent tools run statements through Drizzle `execute()` and read the schema from `information_schema`.
- Keep provider credentials in Server Env. Direct D1 HTTP access sends `CLOUDFLARE_API_TOKEN` only as the Cloudflare Bearer credential. Proxy access sends only its configured `cloudflare.http.authToken`.
- Keep migrations, backups, and hosted database lifecycle in deployment workflows, not in route code.
