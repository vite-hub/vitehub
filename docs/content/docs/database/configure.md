---
title: Database configuration
description: Set Database options and define default and named databases for your app.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configure the integration

Pass these options to `database`. `hubDb()` accepts the same options when you add it yourself.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    database: {
      cli: { generate: false },
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
      database: {
        cli: { generate: false },
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
      database: {
        cli: { generate: false },
      },
    }),
  ],
})
```
:::
::

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `database` | `boolean` or `DatabaseOptions` | disabled | `true` or an object turns on Database in `vitehub()`. `false` leaves it off. |
| `database.projectRoot` | `string` | effective application root | Root for finding Definitions, generated files, and provisioning. Relative paths start from the Vite root, or from the Nuxt `rootDir` in Nuxt. |
| `database.cli.export` | `false` | enabled | Turns off `database export`. |
| `database.cli.generate` | `false` | enabled | Turns off `database generate`. |
| `database.cli.migrate` | `false` | enabled | Turns off `database migrate`. |
| `database.connection` | `DatabaseConnectionConfig` | local SQLite | Hosted libSQL connection for Definitions that set none. Values in a Definition win. |
| `database.driver` | `DatabaseRuntimeD1Options['driver']` | none | `d1` selects Cloudflare D1 output for all databases. |
| `database.binding` | `string` | `DB` | D1 binding of the default database. Named databases get their own binding names. |
| `database.databaseId` | `DatabaseConfigValue` | Provision State | Cloudflare D1 database id. |
| `database.previewDatabaseId` | `DatabaseConfigValue` | none | Cloudflare D1 preview database id. |
| `database.databaseName` | `DatabaseConfigValue` | none | Cloudflare D1 database name. |
| `database.migrationsTable` | `string` | provider default | Cloudflare D1 migrations table. |
| `database.migrateOnStart` | `boolean` or `{ allowDataLoss?: boolean }` | `false` | Applies pending migrations of local SQLite databases when a Node server build starts. See [Migrate when the server starts](#migrate-when-the-server-starts). |
| `database.readReplication` | `boolean` | `false` | Reads from D1 read replicas. See [Read from D1 replicas](/docs/database/hosts#read-from-d1-replicas). |

With `vitehub()`, a Definition file alone does not turn Database on. Without the `database` option, importing `vite-hub/database/drizzle` fails the build or `vite dev` with `VITE_HUB_B0013`, and `vitehub database generate` and `migrate` exit with an error. Set `database`, or add `hubDb()` yourself.

## Define a database

A Database Definition is the file where you write your tables, next to the server code that uses them. ViteHub finds Definitions in these files:

| File | Database |
| --- | --- |
| `server/databases/<name>.ts` or `server/databases/<name>/index.ts` | The Database `<name>`. `server/databases/default.ts` is the Default Database. Every other name must set `name: '<name>'`. |
| `src/database.ts` | Default Database, addressed as `default`. |
| `src/<name>.database.ts` | Named Database, addressed as `<name>`. The Definition must set `name: '<name>'`. |

Use `server/databases/<name>/index.ts` when the Database has other files, such as schema modules. A folder with an `index.ts` is one Database, so ViteHub does not read its other files as Definitions. Every other file in `server/databases/` is a Definition. The migrations of the Database `<name>` are in `server/databases/<name>/migrations/`.

`src/database.ts` cannot be used beside Named Databases, and two Default Databases fail discovery. Before this release, Databases used `server/databases/config.ts` and `server/databases/<name>/config.ts`. Those files now fail with `DATABASE_LEGACY_CONFIG_FILE`, and `npx @vite-hub/codemods define-forms` moves them.

An enabled Vite Database without a Definition is one empty Default Database. It works like `server/databases/default.ts` with `defineDatabase({ schema: {} })`: it uses `database.connection`, keeps migrations in `server/databases/default/migrations`, receives contributed tables, and is listed by `vitehub inspect` and the Console. Connections use it for their tables. The Nuxt module does not add it.

```ts [src/database.ts]
import { defineDatabase } from 'vite-hub/database'
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

`schema` can be an object literal, an imported object, a namespace import such as `import * as schema from './schema'`, or a spread of several schemas. ViteHub loads the Definition and exports every Drizzle table and view in it, so `vitehub database generate` writes migrations for all of them. A schema key cannot be `schema` or `default`, because the generated module uses those export names.

ViteHub loads the Definition with your Vite or Nuxt string aliases. If it still fails, for example on a module that only a Vite plugin provides, `vite dev` and builds warn and use the keys of a literal `schema: { ... }`. `vitehub database generate` fails instead, so a migration never drops a table silently.

## Apply migrations

A migration is a SQL file that changes your tables. `vitehub database generate` writes one next to the Definition. `vitehub database migrate` first reads each database's migrations table and checks the SQL of each pending migration, then applies them with Drizzle Kit.

Both commands run from the Database project root, even when Nuxt uses `app/` as its Vite root. The CLI finds Drizzle Kit in your dependencies or in `vite-hub`.

Connection URLs and tokens can be string literals or runtime env declarations, also through module-level variables. Kit reads env values when it runs, and uses the Turso dialect for remote or authenticated libSQL. The check uses the same connection. Local migration creates the database folder after the check. Generation and `--dry-run` never create the database file.

```bash [commands/migrate]
pnpm vitehub database migrate --dry-run
pnpm vitehub database migrate
```

`--dry-run` prints each pending migration with its SQL and changes nothing. `vitehub database migrate` refuses migrations that lose data and names the statements with `DATABASE_MIGRATION_DATA_LOSS`. These statements lose data:

- `DROP TABLE` and `DROP SCHEMA`
- a column drop with `ALTER TABLE`
- `TRUNCATE`, and `DELETE` without `WHERE`
- a SQLite table rebuild that does not copy every column of the previous Drizzle snapshot

With `--dry-run`, a migration that loses data makes the command exit with code 1, so CI can use it. The check skips a table that an earlier migration in the same run created or dropped, since it has no old rows. A table filled from an older table, like a SQLite rebuild, stays in the check. For PostgreSQL, the skip needs schema-qualified table names, and for `TRUNCATE`, `ONLY` on every target without `CASCADE`. After a SQLite temporary table is created, later losses stay in the check, because unqualified names can switch between temporary and permanent tables.

```txt
[vitehub] Database "default" (local SQLite .vitehub/data/database/sqlite.db): 1 pending migration.

  0001_drop_body
    ALTER TABLE `notes` DROP COLUMN `body`;
    ! Data loss: drops column "body" from "notes".
```

To accept the loss, back up the data and run `vitehub database migrate --allow-data-loss`. The flag also skips the check, for example when ViteHub cannot read the migrations table.

The check reads the database that Drizzle Kit migrates:

| Database | Check |
| --- | --- |
| Local SQLite | Reads the file. A missing file has no applied migrations, and the dry run does not create it. |
| Remote libSQL | Connects with `connection.url` and `connection.authToken`. |
| D1 HTTP (`cloudflare.http`) | Reads Wrangler's migrations table. `true` calls the Cloudflare API with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. An object uses its `url` and `authToken`. Missing credentials fail with `DATABASE_MIGRATION_CHECK_FAILED`. |
| Postgres | Connects with `connection.url` or the PG* variables. It needs the `postgres` package in the app. |

A native D1 binding is migrated with `wrangler d1 migrations apply`, not `vitehub database migrate`, so this check does not run.

For D1 HTTP, `vitehub database migrate` uses Wrangler's migrations table (`cloudflare.migrationsTable`, default `d1_migrations`), one row per applied `.sql` file, so Wrangler and ViteHub can take turns. Each file and its row go in one request, so D1 keeps neither when the file fails. When that table is missing but Drizzle Kit's `__drizzle_migrations` exists, ViteHub records the migrations Drizzle Kit applied.

## Migrate when the server starts

A self-hosted Node server, for example in Docker, often has only `.output`, with no sources or CLI for `vitehub database migrate`. Set `migrateOnStart` to apply pending migrations when the server starts:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { database: { migrateOnStart: true } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ database: { migrateOnStart: true } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ database: { migrateOnStart: true } })],
})
```
:::
::

The build copies each migrations folder into a Nitro plugin. At startup, the plugin reads Drizzle Kit's `__drizzle_migrations` table and applies pending migrations before the first request, in one transaction per database, and logs each one. It writes the same rows as `vitehub database migrate`, so either can migrate next.

Definitions that share a SQLite file share one transaction. Their migrations run in journal timestamp order, and matching timestamp and hash pairs run once. If a shared journal has a migration at or below the latest applied timestamp with no matching timestamp and hash in the table, startup fails with `DATABASE_MIGRATE_ON_START_UNSUPPORTED` before any change. Use compatible histories or separate SQLite files. `allowDataLoss` does not skip this check.

A migration that loses data, by the `vitehub database migrate` rules, stops the server with `DATABASE_MIGRATION_DATA_LOSS` and no change. Back up the data and set `migrateOnStart: { allowDataLoss: true }` to apply it.

`migrateOnStart` works only for local SQLite files (`file:` URLs) in a production build with the Node preset. Another host, Postgres, D1 over HTTP, or a URL that turns out to be remote libSQL fails with `DATABASE_MIGRATE_ON_START_UNSUPPORTED`. Migrate those, and development databases, with `vitehub database migrate`.

> [!WARNING]
> Run one server process per database file. Two processes that start together can both find a migration pending, and the second fails to start. With several processes, such as the `node-cluster` preset, migrate before you start them.

## Export a database

`vitehub database export` writes a SQL dump of each database. Like `vitehub database migrate`, it reads the config and does not build the app.

```bash [commands/export]
pnpm vitehub database export                                   # the local SQLite file
pnpm vitehub database export --remote --stage production       # the deployed database
pnpm vitehub database export --remote --database analytics --output backups/analytics.sql
```

Without `--output`, each database goes to `.vitehub/exports/database/<name>-<local|remote>-<time>.sql` in the Database project root. `--output` writes one file, so it needs `--database` when the app has several. The command never replaces a file. `--stage <name>` loads the Vite env files of that mode. Variables of the current process win.

Without `--remote`, the command reads only the local SQLite file that `vitehub database migrate` uses. Any other database needs `--remote`, so you never export production by accident:

| Database | Export |
| --- | --- |
| Local SQLite, or a native D1 binding without `--remote` | Reads the file in one read transaction. |
| Remote libSQL | Connects with `connection.url` and `connection.authToken` in one read transaction. |
| Native D1 binding or `cloudflare.http: true` | Calls Cloudflare's D1 export API, like `wrangler d1 export --remote`, with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. It uses `cloudflare.databaseId` or the provisioned id, else finds the database by `cloudflare.databaseName`. A native binding with a remote libSQL `connection.url` exports libSQL instead. |
| Object-form `cloudflare.http` | Reads the tables through the proxy `url` and `authToken`. |
| Postgres | Runs `pg_dump` with `connection.url` or the PG* variables. The password goes in `PGPASSWORD`, not the process arguments. `pg_dump` must be on `PATH`. |

SQLite, libSQL, and D1 dumps use the `wrangler d1 export` format: `PRAGMA defer_foreign_keys=TRUE;`, tables with rows, then indexes, views, and triggers, with no `BEGIN TRANSACTION`. Restore with `wrangler d1 execute <database> --remote --file <dump>` or `sqlite3 app.db < dump.sql`. The command skips SQLite and D1 internal tables, except `sqlite_sequence`. It prints the target without credentials. On failure, it prints `DATABASE_EXPORT_FAILED`, removes the partial file, and exits with code 1.

For local SQLite, libSQL, and object-form D1 proxies, contentless FTS5 tables (`content=''`) are not supported. The command fails instead of writing a dump without their search indexes. Use a SQLite backup that keeps FTS shadow tables.

Object-form D1 proxies cannot keep one read transaction across requests. So tables without a usable rowid key, such as `WITHOUT ROWID` and virtual tables, are read in one query, and writes cannot shift pages. If that query is over the proxy's response limit, the export fails with no dump. Use the native D1 export API then.

## Tables from Nuxt layers

In Nuxt, ViteHub also finds Definitions in the server folder of each layer.
Definitions with the same name join into one database with all their tables.
`vitehub database generate` writes one set of migrations for it.

```ts [layers/blog/server/databases/default.ts]
import { defineDatabase } from 'vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    posts: sqliteTable('posts', {
      id: integer('id').primaryKey(),
      title: text('title').notNull(),
    }),
  },
})
```

Rules:

- `connection`, `cloudflare`, and `drizzle` come from one Definition. When the application Definition sets one of them, it replaces all layer options, so it must also set each option that a layer sets. The application and each layer that sets options must then pass an object literal to `defineDatabase()`, so that ViteHub can read their options. Otherwise one layer can set them. Two layers that set them fail discovery until the application sets them.
- An application table replaces a layer table with the same key. Use this to add columns to a layer table. Two layers that declare the same table key fail discovery.
- Migrations go to the application, in `server/databases/default/migrations` or `server/databases/<name>/migrations`, also when only layers define the database.

ViteHub finds duplicate table keys when `schema` is an object literal. Query the merged database with `useDatabase()` or the `db` server auto-import. A layer that queries its own `defineDatabase()` object sees only its own tables.

## Contribute tables from a package

A package can add Drizzle tables to the app's database from its Vite plugin, without editing the app's Definition. Add `vitehub.databases` to the plugin object. Each entry has a `name` and a `definition` with the module and export of an object of tables:

```ts [my-package/vite.ts]
import type { Plugin } from 'vite'
import type { DatabaseContributingPlugin } from '@vite-hub/database/vite'

export function myPackage(): Plugin & DatabaseContributingPlugin {
  return {
    name: 'my-package/vite',
    vitehub: {
      databases: () => [{
        name: 'history',
        definition: { module: 'my-package/schema', export: 'historySchema' },
        reason: 'Stores Workspace history.',
      }],
    },
  }
}
```

```ts [my-package/schema.ts]
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const historySchema = {
  historyRefs: sqliteTable('history_refs', { workspace: text('workspace').primaryKey(), head: text('head') }),
  historyRevisions: sqliteTable('history_revisions', { id: integer('id').primaryKey() }),
}
```

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Name of this group of tables, unique per contribution. Inspection and errors show it. |
| `definition.module` | `string` | Absolute file path, `file:` URL, or package specifier that the app can import. Relative paths are rejected. |
| `definition.export` | `string` | Export that holds the object of tables. Defaults to `default`. |
| `reason` | `string` | Optional. Why the package adds the tables. `vitehub inspect definitions` and the Console show it. |
| `database` | `string` | Optional. Database that gets the tables. Omit it for the default or only database. |
| `dialect` | `'sqlite' \| 'postgresql'` | Optional. SQL dialect of the tables. The build fails if the target database uses another one. |
| `tables` | `Record<string, string>` | Optional. Every table of the export, key to SQL name, such as `{ historyRefs: 'history_refs' }`. The build then lists tables without loading the module, so the Vite config loads neither the schema nor drizzle-orm. A key missing here is missing from the generated schema. |

`vitehub.databases` accepts an array or a factory, which can be async. The factory gets `{ root, projectRoot, serverDirs }`, where `root` is the Vite root. It runs once per discovery pass and must return the same result each time. Contributions are sorted by name.

### Contribute tables from a Nuxt module

A Nuxt module adds the same plugin to `nuxt.options.vite.plugins` during setup:

```ts [my-package/nuxt.ts]
import { defineNuxtModule } from '@nuxt/kit'
import { myPackage } from './vite'

export default defineNuxtModule({
  setup(_options, nuxt) {
    nuxt.options.vite.plugins ||= []
    nuxt.options.vite.plugins.push(myPackage())
  },
})
```

Database reads contributions after every module has run setup, so module order does not matter. Do not use `addVitePlugin()`: it adds the plugin when Vite starts, after Nitro has built its Database runtime.

Contributed tables go everywhere the Definition schema goes:

- The generated Drizzle schema exports each contributed table, so `vitehub database generate` writes their migrations.
- `useDatabase(name).schema`, `db.query`, and the generated `DatabaseRegistry` types include them, in Vite, Nuxt, and Nitro.
- `vitehub inspect definitions` and the Console Database section list them in a `Contributed tables` field, with the plugin.

The Definition object you import from its file has only its own `schema`. Read contributed tables from `useDatabase(name).schema` or import them from their package.

A contribution without `database` targets `default`, or the only database. `resolveDefaultDatabase(names)` from `@vite-hub/database/config` uses the same rule, so a package can pick that database at runtime. The Console uses it to choose its D1 journal.

### Need the default Database

A package that needs a database contributes its tables without `database`, or with `database: 'default'`, and does not add one. When the app has no Definition, Database adds one empty `default` database for all such packages, in Vite and Nuxt. Its migrations go to `server/databases/default/migrations/`, and it uses the contributions' `dialect`, or SQLite. The CMS preset, Comments, and Connections work this way.

A package that uses its own SQL and has no Drizzle tables contributes an entry without `definition`. ViteHub checks its database and dialect as for tables:

```ts [my-package/vite.ts] fragment
vitehub: {
  databases: () => [{ name: 'my-package', database: 'default', dialect: 'sqlite', reason: 'Stores my-package state with its own SQL.' }],
},
```

`vitehub inspect definitions --kind database` shows `Definition: Implicit` with the plugins that need it, a `Contributed tables` field per table contribution, and a `Used by` field per entry without tables. When the app adds `server/databases/default.ts`, the contributions move to it and keep the same migrations folder. Contributions that need different dialects fail with `DATABASE_INVALID_CONTRIBUTION_TARGET`.

### Contribute a Database

A package that owns a named database can add a whole Definition. For the default database, read [Need the default Database](#need-the-default-database). Write the Definition module, for example under `.vitehub/`, and return `{ name, definition, reason? }` from `vitehub.databases`. Here `definition` is the absolute module path, not a `{ module, export }` object:

```ts [my-package/vite.ts] fragment
// In the plugin object:
vitehub: {
  databases: async ({ rootDir }) => {
    const definition = await writeDefinition(rootDir) // export default defineDatabase({ name: 'history', schema: {} })
    return [
      { name: 'history', definition, reason: 'my-package keeps its history in its own Database.' },
      { name: 'history-tables', database: 'history', definition: { module: 'my-package/schema', export: 'historySchema' } },
    ]
  },
},
```

A project cannot mix a default database with named ones, so this fits an app whose databases are all named.

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Database name. The app must not define a database with this name. |
| `definition` | `string` | Absolute path of a module whose default export is `defineDatabase({ schema })`, with the same `name`. |
| `reason` | `string` | Optional. Why the package adds the Database. `vitehub inspect` shows it. |

A contributed database works like one in `server/databases/`: `vitehub database generate`, `database migrate`, the runtime registry, `vitehub provision`, and `vitehub inspect definitions` include it. Inspection shows `Contributed by`, `Reason`, and `Migrations`. Its migrations go where an app Definition with the same name keeps them (`server/databases/default/migrations/` for `default`, else `server/databases/<name>/migrations/`), so adding that Definition later keeps the history.

The factory context also has `rootDir`, the root where Definitions are found, and `plugins`, the flat list of Vite plugins.

### Contribution errors

| Code | Cause |
| --- | --- |
| `DATABASE_DUPLICATE_TABLE` | Two plugins use one `name`, or a contributed table uses the key or SQL name of an app table or another contribution. |
| `DATABASE_INVALID_CONTRIBUTION_TARGET` | The target database does not exist, is ambiguous, or has another dialect, or contributions to the implicit default database need different dialects. |
| `DATABASE_INVALID_CONTRIBUTION` | The contribution shape or schema export is invalid, or a contributed Definition module does not exist. |
| `DATABASE_DUPLICATE_DEFINITION` | Two plugins contribute different Definitions with one name, or the app already defines that database. |
| `DATABASE_SCHEMA_LOAD_FAILED` | The contributed module cannot load. `vitehub database generate` fails; dev and builds print a warning. |

For other build steps, `collectDatabaseContributions(plugins, context)` from `@vite-hub/database/vite` returns the validated `{ definitions, tables, uses }`. `resolveDatabaseContributionTargets(names, tables)` returns the target of each table contribution or use.

## Connect without a Definition

A package with its own tables, such as [Comments](/docs/comments/configure#choose-the-database), can connect to the app's database without a Definition or migrations. `connectDatabase()` takes a string that says where the database is and returns a Drizzle SQLite database:

```ts [server/utils/notes.ts] fragment
import { connectDatabase } from '@vite-hub/database/connect'
import { notes } from './schema'

export const db = connectDatabase('env:NOTES_DATABASE_URL', {
  schema: { notes },
  setup: ['CREATE TABLE IF NOT EXISTS notes (id integer PRIMARY KEY, body text NOT NULL)'],
})
```

| Location | Connects to |
| --- | --- |
| Not set (`undefined`) | `DATABASE_URL`, else `TURSO_DATABASE_URL`, else the Cloudflare D1 binding `DB`. A Postgres URL is skipped. |
| `'d1:NAME'` | The Cloudflare D1 binding `NAME`. |
| `'env:NAME'` | The libSQL URL in the variable `NAME`. Its token is the URL's `authToken` parameter, or the variable next to it: `TURSO_DATABASE_URL` reads `TURSO_AUTH_TOKEN`, and `NOTES_DATABASE_URL` reads `NOTES_AUTH_TOKEN`. |
| `'libsql://…'`, `'https://…'` | That libSQL URL. A token in it ends up in the build. |
| `'file:./data/app.sqlite'` | A SQLite file, opened with Node's `node:sqlite`. Import `connectDatabase()` from `@vite-hub/database/connect/node` for it. Workers have no files. |

Remote connections use libSQL over HTTP. `ws://` and `wss://` are not supported.

Variables and bindings are read on each query, so a Worker gets the bindings of its request. `setup` runs once per database before the first query, and again on the next query if it fails, so use repeatable statements such as `CREATE TABLE IF NOT EXISTS`. `fallback` is a second location for when the first finds nothing, such as a SQLite file on the dev server.

Errors: [`DATABASE_NOT_CONNECTED`](/docs/database/limits-and-errors#database_not_connected) when a query finds no database, and [`DATABASE_UNSUPPORTED_URL`](/docs/database/limits-and-errors#database_unsupported_url) for a location it cannot use. Drizzle puts them in `error.cause` of its query error. Postgres is not supported yet.

## Database Definition options

`defineDatabase()` accepts one object.

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Named databases only | Must match the file or folder name. |
| `dialect` | `'sqlite' \| 'postgresql'` | No | Defaults to `sqlite`. Write it as a string literal. See [Define a Postgres database](#define-a-postgres-database). |
| `schema` | `Record<string, Drizzle table>` | Yes | Your tables. Packages can [contribute more](#contribute-tables-from-a-package). |
| `connection.url` | `DatabaseConfigValue` | No | SQLite or libSQL URL. Defaults to `file:.vitehub/data/database/sqlite.db` for the default database and `file:.vitehub/data/database/<name>.sqlite.db` for a named one. |
| `remote` | `boolean` | No | In `vite dev`, queries the real D1 database over HTTP instead of local SQLite, so writes change real data. Builds ignore it. See [Use the real D1 database in development](/docs/database/hosts#use-the-real-d1-database-in-development). |
| `connection.authToken` | `DatabaseConfigValue` | No | Hosted database auth token. |
| `cloudflare.binding` | `string` | No | D1 binding. Defaults to `DB`, or `DB_<NAME>` for a named database. |
| `cloudflare.databaseId` | `DatabaseConfigValue` | No | D1 database id. |
| `cloudflare.http` | `true \| { url?, authToken? }` | No | D1 over authenticated HTTP, locally and hosted. `true` uses Cloudflare's API. An object selects a compatible proxy. In `vite dev`, it also makes the Database remote, like `remote: true`. |
| `cloudflare.previewDatabaseId` | `DatabaseConfigValue` | No | D1 preview database id. |
| `cloudflare.databaseName` | `DatabaseConfigValue` | No | D1 database name. |
| `cloudflare.migrationsTable` | `string` | No | D1 migrations table that Wrangler and `vitehub database migrate` use. Default: `d1_migrations`. |
| `cloudflare.readReplication` | `boolean` | No | Reads from D1 read replicas. Inherits `database.readReplication`. See [Read from D1 replicas](/docs/database/hosts#read-from-d1-replicas). |
| `drizzle.casing` | `DrizzleCasing` | No | `snake_case` or `camelCase`. Applies to queries and to migrations from `vitehub database generate`. |

A Definition uses the top-level `database` D1 resource when it sets neither `cloudflare.databaseId` nor `cloudflare.databaseName`. Setting either selects its own resource, so it takes no database ID, name, or preview ID from the top level. Other D1 settings still use their defaults. HTTP proxy URLs and tokens are inherited one field at a time, and both must be set in the end for HTTP access.

A Definition that owns a native resource needs a nonblank database ID and name at build time. For a native D1 binding, write the `cloudflare` block as a literal that ViteHub can read. An opaque expression, such as an identifier or a top-level spread, fails the Cloudflare build when no D1 HTTP or remote libSQL connection is known, even if the block would inherit. With such a connection, opaque Definitions work.

Keep an explicit `cloudflare` property when its value is opaque. For a fully hidden Definition, declare D1 with `database: { driver: 'cloudflare' }`, or ViteHub writes no native D1 output. Opaque local SQLite Definitions still work.

A named Definition without `cloudflare.binding` uses its per-name binding. A default Definition without one keeps the top-level binding. Named Definitions can share the top-level resource through different binding names. Generated D1 binding names must be unique, even for identical resources. Set different binding values when explicit or normalized names collide.

An opaque Definition that selects its own resource uses HTTP or libSQL, never a native binding, even when it gives the top-level binding name.

Vite and Nuxt output keep provisioned IDs as fallbacks for unset runtime env values. Runtime values win. Opaque Definitions that select their own resource do not get top-level provisioned IDs. Provision state is read from the Vite root, even when `projectRoot` sets another root.

## Define a Postgres database

Set `dialect: 'postgresql'`, write the tables with `drizzle-orm/pg-core`, and install the [`postgres`](https://github.com/porsager/postgres) driver.

```bash
pnpm add postgres
```

```ts [server/databases/default.ts]
import { defineDatabase } from 'vite-hub/database'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export default defineDatabase({
  dialect: 'postgresql',
  cloudflare: { hyperdriveId: process.env.CLOUDFLARE_HYPERDRIVE_ID },
  connection: { url: process.env.DATABASE_URL },
  schema: {
    notes: pgTable('notes', {
      id: serial('id').primaryKey(),
      title: text('title').notNull(),
    }),
  },
})
```

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `connection.url` | `DatabaseConfigValue` | No | Postgres URL for Node, Vercel, local development, and `vitehub database migrate`. |
| `cloudflare.binding` | `string` | No | Cloudflare Hyperdrive binding. Defaults to `HYPERDRIVE`, or `HYPERDRIVE_<NAME>` for a named database. |
| `cloudflare.hyperdriveId` | `DatabaseConfigValue` | No | Hyperdrive config id. When it is known at build time, ViteHub adds the binding to the Wrangler config. |
| `drizzle.casing` | `DrizzleCasing` | No | Drizzle casing option. |

A Postgres Definition has its own connection. It ignores the top-level `connection`, the D1 options, and the local SQLite default. With a Hyperdrive binding at runtime, ViteHub uses its connection string, else `connection.url`. Outside a Cloudflare request with an empty URL, postgres.js reads `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` (or `PGUSERNAME`), and `PGPASSWORD`. A query fails with `DATABASE_MISSING_CONNECTION` when none is set.

Query it with `useDatabase()`. See [Hosts](/docs/database/hosts#use-postgres) for how ViteHub creates clients on each host.
