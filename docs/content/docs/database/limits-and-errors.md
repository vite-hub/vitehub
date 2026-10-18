---
title: Database limits and errors
description: Read Database error codes, and repair Database configuration and build errors.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Handle Database errors

`useDatabase()` returns a Drizzle client. Queries use the Drizzle API, so a failed query rejects, as it does in Drizzle. ViteHub does not change that API to `[error, data]`.

ViteHub errors are Nostics diagnostics with `code`, `why`, `fix`, `docs`, and `cause`. `error.docs` links to the code on this page. Each one means that the code or the deployment must change, so ViteHub throws it:

- A Definition error throws from `defineDatabase()`.
- A build error throws when ViteHub discovers Database Definitions or builds the app.
- A config error throws when code first uses the database, for example when a binding or a connection URL is missing.
- A Cloudflare D1 HTTP error rejects the Drizzle query. Drizzle can wrap it, so read `error.cause` of the query error.

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

`JSON.stringify()` of a ViteHub error includes only `name`, `code`, `why`, `fix`, and `docs`. It does not include `cause` or `stack`.

| Code | Thrown |
| --- | --- |
| `DATABASE_D1_INVALID_RESPONSE`, `DATABASE_D1_REQUEST_FAILED` | When a D1 HTTP query fails |
| `DATABASE_DISABLED`, `DATABASE_INVALID_D1_HTTP_URL`, `DATABASE_MISSING_CONNECTION`, `DATABASE_MISSING_D1_HTTP_CONFIG`, `DATABASE_NOT_FOUND` | When code first uses the database |
| `DATABASE_INVALID_CASING`, `DATABASE_INVALID_DIALECT`, `DATABASE_INVALID_NAME`, `DATABASE_INVALID_OPTIONS`, `DATABASE_UNKNOWN_OPTION` | By `defineDatabase()`, or by the build when it reads the Definition |
| Every other code | During discovery, the build, or `vitehub provision run` |

## Runtime errors

### DATABASE_D1_INVALID_RESPONSE

Cloudflare D1 HTTP returned a different number of results than the number of queries in the batch. Retry the query. If it fails again, open a ViteHub issue with the query and the response.

### DATABASE_D1_REQUEST_FAILED

A Cloudflare D1 HTTP request, or one query of a batch, failed. `error.why` has the HTTP status and the D1 message, for example `no such table: notes`. Check the SQL, the D1 API token permissions, and the D1 database id.

## Configuration errors

### DATABASE_DISABLED

Code imported `@vite-hub/database/drizzle`, but the runtime has no Database configuration. Add `hubDb()` to the Vite config, and do not set `database: false`.

### DATABASE_INVALID_D1_HTTP_URL

`cloudflare.http.url` is not an HTTP or HTTPS URL.

### DATABASE_MISSING_CONNECTION

The database has no connection at runtime. `error.why` lists what it needs: a Cloudflare D1 binding, a Hyperdrive binding, D1 HTTP configuration, or a `connection.url`. On Cloudflare, add the binding to the Worker configuration. On other hosts, set `connection.url`.

### DATABASE_MISSING_D1_HTTP_CONFIG

The database uses D1 HTTP, and a value is missing at runtime: `cloudflare.databaseId`, `cloudflare.http.url` and `cloudflare.http.authToken`, or the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` environment variables when `cloudflare.http` is `true`.

### DATABASE_NOT_FOUND

`useDatabase(name)` or `agentDb.database(name)` received a name that has no Database Definition. Run `vitehub inspect definitions --kind database` to see the discovered databases.

## Definition errors

### DATABASE_INVALID_CASING

`drizzle.casing` is not `snake_case` or `camelCase`.

### DATABASE_INVALID_DIALECT

`dialect` is not `sqlite` or `postgresql`. The build reads `dialect` from the source, so it must be a string literal.

### DATABASE_INVALID_NAME

`name` must be a normalized path of letters, numbers, dots, underscores, or dashes, for example `analytics` or `reports/daily`.

### DATABASE_INVALID_OPTIONS

The options of `defineDatabase()`, or one of its objects such as `schema`, `cloudflare`, or `connection`, is not a plain object.

### DATABASE_UNKNOWN_OPTION

`defineDatabase()` received an option that it does not support. A PostgreSQL Definition supports only `cloudflare.binding`, `cloudflare.hyperdriveId`, and `connection.url` in those objects.

## Build errors

### DATABASE_BINDING_CONFLICT

Two Database Definitions, or a Database Definition and the Nuxt host D1 resource, use one Cloudflare D1 or Hyperdrive binding. Set `cloudflare.binding` to a different name for each Definition.

### DATABASE_DUPLICATE_DEFINITION

Two files define the same database in the same layer. Remove one, or give it another name.

### DATABASE_DUPLICATE_TABLE

Two schema sources of one database use the same schema key or the same SQL table name. Rename one, or remove the contribution. If the Definition already lists the contributed tables, remove them from its schema.

### DATABASE_INVALID_CONTRIBUTION

A Vite plugin contributed an invalid `vitehub.databases` entry, two plugins contributed tables with the same name, or the contributed module does not export an object of Drizzle tables. `error.why` names the plugin.

### DATABASE_INVALID_CONTRIBUTION_TARGET

Contributed tables have no Database to go to. The app has no Database Definition, has several and none is named `default`, names a missing database, or uses another dialect. Add `server/databases/config.ts` with `defineDatabase({ schema: {} })`, or set the `database` option of the contribution.

### DATABASE_INVALID_SCHEMA_EXPORT

A Database Definition file does not default export `defineDatabase({ schema })` with a schema object.

### DATABASE_LAYER_OPTIONS_CONFLICT

The options of one database come from more than one Nuxt layer, or the application definition replaces layer options and does not repeat them. Keep every option in one file. Pass an object literal to `defineDatabase()`, so that ViteHub can read the options.

### DATABASE_LAYER_TABLE_CONFLICT

Two Nuxt layers declare the same table in one database. Rename one, or declare the table in the application definition to replace both.

### DATABASE_MISSING_D1_RESOURCE

Cloudflare D1 output needs the D1 database id and name at build time. Set `cloudflare.databaseId` and `cloudflare.databaseName`, or run `vitehub provision run --provider cloudflare`. For values that resolve at runtime, use D1 HTTP or a remote libSQL connection.

### DATABASE_MIXED_DEFINITIONS

The app has a default Database Definition and named ones. Use one default database, or only named databases.

### DATABASE_NAME_MISMATCH

The `name` in a Database Definition is not the name from its file path. Set it to that name, or remove it.

### DATABASE_OPAQUE_CLOUDFLARE_CONFIG

ViteHub reads the `cloudflare` object of a Database Definition from the source to write the D1 binding. Write it as an object literal, or use D1 HTTP or a remote libSQL connection.

### DATABASE_PROVISION_FAILED

`vitehub provision run` received a D1 database or a database list from Cloudflare that it cannot use. Run it again with `--dry-run`, and check the permissions of the Cloudflare token.

### DATABASE_RESERVED_SCHEMA_KEY

A schema uses a key that the generated schema module uses for its own exports. Rename the table key.

### DATABASE_SCHEMA_LOAD_FAILED

A Database Definition or a contributed schema module threw when it loaded. `error.why` has the import error, and `error.cause` keeps it. During config resolution ViteHub can warn and read the literal `schema` keys instead, but `vitehub db generate` needs every schema module to load.
