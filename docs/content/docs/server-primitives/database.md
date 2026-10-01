---
title: Database
description: Define relational data with Drizzle and query it through generated ViteHub imports.
navigation.order: 5
navigation.group: Data
icon: i-lucide-database
---

Use Database when your app needs relational schemas, constraints, joins, migrations, or queryable state. You define the schema with Drizzle next to your server code. ViteHub discovers the Definition, generates Drizzle artifacts and migration config, and gives server code a typed Drizzle client by database name.

The same Definition runs on local SQLite, a hosted libSQL database, or Cloudflare D1. Database works without Agents.

::tip
Choose the storage primitive by data shape:

- [KV](/docs/server-primitives/kv): small values that you read and write by key, such as settings, flags, cursors, and counters.
- Database: rows with a schema, constraints, joins, and migrations.
- [Blob](/docs/server-primitives/blob): files and binary objects with metadata, such as uploads, media, and exports.
- [Workspace](/docs/server-primitives/workspace): file trees with paths, snapshots, and diffs.
::

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/database drizzle-orm
pnpm add -D @vite-hub/cli drizzle-kit
```

### Configure

```ts [vite.config.ts]
import { hubDb } from '@vite-hub/database/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubDb()],
})
```

### Start using it

Define the schema in `src/database.ts`:

```ts [src/database.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    notes: sqliteTable('notes', {
      id: integer('id').primaryKey(),
      title: text('title').notNull(),
    }),
  },
})
```

Generate and apply the first migration:

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db migrate
```

Query it from server code:

```ts [server/api/notes.get.ts]
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('default')
  return db.select().from(schema.notes)
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `defineDatabase` from `@vite-hub/database` | Declare a Database Definition. |
| `useDatabase` from `@vite-hub/database/drizzle` | Select a generated Drizzle database and its schema by name. |
| `hubDb` from `@vite-hub/database/vite` | Register database discovery, generated schema, and Provider Output. |
| `@vite-hub/database/config` | Resolve database config values and discovery config. |
| `@vite-hub/database/cli` | Use the package-owned database CLI contribution. |
| `@vite-hub/database/nuxt` | Use the narrow Nuxt D1 host-resource bridge. |

All Database Definition, integration, connection, Cloudflare D1, Drizzle, and runtime config types are exported from `@vite-hub/database`.

## Configure the Vite Integration

`hubDb()` accepts the integration options below. You can also set them under the `database` key in `vite.config.ts`. That key takes precedence over the options passed to `hubDb()`.

```ts [vite.config.ts]
import { hubDb } from '@vite-hub/database/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubDb()],
  database: {
    cli: { generate: false },
  },
})
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `database` | `boolean` or `DBModulePublicOptions` | disabled | Enables database discovery and generated runtime imports through `vitehub()` with `true` or an options object. `false` leaves it disabled. |
| `database.projectRoot` | `string` | effective application root | Sets the root used for Database Definition discovery, generated artifacts, and provisioning. Relative paths resolve from the Vite root in a Vite app and from the Nuxt `rootDir` in a Nuxt app. |
| `database.cli.generate` | `false` | enabled | Disables the package-owned `db generate` command. |
| `database.cli.migrate` | `false` | enabled | Disables the package-owned `db migrate` command. |
| `database.connection` | `DatabaseConnectionConfig` | local SQLite | Supplies a hosted libSQL connection for Database Definitions that do not declare one. Definition connection values override matching integration values. |
| `database.driver` | `DatabaseRuntimeD1Options['driver']` | none | Selects Cloudflare D1 runtime output at integration level. Value: `d1`. |
| `database.binding` | `string` | `DB` or `DB_<NAME>` | Cloudflare D1 binding for integration-level runtime output. |
| `database.databaseId` | `DatabaseConfigValue` | Provision State | Cloudflare D1 database id. |
| `database.previewDatabaseId` | `DatabaseConfigValue` | none | Cloudflare D1 preview database id. |
| `database.databaseName` | `DatabaseConfigValue` | none | Cloudflare D1 database name. |
| `database.migrationsTable` | `string` | provider default | Cloudflare D1 migrations table. |

## Define a database

A Database Definition keeps the Database Table Schema next to the server code that uses it. ViteHub discovers Definitions from these files:

| File | Database |
| --- | --- |
| `src/database.ts` or `server/databases/config.ts` | Default Database, addressed as `default`. |
| `src/<name>.database.ts` or `server/databases/<name>/config.ts` | Named Database, addressed as `<name>`. The Definition must set `name: '<name>'`. |

A project uses either one Default Database or a set of Named Databases. Mixing both modes, or declaring two Default Databases, fails discovery.

```ts [src/database.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    notes: sqliteTable('notes', {
      id: integer('id').primaryKey(),
      title: text('title').notNull(),
      body: text('body').notNull(),
    }),
  },
})
```

## Database Definition options

`defineDatabase()` accepts one object.

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Named Databases only | Runtime identity. Must match the discovered file or directory name. |
| `schema` | `Record<string, Drizzle table>` | Yes | Database Table Schema source of truth. |
| `connection.url` | `DatabaseConfigValue` | No | SQLite or libSQL connection URL. Defaults to `file:.vitehub/data/database/sqlite.db` for a Default Database and `file:.vitehub/data/database/<name>.sqlite.db` for a Named Database. |
| `connection.authToken` | `DatabaseConfigValue` | No | Hosted database auth token. |
| `cloudflare.binding` | `string` | No | D1 binding. Defaults to `DB` for a Default Database and `DB_<NAME>` for a Named Database. |
| `cloudflare.databaseId` | `DatabaseConfigValue` | No | D1 database id. |
| `cloudflare.http` | `true \| { url, authToken }` | No | Selects authenticated D1 raw HTTP access for local and hosted runtimes. `true` uses Cloudflare's API. An object selects a compatible proxy. |
| `cloudflare.previewDatabaseId` | `DatabaseConfigValue` | No | D1 preview database id. |
| `cloudflare.databaseName` | `DatabaseConfigValue` | No | D1 database name. |
| `cloudflare.migrationsTable` | `string` | No | D1 migrations table. |
| `drizzle.casing` | `DrizzleCasing` | No | Drizzle casing option. Values: `snake_case`, `camelCase`. |

ViteHub currently exposes `sqlite` as the only public `DatabaseDialect`.

## Generate and apply migrations

The Database integration adds the `db` commands to the ViteHub CLI. `vite-hub` includes the CLI. Direct package installations need `@vite-hub/cli`, as shown in the quick start. Run the commands from the project root:

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db migrate
```

| Command | Effect |
| --- | --- |
| `vitehub db generate` | Refreshes the generated Drizzle config and creates migrations from your Database Definitions. Pass `--name <name>` to name the migration or `--custom` to create an empty migration. |
| `vitehub db migrate` | Refreshes the generated Drizzle config and applies pending migrations. |

Migrations go to a `migrations` directory next to each Database Definition file.

## Use it at runtime

Call `useDatabase()` from server code with the discovered database name. Use `default` for a Default Database. It returns the Drizzle client as `db` and the Definition schema as `schema`.

```ts [server/api/notes.get.ts]
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('default')
  return db.select().from(schema.notes)
})
```

The ViteHub Vite Integration resolves `@vite-hub/database/drizzle` for server code and Provider Output. Do not run files that import it with plain `node`. Run them through your Vite-built server or Provider Output.

### Use Named Databases

Use Named Databases when the app needs more than one independent database. Name a database for a real data or deployment split, not for a source-code folder.

```ts [src/analytics.database.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const events = sqliteTable('events', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
})

export default defineDatabase({
  name: 'analytics',
  schema: { events },
})
```

```ts [server/api/events.get.ts]
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('analytics')
  return db.select().from(schema.events)
})
```

## Providers

| Provider or runtime | Configure with | Notes |
| --- | --- | --- |
| Local SQLite | `connection.url` or no connection config | Default for local development and generated Drizzle artifacts. |
| Hosted libSQL (for example Turso) | `connection.url` and optional `connection.authToken` | Keep URLs and tokens in Server Env when they are secrets. |
| Cloudflare D1 | `cloudflare` Definition options or integration-level `database.driver: 'd1'` | Uses a D1 binding on Cloudflare. Local development and hosted Vercel output use D1 only when you set `cloudflare.http`. |

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

D1 HTTP also generates Drizzle Kit `d1-http` credentials. Migration and inspection commands call Cloudflare's API with `CLOUDFLARE_ACCOUNT_ID`, the database id, and `CLOUDFLARE_API_TOKEN`. ViteHub never embeds these credentials in generated output.

::warning
Cloudflare describes its built-in D1 REST API as best suited to administrative use because the global Cloudflare API rate limit applies. For sustained application traffic, use a narrowly authenticated proxy Worker and validate which queries or tables it may access. See Cloudflare's [D1 proxy Worker guide](https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1/).
::

If you omit `cloudflare.http`, ViteHub keeps local SQLite and the hosted libSQL selection, even when `cloudflare.databaseId` is set.

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

## Provider output

The Database Package discovers Database Definitions, generates the Drizzle Runtime Surface and schema artifacts, and wires provider-specific output. Provider bindings are integration details. The public database identity is the Default Database or Named Database name.

Put Cloudflare D1 bindings, hosted libSQL URLs, and Nuxt host resources in Database configuration or host setup. Route code keeps using the generated Drizzle imports.

Run `vitehub inspect definitions --kind database` to list the Definitions that ViteHub discovered.

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
- `sqlite` is the only dialect. Local SQLite, hosted libSQL, and Cloudflare D1 all use SQLite-compatible SQL.
- Keep provider credentials in Server Env. Direct D1 HTTP access sends `CLOUDFLARE_API_TOKEN` only as the Cloudflare Bearer credential. Proxy access sends only its configured `cloudflare.http.authToken`.
- Keep migrations, backups, and hosted database lifecycle in deployment workflows, not in route code.

## Connect Database to Agents

Direct Database access is for server code. To let a model inspect the schema or run guarded statements, attach the [Database Capability](/docs/capabilities/db).

The Database Capability is not a raw Drizzle client proxy. It adds agent-facing guardrails such as schema mode, data mode, write approvals, and a single-statement SQL check. Read it before you expose database access to an Agent.

## Next steps

- Store small key values with [KV](/docs/server-primitives/kv).
- Store file-shaped objects with [Blob](/docs/server-primitives/blob).
- Give an Agent guarded access with the [Database Capability](/docs/capabilities/db).
- Learn shared discovery rules in [Definitions and discovery](/docs/concepts/definitions-and-discovery).
