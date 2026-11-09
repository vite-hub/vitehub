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

```ts [server/api/notes.get.ts]
import { useDatabase } from '@vite-hub/database/drizzle'

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
| `DATABASE_DISABLED`, `DATABASE_INVALID_D1_HTTP_URL`, `DATABASE_MISSING_CONNECTION`, `DATABASE_MISSING_D1_HTTP_CONFIG`, `DATABASE_NOT_FOUND` | When code first uses the database |
| `DATABASE_MIGRATION_CHECK_FAILED`, `DATABASE_MIGRATION_DATA_LOSS` | Printed by `vitehub db migrate`, which then exits with code 1 |
| `DATABASE_EXPORT_FAILED` | Printed by `vitehub db export`, which then exits with code 1 |
| `DATABASE_MIGRATION_DATA_LOSS`, `DATABASE_MIGRATE_ON_START_UNSUPPORTED` | With `migrateOnStart`, when the Node server starts. `DATABASE_MIGRATE_ON_START_UNSUPPORTED` also fails the build |
| `DATABASE_INVALID_CASING`, `DATABASE_INVALID_DIALECT`, `DATABASE_INVALID_NAME`, `DATABASE_INVALID_OPTIONS`, `DATABASE_UNKNOWN_OPTION` | By `defineDatabase()`, or by the build when it reads the Definition |
| Every other code | During discovery, the build, or `vitehub provision run` |

## D1 limits

Before a query reaches D1, through the binding or D1 HTTP, ViteHub checks these [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). The query rejects with a named code instead of the D1 error.

| Limit | Cloudflare D1 | Code |
| --- | --- | --- |
| Bound parameters per query | 100 | `DATABASE_D1_TOO_MANY_PARAMETERS` |
| SQL statement length, in UTF-8 bytes | 100,000 bytes | `DATABASE_D1_STATEMENT_TOO_LONG` |
| One bound string or BLOB | 2,000,000 bytes | `DATABASE_D1_VALUE_TOO_LARGE` |

Without a D1 binding, `vite dev` uses local SQLite, which accepts more than D1. So when the build targets Cloudflare (`vitehub({ host: 'cloudflare' })` or the Cloudflare Nitro preset), the dev server runs the same checks for each database with D1 options. A query that D1 rejects then fails in development with the same code. Other dev servers, and local SQLite in production, keep the SQLite limits.

D1 also limits a row to 2,000,000 bytes. ViteHub does not check it, because a row can be larger than its bound values. Migrations from `vitehub db migrate` are not checked.

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

Code imported `@vite-hub/database/drizzle`, but the runtime has no Database config. Add `hubDb()` to the Vite config, and do not set `database: false`.

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

### DATABASE_NOT_FOUND

`agentDb.database(name)` got a name with no Definition, or a query ran on a named database with no runtime config.

`useDatabase(name)` does not throw it. For an unknown name it returns `undefined`, so `const { db } = useDatabase('typo')` fails with a `TypeError`. `useDatabase('default')` always returns an entry. Its `db` throws `DATABASE_DISABLED` when the app has no default database.

Run `vitehub inspect definitions --kind database` to see the database names.

## Migration errors

`vitehub db migrate` reads the migrations table of each database first. On these errors, it changes no database and exits with code 1.

### DATABASE_MIGRATION_CHECK_FAILED

ViteHub cannot read which migrations the database has applied. `error.why` has the reason, such as missing `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for D1 HTTP, a connection error, a missing `postgres` package, or an invalid `meta/_journal.json`. Make the database reachable with the connection that `vitehub db migrate` uses. To skip the check, run `vitehub db migrate --allow-data-loss`.

### DATABASE_MIGRATION_DATA_LOSS

A pending migration drops a table, column, or schema, deletes every row of a table, or rebuilds a SQLite table without one of its columns. A table that an earlier pending migration created or dropped does not count, because it has no old rows. For PostgreSQL, this skip needs schema-qualified table names, and for `TRUNCATE`, `ONLY` on every target without `CASCADE`. After a SQLite temporary table is created, later losses stay in the check, because unqualified names can switch between temporary and permanent tables. `error.why` names each migration and statement.

Run `vitehub db migrate --dry-run` to read the SQL. To keep the data, change the schema or edit the migration. To accept the loss, back up the data and run `vitehub db migrate --allow-data-loss`. With `migrateOnStart`, the server throws this at startup and handles no requests. Back up the data and set `migrateOnStart: { allowDataLoss: true }` to accept the loss.

### DATABASE_MIGRATE_ON_START_UNSUPPORTED

`migrateOnStart` works only for local SQLite files in a production Node server. The build fails for another host, Postgres, or D1 over HTTP. The server fails to start when a database connects to remote libSQL, or when Definitions that share a SQLite file have an unrecorded migration at or below the latest applied timestamp. For shared files, use compatible histories or separate files. Otherwise, build with the Node host and a `file:` URL, or remove `migrateOnStart` and run `vitehub db migrate` from the deployment.

## Export errors

### DATABASE_EXPORT_FAILED

`vitehub db export` cannot write the dump. `error.why` has the reason, such as a missing SQLite file, a remote database without `--remote`, missing `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN`, a Cloudflare API error, a missing `pg_dump`, or an output file that exists. It writes no file on failure. See [Export a database](/docs/database/configure#export-a-database).

## Definition errors

### DATABASE_INVALID_CASING

`drizzle.casing` is not `snake_case` or `camelCase`.

### DATABASE_INVALID_DIALECT

`dialect` is not `sqlite` or `postgresql`. The build reads it from the source, so write a string literal.

### DATABASE_INVALID_NAME

`name` must be a normalized path of letters, numbers, dots, underscores, or dashes, for example `analytics` or `reports/daily`.

### DATABASE_INVALID_OPTIONS

The options of `defineDatabase()`, or an object in them such as `schema`, `cloudflare`, or `connection`, is not a plain object.

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

Contributed tables or data have no database to go to. The app has several Definitions and none is `default`, the contribution names a missing database or uses another dialect, or contributions to the implicit default database need different dialects. Add `server/databases/config.ts` with `defineDatabase({ schema: {} })`, or set the contribution's `database`.

### DATABASE_INVALID_SCHEMA_EXPORT

A Definition file does not default export `defineDatabase({ schema })` with a schema object.

### DATABASE_LAYER_OPTIONS_CONFLICT

The options of one database come from more than one Nuxt layer, or the app Definition replaces layer options without repeating them. Keep every option in one file. Pass an object literal to `defineDatabase()`, so ViteHub can read it.

### DATABASE_LAYER_TABLE_CONFLICT

Two Nuxt layers declare the same table in one database. Rename one, or declare the table in the app Definition to replace both.

### DATABASE_MISSING_D1_RESOURCE

D1 output needs the database id and name at build time. Set `cloudflare.databaseId` and `cloudflare.databaseName`, or run `vitehub provision run --provider cloudflare`. For values known only at runtime, use D1 HTTP or a remote libSQL connection.

### DATABASE_MIXED_DEFINITIONS

The app has a default Definition and named ones. Use one default database, or only named ones.

### DATABASE_NAME_MISMATCH

The `name` in a Definition does not match its file path. Fix it, or remove it.

### DATABASE_OPAQUE_CLOUDFLARE_CONFIG

ViteHub reads the `cloudflare` object from the source to write the D1 binding. Write it as an object literal, or use D1 HTTP or a remote libSQL connection.

### DATABASE_PROVISION_FAILED

`vitehub provision run` got a D1 database or database list from Cloudflare that it cannot use. Run it again with `--dry-run`, and check the Cloudflare token permissions.

### DATABASE_RESERVED_SCHEMA_KEY

A schema key is one that the generated schema module uses for its own exports. Rename the table key.

### DATABASE_SCHEMA_LOAD_FAILED

A Definition or contributed schema module threw when it loaded. `error.why` has the import error, and `error.cause` keeps it. While it reads config, ViteHub can warn and use the literal `schema` keys instead, but `vitehub db generate` needs every schema module to load.

### DATABASE_WRANGLER_BINDING_CONFLICT

The project `wrangler.json` (or `wrangler.jsonc`, `wrangler.toml`) declares a D1 binding that ViteHub also writes, with a different `database_id`, `database_name`, or `preview_database_id`. An all-zero id never conflicts: the real id replaces it. Remove the binding from the project file, or rename one. When the two agree, ViteHub keeps one binding and fills its missing fields from the project entry.
