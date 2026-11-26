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
| `database.cli.drop` | `false` | enabled | Turns off `database drop`. |
| `database.cli.export` | `false` | enabled | Turns off `database export`. |
| `database.cli.generate` | `false` | enabled | Turns off `database generate`. |
| `database.cli.migrate` | `false` | enabled | Turns off `database migrate`. |
| `database.cli.reset` | `false` | enabled | Turns off `database reset`. |
| `database.cli.seed` | `false` | enabled | Leaves the Database out of `vitehub seed`. |
| `database.cli.sql` | `false` | enabled | Turns off `database sql`. |
| `database.cli.up` | `false` | enabled | Turns off `database up`. |
| `database.connection` | `DatabaseConnectionConfig` | local SQLite | Hosted libSQL connection for Definitions that set none. Values in a Definition win. |
| `database.driver` | `DatabaseRuntimeD1Options['driver']` | none | `cloudflare` selects Cloudflare D1 output for all databases. The former `d1` fails with [`DATABASE_UNKNOWN_DRIVER`](/docs/database/diagnostics/database_unknown_driver). |
| `database.binding` | `string` | `DB` | D1 binding of the default database. Named databases get their own binding names. |
| `database.databaseId` | `DatabaseConfigValue` | Provision State | Cloudflare D1 database id. |
| `database.previewDatabaseId` | `DatabaseConfigValue` | none | Cloudflare D1 preview database id. |
| `database.databaseName` | `DatabaseConfigValue` | none | Cloudflare D1 database name. |
| `database.migrationsTable` | `string` | provider default | Cloudflare D1 migrations table. |
| `database.migrateOnStart` | `boolean` or `{ allowDataLoss?: boolean, backup?: boolean \| { keep?: number, dir?: string } }` | On for Postgres in a Node build | Applies pending migrations when a Node server build starts. Unset, only Postgres databases migrate. `true` also migrates local SQLite files and D1 over HTTP. `false` turns it off. `backup` copies each SQLite file first. See [Migrate when the server starts](#migrate-when-the-server-starts). |
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

Use `server/databases/<name>/index.ts` when the Database has other files, such as schema modules. A folder with an `index.ts` is one Database, so ViteHub does not read its other files as Definitions. Every other file in `server/databases/` is a Definition, except `migrations/` folders and the [seed file](#seed-data) `server/databases/<name>/seed.ts`. The migrations of the Database `<name>` are in `server/databases/<name>/migrations/`.

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

ViteHub loads the Definition with your Vite or Nuxt string aliases, such as `~~` and `#layers/<name>`. It also writes them to `.vitehub/database/tsconfig.json`, so drizzle-kit resolves the same imports in `vitehub database generate`. If it still fails, for example on a module that only a Vite plugin provides, `vite dev` and builds warn and use the keys of a literal `schema: { ... }`. `vitehub database generate` fails instead, so a migration never drops a table silently.

### Query related tables

`db.query.<table>` reads rows with Drizzle's relational queries. To read related rows in the same query, pass `relations` from Drizzle's `defineRelations()`:

```ts [server/databases/blog.ts]
import { defineDatabase } from 'vite-hub/database'
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
import { useDatabase } from 'vite-hub/database'
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
import { defineDatabase } from 'vite-hub/database'
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

A migration is a folder that changes your tables. `vitehub database generate` writes one next to the Definition, as Drizzle Kit 1.0 does: `migrations/<YYYYMMDDHHmmss>_<name>/` with `migration.sql` and `snapshot.json`. `vitehub database migrate` first reads each database's migrations table and checks the SQL of each pending migration, then applies them with Drizzle Kit. For Postgres, it applies them with the migrator that a server runs [on start](#migrate-when-the-server-starts): it writes the same rows as Drizzle Kit and holds the same advisory lock as a starting server. A Postgres Database on [PGlite](#run-postgres-locally-with-pglite) uses the same migrator, so it does not need Drizzle Kit to migrate. A PGlite folder that Drizzle Kit migrated before keeps its applied migrations. A migration is pending when the `name` column of the table does not list its folder.

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

For D1 HTTP, `vitehub database migrate` uses Wrangler's migrations table (`cloudflare.migrationsTable`, default `d1_migrations`), one row per applied file, so Wrangler and ViteHub can take turns. Wrangler reads flat `.sql` files, so each migration folder counts as `NNNN_<name>.sql`, and a Cloudflare build writes it as that file next to the Wrangler config. `vitehub database generate` and the build keep these names in `d1-migrations.json` next to the migrations. Commit it: a listed folder keeps its name, and a new folder takes the next number, even when a merge brings a folder with an earlier timestamp. Without the file, the numbers follow the folder order. These are the names that Drizzle Kit 0.x used, so a folder that `drizzle-kit up` converted keeps its row in `d1_migrations` and does not run again. When a name in `d1_migrations` moved to another number, `vitehub database migrate` fails the check with `DATABASE_MIGRATION_CHECK_FAILED`. Each file and its row go in one request, so D1 keeps neither when the file fails.

### Keep an existing migrations table

A database that another tool migrated already has a migrations table, such as NuxtHub's `_hub_migrations` or Wrangler's `d1_migrations`. `vitehub database migrate` reads it, so it does not run those migrations again. This works for local SQLite, libSQL, D1 HTTP, Postgres, and PGlite. On Postgres and PGlite, ViteHub checks `_hub_migrations` only in the first active schema in the connection's `search_path` and in [`migrationsSchema`](#keep-the-migrations-table-in-a-schema). It does not use a table from another schema. When Drizzle's ledger already lists every migration, ViteHub does not read `_hub_migrations`. If a history row matches multiple folders, the check stops rather than guessing which SQL ran.

Keep the migration files when you move them, for example from `server/db/migrations/sqlite/` to `server/databases/default/migrations/`. Convert files of Drizzle Kit 0.x and hand-written SQL files with `vitehub database up`, then check what ViteHub reads:

```bash [Terminal]
pnpm vitehub database migrate --dry-run
```

```txt
[vitehub] Database "default" (local SQLite .vitehub/data/database/sqlite.db): 1 pending migration.
  Applied before, as _hub_migrations lists: 20261101090000_init, 20261102090000_add_body

  20261103090000_add_tags
    ALTER TABLE `notes` ADD `tags` text;
[vitehub] Dry run. No changes were made.
```

A migration counts as applied when a migrations table lists one of its names:

- its file name for Wrangler, such as `0000_init.sql`, or that name without `.sql`, as NuxtHub records it
- its folder name, such as `20261101090000_init`
- the old file name that its folder keeps, such as `0000_init.sql` for the folder `20261027095547_0000_init`
- in Drizzle's `__drizzle_migrations`, the SQL hash of a folder that you renamed

For Postgres and PGlite, a folder can keep a NuxtHub file name without a number. For example, `20261027095547_bootstrap` matches `bootstrap`, and `20261027095547_0001_init.postgresql` matches `0001_init`. These names take precedence over the numbers ViteHub assigns from folder order.

`vitehub database migrate` then records these migrations in the table it uses: Drizzle's `__drizzle_migrations` for SQLite, libSQL, Postgres, and PGlite, and Wrangler's table for D1 HTTP. It reads `_hub_migrations`, `d1_migrations`, `__drizzle_migrations`, and `cloudflare.migrationsTable`. When a table lists a name that now has another number, such as `0000_init` for the migration that is now `0001_init.sql`, the check fails with `DATABASE_MIGRATION_CHECK_FAILED`. For Postgres or PGlite, verify which SQL ran and run the `UPDATE` from the diagnostic on the affected database. It names the schema of the `_hub_migrations` table that lists the row. When more than one table lists it, the diagnostic names each table, so check which one NuxtHub used. A name that matches no folder does not block, because you can delete old files. When the check reads `_hub_migrations`, `--dry-run` lists such names as `Not in the migrations folder`.

On SQLite, run `vitehub database migrate` once before a server migrates on start, because [Migrate when the server starts](#migrate-when-the-server-starts) reads only Drizzle's table there. On Postgres and PGlite, migrate on start reads `_hub_migrations` too.

A native Cloudflare D1 binding is migrated with Wrangler, which tracks filenames in its own table instead of NuxtHub's normalized names in `_hub_migrations`. To baseline an existing D1 database:

1. Back up the database and remove `migrations_table: "_hub_migrations"` from your Wrangler config.
2. Generate a baseline into an empty `server/databases/default/migrations/` folder with `pnpm vitehub database generate --name baseline`. Check that the generated SQL matches the existing schema. Add `IF NOT EXISTS` to the `CREATE` statements in `migration.sql` so they skip existing objects. Keep `snapshot.json`.
3. Build the app and check that the D1 entry in `.output/server/wrangler.json` has the intended `database_id` and that its `migrations_dir` points to the generated baseline SQL. Run `pnpm wrangler d1 migrations list <database-name> --remote --config .output/server/wrangler.json`.
4. Run `pnpm wrangler d1 migrations apply <database-name> --remote --config .output/server/wrangler.json` only if the baseline is the sole pending file. Otherwise, stop and check the migration directory and Wrangler's migration history. Commit the migration folder and generated `d1-migrations.json` after the baseline is applied.

### Rename a column or table

When one change removes a column and adds another in the same table, Drizzle Kit cannot know if you renamed it. A rename keeps the data. A new column starts empty, and the migration drops the old column with its data. The same applies to tables.

In a terminal, `vitehub database generate` asks. Without a terminal, or with `CI` set, it never waits for an answer. It writes no migration, exits with code 2, and prints `DATABASE_GENERATE_AMBIGUOUS_CHANGE` with one command per answer:

```txt
[DATABASE_GENERATE_AMBIGUOUS_CHANGE] The Definitions of the database "default" add a column or table and remove another one, and Drizzle Kit cannot tell whether the new one is a rename. Without a terminal, `vitehub database generate` cannot ask, so it wrote no migration.
The changes to answer:
  - column public.notes.content
├▶ fix: Answer each change with a hint and run the command again. A rename keeps the data. A create adds an empty column or table, and the migration drops the removed one with its data.
Replace <old_name> with the removed name. With several changes, put one answer per change in the same array:
  column public.notes.content:
    rename: vitehub database generate --hints '[{"type":"rename","kind":"column","from":["public","notes","<old_name>"],"to":["public","notes","content"]}]'
    create: vitehub database generate --hints '[{"type":"create","kind":"column","entity":["public","notes","content"]}]'
```

Run the command for your answer. This one renames `body` to `content`:

```bash [commands/generate]
pnpm vitehub database generate --hints '[{"type":"rename","kind":"column","from":["public","notes","body"],"to":["public","notes","content"]}]'
```

`--hints` takes the JSON array that Drizzle Kit reads for its own `--hints` option, and `--hints-file <file>` reads it from a file. SQLite ids also start with `public`. ViteHub never picks an answer for you.

### Upgrade to Drizzle 1.0

ViteHub uses `drizzle-orm` and `drizzle-kit` 1.0. Install `drizzle-orm@1.0.0-rc.6` and `drizzle-kit@1.0.0-rc.6`. Four things change for an app that used Drizzle 0.x:

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

A folder of SQL files that you wrote by hand also needs `vitehub database up` once. Examples are files from `wrangler d1 migrations create`, or the Postgres files of NuxtHub, such as `0000_init.sql` and `0001_add_posts.sql`. Drizzle Kit 1.0 skips flat `.sql` files, so `vitehub database migrate` and the build with `migrateOnStart` refuse such a folder. This is also true when `meta/_journal.json` lists only some of the files. `vitehub database up` replays the SQL on a temporary database, then moves each file to a folder that keeps its name, such as `20261029101500_0000_init/migration.sql`. SQLite and D1 files replay on SQLite. Postgres files replay on PGlite, so install `@electric-sql/pglite`. A Postgres file whose first line is `-- vitehub:no-transaction` replays one statement at a time, outside a transaction, and keeps that line. The newest folder records the schema that the SQL creates, so `generate` can still write changes from your Definitions. When the Definitions match that schema, `generate` writes no migration. On Postgres, constraint and index names that Postgres or Drizzle Kit generated, such as `users_email_unique` or `posts_author_id_fkey`, stay as they are. If the SQL cannot replay or the file order would change a journal timestamp, the folder stays as it was. On D1, `d1-migrations.json` keeps the file names that Wrangler applied, so Wrangler and `vitehub database migrate` do not apply them again. D1 over HTTP can still apply flat files without the conversion.

Postgres replay uses the same statement breakpoints as `migrate`. It also checks if an enum value can be used when the enum already exists from an applied migration. If this check fails, move the migrations that use the new value out of the folder. Convert and apply the files through the enum addition first. Then add the dependent migrations as migration folders and apply them.

On SQLite, Drizzle Kit 0.x made a unique index for a `.unique()` column, and Drizzle Kit 1.0 declares a `UNIQUE` constraint in the table. `vitehub database up` records these indexes as the constraints of your Definitions in the converted snapshots, so the next `vitehub database generate` does not rebuild the tables. The database keeps its indexes, and they reject the same duplicate rows. A folder that `drizzle-kit up` or an older ViteHub converted still lists these indexes, so `vitehub database generate` records them first. Commit the changed `snapshot.json` files.

## Migrate when the server starts

A self-hosted Node server, for example in Docker, often has only `.output`, with no sources or CLI for `vitehub database migrate`. ViteHub can apply pending migrations when the server starts, before it handles a request.

| Database | Default in a Node build | With `migrateOnStart: true` |
| --- | --- | --- |
| Postgres | Migrates on start | Migrates on start |
| Local SQLite file (`file:` URL) | Does not migrate | Migrates on start |
| D1 over HTTP (`cloudflare.http`) | Does not migrate | Migrates on start, in Wrangler's `d1_migrations` table |
| Remote libSQL | Does not migrate | `DATABASE_MIGRATE_ON_START_UNSUPPORTED` |

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

The build copies each migrations folder into the server output, so the output needs no folder. A Nitro plugin applies them, and Nitro loads it before the production server listens. Prerendering during the build skips migrations and does not need a database connection. For SQLite and Postgres, the plugin reads Drizzle's `__drizzle_migrations` table, applies the pending migrations in one transaction per database, and logs each one. Only then does the server accept requests. It writes the same rows as `vitehub database migrate` and `drizzle-kit migrate`, so any of them can migrate next. A migrations table from Drizzle Kit 0.x gets the `name` column first, as Drizzle 1.0 adds it. If one of its rows matches no migration folder, startup fails with `DATABASE_MIGRATE_ON_START_UNSUPPORTED` before any change.

A D1 over HTTP database uses Wrangler's migrations table (`cloudflare.migrationsTable`, default `d1_migrations`) instead, with the same file names as `vitehub database migrate` and `wrangler d1 migrations apply`, so any of them can migrate next. The build writes new names to `d1-migrations.json`: commit it. Use one migration owner per D1 ledger. The server sends each migration and its row in one request. A file that drops a table that an earlier pending file creates goes in the same request as that file. If a request fails, earlier requests and their rows stay applied. Several servers can start together: see [Several instances on D1 over HTTP](#several-instances-on-d1-over-http). `backup` cannot copy a D1 database.

When a migration fails, the server stops before it listens, with `DATABASE_MIGRATION_FAILED` for Postgres. SQLite and Postgres roll back all pending migrations for the database that failed. A migration that loses data stops the server with `DATABASE_MIGRATION_DATA_LOSS` and no change. A table that an earlier pending migration creates has no older rows, so a later migration may drop it. On D1, the server sends both files in one request, so when another server applied only the first one and wrote to the table, D1 rejects the request and the start stops. To apply a migration that loses data, back up the data and set `migrateOnStart: { allowDataLoss: true }` to apply it. To accept the loss for one start of a built server, such as a Docker container, set `VITEHUB_DATABASE_ALLOW_DATA_LOSS=1` in its environment:

```bash
docker run -e VITEHUB_DATABASE_ALLOW_DATA_LOSS=1 my-app
```

Remove the variable after that start, so a later migration that loses data stops the server again.

To apply the same migrations from a Nitro task, a test, or a build without the start plugin, call [`ensureMigrations()`](/docs/database/server-api#apply-migrations-from-server-code). It shares the run of the start plugin, so the process applies each migration once.

### Back up SQLite before migrations

A failed SQLite migration rolls back, but a migration that applies with a mistake, such as a wrong `UPDATE`, changes the data for good. Set `backup` to copy each local SQLite file before the server applies its pending migrations:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { database: { migrateOnStart: { backup: true } } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ database: { migrateOnStart: { backup: true } } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ database: { migrateOnStart: { backup: true } } })],
})
```
:::
::

- The server copies the file with SQLite's `VACUUM INTO` only when at least one migration is pending. A start with nothing pending, or a new empty database, makes no copy.
- Each copy is `<file name>-<UTC time>-before-<last pending migration><extension>`, for example `backups/app-2026-11-13T08-00-00-123Z-before-20261113080000_add_tags.sqlite`.
- `true` puts the copies in a `backups` folder beside the database file and keeps the 3 newest copies of that file. Set `{ keep: 5, dir: '/var/backups/app' }` to change them. A custom `dir` adds a stable hash of the source path after the file name, so same-named databases retain their copies independently. A relative `dir` starts at the server's working directory, like a `file:` URL. Other files in the folder stay.
- When the copy fails, for example because the folder is not writable, the server stops before it applies a migration, with `DATABASE_MIGRATION_BACKUP_FAILED`.
- `backup` works only for local SQLite files. A Postgres database, D1 over HTTP, a remote libSQL URL, or an in-memory database fails the build, or the start for a URL from the environment, with `DATABASE_MIGRATION_BACKUP_UNSUPPORTED`. Back up those databases with their own tools, such as `pg_dump`.

To restore, stop the server, replace the database file with a copy, and deploy the build that matches it. `ensureMigrations()` makes the same copy when it applies migrations.

### Several instances on Postgres

Several Node instances can start together on one Postgres database. Each one takes the advisory lock `pg_advisory_xact_lock(hashtext('vitehub:migrations'))` in its migrate transaction before it reads the migrations table, and keeps it until the commit. The first instance applies the migrations. The others log that they wait. When the first one commits, they read its rows, find nothing pending, and start. `vitehub database migrate` holds the same lock, so a deploy step and a starting instance never migrate at the same time. The data loss check reads the table under the lock too, so a server waits for `vitehub database migrate --allow-data-loss` and then finds nothing pending.

```txt
[vitehub] Database "default": another process is applying migrations. Waiting for it to finish.
```

After acquiring the advisory lock, the transaction sets a five-second `lock_timeout`. A statement waiting longer for a table lock fails with `DATABASE_MIGRATION_FAILED` and rolls back the pending migrations, so a queued DDL statement cannot block reads on existing instances indefinitely. The next start retries the migrations. Waiting for another migrator's advisory lock has no added timeout.

To see who holds or waits for the lock, query `pg_locks` where `locktype = 'advisory'`. `drizzle-kit migrate` does not take this lock, so do not run it while instances start.

Definitions on one Postgres database share its migrations table. ViteHub asks each server which database it reaches (`current_database()` and the server start time in Unix seconds), so a Unix socket, a TCP address, two URL spellings and another `TimeZone` on one database count as one. Their migrations run in one transaction, in folder timestamp order, and each folder name runs once. The Definitions must use the same role and effective schema search path (`current_user` and `current_schemas(false)`); otherwise startup and `vitehub database migrate` fail with `DATABASE_MIGRATE_ON_START_UNSUPPORTED` before any change. Configure them with the same role and `search_path`. As on a shared SQLite file, two Definitions must not have one folder name with different SQL, and a folder name that the database already applied must keep its SQL: startup fails with `DATABASE_MIGRATE_ON_START_UNSUPPORTED` before any change.

When the migrations table already lists every folder, startup runs no DDL. An owner can apply migrations before deployment, then servers can start with a runtime role that has `USAGE` on the schemas and `SELECT` on `drizzle.__drizzle_migrations` (or the table in `migrationsSchema`), alongside its application table permissions. Creating or upgrading the migrations table and applying pending migrations still require the corresponding DDL permissions. Set `database: { migrateOnStart: false }` to skip the startup migration check.

### Several instances on D1 over HTTP

D1 over HTTP has no lock, so ViteHub uses the migrations table instead. Each migration goes to D1 in one request with its row, and D1 applies all of the request or none of it, as `wrangler d1 migrations apply` expects. The `name` column of the table is unique. When two servers start together, both can send the same migration. D1 applies the first request. The second request fails, because its SQL or its row conflicts with the first one, and D1 rolls it back. That server then finds the row and goes on to the next migration. `vitehub database migrate` writes the same rows the same way, so a deploy step can run while servers start.

This is safe only under these conditions:

- Every server and deploy step has the same migration history. D1 identifies a migration by its file name, not its SQL. A server that finds the name in the table skips its own file, even when that file has different SQL.
- `name` stays unique, as Wrangler creates the table. A migrations table that you create without `UNIQUE` on `name` lets two servers apply the same migration.
- A proxy in `cloudflare.http: { url, authToken }` runs a request with many statements as one transaction, as D1 does. If your proxy commits each statement on its own, do not send migrations through it. Set `migrateOnStart: false` on the server. Before deployment, run `vitehub database migrate` with `cloudflare.http: true` for the same database and migrations table, so the CLI calls Cloudflare directly.

### Several processes on SQLite

Definitions that share a SQLite file share one transaction. Their migrations run in folder timestamp order, then folder name order for equal timestamps, and each folder name runs once. Startup checks for data loss in this same order. Two Definitions on one file must not have one folder name with different SQL, and a folder name that the file already applied must keep its SQL: startup fails with `DATABASE_MIGRATE_ON_START_UNSUPPORTED` before any change, because the migrations table keys a migration by its name.

> [!WARNING]
> SQLite has no lock across processes here. Run one server process per database file. Two processes that start together can both find a migration pending, and the second fails to start. With several processes, such as the `node-cluster` preset, migrate before you start them.

## Seed data

A seed file fills a database with starting rows, such as demo notes. Put it beside the migrations folder of the database: `server/databases/<name>/seed.ts`, so `server/databases/default/seed.ts` for the default database. With `src/database.ts`, it is `src/seed.ts`. Its default export gets `db`, the Drizzle database, and `schema`, the tables of the Definition:

```ts [server/databases/default/seed.ts]
import type { DatabaseSeed } from 'vite-hub/database'

export default (async ({ db, schema }) => {
  await db.insert(schema.notes).values([
    { title: 'Welcome', body: 'This note comes from the seed.' },
    { title: 'Second note', body: 'Edit server/databases/default/seed.ts to change it.' },
  ])
}) satisfies DatabaseSeed
```

For a named database, write `DatabaseSeed<'analytics'>`. Then apply the migrations and run the seed:

```bash [commands/seed]
pnpm vitehub database migrate
pnpm vitehub seed                       # each database that has a seed file, and the KV and Blob seed files
pnpm vitehub seed database              # only the databases
pnpm vitehub seed --database analytics
pnpm vitehub seed --remote --stage staging
```

Without `--remote`, the command writes only the local database that `vitehub database migrate` uses: the SQLite file, or the PGlite folder of a Postgres Database. A remote database needs `--remote`, so a seed never reaches production by accident. With `--remote`, it connects like `vitehub database export --remote`: Cloudflare D1 through the Cloudflare API, D1 HTTP, remote libSQL, or Postgres. `--stage <name>` loads the Vite env files of that mode.

The command refuses a database with pending migrations, with `DATABASE_SEED_PENDING_MIGRATIONS`, so the seed always sees the current tables. A missing seed file gives `DATABASE_SEED_NOT_FOUND` with the path that ViteHub looks for. A seed that throws gives `DATABASE_SEED_FAILED` and keeps the rows that it wrote before the error. Write the rows in one `db.transaction()` to keep all or none.

The command runs the seed every time. To run it again on the same data, make it idempotent, for example with `.onConflictDoNothing()`. For many rows of fake data, install [`drizzle-seed`](https://orm.drizzle.team/docs/seed-overview) and call it in the seed file:

```ts [server/databases/default/seed.ts] fragment
import type { DatabaseSeed } from 'vite-hub/database'
import { seed } from 'drizzle-seed'

export default (async ({ db, schema }) => {
  await seed(db, schema, { count: 100 })
}) satisfies DatabaseSeed
```
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

- **Order.** `vitehub deploy` supports the generated `npx wrangler deploy --config ...` command and its migration steps, not arbitrary commands in `nitro.json`. It applies the migrations first and stops before deploying if a migration fails.
- **Other deploy commands.** `nitro deploy --prebuilt` uses `commands.deploy` from the loaded Nitro config, which defaults to the preset's command. It does not use `commands.deploy` from `nitro.json`. Workers Builds uses the deploy command set on the Worker. For either path, put the migrate steps before the deploy, as [Workers Builds](/docs/frameworks-hosts/cloudflare#workers-builds) shows.
- **Ledger.** Wrangler applies the migration files that the build copies into the server output, and records them in Wrangler's migrations table (`cloudflare.migrationsTable`, default `d1_migrations`). `vitehub database migrate` reads the same table, so you can still run it by hand.
- **Old code.** The Worker that serves traffic runs on the new tables until the deploy finishes. Write migrations that the previous code can use, for example add a column before you drop the old one.
- **Without `migrateOnDeploy`.** `vitehub deploy` reads the migrations table of each D1 binding and stops with [`SETUP_DEPLOY_D1_MIGRATIONS_PENDING`](/docs/cli/diagnostics/setup_deploy_d1_migrations_pending) when the build has a migration that the table does not list. With the default `nitro deploy --prebuilt` command or a plain `wrangler deploy`, apply migrations yourself before deploying.
- **Prompt.** `vitehub deploy` runs Wrangler without a prompt, even from a terminal. A direct, interactive `wrangler d1 migrations apply` can prompt. If you decline, Wrangler exits successfully and a deploy chained with `&&` still runs.
- **Preview.** `vitehub deploy --preview` and `--temporary` do not apply migrations, so a preview version does not change the production database.
- **Limits.** The option works only for a Cloudflare build where each Database has a D1 binding. Another host, D1 over HTTP, or Postgres fails the build with `DATABASE_MIGRATE_ON_DEPLOY_UNSUPPORTED`. The build also prepends migration steps to a custom `nitro.commands.deploy`, but `vitehub deploy` rejects the result unless it matches the supported Wrangler command shape.

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

## Run SQL and drop tables

`vitehub database sql` runs SQL on one database and prints the rows of each statement as a table. `vitehub database drop` drops every table and view of one database, and the migrations table with them, so the next `vitehub database migrate` starts from an empty database. Like `export`, they read the config and do not build the app.

```bash [commands/sql]
pnpm vitehub database sql "select id, email from users limit 5"
pnpm vitehub database sql --json "select count(*) as users from users"
cat seed.sql | pnpm vitehub database sql
pnpm vitehub database sql --remote --stage production "select count(*) from users"
pnpm vitehub database drop
pnpm vitehub database drop --yes                            # in CI or a script
pnpm vitehub database reset                                 # drop, then migrate
```

Both commands use the same target as `export`. Without `--remote`, they use only the local SQLite file or PGlite folder of `vitehub database migrate`. Any other database, such as D1, libSQL, or a Postgres server, needs `--remote` and the same credentials as `export --remote`. `--stage <name>` loads the Vite env files of that mode, and `--database <name>` picks the database when the app has several.

`sql` reads the SQL from the argument, or from stdin when there is no argument. It runs the statements in order and stops at the first error. A statement without rows prints the number of changed rows, when the driver reports it. `--json` prints one JSON array, with `{ columns, rows, rowsAffected }` for each statement. Bytes print as hex and big integers as strings. SQLite and D1 statements are split at semicolons, so a trigger with `BEGIN ... END` does not run through `sql`. Postgres and PGlite get the script as one query.

`drop` lists what it will drop and asks before it drops it. Without a terminal to ask, such as in CI, it needs `--yes`, else it fails with `DATABASE_DROP_NOT_CONFIRMED`. It runs in one transaction, so a failure drops nothing:

| Database | Drops |
| --- | --- |
| SQLite, libSQL, and D1 | Every table and view, with `__drizzle_migrations` or Wrangler's `d1_migrations`. SQLite and Cloudflare internal tables stay. Foreign key checks wait until the commit. |
| Postgres and PGlite | The tables, views, sequences, and enum types that the connecting user owns, in every schema but the system ones, and Drizzle's `drizzle` schema. Then each schema that is left empty, except `public`. Objects of other roles, such as the `auth` tables of Supabase, stay. If their dependencies prevent dropping an owned object, the whole reset fails without changes. |

Failures print `DATABASE_SQL_FAILED` or `DATABASE_DROP_FAILED` and exit with code 1. A local file that does not exist fails `sql`, and `drop` has nothing to drop. Neither creates the file.

`reset` gives you an empty database with the current tables. It drops like `drop`, with the same question and `--yes`, and then applies every migration of that database like `vitehub database migrate`. It reads the migrations folder first, so a broken folder stops it before it drops anything. It does not run the seed file: run `vitehub seed database` after it. A native D1 binding with `--remote` is refused, because `migrate` applies D1 binding migrations only to the local file. Use `drop --remote`, then `wrangler d1 migrations apply <name> --remote`.

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

ViteHub finds duplicate table keys when `schema` is an object literal. Query the merged database with `useDatabase()` or `db` from `vite-hub/database`. A `defineDatabase()` object holds options only. It is not a Drizzle database.

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
| `migrations` | `string` | Optional. Absolute path of a folder of `.sql` files. See [Contribute SQL migrations](#contribute-sql-migrations). |

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
- A production build checks generated migration history for contributed tables and columns. When a new version adds one, run `vitehub database generate` and commit the migration. If a committed migration folder lacks `migration.sql`, restore that file instead. When custom SQL leaves the schema unknown, the build skips table and column comparisons but still checks for contributed SQL files.

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

### Contribute SQL migrations

A table contribution or an entry without tables can set `migrations` to a folder of `.sql` files:

```ts [my-package/vite.ts] fragment
vitehub: {
  databases: () => [{ name: 'my-package', migrations: fileURLToPath(new URL('./migrations', import.meta.url)) }],
},
```

`vitehub database generate` adds each file that the target database does not have yet to its migrations folder, as `<timestamp>_<name>_<file>/migration.sql`, after the migrations it generates. Files go in file name order. Commit them like other migrations. `vitehub database migrate`, D1, and migrate on start then apply them once, and a later generate does not add them again.

- A file named `<name>.<dialect>.sql`, such as `0001_init.postgresql.sql`, applies only to a database of that dialect.
- ViteHub puts a `--> statement-breakpoint` between statements, at the semicolons outside quotes and comments. A file that already has breakpoints is copied as written. Use breakpoints when a statement has its own semicolons, such as a trigger.
- `vitehub inspect definitions` shows a `Contributed migrations` field with how many files are added and how many still need `vitehub database generate`. A production build fails with `DATABASE_CONTRIBUTED_TABLES_NOT_GENERATED` while a file is not added.

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

A project cannot combine `src/database.ts` with named databases, so this fits any app that does not define its Default Database in `src/database.ts`.

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
| `connection.url` | `DatabaseConfigValue` | No | SQLite or libSQL URL. Defaults to `file:.vitehub/data/database/sqlite.db` for the default database and `file:.vitehub/data/database/<name>.sqlite.db` for a named one. A Definition does not read `DATABASE_URL` or `TURSO_DATABASE_URL` on its own. Write `url: process.env.TURSO_DATABASE_URL`. |
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

Keep an explicit `cloudflare` property when its value is opaque. For a fully hidden Definition, declare D1 with `database: { driver: 'cloudflare' }`, or ViteHub writes no native D1 output. Opaque local SQLite Definitions still work.

A named Definition without `cloudflare.binding` uses its per-name binding. A default Definition without one keeps the top-level binding. Named Definitions can share the top-level resource through different binding names. Generated D1 binding names must be unique, even for identical resources. Set different binding values when explicit or normalized names collide.

An opaque Definition that selects its own resource uses HTTP or libSQL, never a native binding, even when it gives the top-level binding name.

Vite and Nuxt output keep provisioned IDs as fallbacks for unset runtime env values. Runtime values win. Opaque Definitions that select their own resource do not get top-level provisioned IDs. Provision state is read from the Vite root, even when `projectRoot` sets another root.

## Define a Postgres database

Set `dialect: 'postgresql'`, write the tables with `drizzle-orm/pg-core`, and install the [`postgres`](https://github.com/porsager/postgres) driver. To use [`pg`](https://node-postgres.com) instead, see [Use node-postgres](#use-node-postgres).

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
| `connection.replicas` | `DatabaseConfigValue[]` | No | Read replica URLs. `db.$replica` reads from them. See [Read from replicas](#read-from-replicas). |
| `cloudflare.binding` | `string` | No | Cloudflare Hyperdrive binding. Defaults to `HYPERDRIVE`, or `HYPERDRIVE_<NAME>` for a named database. |
| `cloudflare.hyperdriveId` | `DatabaseConfigValue` | No | Hyperdrive config id. When it is known at build time, ViteHub adds the binding to the Wrangler config. |
| `driver` | `'node-postgres' \| 'pglite'` | No | The client. Without it, ViteHub uses postgres.js. See the driver list below. |
| `migrationsSchema` | `string` | No | The schema of Drizzle's migrations table. Defaults to `drizzle`. ViteHub does not create it. See [Keep the migrations table in a schema](#keep-the-migrations-table-in-a-schema). |

| Driver | Package | Use it for |
| --- | --- | --- |
| none (default) | `postgres` | postgres.js. `db.$client` is its `sql` function. |
| `'node-postgres'` | `pg` | node-postgres. `db.$client` is a `pg` Pool. See [Use node-postgres](#use-node-postgres). |
| `'pglite'` | `@electric-sql/pglite` | PGlite in development, app tests, and `vitehub database migrate`, even with a URL. A production build fails with it. See [Run Postgres locally with PGlite](#run-postgres-locally-with-pglite). |

A Postgres Definition has its own connection. It ignores the top-level `connection`, the D1 options, and the local SQLite default. With a Hyperdrive binding at runtime, ViteHub uses its connection string, else `connection.url`. Outside a Cloudflare request with an empty URL, postgres.js reads `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` (or `PGUSERNAME`), and `PGPASSWORD`. When none is set, development uses PGlite, and a production query fails with `DATABASE_MISSING_CONNECTION`.

The client drops the notices of the server, such as `relation already exists, skipping` for each `CREATE ... IF NOT EXISTS`, and prints each Postgres warning with `console.warn`. Errors still reject the query.

Query it with `useDatabase()`. See [Hosts](/docs/database/hosts#use-postgres) for how ViteHub creates clients on each host.

### Use node-postgres

Set `driver: 'node-postgres'` and install `pg` instead of `postgres`:

```bash
pnpm add pg
```

```ts [server/databases/default.ts] fragment
export default defineDatabase({
  dialect: 'postgresql',
  driver: 'node-postgres',
  connection: { url: process.env.DATABASE_URL },
  schema,
})
```

- The connection rules do not change: a Hyperdrive binding, then `connection.url`, then the PG* variables. Development without any of them still runs on PGlite.
- `db.$client` is a `pg` Pool. Inside a Cloudflare request, each request gets its own Pool with at most 5 connections, as with postgres.js.
- The app loads only the driver that its Definitions use. An app with only `driver: 'node-postgres'` does not need `postgres`, and an app without it never loads `pg`.
- `migrateOnStart` and `vitehub database migrate` use `pg` too, with the same advisory lock.
- The Pool prints Postgres warnings with `console.warn` and drops notices. An idle connection that fails prints an error and does not stop the process.

> [!NOTE]
> Cloudflare documents `pg` with Hyperdrive on Workers with `nodejs_compat`. ViteHub tests node-postgres on Node with a real Postgres server, and with fakes for Hyperdrive.

### Keep the migrations table in a schema

Drizzle keeps its migrations table in the schema `drizzle`, and ViteHub creates that schema. When the role cannot create a schema, or you want the table in your own schema, set `migrationsSchema`:

```ts [server/databases/default.ts] fragment
export default defineDatabase({
  dialect: 'postgresql',
  migrationsSchema: 'app',
  schema,
})
```

- ViteHub keeps `__drizzle_migrations` in `app` and creates no `drizzle` schema. This works on Postgres and PGlite.
- ViteHub does not create the schema. Create it first, for example with `vitehub database sql 'CREATE SCHEMA "app"'`. Without it, migrate and start fail with [`DATABASE_MIGRATION_SCHEMA_MISSING`](/docs/database/diagnostics/database_migration_schema_missing).
- The generated Kit config gets `migrations: { schema: "app" }`, so `drizzle-kit migrate` reads the same table.
- ViteHub also reads NuxtHub's `_hub_migrations` in that schema.
- When the table in `drizzle` lists applied migrations that the table in `app` does not list, migrate and start fail with [`DATABASE_MIGRATION_LEDGER_MISPLACED`](/docs/database/diagnostics/database_migration_ledger_misplaced). They do not apply them again. Move the table with the command in the fix:

```bash [Terminal]
pnpm vitehub database sql 'ALTER TABLE "drizzle"."__drizzle_migrations" SET SCHEMA "app"'
```

Definitions on one Postgres database share its migrations table, so they must set the same `migrationsSchema`. Otherwise they fail with `DATABASE_MIGRATION_SCHEMA_CONFLICT`. A SQLite Definition with `migrationsSchema` fails with `DATABASE_UNKNOWN_OPTION`.

### Read from replicas

Set `connection.replicas` to the URLs of read replicas. ViteHub opens one client of the Definition's driver for each one, postgres.js or node-postgres, and gives you Drizzle's [`withReplicas()`](https://orm.drizzle.team/docs/read-replicas) database:

```ts [server/databases/replicas.ts]
import { defineDatabase } from 'vite-hub/database'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'

export default defineDatabase({
  name: 'replicas',
  dialect: 'postgresql',
  connection: {
    url: process.env.DATABASE_URL,
    replicas: [process.env.DATABASE_REPLICA_1_URL, process.env.DATABASE_REPLICA_2_URL],
  },
  schema: {
    notes: pgTable('notes', {
      id: integer('id').primaryKey(),
      title: text('title').notNull(),
    }),
  },
})
```

```ts [server/api/notes.get.ts]
import { defineEventHandler } from 'h3'
import { useDatabase } from 'vite-hub/database'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('replicas')
  return db.$replica.select().from(schema.notes)
})
```

- `db.$replica` sends a query to one replica, picked at random for each read. Drizzle 1.0 sends every other query, and every write and transaction, to `connection.url`. A replica can lag behind the primary, so read your own writes from `db`.
- Empty entries are skipped, so an unset variable turns its replica off.
- Without replicas, `db.$replica` is `db`. Code that reads from replicas runs on every host.
- A Cloudflare Hyperdrive binding has one origin. When it serves the Database, ViteHub ignores `connection.replicas` and prints one warning. PGlite ignores them too. In both cases `db.$replica` is `db`.
- Migrations and `vitehub database` commands use `connection.url` only.
- `vitehub inspect definitions --kind database` shows the number of replicas in the `Read replicas` field, without the URLs.

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
