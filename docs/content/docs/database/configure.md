---
title: Database configuration
description: Set Database options and define default and named databases for your app.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configure the integration

Pass these options to `database`. `hubDatabase()` accepts the same options when you add it yourself.

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
| `database.cli.up` | `false` | enabled | Turns off `database up`. |
| `database.connection` | `DatabaseConnectionConfig` | local SQLite | Hosted libSQL connection for Definitions that set none. Values in a Definition win. |
| `database.driver` | `DatabaseRuntimeD1Options['driver']` | none | `d1` selects Cloudflare D1 output for all databases. |
| `database.binding` | `string` | `DB` | D1 binding of the default database. Named databases get their own binding names. |
| `database.databaseId` | `DatabaseConfigValue` | Provision State | Cloudflare D1 database id. |
| `database.previewDatabaseId` | `DatabaseConfigValue` | none | Cloudflare D1 preview database id. |
| `database.databaseName` | `DatabaseConfigValue` | none | Cloudflare D1 database name. |
| `database.migrationsTable` | `string` | provider default | Cloudflare D1 migrations table. |
| `database.migrateOnStart` | `boolean` or `{ allowDataLoss?: boolean }` | On for Postgres in a Node build | Applies pending migrations when a Node server build starts. Unset, only Postgres databases migrate. `true` also migrates local SQLite files. `false` turns it off. See [Migrate when the server starts](#migrate-when-the-server-starts). |
| `database.migrateOnDeploy` | `boolean` | `false` | Applies the pending migrations of each Cloudflare D1 binding in the deploy command, before the Worker deploys. See [Migrate when you deploy](#migrate-when-you-deploy). |
| `database.readReplication` | `boolean` | `false` | Reads from D1 read replicas. See [Read from D1 replicas](/docs/database/hosts#read-from-d1-replicas). |

With `vitehub()`, a Definition file alone does not turn Database on. Without the `database` option, importing `vite-hub/database` fails the build or `vite dev` with `VITE_HUB_B0013`, and `vitehub database generate` and `migrate` exit with an error. Set `database`, or add `hubDatabase()` yourself.

## Define a database

A Database Definition is the file where you write your tables, next to the server code that uses them. ViteHub finds Definitions in these files:

| File | Database |
| --- | --- |
| `server/databases/<name>.ts` or `server/databases/<name>/index.ts` | The Database `<name>`. `server/databases/default.ts` is the Default Database. Every other name must set `name: '<name>'`. |
| `src/database.ts` | Default Database, addressed as `default`. |
| `src/<name>.database.ts` | Named Database, addressed as `<name>`. The Definition must set `name: '<name>'`. |

Use `server/databases/<name>/index.ts` when the Database has other files, such as schema modules. A folder with an `index.ts` is one Database, so ViteHub does not read its other files as Definitions. Every other file in `server/databases/` is a Definition. The migrations of the Database `<name>` are in `server/databases/<name>/migrations/`.

`src/database.ts` cannot be used beside Named Databases, and two Default Databases fail discovery. Before this release, Databases used `server/databases/config.ts` and `server/databases/<name>/config.ts`. Those files now fail with `DATABASE_LEGACY_CONFIG_FILE`, and the [`define-forms` codemod](/docs/codemods/upgrade-vitehub#define-forms) moves them.

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

`schema` can be an object literal, an imported object, a namespace import such as `import * as schema from './schema'`, or a spread of several schemas. ViteHub loads the Definition and exports every Drizzle table and view in it, so `vitehub database generate` writes migrations for all of them. A schema key cannot be `schema`, `relations`, or `default`, because the generated module uses those export names.

ViteHub loads the Definition with your Vite or Nuxt string aliases. If it still fails, for example on a module that only a Vite plugin provides, `vite dev` and builds warn and use the keys of a literal `schema: { ... }`. `vitehub database generate` fails instead, so a migration never drops a table silently.

### Query related tables

`db.query.<table>` reads rows with Drizzle's relational queries. To read related rows in the same query, pass `relations` from Drizzle's `defineRelations()`:

```ts [server/databases/blog.ts]
import { defineDatabase } from '@vite-hub/database'
import { defineRelations } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
})
const posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  title: text('title').notNull(),
})

export default defineDatabase({
  name: 'blog',
  schema: { users, posts },
  relations: defineRelations({ users, posts }, r => ({
    users: { posts: r.many.posts() },
    posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) },
  })),
})
```

Then `with` reads the related rows, and its result is typed:

```ts [server/api/users.get.ts]
import { useDatabase } from '@vite-hub/database'
import { defineEventHandler } from 'h3'

export default defineEventHandler(() => {
  const { db } = useDatabase('blog')
  // [{ id, name, posts: [{ id, authorId, title }] }]
  return db.query.users.findMany({ with: { posts: true } })
})
```

Without `relations`, ViteHub uses `defineRelations(schema)`: `db.query.<table>` reads each table, and no table has relations. Postgres Definitions take `relations` the same way. `useDatabase(name).relations` holds the relations that the database uses, after it merges Nuxt layers and contributed tables.

`defineRelations()` must get the same table objects as `schema`. A relation to a table that is not in the database, or to a table that a later layer replaced, fails with `DATABASE_INVALID_RELATIONS` when the server starts.

### Name columns in snake_case

Drizzle 1.0 sets the casing of column names on each table, not on the database. To write camelCase keys as snake_case columns, declare the table with `snakeCase.table()`. Queries and the migrations of `vitehub database generate` both use the snake_case names.

```ts [server/databases/default/index.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, snakeCase, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    // Columns `id` and `display_name`.
    users: snakeCase.table('users', {
      id: integer().primaryKey(),
      displayName: text().notNull(),
    }),
  },
})
```

Postgres tables use `snakeCase.table()` from `drizzle-orm/pg-core`. `defineDatabase()` has no `drizzle` option and throws `DATABASE_DRIZZLE_OPTION_REMOVED` when it gets one.

## Apply migrations

A migration is a folder that changes your tables. `vitehub database generate` writes one next to the Definition, as Drizzle Kit 1.0 does: `migrations/<YYYYMMDDHHmmss>_<name>/` with `migration.sql` and `snapshot.json`. `vitehub database migrate` first reads each database's migrations table and checks the SQL of each pending migration, then applies them with Drizzle Kit. For Postgres, it applies them with the migrator that a server runs [on start](#migrate-when-the-server-starts): it writes the same rows as Drizzle Kit and holds the same advisory lock as a starting server. A Postgres Database on [PGlite](#run-postgres-locally-with-pglite) has no server to lock, so Drizzle Kit applies its migrations. A migration is pending when the `name` column of the table does not list its folder.

A folder from Drizzle Kit 0.x needs `vitehub database up` once. Read [Upgrade to Drizzle 1.0](#upgrade-to-drizzle-10).

The CLI and startup refuse the ledger upgrade when overlapping timestamp or hash updates would assign different folder names to one row. Drizzle Kit can replay applied SQL in that case. Verify and repair the ledger upgrade on a database copy before retrying.

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

For D1 HTTP, `vitehub database migrate` uses Wrangler's migrations table (`cloudflare.migrationsTable`, default `d1_migrations`), one row per applied file, so Wrangler and ViteHub can take turns. Wrangler reads flat `.sql` files, so each migration folder counts as `NNNN_<name>.sql`, and a Cloudflare build writes it as that file next to the Wrangler config. `vitehub database generate` and the build keep these names in `d1-migrations.json` next to the migrations. Commit it: a listed folder keeps its name, and a new folder takes the next number, even when a merge brings a folder with an earlier timestamp. Without the file, the numbers follow the folder order. These are the names that Drizzle Kit 0.x used, so a folder that `drizzle-kit up` converted keeps its row in `d1_migrations` and does not run again. When a name in `d1_migrations` moved to another number, `vitehub database migrate` fails the check with `DATABASE_MIGRATION_CHECK_FAILED`. Each file and its row go in one request, so D1 keeps neither when the file fails. When that table is missing but Drizzle Kit's `__drizzle_migrations` exists, ViteHub records the migrations Drizzle Kit applied.

### Upgrade to Drizzle 1.0

ViteHub uses `drizzle-orm` and `drizzle-kit` 1.0. Install `drizzle-orm@1.0.0-rc.5` and `drizzle-kit@1.0.0-rc.5`. Four things change for an app that used Drizzle 0.x:

- **Migrations folders.** Drizzle Kit 0.x wrote flat `.sql` files and `meta/_journal.json`. Drizzle Kit 1.0 writes one `<YYYYMMDDHHmmss>_<name>/` folder per migration and cannot read the old layout. Until you convert it, `vitehub database generate`, `vitehub database migrate`, the build with `migrateOnStart`, and test mode fail with `DATABASE_MIGRATIONS_OLD_LAYOUT`.
- **Applied migrations.** The next `vitehub database migrate` adds the `name` column to the migrations table and fills it for the migrations that 0.x applied. They do not run again. On D1, each converted folder keeps the file name that Wrangler applied, such as `0000_init.sql`.
- **Casing.** `defineDatabase()` has no `drizzle` option. Drizzle 1.0 has no `casing` for a database. Declare each table with `snakeCase.table()`, as in [Name columns in snake_case](#name-columns-in-snake_case). A `drizzle` option throws `DATABASE_DRIZZLE_OPTION_REMOVED`.
- **Relational queries.** `db.query` uses Drizzle's relational queries v2: filters are objects, such as `where: { id: 1 }`, and `with` follows the `relations` of the Definition. Read [Query related tables](#query-related-tables).

Convert the migrations folder of each Database once, and commit the result:

```bash [Terminal]
pnpm vitehub database up
pnpm vitehub database migrate --dry-run
```

`vitehub database up` runs `drizzle-kit up` on the migrations folder of each Database Definition, with the `sqlite` or `postgresql` dialect of the Definition. It removes `meta/` and leaves folders that already use the 1.0 layout as they are, so you can run it again. Then `vitehub database migrate --dry-run` lists no pending migrations for a database that 0.x had migrated.

## Migrate when the server starts

A self-hosted Node server, for example in Docker, often has only `.output`, with no sources or CLI for `vitehub database migrate`. ViteHub can apply pending migrations when the server starts, before it handles a request.

| Database | Default in a Node build | With `migrateOnStart: true` |
| --- | --- | --- |
| Postgres | Migrates on start | Migrates on start |
| Local SQLite file (`file:` URL) | Does not migrate | Migrates on start |
| Remote libSQL, D1 over HTTP | Does not migrate | `DATABASE_MIGRATE_ON_START_UNSUPPORTED` |

A build whose host is not Node, or is unknown, does not migrate on start by default. In Nuxt without a preset, ViteHub waits for the preset that Nitro detects. With `migrateOnStart: true`, another host fails the build with `DATABASE_MIGRATE_ON_START_UNSUPPORTED`. Development never migrates on start: run `vitehub database migrate`.

Set `true` to also migrate local SQLite files, or `false` to migrate only with `vitehub database migrate`:

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

The build copies each migrations folder into the server output, so the output needs no folder. A Nitro plugin applies them, and Nitro loads it before the production server listens. Prerendering during the build skips migrations and does not need a database connection. The plugin reads Drizzle's `__drizzle_migrations` table, applies the pending migrations in one transaction per database, and logs each one. Only then does the server accept requests. It writes the same rows as `vitehub database migrate` and `drizzle-kit migrate`, so any of them can migrate next. A migrations table from Drizzle Kit 0.x gets the `name` column first, as Drizzle 1.0 adds it. If one of its rows matches no migration folder, startup fails with `DATABASE_MIGRATE_ON_START_UNSUPPORTED` before any change.

When a migration fails, the database keeps none of the pending migrations of that start, and the server stops before it listens, with `DATABASE_MIGRATION_FAILED` for Postgres. A migration that loses data, by the `vitehub database migrate` rules, stops the server with `DATABASE_MIGRATION_DATA_LOSS` and no change. Back up the data and set `migrateOnStart: { allowDataLoss: true }` to apply it.

To apply the same migrations from a Nitro task, a test, or a build without the start plugin, call [`ensureMigrations()`](/docs/database/server-api#apply-migrations-from-server-code). It shares the run of the start plugin, so the process applies each migration once.

### Several instances on Postgres

Several Node instances can start together on one Postgres database. Each one takes the advisory lock `pg_advisory_xact_lock(hashtext('vitehub:migrations'))` in its migrate transaction before it reads the migrations table, and keeps it until the commit. The first instance applies the migrations. The others log that they wait. When the first one commits, they read its rows, find nothing pending, and start. `vitehub database migrate` holds the same lock, so a deploy step and a starting instance never migrate at the same time. The data loss check reads the table under the lock too, so a server waits for `vitehub database migrate --allow-data-loss` and then finds nothing pending.

```txt
[vitehub] Database "default": another process is applying migrations. Waiting for it to finish.
```

After acquiring the advisory lock, the transaction sets a five-second `lock_timeout`. A statement waiting longer for a table lock fails with `DATABASE_MIGRATION_FAILED` and rolls back the pending migrations, so a queued DDL statement cannot block reads on existing instances indefinitely. The next start retries the migrations. Waiting for another migrator's advisory lock has no added timeout.

To see who holds or waits for the lock, query `pg_locks` where `locktype = 'advisory'`. `drizzle-kit migrate` does not take this lock, so do not run it while instances start.

Definitions on one Postgres database share its migrations table. ViteHub asks each server which database it reaches (`current_database()` and the server start time in Unix seconds), so a Unix socket, a TCP address, two URL spellings and another `TimeZone` on one database count as one. Their migrations run in one transaction, in folder timestamp order, and each folder name runs once. The Definitions must use the same role and effective schema search path (`current_user` and `current_schemas(false)`); otherwise startup and `vitehub database migrate` fail with `DATABASE_MIGRATE_ON_START_UNSUPPORTED` before any change. Configure them with the same role and `search_path`. As on a shared SQLite file, two Definitions must not have one folder name with different SQL, and a folder name that the database already applied must keep its SQL: startup fails with `DATABASE_MIGRATE_ON_START_UNSUPPORTED` before any change.

When the migrations table already lists every folder, startup runs no DDL. An owner can apply migrations before deployment, then servers can start with a runtime role that has `USAGE` on the schemas and `SELECT` on `drizzle.__drizzle_migrations`, alongside its application table permissions. Creating or upgrading the migrations table and applying pending migrations still require the corresponding DDL permissions. Set `database: { migrateOnStart: false }` to skip the startup migration check.

### Several processes on SQLite

Definitions that share a SQLite file share one transaction. Their migrations run in folder timestamp order, then folder name order for equal timestamps, and each folder name runs once. Startup checks for data loss in this same order. Two Definitions on one file must not have one folder name with different SQL, and a folder name that the file already applied must keep its SQL: startup fails with `DATABASE_MIGRATE_ON_START_UNSUPPORTED` before any change, because the migrations table keys a migration by its name.

> [!WARNING]
> SQLite has no lock across processes here. Run one server process per database file. Two processes that start together can both find a migration pending, and the second fails to start. With several processes, such as the `node-cluster` preset, migrate before you start them.

## Migrate when you deploy

A Cloudflare Worker reads D1 through a binding, so it cannot migrate when it starts. When a deploy ships code before its migrations, the new code queries tables or columns that do not exist yet. Set `migrateOnDeploy: true` to apply the migrations as part of the deploy:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'cloudflare', database: { migrateOnDeploy: true } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare', database: { migrateOnDeploy: true } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare', database: { migrateOnDeploy: true } })],
})
```
:::
::

The build then puts one `wrangler d1 migrations apply <binding> --remote` for each D1 binding before `wrangler deploy` in the deploy command of `.output/nitro.json`:

```bash [.output/nitro.json commands.deploy]
npx wrangler d1 migrations apply DB --remote --config ./server/wrangler.json && npx wrangler deploy --config ./server/wrangler.json
```

- **Order.** `pnpm exec nitro deploy --prebuilt`, which Workers Builds runs, and `vitehub deploy` apply the migrations first. When a migration fails, the command stops and the Worker does not deploy.
- **Ledger.** Wrangler applies the migration files that the build copies into the server output, and records them in Wrangler's migrations table (`cloudflare.migrationsTable`, default `d1_migrations`). `vitehub database migrate` reads the same table, so you can still run it by hand.
- **Old code.** The Worker that serves traffic runs on the new tables until the deploy finishes. Write migrations that the previous code can use, for example add a column before you drop the old one.
- **Prompt.** In CI, Wrangler applies the migrations without a question. In a terminal, `nitro deploy --prebuilt` asks first. If you answer no, the deploy continues without them.
- **Preview.** `vitehub deploy --preview` and `--temporary` do not apply migrations, so a preview version does not change the production database.
- **Limits.** The option works only for a Cloudflare build where each Database has a D1 binding. Another host, D1 over HTTP, or Postgres fails the build with `DATABASE_MIGRATE_ON_DEPLOY_UNSUPPORTED`. Your own `nitro.commands.deploy` gets the same migrate steps in front of it.

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

- `connection` and `cloudflare` come from one Definition. When the application Definition sets one of them, it replaces all layer options, so it must also set each option that a layer sets. The application and each layer that sets options must then pass an object literal to `defineDatabase()`, so that ViteHub can read their options. Otherwise one layer can set them. Two layers that set them fail discovery until the application sets them.
- An application table replaces a layer table with the same key. Use this to add columns to a layer table. Two layers that declare the same table key fail discovery.
- `relations` join like tables. The relations of one table merge across layers, and the app wins a relation name. A layer can relate its tables to the tables of another layer: import them, and pass them to `defineRelationsPart()`. When a layer replaces a table, it must also define the relations of that table.
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
| `relations` | `string` | Optional. Export of `definition.module` that holds the relations of the contributed tables, from `defineRelationsPart()`. The target database merges them before the relations of its Definition, so the app wins a relation name. |

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
- `useDatabase(name).schema`, `db.query`, and the generated `DatabaseRegistry` types include them, in Vite, Nuxt, and Nitro. With `relations`, `with` follows their relations too.
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

A Definition uses the top-level `database` D1 resource when it sets neither `cloudflare.databaseId` nor `cloudflare.databaseName`. Setting either selects its own resource, so it takes no database ID, name, or preview ID from the top level. Other D1 settings still use their defaults. HTTP proxy URLs and tokens are inherited one field at a time, and both must be set in the end for HTTP access.

A Definition that owns a native resource needs a nonblank database ID and name at build time. For a native D1 binding, write the `cloudflare` block as a literal that ViteHub can read. An opaque expression, such as an identifier or a top-level spread, fails the Cloudflare build when no D1 HTTP or remote libSQL connection is known, even if the block would inherit. With such a connection, opaque Definitions work.

Keep an explicit `cloudflare` property when its value is opaque. For a fully hidden Definition, declare D1 with `database: { driver: 'd1' }`, or ViteHub writes no native D1 output. Opaque local SQLite Definitions still work.

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
| `driver` | `'pglite'` | No | Runs the Database on PGlite in development, app tests, and `vitehub database migrate`, even with a URL. A production build fails with it. See [Run Postgres locally with PGlite](#run-postgres-locally-with-pglite). |

A Postgres Definition has its own connection. It ignores the top-level `connection`, the D1 options, and the local SQLite default. With a Hyperdrive binding at runtime, ViteHub uses its connection string, else `connection.url`. Outside a Cloudflare request with an empty URL, postgres.js reads `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` (or `PGUSERNAME`), and `PGPASSWORD`. When none is set, development uses PGlite, and a production query fails with `DATABASE_MISSING_CONNECTION`.

The client drops the notices of the server, such as `relation already exists, skipping` for each `CREATE ... IF NOT EXISTS`, and prints each Postgres warning with `console.warn`. Errors still reject the query.

Query it with `useDatabase()`. See [Hosts](/docs/database/hosts#use-postgres) for how ViteHub creates clients on each host.

### Run Postgres locally with PGlite

[PGlite](https://pglite.dev) is Postgres that runs in the Node process and keeps its data in a folder. With it, you develop and test a Postgres Database without a Postgres server. Install it as a development dependency:

```bash pm
pnpm add -D @electric-sql/pglite
```

Keep `connection: { url: process.env.DATABASE_URL }`, and do not set `DATABASE_URL` or PG* variables on your computer. In development, the Database then runs on PGlite. In production, it connects to `DATABASE_URL`.

- `vite dev` and `nuxt dev` keep the data in `.vitehub/data/database/pglite`, or in `.vitehub/data/database/<name>.pglite` for a named database. The first query prints `[vitehub] Database "default" runs on PGlite in <folder>`.
- `vitehub database generate` and `vitehub database migrate` use the same rule, so `vitehub database migrate` applies the migrations to that folder. Its output names the target, for example `Database "default" (PGlite .vitehub/data/database/pglite)`.
- App tests with `vite-hub/test` get an empty in-memory PGlite with the migrations of the Definition, again after each reset.
- `vitehub inspect definitions --kind database` shows the folder in the `Development` field.

> [!NOTE]
> PGlite opens its folder in one process only. Stop the dev server before you run `vitehub database migrate`.

To use PGlite also when a URL or PG* variables are set, set `driver: 'pglite'`:

```ts [server/databases/default.ts] fragment
export default defineDatabase({
  dialect: 'postgresql',
  driver: 'pglite',
  schema,
})
```

Production output never includes PGlite. A production build fails with [`DATABASE_PGLITE_IN_BUILD`](/docs/database/limits-and-errors#database_pglite_in_build) when a Definition sets `driver: 'pglite'`. Remove `driver` and set `connection.url` before you build. Without `driver`, a production Database without a connection fails with `DATABASE_MISSING_CONNECTION` on its first query, as before.
