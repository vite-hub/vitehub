---
title: Database
description: Define Drizzle-backed relational data and query it through generated ViteHub runtime surfaces.
navigation.order: 5
icon: i-lucide-database
---

Database owns relational application data for ViteHub apps. Use it when the app needs schema, constraints, joins, migrations, history, or queryable state.

Database is not KV, Blob, or Workspace. Use KV for small key-addressed values, Blob for object storage, and Workspace for file-tree state.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/database drizzle-orm
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

```ts [src/database.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
})

export default defineDatabase({
  tables: { notes },
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `defineDatabase` from `@vite-hub/database` | Declare a Database Definition. |
| `db`, `databases`, `schema` from `@vite-hub/database/drizzle` | Query the generated Drizzle Runtime Surface. |
| `hubDb` from `@vite-hub/database/vite` | Register database discovery, generated schema, and Provider Output. |
| `@vite-hub/database/config` | Resolve database config values and discovery config. |
| `@vite-hub/database/cli` | Use package-owned database CLI contribution. |
| `@vite-hub/database/nuxt` | Use the narrow Nuxt D1 host-resource bridge. |

All Database Definition, integration, connection, Cloudflare D1, Drizzle, and runtime config types are exported from `@vite-hub/database`.

## Configure the Vite Integration

```ts [vite.config.ts]
import { hubDb } from '@vite-hub/database/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubDb()],
})
```

The Vite config key is `database`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `database` | `true` or `DBModulePublicOptions` | disabled | Enables database discovery and generated runtime surfaces through `vitehub()`. |
| `database.cli.generate` | `false` | enabled | Disables package-owned schema generation CLI contribution. |
| `database.cli.migrate` | `false` | enabled | Disables package-owned migration CLI contribution. |
| `database.connection` | `DatabaseConnectionConfig` | local SQLite | Supplies a hosted libSQL connection for Database Definitions that do not declare one. Definition connection values override matching integration values. |
| `database.driver` | `DatabaseRuntimeD1Options['driver']` | none | Selects Cloudflare D1 runtime output when configured at integration level. Value: `d1`. |
| `database.binding` | `string` | `DB` or `DB_<NAME>` | Cloudflare D1 binding for integration-level runtime output. |
| `database.databaseId` | `DatabaseConfigValue` | none | Cloudflare D1 database id. |
| `database.previewDatabaseId` | `DatabaseConfigValue` | none | Cloudflare D1 preview database id. |
| `database.databaseName` | `DatabaseConfigValue` | none | Cloudflare D1 database name. |
| `database.migrationsTable` | `string` | provider default | Cloudflare D1 migrations table. |

## Define a database

Database Definitions keep the Database Table Schema close to the server code that owns it.

```ts [src/database.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
})

export default defineDatabase({
  tables: { notes },
})
```

A project uses either one Default Database or a set of Named Databases. Do not mix both modes in one app.

## Database Definition options

`defineDatabase()` accepts one object.

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `tables` | `Record<string, Drizzle table>` | Yes | Database Table Schema source of truth. |
| `connection.url` | `DatabaseConfigValue` | No | SQLite/libSQL connection URL. Defaults to `.vitehub/data/database/sqlite.db` for a Default Database. |
| `connection.authToken` | `DatabaseConfigValue` | No | Hosted database auth token. |
| `cloudflare.binding` | `string` | No | D1 binding. Defaults to `DB` for Default Database and `DB_<NAME>` for Named Databases. |
| `cloudflare.databaseId` | `DatabaseConfigValue` | No | D1 database id. |
| `cloudflare.http` | `true \| { url, authToken }` | No | Explicitly selects authenticated D1 raw HTTP access for hosted runtimes. `true` uses Cloudflare's API; an object selects a compatible proxy. |
| `cloudflare.previewDatabaseId` | `DatabaseConfigValue` | No | D1 preview database id. |
| `cloudflare.databaseName` | `DatabaseConfigValue` | No | D1 database name. |
| `cloudflare.migrationsTable` | `string` | No | D1 migrations table. |
| `drizzle.casing` | `DrizzleCasing` | No | Drizzle casing option. Values: `snake_case`, `camelCase`. |

ViteHub currently exposes `sqlite` as the public `DatabaseDialect`.

## Use it at runtime

Use the generated Drizzle Runtime Surface from server code.

```ts [server/api/notes.get.ts]
import { db, schema } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  return db.select().from(schema.notes)
})
```

The `@vite-hub/database/drizzle` runtime import is resolved by the ViteHub Vite Integration for server code and provider output. Do not run files that import it directly with plain `node`; run them through your Vite-built server path or provider output.

Use Named Databases when separate data boundaries need explicit names.

```ts [src/analytics.database.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const events = sqliteTable('events', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
})

export default defineDatabase({
  tables: { events },
})
```

Named databases should represent real ownership or operational boundaries, not folder organization.

```ts [server/api/events.get.ts]
import { databases } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  return databases.analytics.db.select().from(databases.analytics.schema.events)
})
```

## Providers

| Provider/runtime | Configure with | Nuance |
| --- | --- | --- |
| Local SQLite | `connection.url` or no connection config | Default for local development and generated Drizzle artifacts. |
| Hosted SQLite/libSQL-style connection | `connection.url` and optional `connection.authToken` | Keep URLs and tokens in Server Env when they are secrets. |
| Cloudflare D1 | `cloudflare` Definition options or integration-level `database.driver: 'd1'` | Uses a D1 binding on Cloudflare. Hosted Vercel output uses D1 only when `cloudflare.http` is selected explicitly. |

### Use Cloudflare D1 from Vercel

A Database Definition can use the same D1 database from Cloudflare and Vercel. Cloudflare output prefers the configured binding. Set `cloudflare.http: true` to make Vercel call Cloudflare's D1 raw API with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from Server Env.

```ts [server/databases/config.ts]
import { defineDatabase } from '@vite-hub/database'

import { notes } from './schema'

export default defineDatabase({
  cloudflare: {
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    databaseName: process.env.CLOUDFLARE_D1_DATABASE_NAME,
    http: true,
  },
  tables: { notes },
})
```

Use `cloudflare.http: { url, authToken }` to send the same raw query wire format to an authenticated HTTP(S) proxy instead. Both values are required at runtime, and proxy authentication never falls back to `CLOUDFLARE_API_TOKEN`.

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
  tables: { notes },
})
```

Selecting D1 HTTP also generates Drizzle Kit's `d1-http` credentials. Migration and inspection commands use Cloudflare's API with `CLOUDFLARE_ACCOUNT_ID`, the database id, and `CLOUDFLARE_API_TOKEN`; those credentials are never embedded in generated output.

::warning
Cloudflare describes its built-in D1 REST API as best suited to administrative use because the global Cloudflare API rate limit applies. For sustained application traffic, use a narrowly authenticated proxy Worker and validate which queries or tables it may access. See Cloudflare's [D1 proxy Worker guide](https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1/).
::

Omitting `cloudflare.http` preserves the existing hosted libSQL selection even when `cloudflare.databaseId` is present.

### Select a hosted database for Vercel

Keep the Database Definition limited to tables, then select its hosted libSQL connection in the Vite Integration. Runtime Env declarations preserve the Vercel Marketplace environment variable lookup in generated output instead of embedding credentials at build time.

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

This connection is a deployment default. A Database Definition can still declare a different `connection.url` or `connection.authToken`; those values take precedence for that database.

## Provider output

The Database Package discovers Database Definitions, generates the Drizzle Runtime Surface, produces generated schema artifacts, and wires provider-specific output. Provider bindings are integration details; the public database identity is the Default Database or Named Database.

Cloudflare D1 bindings, hosted libSQL URLs, and Nuxt host resources belong in Database configuration or host setup. Route code should keep using the generated Drizzle Runtime Surface.

::note
`@vite-hub/database/nuxt` is a narrow Nuxt lifecycle bridge for one D1 Database Host Resource, mainly to keep Nuxt Content and Cloudflare `wrangler.d1_databases` in sync. Discovered Database Definitions still own the Drizzle Runtime Surface.
::

## Connect it to Agents

Direct Database access is for server code. To let a model inspect schema or run guarded statements, attach the Database Capability.

The Database Capability is not a raw Drizzle client proxy. It uses agent-facing guardrails such as schema mode, data mode, write approvals, and the single-statement SQL guardrail. Read [Official capabilities](/docs/capabilities/official-capabilities) before exposing database access to an Agent.

## Production boundaries

Database Table Schema is the source schema in code. Live Database Schema can diverge when migrations have not run or when an Agent has explicit schema write permission.

Keep provider credentials in Server Env. Direct D1 HTTP access sends `CLOUDFLARE_API_TOKEN` only as the Cloudflare Bearer credential; proxy access sends only its configured `cloudflare.http.authToken`. Keep migrations, backup behavior, and hosted database lifecycle in deployment workflows instead of hiding them in route code.

## Next steps

- Store small key values with [KV](/docs/server-primitives/kv).
- Store file-shaped objects with [Blob](/docs/server-primitives/blob).
- Learn shared discovery rules in [Definitions and discovery](/docs/concepts/definitions-and-discovery).
