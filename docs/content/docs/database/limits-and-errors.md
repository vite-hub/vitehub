---
title: Database limits and errors
description: Read Database error codes and learn how to fix configuration and build errors.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Handle Database errors

`useDatabase()` returns a Drizzle client, so a failed query rejects, as in Drizzle. ViteHub does not change it to `[error, data]`.

ViteHub errors have `code`, `why`, `fix`, `docs`, and `cause`. `error.docs` links to the code in [Database diagnostics](/docs/database/diagnostics). Each one means the code or the deployment must change, so ViteHub throws it:

- A Definition error throws from `defineDatabase()`.
- A build error throws when ViteHub finds Definitions or builds the app.
- A config error throws when code first uses the database, for example when a binding or a connection URL is missing.
- A D1 HTTP error rejects the Drizzle query. Drizzle can wrap it, so read `error.cause`.

This route reads the `notes` table of the default Database:

```ts [server/databases/default.ts]
import { defineDatabase } from 'vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    notes: sqliteTable('notes', {
      id: integer('id').primaryKey({ autoIncrement: true }),
      title: text('title').notNull(),
    }),
  },
})
```

```ts [server/api/notes.get.ts]
import { defineEventHandler } from 'h3'
import { useDatabase } from 'vite-hub/database'

export default defineEventHandler(async () => {
  const { db, schema } = useDatabase('default')
  try {
    return await db.select().from(schema.notes)
  }
  catch (error) {
    console.error(error) // Read `error.cause` for `DATABASE_D1_REQUEST_FAILED` and other ViteHub codes.
    throw error
  }
})
```

`JSON.stringify()` of a ViteHub error keeps only `name`, `code`, `why`, `fix`, and `docs`, not `cause` or `stack`.

| Code | Thrown |
| --- | --- |
| `DATABASE_D1_INVALID_RESPONSE`, `DATABASE_D1_REQUEST_FAILED` | When a D1 HTTP query fails |
| `DATABASE_D1_STATEMENT_TOO_LONG`, `DATABASE_D1_TOO_MANY_PARAMETERS`, `DATABASE_D1_VALUE_TOO_LARGE` | When a query to D1 is above a [D1 limit](#d1-limits), before D1 runs it |
| `DATABASE_NAME_REQUIRED`, `DATABASE_NOT_FOUND` | By `useDatabase()`, when the name does not select one Database |
| `DATABASE_DISABLED`, `DATABASE_INVALID_D1_HTTP_URL`, `DATABASE_MISSING_CONNECTION`, `DATABASE_MISSING_D1_HTTP_CONFIG`, `DATABASE_NO_D1_BINDING`, `DATABASE_NOT_FOUND`, `DATABASE_PGLITE_NOT_INSTALLED` | When code first uses the database |
| `DATABASE_MIGRATION_CHECK_FAILED`, `DATABASE_MIGRATION_DATA_LOSS`, `DATABASE_MIGRATION_FAILED` | Printed by `vitehub database migrate`, which then exits with code 1 |
| `DATABASE_MIGRATIONS_OLD_LAYOUT` | Printed by `vitehub database generate` and `vitehub database migrate`, which then exit with code 1. Also by the build with `migrateOnStart`, and by test mode |
| `DATABASE_EXPORT_FAILED` | Printed by `vitehub database export`, which then exits with code 1 |
| `DATABASE_MIGRATION_DATA_LOSS`, `DATABASE_MIGRATION_FAILED`, `DATABASE_MIGRATE_ON_START_UNSUPPORTED` | When a Node server migrates on start, before it listens. `DATABASE_MIGRATE_ON_START_UNSUPPORTED` also fails the build |
| `DATABASE_DRIZZLE_OPTION_REMOVED`, `DATABASE_INVALID_DIALECT`, `DATABASE_INVALID_DRIVER`, `DATABASE_INVALID_NAME`, `DATABASE_INVALID_OPTIONS`, `DATABASE_UNKNOWN_OPTION` | By `defineDatabase()`, or by the build when it reads the Definition |
| Every other code | During discovery, the build, or `vitehub provision run` |

## D1 limits

Before a query reaches D1, through the binding or D1 HTTP, ViteHub checks these [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). The query rejects with a named code instead of the D1 error.

| Limit | Cloudflare D1 | Code |
| --- | --- | --- |
| Bound parameters per query | 100 | `DATABASE_D1_TOO_MANY_PARAMETERS` |
| SQL statement length, in UTF-8 bytes | 100,000 bytes | `DATABASE_D1_STATEMENT_TOO_LONG` |
| One bound string or BLOB | 2,000,000 bytes | `DATABASE_D1_VALUE_TOO_LARGE` |

Without a D1 binding, `vite dev` uses local SQLite, which accepts more than D1. So when the build targets Cloudflare (`vitehub({ host: 'cloudflare' })` or the Cloudflare Nitro preset), the dev server runs the same checks for each database with D1 options. A query that D1 rejects then fails in development with the same code. Other dev servers, and local SQLite in production, keep the SQLite limits.

D1 also limits a row to 2,000,000 bytes. ViteHub does not check it, because a row can be larger than its bound values. Migrations from `vitehub database migrate` are not checked.

## Runtime errors

### DATABASE_D1_INVALID_RESPONSE

D1 HTTP returned a different number of results than queries in the batch. Retry. If it fails again, open a ViteHub issue with the query and the response.

### DATABASE_D1_REQUEST_FAILED

A D1 HTTP request, or one query of a batch, failed. `error.why` has the HTTP status and the D1 message, for example `no such table: notes`. Check the SQL, the API token permissions, and the database id.

### DATABASE_D1_STATEMENT_TOO_LONG

One statement is longer than 100,000 bytes, the D1 limit. Bind values as parameters instead of writing them into the SQL, or split the statement.

### DATABASE_D1_TOO_MANY_PARAMETERS

The query binds more than 100 parameters, the D1 limit, often from a long `inArray()` or a multi-row `insert().values()`. Split the values with [`chunkParameters()`](/docs/database/server-api#stay-under-the-bound-parameter-limit) and run one query per chunk.

### DATABASE_D1_VALUE_TOO_LARGE

One bound string or BLOB is larger than 2,000,000 bytes, the D1 limit. Store large files in [Blob](/docs/blob) and keep the pathname in the row.

## Configuration errors

### DATABASE_DISABLED

Code read the Default Database, but the runtime has none. If the app has only Named Databases, read one with `useDatabase('<name>')`, or add a Default Database. Otherwise, set `database` in `vitehub()`. With `@vite-hub/database` alone, add `hubDatabase()` to the Vite plugins and do not pass `false` to it.

### DATABASE_INVALID_D1_HTTP_URL

`cloudflare.http.url` is not an HTTP or HTTPS URL.

### DATABASE_MISSING_CONNECTION

The database has no connection at runtime. `error.why` lists what it needs: a D1 binding, a Hyperdrive binding, D1 HTTP config, a `connection.url`, or for Postgres outside Cloudflare, PG* variables such as `PGHOST`. On Cloudflare, add the binding to the Worker config. On other hosts, set `connection.url`, or the PG* variables for Postgres.

### DATABASE_MISSING_D1_HTTP_CONFIG

The database uses D1 HTTP, and a runtime value is missing: `cloudflare.databaseId`, `cloudflare.http.url` and `cloudflare.http.authToken`, or `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` when `cloudflare.http` is `true`.

### DATABASE_NOT_CONNECTED

`connectDatabase()` found no database for a query. `error.why` says what it looked for: the variable of an `env:` location, the D1 binding of a `d1:` location, or with no location, `DATABASE_URL`, `TURSO_DATABASE_URL`, and the D1 binding `DB`. Set the variable or add the binding, then retry. See [Connect without a Definition](/docs/database/configure#connect-without-a-definition).

### DATABASE_UNSUPPORTED_URL

`connectDatabase()` cannot use the location. It reads `d1:BINDING`, `env:VARIABLE`, `libsql://` and `https://` URLs, and `file:` paths. Postgres URLs are not supported yet. A `file:` path needs Node: import `connectDatabase()` from `@vite-hub/database/connect/node`.

### DATABASE_NAME_REQUIRED

`useDatabase()` was called without a name, and the app has several Named Databases and none is named `default`. `error.why` lists the names. Pass one, for example `useDatabase('analytics')`.

### DATABASE_NO_D1_BINDING

`useDatabaseBinding(name)` found no Cloudflare D1 binding for the database. The database runs on local SQLite, libSQL, D1 HTTP, or Postgres here. Call it only where the database runs on a D1 binding, such as a Cloudflare Worker. Elsewhere, query the database with `useDatabase(name).db`.

### DATABASE_PGLITE_NOT_INSTALLED

A Postgres Database runs on PGlite in development, and the app cannot load `@electric-sql/pglite`. It runs on PGlite when the Definition sets `driver: "pglite"`, or when it has no `connection.url` and no PG* variables. Install PGlite with `pnpm add -D @electric-sql/pglite`, or set `connection.url` to a Postgres server. See [Run Postgres locally with PGlite](/docs/database/configure#run-postgres-locally-with-pglite).

### DATABASE_NOT_FOUND

`useDatabase(name)`, `useDatabaseBinding(name)`, or the Database Agent Capability received a name that has no Database Definition, or `useDatabase()` was called without a name in an app with no Database. `error.why` from `useDatabase()` lists the Database names. A query on a Named Database that has no runtime configuration also throws it.

The `db` export exists in every app. When the app has no Default Database, a query on it throws `DATABASE_DISABLED` or `DATABASE_NOT_FOUND`.

Run `vitehub inspect definitions --kind database` to see the database names.

## Migration errors

`vitehub database migrate` reads the migrations table of each database first. On these errors, it changes no database and exits with code 1.

### DATABASE_D1_MIGRATION_INVALID

The D1 migration names are invalid, duplicated, or no longer match the names Wrangler applied. Restore `d1-migrations.json` with the migration folders from version control. Keep each applied migration's Wrangler file name and assign each new migration a unique name. The error identifies the file or mapping to repair.

### DATABASE_MIGRATION_CHECK_FAILED

ViteHub cannot read which migrations the database has applied. `error.why` has the reason, such as missing `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for D1 HTTP, a connection error, a missing `postgres` package, or a Drizzle Kit 0.x migrations table with rows that match no migration folder. Make the database reachable with the connection that `vitehub database migrate` uses. To skip the check, run `vitehub database migrate --allow-data-loss`. Missing `migration.sql` files must still be restored.

### DATABASE_MIGRATIONS_OLD_LAYOUT

A migrations folder has the layout of Drizzle Kit 0.x: flat `.sql` files and `meta/_journal.json`. Drizzle Kit 1.0 and ViteHub read one `<YYYYMMDDHHmmss>_<name>/migration.sql` folder per migration. Run `vitehub database up` once, and commit the new folders. Migrations that the database applied stay applied. See [Upgrade to Drizzle 1.0](/docs/database/configure#upgrade-to-drizzle-10).

### DATABASE_MIGRATION_DATA_LOSS

A pending migration drops a table, column, or schema, deletes every row of a table, or rebuilds a SQLite table without one of its columns. A table that an earlier pending migration created or dropped does not count, because it has no old rows. For PostgreSQL, this skip needs schema-qualified table names, and for `TRUNCATE`, `ONLY` on every target without `CASCADE`. After a SQLite temporary table is created, later losses stay in the check, because unqualified names can switch between temporary and permanent tables. `error.why` names each migration and statement.

Run `vitehub database migrate --dry-run` to read the SQL. To keep the data, change the schema or edit the migration. To accept the loss, back up the data and run `vitehub database migrate --allow-data-loss`. With `migrateOnStart`, the server throws this at startup and handles no requests. Back up the data and set `migrateOnStart: { allowDataLoss: true }` to accept the loss.

### DATABASE_MIGRATION_FAILED

A statement of a pending Postgres migration failed. `error.why` names the migration and has the Postgres message, and `error.cause` is the Postgres error. All pending migrations of the run share one transaction, so the database keeps none of them, and the ledger is as it was before. A server that migrates on start stops before it listens. Fix the SQL of the migration, or the data that it conflicts with, then run `vitehub database migrate` or start the server again.

### DATABASE_MIGRATE_ON_START_UNSUPPORTED

`migrateOnStart` works only for Postgres and local SQLite files in a production Node server. With `migrateOnStart: true`, the build fails for another host or D1 over HTTP. The server fails to start when a database connects to remote libSQL; when Definitions that share a SQLite file or a Postgres database have one folder name with different SQL, or SQL that differs from an applied folder of that name; or when a migrations table from Drizzle Kit 0.x has a row that matches no migration folder. For shared databases, rename the migration folder or use a separate file or database for each Definition. Otherwise, build with the Node host and a `file:` or Postgres URL, or set `migrateOnStart: false` and run `vitehub database migrate` from the deployment.

## Export errors

### DATABASE_EXPORT_FAILED

`vitehub database export` cannot write the dump. `error.why` has the reason, such as a missing SQLite file, a remote database without `--remote`, missing `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN`, a Cloudflare API error, a missing `pg_dump`, or an output file that exists. It writes no file on failure. See [Export a database](/docs/database/configure#export-a-database).

## Definition errors

### DATABASE_DRIZZLE_OPTION_REMOVED

The Definition sets `drizzle`. Drizzle 1.0 has no `casing` option on the database, so ViteHub removed the `drizzle` option. Declare each table with `snakeCase.table()` from `drizzle-orm/sqlite-core` or `drizzle-orm/pg-core` to map camelCase keys to snake_case columns.

### DATABASE_INVALID_DIALECT

`dialect` is not `sqlite` or `postgresql`. The build reads it from the source, so write a string literal.

### DATABASE_INVALID_DRIVER

`driver` of a Postgres Definition is not `node-postgres` or `pglite`. The build reads it from the source, so write a string literal. Remove `driver` to connect with postgres.js.

### DATABASE_INVALID_NAME

`name` must be a normalized path of letters, numbers, dots, underscores, or dashes, for example `analytics` or `reports/daily`.

### DATABASE_INVALID_OPTIONS

The options of `defineDatabase()`, or an object in them such as `schema`, `cloudflare`, or `connection`, is not a plain object.

### DATABASE_INVALID_RELATIONS

The `relations` of a Definition, a Nuxt layer, or a table contribution name a table that the merged database does not hold, or a table that a later Nuxt layer replaced. Drizzle builds SQL from the table objects in the relations, so they must be the tables of the database. Pass `defineRelations()` the same table objects as `schema`. When a layer replaces a table, define the relations of that table in the same layer.

### DATABASE_INVALID_REMOTE

`remote` is not `true` or `false`. Set `remote: true` to query the real D1 database in `vite dev`, or remove it to keep local SQLite.

### DATABASE_REMOTE_CONFLICT

A Definition sets `remote: false`, but its `cloudflare.http`, or the `cloudflare.http` of the integration, sends `vite dev` queries to the remote D1 database. `defineDatabase()` throws it for the Definition's own `http`. The development server throws it for an inherited `http`. Remove `remote: false` to keep D1 over HTTP, or remove `cloudflare.http` to use local SQLite.

### DATABASE_UNKNOWN_OPTION

`defineDatabase()` got an option it does not support. In those objects, a PostgreSQL Definition supports only `cloudflare.binding`, `cloudflare.hyperdriveId`, and `connection.url`.

## Build errors

### DATABASE_BINDING_CONFLICT

Two Definitions, or a Definition and the Nuxt host D1 resource, use one D1 or Hyperdrive binding. Give each Definition its own `cloudflare.binding`.

### DATABASE_DUPLICATE_DEFINITION

Two files define the same database in one layer, two plugins contribute different Definitions with one name, or the app already defines a contributed database. Remove one, or rename it.

### DATABASE_DUPLICATE_TABLE

Two schema sources of one database use the same key or SQL table name. Rename one, or remove the contribution. If the Definition already lists the contributed tables, remove them from its schema.

### DATABASE_INVALID_CONTRIBUTION

A Vite plugin contributed an invalid `vitehub.databases` entry, two plugins used the same name, a contributed Definition module does not exist, or a contributed module exports no object of Drizzle tables. `error.why` names the plugin.

### DATABASE_INVALID_CONTRIBUTION_TARGET

Contributed tables or data have no database to go to. The app has several Definitions and none is `default`, the contribution names a missing database or uses another dialect, or contributions to the implicit default database need different dialects. Add `server/databases/default.ts` with `defineDatabase({ schema: {} })`, or set the contribution's `database`.

### DATABASE_INVALID_SCHEMA_EXPORT

A Definition file does not default export `defineDatabase({ schema })` with a schema object.

### DATABASE_LAYER_OPTIONS_CONFLICT

The options of one database come from more than one Nuxt layer, or the app Definition replaces layer options without repeating them. Keep every option in one file. Pass an object literal to `defineDatabase()`, so ViteHub can read it.

### DATABASE_LAYER_TABLE_CONFLICT

Two Nuxt layers declare the same table in one database. Rename one, or declare the table in the app Definition to replace both.

### DATABASE_LEGACY_CONFIG_FILE

A Database Definition still uses `config.ts`. The Database `<name>` is now `server/databases/<name>.ts` or `server/databases/<name>/index.ts`, and its migrations are in `server/databases/<name>/migrations/`. The former `server/databases/config.ts` is the `default` Database: move it to `server/databases/default/index.ts` with the files beside it, and move `server/databases/migrations/` to `server/databases/default/migrations/`. Run `npx @vite-hub/codemods define-forms` to do these moves and update the imports. See [define-forms](/docs/codemods/upgrade-vitehub#define-forms).

### DATABASE_MISSING_D1_RESOURCE

D1 output needs the database id and name at build time, so create the database before the first production build. Set `cloudflare.databaseId` and `cloudflare.databaseName`, or run `vitehub provision run --provider cloudflare`. In the Nuxt module options, the names are `database.databaseId` and `database.databaseName`. To create the database, read [Create the D1 database](/docs/guides/cloudflare-d1#create-the-d1-database). For values known only at runtime, use D1 HTTP or a remote libSQL connection.

### DATABASE_MIXED_DEFINITIONS

`src/database.ts` defines the default Database beside named Databases. Move the Databases to `server/databases/<name>.ts`, with `server/databases/default.ts` for the default one.

### DATABASE_NAME_MISMATCH

The `name` in a Definition does not match its file path. Fix it, or remove it.

### DATABASE_OPAQUE_CLOUDFLARE_CONFIG

ViteHub reads the `cloudflare` object from the source to write the D1 binding. Write it as an object literal, or use D1 HTTP or a remote libSQL connection.

### DATABASE_PGLITE_IN_BUILD

A production build includes a Postgres Definition with `driver: "pglite"`. PGlite keeps its data in a local folder that one process opens, so production output does not include it. Remove `driver: "pglite"` and set `connection.url`, for example to `process.env.DATABASE_URL`. In development, a Postgres Database without a URL still runs on PGlite.

### DATABASE_PROVISION_FAILED

`vitehub provision run` got a D1 database or database list from Cloudflare that it cannot use. Run it again with `--dry-run`, and check the Cloudflare token permissions.

### DATABASE_RESERVED_SCHEMA_KEY

A schema key is one that the generated schema module uses for its own exports: `schema`, `relations`, or `default`. Rename the table key.

### DATABASE_SCHEMA_LOAD_FAILED

A Definition or contributed schema module threw when it loaded. `error.why` has the import error, and `error.cause` keeps it. While it reads config, ViteHub can warn and use the literal `schema` keys instead, but `vitehub database generate` needs every schema module to load.

### DATABASE_WRANGLER_BINDING_CONFLICT

The project `wrangler.json` (or `wrangler.jsonc`, `wrangler.toml`) declares a D1 binding that ViteHub also writes, with a different `database_id`, `database_name`, or `preview_database_id`. An all-zero id never conflicts: the real id replaces it. Remove the binding from the project file, or rename one. When the two agree, ViteHub keeps one binding and fills its missing fields from the project entry.
