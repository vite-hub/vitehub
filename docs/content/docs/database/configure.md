---
title: Database configuration
description: Set Database integration options and define Default and Named Databases.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

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
| `database.binding` | `string` | `DB` | Integration D1 binding used by the Default Database. Named Databases infer their own binding names. |
| `database.databaseId` | `DatabaseConfigValue` | Provision State | Cloudflare D1 database id. |
| `database.previewDatabaseId` | `DatabaseConfigValue` | none | Cloudflare D1 preview database id. |
| `database.databaseName` | `DatabaseConfigValue` | none | Cloudflare D1 database name. |
| `database.migrationsTable` | `string` | provider default | Cloudflare D1 migrations table. |

With `vitehub()`, a discovered Database Definition does not enable Database. Without the `database` option, a build or `vite dev` that imports `vite-hub/database/drizzle` fails with `VITE_HUB_B0013`, and `vitehub db generate` and `vitehub db migrate` exit with an error. Add `database: true` or an options object to enable them. A directly composed `hubDb()` also provides Database.

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
| `cloudflare.http` | `true \| { url?, authToken? }` | No | Selects authenticated D1 raw HTTP access for local and hosted runtimes. `true` uses Cloudflare's API. An object selects a compatible proxy. |
| `cloudflare.previewDatabaseId` | `DatabaseConfigValue` | No | D1 preview database id. |
| `cloudflare.databaseName` | `DatabaseConfigValue` | No | D1 database name. |
| `cloudflare.migrationsTable` | `string` | No | D1 migrations table. |
| `drizzle.casing` | `DrizzleCasing` | No | Drizzle casing option. Values: `snake_case`, `camelCase`. |

A Definition inherits the integration resource when it omits both `cloudflare.databaseId` and `cloudflare.databaseName`. Setting either selects its own resource, so it inherits no integration database ID, name, or preview ID. Other D1 settings still inherit their defaults. HTTP proxy URLs and tokens inherit by field. Both must be available after inheritance for HTTP access to work.

Owned native resources need a nonblank database ID and name at build time. For native D1 provider output, use a Cloudflare block that ViteHub can read as a literal. An identifier, top-level spread, or other opaque resource expression fails the provider build when no D1 HTTP or remote libSQL connection is known, even if the evaluated block would inherit the integration resource. A known HTTP or libSQL connection keeps opaque Definitions supported.

Keep an explicit `cloudflare` property when its value is opaque. For a wholly hidden Definition, declare D1 intent with `hubDb({ driver: 'd1' })` in Vite or set `database.driver` to `'d1'` in Nuxt. Without that intent, ViteHub does not project native D1 output. Opaque local SQLite Definitions remain supported.

A Named Definition without an explicit `cloudflare.binding` uses its per-name binding. A Default Definition without an explicit binding keeps the integration binding. Named Definitions can inherit the integration resource through different binding names. Generated native D1 binding names must be unique, including bindings for identical resources. Set distinct binding values when explicit bindings or normalized names collide.

An opaque Definition that selects its own resource uses HTTP or libSQL access. Native bindings are not used, even when the Definition supplies the integration binding name.

Direct Vite and Nuxt output retain provisioned IDs as fallbacks for unset runtime Env values. Runtime values take precedence. Opaque Definitions that select their own resource do not receive integration provision IDs. Provision state is read from the Vite root even when `projectRoot` sets another root for Definitions and generated files.

ViteHub currently exposes `sqlite` as the only public `DatabaseDialect`.
