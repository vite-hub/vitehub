# @vite-hub/database

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://comark-ui.onmax.me/badge.svg?label=ViteHub&amp;value=vitehub.dev"></a>
  <img alt="TypeScript" src="https://comark-ui.onmax.me/badge.svg?label=TypeScript&amp;value=ready">
  <img alt="Drizzle" src="https://comark-ui.onmax.me/badge.svg?label=Drizzle&amp;value=schema">
  <img alt="Vite" src="https://comark-ui.onmax.me/badge.svg?label=Vite&amp;value=discovery">
</p>

`@vite-hub/database` turns a colocated Drizzle schema into a generated `useDatabase()` lookup for server code.

## Install

```sh
pnpm add @vite-hub/database drizzle-orm@1.0.0-rc.5
pnpm add -D drizzle-kit@1.0.0-rc.5
```

## Minimal API

```ts
// src/database.ts
import { defineDatabase } from "@vite-hub/database"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export default defineDatabase({
  schema: {
    notes: sqliteTable("notes", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      title: text("title").notNull(),
    }),
  },
})
```

```ts
// server/api/notes.get.ts
import { useDatabase } from "@vite-hub/database"
import { defineEventHandler } from "h3"

export default defineEventHandler(() => {
  const { db, schema } = useDatabase("default")
  return db.select().from(schema.notes)
})
```

```ts
// vite.config.ts
import { hubDatabase } from "@vite-hub/database/vite"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubDatabase(), nitro()],
})
```

Cloudflare D1 binds at most 100 parameters in one statement. `chunkParameters(values, { per, reserved, limit })` from `@vite-hub/database` splits values into arrays that fit one statement each: `per` is the parameters of one value (a Drizzle table counts its columns, for a multi-row insert), `reserved` the other parameters of the statement, and `limit` defaults to 100. It throws a `RangeError` when one value does not fit. A query to D1, through the binding or D1 HTTP, rejects with `DATABASE_D1_TOO_MANY_PARAMETERS` above 100 bound parameters, `DATABASE_D1_STATEMENT_TOO_LONG` above 100,000 bytes of SQL, and `DATABASE_D1_VALUE_TOO_LARGE` for a bound string or BLOB above 2,000,000 bytes ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). When the build targets Cloudflare, `vite dev` runs the same checks on the local SQLite that stands in for D1.

The table shorthand covers inserts binding at most one parameter per column. The helper does not inspect row contents or SQL defaults. For SQL expressions with more bindings, supply a numeric `per` covering the maximum bindings of a whole row, including defaults: a one-column row containing `` sql`${first} || ${second}` `` needs `{ per: 2 }`.

```ts fragment
for (const chunk of chunkParameters(ids, { reserved: 1 })) {
  await db.delete(schema.files).where(and(eq(schema.files.ownerId, ownerId), inArray(schema.files.id, chunk)))
}
```

## Vite Integration

Database instances expose Drizzle's `batch()` method on D1, D1 HTTP, and libSQL.
The batch executes atomically. Use conditional statements in a batch when a
change must compare and update shared state without an interactive transaction.

```ts
// server/api/notes/seed.post.ts
import { useDatabase } from "@vite-hub/database"
import { defineEventHandler } from "h3"

export default defineEventHandler(async () => {
  const { db, schema } = useDatabase("default")
  await db.batch([
    db.insert(schema.notes).values({ title: "First note" }),
    db.insert(schema.notes).values({ title: "Second note" }),
  ])
})
```

Each Database is `server/databases/<name>.ts`, or `server/databases/<name>/index.ts` when it has other files such as schema modules. `server/databases/default.ts` is the default database, and every other Definition sets the same `name` option. Its migrations are in `server/databases/<name>/migrations/`. The Vite forms `src/database.ts` and `src/<name>.database.ts` also work, but `src/database.ts` cannot be used beside named databases. Vite discovers those files, writes generated Drizzle artifacts, and lets server handlers import `@vite-hub/database`. The former `config.ts` files fail with `DATABASE_LEGACY_CONFIG_FILE`; `npx @vite-hub/codemods define-forms` moves them. Without a Definition, the Vite integration uses one empty default Database (`@vite-hub/database/runtime/default-database`) with `database.connection` and migrations in `server/databases/default/migrations`. Pass `implicitDefault: true` to `resolveDBViteConfig()`, `discoverDatabaseDefinitions()`, or `inspectDatabaseDefinitions()` to resolve it the same way.

`db`, `schema`, and `useDatabase()` from `@vite-hub/database` read the Databases that the Vite integration generates for server code that Nitro builds. Nitro is the only host output. In plain `node`, outside Vite, `db` throws `DATABASE_DISABLED` and `useDatabase()` throws `DATABASE_NOT_FOUND`.

Application code calls `useDatabase()` with the discovered name. Use `default` for a Default Database. Without a name, `useDatabase()` returns the Default Database or the only Named Database. It throws `DATABASE_NAME_REQUIRED` when the app has several Named Databases, and `DATABASE_NOT_FOUND` for a name that has no Definition. Both errors list the Database names. It returns `{ db, schema, relations }`.

Pass `relations` from Drizzle's `defineRelations(schema, r => ({ ... }))` to `defineDatabase()` to read related rows with `db.query.<table>.findMany({ with })`. The result of `with` is typed. Without `relations`, ViteHub uses `defineRelations(schema)`: every table, with no relations. A relation to a table that the merged database does not hold, or that a later layer replaced, fails with `DATABASE_INVALID_RELATIONS`.

In a Nuxt application, ViteHub also discovers Definitions in each layer's server directory. Definitions with the same name merge their tables into one database and one set of migrations in the application. The application Definition takes precedence over layer tables. Relations merge like tables: the relations of one table merge across layers, and the application wins a relation name. When the application sets `connection` or `cloudflare`, it replaces all layer options and must also set each option that a layer sets.

When the Nitro Vite plugin builds with a Cloudflare host, the Vite integration merges each resolved D1 binding into `nitro.cloudflare.wrangler.d1_databases` and copies the Definition's migration SQL to `.output/server/.vitehub/database/migrations/<binding>`. A Definition's binding replaces a Nitro binding with the same name.

A production build bundles libSQL only when a Database can reach a remote libSQL server: a `libsql:`, `http(s):`, or `ws(s):` connection URL, a URL from the environment, or a Definition that the build cannot read. A Cloudflare build whose Databases use D1 bindings or D1 over HTTP, or a Nuxt build with only D1-over-HTTP Databases, ships no libSQL client and no SQLite WASM. There, a Database without its D1 binding fails with `DATABASE_MISSING_CONNECTION`. Development and Node builds keep local SQLite.

## Migrations

`vitehub database generate` writes Drizzle migrations beside the Definition, one `<YYYYMMDDHHmmss>_<name>/migration.sql` folder each, as Drizzle Kit 1.0 does. Convert a `meta/_journal.json` folder from Drizzle Kit 0.x once with `vitehub database up`, which runs `drizzle-kit up` on the folder of each Definition. Until then, `vitehub database generate`, `vitehub database migrate`, `migrateOnStart`, and test mode fail with `DATABASE_MIGRATIONS_OLD_LAYOUT`. For Cloudflare D1, commit the `d1-migrations.json` that keeps the Wrangler file name of each folder. `vitehub database migrate` applies the pending ones with Drizzle Kit. For D1 HTTP it applies them itself with Wrangler's migrations table (`cloudflare.migrationsTable`, default `d1_migrations`), so `wrangler d1 migrations apply` and `vitehub database migrate` agree on what is applied. Each file and its ledger row go in one request. Kit runs from the Database project root, including when Nuxt uses `app/` as its Vite root. The CLI resolves Kit from the application or the installed `vite-hub` facade, so it does not depend on an application binary on `PATH`.

Connection URLs and tokens can use string literals or runtime environment declarations, including module-level variables initialized with those values. The generated Kit config reads environment values at invocation time and uses the Turso dialect for remote or authenticated libSQL. The migration check uses the same connection values. Local migration creates the database's parent directory after the check; generation and `--dry-run` do not create the database file.

```sh
pnpm vitehub database migrate --dry-run         # print pending migrations and their SQL, change nothing
pnpm vitehub database migrate                   # refuse pending migrations that lose data
pnpm vitehub database migrate --allow-data-loss # apply them, and skip the check
```

Before it applies anything, `vitehub database migrate` reads Drizzle's migrations table (`__drizzle_migrations`) of each database, or Wrangler's table for D1 HTTP, to find the pending migrations. It refuses `DROP TABLE`, `DROP SCHEMA`, a column drop with `ALTER TABLE`, `TRUNCATE`, `DELETE` without `WHERE`, and a SQLite table rebuild that does not copy every column of the previous Drizzle snapshot. It reports them with `DATABASE_MIGRATION_DATA_LOSS` and exits with code 1. The check skips a table that an earlier pending migration of the same run created or dropped, because the table has no rows from before the run, for example a create and a drop on a new database. A table that gets rows from an older table, like a SQLite rebuild of an existing table, stays in the check. For PostgreSQL, this exception requires schema-qualified table names and, for `TRUNCATE`, `ONLY` on every target without `CASCADE`. After a SQLite temporary table is created, subsequent losses stay in the check because unqualified names can switch between temporary and permanent tables. `--dry-run` also exits with code 1 in that case, so CI can run it as a check.

The check connects to the migration target: the local SQLite file, remote libSQL, D1 HTTP with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (or the object-form `cloudflare.http` proxy's resolved `url` and `authToken`), or Postgres with the `postgres` package. When it cannot read the migrations table, it fails with `DATABASE_MIGRATION_CHECK_FAILED` and does not guess. A D1 HTTP database without Wrangler's table but with `__drizzle_migrations` keeps the migrations that Drizzle Kit applied: the first `vitehub database migrate` writes them to Wrangler's table. Wrangler applies the migrations of a native D1 binding, so that path has no check.

The CLI and startup refuse a legacy ledger upgrade when overlapping timestamp or hash updates would assign different folder names to one row. Drizzle Kit can replay applied SQL in that case. Verify and repair the ledger upgrade on a database copy before retrying.

`vitehub database export` writes a SQL dump of each database without a build. It reads the local SQLite file by default. `--remote` reads remote libSQL, Cloudflare D1 through the D1 export API (like `wrangler d1 export --remote`), an object-form `cloudflare.http` proxy, or Postgres through `pg_dump`. `--stage <name>` loads that mode's Vite env files, `--database <name>` picks one database, and `--output <file>` sets the file. SQLite-family dumps use Wrangler's format, so `wrangler d1 execute --file` and `sqlite3` can restore them. Failures print `DATABASE_EXPORT_FAILED`.

Local SQLite, libSQL, and object-form D1 proxy exports reject contentless FTS5 tables (`content=''`) to avoid losing their search indexes. Use a SQLite backup that preserves FTS shadow tables for these databases.

Object-form D1 proxies read tables without a usable rowid pagination key in one query to avoid skipping or duplicating rows during concurrent writes. If the query exceeds the proxy's response limit, the export fails without publishing a dump; use the native D1 export API instead. A native D1 binding with a configured remote libSQL `connection.url` exports libSQL instead.

```sh
pnpm vitehub database export                             # local SQLite to .vitehub/exports/database/
pnpm vitehub database export --remote --stage production # the deployed database
```

A self-hosted Node build applies migrations itself when the server starts. The build writes each database's migrations into the server output, and a Nitro plugin that Nitro loads before the server listens applies them. Postgres databases migrate on start by default when the build's host is Node; `migrateOnStart: true` also migrates local SQLite files, and `migrateOnStart: false` turns it off. The plugin applies the pending migrations in one transaction, with Drizzle 1.0's ledger: a migration folder is pending when the `name` column does not list it. A Drizzle Kit 0.x ledger gets `name` first, as Drizzle 1.0 adds it. It refuses data loss like `vitehub database migrate`, unless `migrateOnStart: { allowDataLoss: true }`. A failed migration rolls back and stops the server with `DATABASE_MIGRATION_FAILED` for Postgres.

On Postgres, the transaction first takes the advisory lock `pg_advisory_xact_lock(hashtext('vitehub:migrations'))` and keeps it until the commit. Several instances can start together: one migrates, and the others wait, then find nothing pending. `vitehub database migrate` applies Postgres migrations with the same migrator and lock, not with Drizzle Kit. A Postgres Database on PGlite has no server to lock, so Drizzle Kit applies its migrations. Definitions on one Postgres database, as the server reports it (`current_database()` and the server start time in Unix seconds, the same for every session), share its ledger and migrate in one transaction.

With `migrateOnStart: true`, another host, D1 over HTTP, and remote libSQL fail with `DATABASE_MIGRATE_ON_START_UNSUPPORTED`. Definitions sharing a SQLite file or a Postgres database must not have one folder name with different SQL; otherwise startup refuses all changes with that error. SQLite has no lock across processes: run one server process per database file.

`ensureMigrations(name?)` from `@vite-hub/database` applies the same migrations from server code, for example a Nitro task, a Nitro plugin, or an app test. It runs the start path, with the Postgres lock, once for each Database in the process: parallel calls and later calls share the run, and the start plugin shares it too. A failed run is forgotten, so the next call tries again. A new run waits for the run before it, so Definitions that share a SQLite file apply each migration once. It works in a build with `migrateOnStart: false`. A Cloudflare or Vercel build ships no migrations, and the call rejects with `DATABASE_MIGRATE_ON_START_UNSUPPORTED`. In app tests, it skips SQLite Databases, which already have their migrations.

## Contributed tables

Packages can add Drizzle tables to an application's Database from their own Vite plugin with `vitehub.databases`. Each entry has the shared contribution shape `{ name, definition: { module, export }, reason? }`, where `export` holds an object of tables. Database entries can also set `database` and `dialect`. `tables`, such as `{ historyRefs: "history_refs" }`, lists every table of the export with its SQL name, so the build does not load the module, or drizzle-orm, while it resolves the Vite config. Without `database`, the tables go to the default or only Database:

```ts
const plugin = {
  name: "my-package/vite",
  vitehub: {
    databases: () => [{
      name: "history",
      definition: { module: "my-package/schema", export: "historySchema" },
      reason: "Stores Workspace history.",
    }],
  },
}
```

A Nuxt module adds the same plugin to `nuxt.options.vite.plugins` during setup.

A package that keeps data in a Database with its own SQL, and has no Drizzle tables, contributes an entry without `definition`: `{ name, reason?, database?, dialect? }`. ViteHub checks its target and dialect as for tables, and `vitehub inspect` lists it as `Used by`.

A package can also contribute a whole Database with `{ name, definition, reason? }`, where `definition` is the absolute path of a module that default exports `defineDatabase({ schema })`. Use it for a named Database that the package owns. For the default Database, read [The default Database](#the-default-database). The contributed Database behaves like one in `server/databases/`, keeps its migrations where that Definition would (`server/databases/default/migrations/` for `default`), and shows `Contributed by`, `Reason`, and `Migrations` in `vitehub inspect`. A name that the application already defines fails with `DATABASE_DUPLICATE_DEFINITION`.

Contributed tables are in the generated Drizzle schema, so `vitehub database generate` writes their migrations. They are also in `useDatabase(name).schema`, the generated types, `vitehub inspect`, and the Console. A table contribution can set `relations` to the name of an export of `definition.module` that holds `defineRelationsPart()` of its tables. The target Database merges them before the relations of its Definition. A contribution name, key, or SQL table name used twice fails with `DATABASE_DUPLICATE_TABLE`. A missing or ambiguous target fails with `DATABASE_INVALID_CONTRIBUTION_TARGET` and lists the Database names. `resolveDefaultDatabase(names)` from `@vite-hub/database/config` returns the same default or only Database.

### The default Database

A package that needs a Database does not add one. It contributes its tables, or a use without tables, and leaves `database` unset (or sets `"default"`). When the app has no Database Definition, the Database integration adds the implicit `default` Database once, for all of them, in Vite and in Nuxt:

- It has no tables of its own, keeps migrations in `server/databases/default/migrations/`, and uses the `dialect` of the contributions for it (SQLite when none sets one). Two different dialects fail with `DATABASE_INVALID_CONTRIBUTION_TARGET`.
- `vitehub inspect definitions --kind database` shows `Definition: Implicit` with the plugins that need it, and each contribution with its `reason`.
- When the app adds `server/databases/default.ts`, the tables move to it and keep the same migrations directory.
- Several Database Definitions without one named `default` are ambiguous for a contribution without `database`, and fail with `DATABASE_INVALID_CONTRIBUTION_TARGET` with the names to choose from.

The CMS preset, Comments, Connections, and Auth's `authDatabase()` use this rule.

## Remote D1 development

`vite dev` uses local SQLite by default. Set `remote: true` on a Database Definition to query its real D1 database during development. Writes then change real data.

```ts fragment
export default defineDatabase({
  cloudflare: {
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
  },
  remote: true,
  schema,
})
```

`remote: true` uses the D1 HTTP path of `cloudflare.http: true`: Cloudflare's API with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. It applies even when a local D1 binding exists. The first query prints `Database "<name>" is remote` with the database id, and `vitehub inspect definitions --kind database` shows `Development: Remote`. Builds ignore `remote`, so the build output does not change. `vitehub database migrate` follows `cloudflare.http`, not `remote`.

`cloudflare.http` also makes `vite dev` remote, so in development it is an alias of `remote: true`. `true` uses Cloudflare's API; an object selects an authenticated D1-compatible proxy. Unlike `remote`, it also selects D1 over HTTP in hosted output without a binding, such as Vercel. `remote: false` with `cloudflare.http` fails with `DATABASE_REMOTE_CONFLICT`. `remote` is not a Postgres option.

Set `cloudflare.readReplication: true` (or `readReplication: true` on a D1 integration) to read from D1 read replicas. Each request gets one D1 session. A request with a method other than GET, HEAD, or OPTIONS starts on the primary database and returns a `vitehub-d1-bookmark-<binding>` cookie, so the same client reads its own writes next. Work outside a request uses the primary database. `vitehub provision run` turns on replication for the database. Its plan shows an `update` action when an existing database does not replicate yet. D1 over HTTP and SQLite ignore the option.

Remote access is explicit. Local development uses SQLite unless the Definition sets `remote: true`, or the Definition or its integration configures `cloudflare.http`. Cloudflare output prefers a matching D1 binding.

A Definition inherits the integration resource when it omits both `databaseId` and `databaseName`. Setting either selects its own resource, so it inherits no integration database ID, name, or preview ID. Other D1 settings still inherit their defaults. HTTP proxy URLs and tokens inherit by field. Both must be available after inheritance for HTTP access to work.

A literal resource field that reads an Env value remains owned when that value is absent. It can use its own provisioned ID, but it does not fall back to the integration resource.

Native D1 output requires a Cloudflare block that ViteHub can read as a literal. An identifier, top-level spread, or other opaque resource expression fails the provider build when no D1 HTTP or remote libSQL connection is known. This rule also applies when the evaluated block would inherit the integration resource. Use a literal block for native output, or configure HTTP or libSQL access.

Keep an explicit `cloudflare` property in the Definition when its value is opaque. If the whole Definition hides that property in an identifier or spread, set `hubDatabase({ driver: 'd1' })` to declare D1 intent. Without that declaration, a wholly hidden Definition does not project native D1 output. Opaque local SQLite Definitions remain supported.

An owned native resource must resolve a nonblank database ID and name at build time. Its own provisioned ID can supply the ID. Use D1 HTTP or remote libSQL access when the resource values become available only at runtime.

Named Definitions without an explicit binding use their per-name binding, such as `DB_ANALYTICS`. A default Definition retains the integration binding. Named Definitions can inherit the integration resource through different binding names. Generated native D1 bindings must have unique names, including bindings for identical resources. Set distinct `cloudflare.binding` values when explicit bindings or normalized names collide.

An opaque Definition that selects its own resource uses remote HTTP or libSQL access. It does not use a native binding, including an explicit binding that matches the integration resource.

Provisioned IDs remain fallbacks for runtime Env values in direct Vite and Nuxt output. A value supplied at runtime takes precedence. An opaque Definition that selects its own resource does not receive the integration resource's provisioned ID. Provision state is read from the Vite root even when `projectRoot` sets another root for Definitions and generated files.

When a libSQL connection URL or auth token changes at runtime, the next database
access creates a client with the new credentials and closes the previous client.
Credential refresh is therefore a lifecycle boundary: await outstanding database
work before changing the credential, because libSQL closes can abort operations
that are still in flight.

## Postgres

Set `dialect: "postgresql"`, declare tables with `drizzle-orm/pg-core`, and install `postgres` in the app.

```ts
// server/databases/default.ts
import { defineDatabase } from "@vite-hub/database"
import { pgTable, serial, text } from "drizzle-orm/pg-core"

export default defineDatabase({
  dialect: "postgresql",
  cloudflare: { hyperdriveId: process.env.CLOUDFLARE_HYPERDRIVE_ID },
  connection: { url: process.env.DATABASE_URL },
  schema: {
    notes: pgTable("notes", {
      id: serial("id").primaryKey(),
      title: text("title").notNull(),
    }),
  },
})
```

ViteHub queries Postgres with postgres.js through Drizzle. A Cloudflare Hyperdrive binding (`HYPERDRIVE`, or `HYPERDRIVE_<NAME>` for a Named Database) takes precedence over `connection.url`. Inside a Cloudflare request, each request gets its own client, because Workers cannot reuse a socket across requests. On other hosts, one client pool serves the process. The client drops server notices, such as `relation already exists, skipping`, and prints each Postgres warning with `console.warn`. When `cloudflare.hyperdriveId` resolves at build time, Cloudflare output and Nitro Wrangler config get the `hyperdrive` binding.

Outside a Cloudflare request, when `connection.url` is not set or its environment variable is empty, postgres.js reads the standard PG* environment variables: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` (or `PGUSERNAME`), and `PGPASSWORD`. Use them for container deploys that give discrete credentials instead of a URL. A URL always takes precedence. Workers ignore PG* variables, and Vercel output still needs `connection.url`.

`vitehub database generate` writes Drizzle Kit migrations with `dialect: "postgresql"`. `vitehub database migrate` applies them with `connection.url`, or with the PG* variables when the URL is empty. Drizzle Kit then needs `PGHOST` and `PGDATABASE`. Query a Postgres Definition through `useDatabase()`; `defineDatabase()` returns only the Definition.

Without a Hyperdrive binding, a URL, and PG* variables, `vite dev`, `nuxt dev`, app tests, and `vitehub database migrate` run a Postgres Database on [PGlite](https://pglite.dev), a Postgres in the Node process. Install `@electric-sql/pglite` in the app; ViteHub loads it only then. The data is in `.vitehub/data/database/pglite`, or `.vitehub/data/database/<name>.pglite` for a Named Database, and app tests get an in-memory PGlite with the migrations. PGlite opens its folder in one process, so stop the dev server before `vitehub database migrate`. `driver: "pglite"` uses PGlite there even with a URL, and a production build with it fails with `DATABASE_PGLITE_IN_BUILD`. Production output never includes PGlite.

## Request stats

With the evlog Nitro module registered, each request's wide event gets `database: { calls, ms, maxConcurrent }`: the calls to any database (a batch is one call), the milliseconds with at least one call in flight, and the most calls in flight at once. A Nitro middleware (`runtime/request-stats`) gives each request its own count, and each driver client (D1 binding, D1 over HTTP, libSQL, postgres.js) reports its calls to it. `db.$client` stays the app's own client (the request's D1 session under read replication), and calls made directly on it are not counted. Calls after the response are not counted, and without evlog nothing is measured. See [Server API](https://vitehub.dev/docs/database/server-api#see-database-work-on-each-request).

## Nuxt D1 host wiring

Nuxt apps can declare one D1 database resource in `vite-hub/nuxt` and let it wire framework consumers and Cloudflare output.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["vite-hub/nuxt", "@nuxt/content"],
  vitehub: {
    host: "cloudflare",
    database: {
      driver: "d1",
      databaseName: "app-content",
    },
  },
})
```

Run `vitehub provision run --provider cloudflare` once to create or resolve the database and write its non-secret id to `.vitehub/provision.json`. `vite-hub/nuxt` reads that state, configures Nuxt Content, merges the D1 binding into `nitro.cloudflare.wrangler.d1_databases`, and stages discovered migrations. Set `databaseId` explicitly when the build cannot access provision state; a complete matching binding already present in Nitro Wrangler config is also preserved.

A Definition that owns a different D1 resource must use a binding that differs from the Nuxt host's `vitehub.database.binding`. Nuxt rejects native bindings that would point Content and the Definition at different resources through the same binding. One Definition with statically fixed database ID and name values that match the host can share that binding. Generated binding names must remain distinct between Definitions. Env declarations require a distinct binding, including declarations with a provisioned default.

`@vite-hub/database/nuxt` is internal. `vite-hub/nuxt` loads it, and it can change in any release. Do not add it to Nuxt `modules`.

Built on [Drizzle ORM](https://orm.drizzle.team/), [Drizzle Kit](https://orm.drizzle.team/docs/kit-overview), [libSQL](https://www.npmjs.com/package/%40libsql/client), [postgres.js](https://github.com/porsager/postgres), and Cloudflare [D1](https://developers.cloudflare.com/d1/) and [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) bindings when deployed to Cloudflare.

Learn more at [vitehub.dev](https://vitehub.dev).
