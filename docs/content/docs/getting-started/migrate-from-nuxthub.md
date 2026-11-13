---
title: Migrate from NuxtHub
description: Move a Nuxt application from NuxtHub KV, Blob, and Database to ViteHub, and see which NuxtHub features have no ViteHub equivalent.
navigation.order: 6
navigation.group: Develop and deploy
icon: i-lucide-arrow-right-left
---

This page moves a Nuxt app from NuxtHub (`@nuxthub/core` v0.10) to ViteHub.
For KV and Blob, you mostly change imports and error handling. Database needs
more care, because ViteHub tracks migrations in a different table. The
baseline steps cover SQLite and Cloudflare D1.

After the move, [Agents](/docs/agents) can also use KV, Blob, and Database
through [Capabilities](/docs/agents/capabilities).

## Compare the features

| NuxtHub | ViteHub | Notes |
| --- | --- | --- |
| `kv` from `@nuxthub/kv` | `kv` from `vite-hub/kv` | Same method names. Methods return `[error, value]`. |
| `blob` from `@nuxthub/blob` | `blob` from `vite-hub/blob` | Same core methods. Methods return `[error, value]`. |
| `db` and `schema` from `@nuxthub/db` | `db`, `schema`, and `useDatabase()` from `vite-hub/database` | Drizzle in both. ViteHub supports SQLite, libSQL, and Cloudflare D1. |
| `hub.db: 'postgresql'` | `dialect: "postgresql"` with `connection: { url: process.env.POSTGRES_URL \|\| process.env.POSTGRESQL_URL \|\| process.env.DATABASE_URL }` | NuxtHub read these variables on its own. A Definition reads only its `connection`. Local PGlite data moves from `.data/db/pglite` to `.vitehub/data/database/pglite`. See [Postgres configuration](/docs/database/configure#define-a-postgres-database). |
| `hub.db.connection.hyperdriveId` | `cloudflare.hyperdriveId` | NuxtHub named the binding `POSTGRES`. ViteHub names it `HYPERDRIVE`. |
| `hub.db.driver: 'd1-http'` | `cloudflare: { databaseId, http: true }` | Rename `NUXT_HUB_CLOUDFLARE_ACCOUNT_ID`, `NUXT_HUB_CLOUDFLARE_API_TOKEN`, and `NUXT_HUB_CLOUDFLARE_DATABASE_ID` to `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_D1_DATABASE_ID`. |
| `hub.db.casing` | `snakeCase.table()` per table | Drizzle 1.0 has no casing for a database. See [Name columns in snake_case](/docs/database/configure#name-columns-in-snake_case). |
| `hub.db: 'mysql'` | Not supported | Keep NuxtHub or Drizzle for MySQL. |
| `hub.cache` | `cache` option | Mounts Nitro's `cache` storage on the host's store. `defineCachedHandler` and `defineCachedFunction` from `nitro/cache` use it. |
| `handleUpload`, multipart helpers, `useUpload`, `useMultipartUpload` | Same names on `blob` and in `vite-hub/blob/vue` | Methods return `[error, value]`. Multipart works with `fs`, `cloudflare-r2` (binding), and `vercel-blob`. |
| `hosting` auto-detection | `host` | Set the host, or let ViteHub detect it from the build variables. |
| `.data/` | `.vitehub/data/` | Local development data does not move automatically. See [Move local data](#move-local-data). |
| Auto-imported `kv`, `blob`, `db`, `schema` | Auto-imported in Nuxt server code | On Nuxt 5, the module adds them, and the helpers of every other enabled feature. See [Nuxt server auto-imports](/docs/frameworks-hosts/nuxt-server-auto-imports). Explicit imports also work. |

NuxtHub v0.10 removed `hubAI()`, AutoRAG, Vectorize, and `hubBrowser()`.
ViteHub has no AI or Vectorize feature either. For browser work on Cloudflare,
see [Browser](/docs/browser).

## Replace the module

Use Nuxt 5. It is only in nightly builds for now: `pnpm add nuxt@npm:nuxt-nightly@5x`. Use pnpm 11.5 or newer; older versions can hang when they resolve this nightly alias. Remove `@nuxthub/core` and install ViteHub.

```bash [Terminal]
pnpm remove @nuxthub/core
pnpm add vite-hub
```

Add the package of each feature that you use. For Database, also keep or add
`drizzle-orm` as a direct dependency because your schema imports it.
`@vite-hub/database` needs `drizzle-orm` 1.0.0-rc.5 or newer, and
`drizzle-kit` 1.0.0-rc.5 or newer for the migration commands. With an older
version, the package manager installs a second copy, and the query types stop
matching.

```bash [Terminal]
pnpm add @vite-hub/blob @vite-hub/kv @vite-hub/database drizzle-orm@1.0.0-rc.5
pnpm add -D drizzle-kit@1.0.0-rc.5
```

Early NuxtHub v0.10 releases use `hub:db`, `hub:kv`, and `hub:blob` imports.
Replace those imports in the same way as the newer `@nuxthub/*` imports below.
`hub:db:schema` has no ViteHub alias: import the tables from your schema file,
as [Move the database](#move-the-database) shows.

Replace the NuxtHub module with `vite-hub/nuxt` and rename the `hub` key to
`vitehub`. Add a [deployment host](/docs/frameworks-hosts#choose-a-host).
Each feature is off until you turn it on.

```diff [nuxt.config.ts]
 export default defineNuxtConfig({
-  modules: ["@nuxthub/core"],
-  hub: {
-    db: "sqlite",
-    kv: true,
-    blob: true,
-  },
+  modules: ["vite-hub/nuxt"],
+  vitehub: {
+    host: "cloudflare",
+    database: true,
+    kv: true,
+    blob: true,
+  },
 })
```

See [Nuxt](/docs/frameworks-hosts/nuxt) for the rest of the module behavior.

## Move KV calls

Import `kv` from `vite-hub/kv`. Each method returns an `[error, value]` tuple
instead of throwing, so check the error.

```diff [server/api/settings.get.ts]
+import { kv } from "vite-hub/kv"
+
 export default defineEventHandler(async () => {
-  return await kv.get("settings")
+  const [error, settings] = await kv.get("settings")
+  if (error) throw error
+  return settings
 })
```

`get`, `set`, `has`, `keys`, and `clear` keep their names; `del` becomes `delete`. NuxtHub also
has other unstorage methods. Check those calls against ViteHub's
[server API](/docs/kv/server-api) before you remove NuxtHub. `set` passes
options such as `ttl` to the store driver, so TTL support depends on the
driver. See [KV](/docs/kv) for named stores and paginated `list()`.

## Move Blob calls

Import `blob` from `vite-hub/blob`. `put`, `get`, `head`, `list`, `delete`, and
`serve` keep their names, and `put` takes the same `contentType`, `prefix`,
`addRandomSuffix`, and `customMetadata` options. Each method except `serve`
returns an `[error, value]` tuple. `serve` takes the `Request` and returns a
`Response`, with `404` for a missing file. Use `blob.delete()` for both NuxtHub's `blob.delete()` and `blob.del()`. The methods take a `string` pathname, so check a
`getRouterParam()` result for `undefined` before you pass it.

For a custom serving route on Nitro 3, see
[Serve a transformed object](/docs/blob/server-api#serve-a-transformed-object).

`blob.handleUpload()` and `blob.handleMultipartUpload()` keep their names and
return `[error, value]`. `handleUpload()` takes `formKey`, `multiple`, `ensure`,
and `put` options. Multipart uses an `[action]/[...pathname]` route, and the
composables send ViteHub's request format. As in NuxtHub, Nuxt auto-imports
`useUpload()` and `useMultipartUpload()` when `blob` is on. See
[Upload files](/docs/blob/server-api#upload-files) and
[Multipart uploads](/docs/blob/server-api#multipart-uploads).

Check client return values, not only imports:

- ViteHub's `useUpload()` returns an array by default. Set `{ multiple: false }` when the caller expects one object.
- Multipart options use `concurrency` instead of NuxtHub's `concurrent`.
- Update the multipart client and server together, because their request and response formats differ.

Multipart uploads work with the `fs`, `cloudflare-r2` (binding), and
`vercel-blob` drivers. Direct `PUT` uploads with `blob.sign()` on Cloudflare
also need `accountId`, `accessKeyId`, `secretAccessKey`, and `bucketName` at
runtime, because an R2 binding alone cannot sign requests. To serve files
without your own route, set `blob: { serve: true }`.

## Move the database

ViteHub uses Drizzle, so your table definitions do not change. Move the schema
file from `server/db/schema.ts` (or `schema.sqlite.ts`) to
`server/databases/schema.ts`, and pass it to a Database Definition at
`server/databases/default.ts`.

```ts [server/databases/schema.ts]
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
})
```

```ts [server/databases/default.ts]
import { defineDatabase } from "vite-hub/database"
import * as schema from "./schema"

export default defineDatabase({
  cloudflare: {
    binding: "DB",
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    databaseName: process.env.CLOUDFLARE_D1_DATABASE_NAME,
  },
  schema,
})
```

### Keep a Turso or libSQL connection

NuxtHub connects to `TURSO_DATABASE_URL`, `LIBSQL_URL`, or `DATABASE_URL`
without config. A ViteHub Database Definition reads only its `connection`.
Without one, it uses the local file `.vitehub/data/database/sqlite.db` and
prints `DATABASE_URL_VARIABLE_IGNORED` when one of these variables is set. Name
the variable in the Definition:

```ts [server/databases/default.ts]
import { defineDatabase } from "vite-hub/database"
import * as schema from "./schema"

export default defineDatabase({
  connection: {
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
  schema,
})
```

When the variable is not set, as on your computer, the Definition still uses
the local file.

`vite-hub/database` exports `db` and `schema` for the `default`
Database, so only the import path changes. Queries do not change.

```diff [server/api/users.get.ts]
-import { db, schema } from "@nuxthub/db"
+import { db, schema } from "vite-hub/database"

 export default defineEventHandler(async () => {
   return await db.select().from(schema.users)
 })
```

For a named Database, call `useDatabase(name)`. Code outside the server, such
as types in `shared/`, imports the tables from the schema file instead of
`hub:db:schema`:

```diff [shared/types/db.ts]
-import type { users } from "hub:db:schema"
+import type { users } from "../../server/databases/schema"

 export type User = typeof users.$inferSelect
```

### Migrations

NuxtHub writes SQL files to `server/db/migrations/<dialect>/` and records them
in the `_hub_migrations` table. ViteHub writes migrations next to the Database
Definition, in `server/databases/default/migrations/`. It applies them with drizzle-kit
for SQLite and libSQL, and with Wrangler for Cloudflare D1. These runners use
different history tables by default.

::warning
Do not set Wrangler's history table to `_hub_migrations` to skip the baseline.
NuxtHub records normalized migration names, and Wrangler records filenames, so
the records do not match.
::

Also list the schema files, migration directories, and post-migration queries
from Nuxt layers and custom NuxtHub configuration. Moving only the app's
`server/db/schema.ts` misses them.

For a new empty SQLite or libSQL database, generate and apply migrations:

```bash [Terminal]
pnpm vitehub database generate
pnpm vitehub database migrate
```

::warning
Do not run these commands as-is on an existing database. Back it up first, and
match its schema and migration history to the new runner. Reading the
generated SQL alone does not create a baseline.
::

`vitehub database generate --custom` creates a migration you write by hand. NuxtHub
applied migrations during `nuxt dev` and `nuxt build`, except at build time for
D1 binding deployments. ViteHub never applies app migrations during
development or builds. Run `pnpm vitehub database migrate` after you pull a new migration. It applies SQLite, libSQL, D1 HTTP, and Postgres migrations. A Node server build applies Postgres migrations when it starts, and SQLite migrations with `migrateOnStart: true`. See [Migrate when the server starts](/docs/database/configure#migrate-when-the-server-starts). Until the Postgres baseline is in place, build with `migrateOnStart: false`.

### Baseline an existing SQLite database

Stop the old app and back up its database. NuxtHub's default local file is
`.data/db/sqlite.db`; ViteHub's is `.vitehub/data/database/sqlite.db`. Copy
the database while all connections are closed, or set `connection.url` in the
Definition to keep the old location. Keep SQLite's sidecar files when needed.

Keep the Definition's schema identical to the existing database, and finish
pending NuxtHub migrations first. Start a new `server/databases/default/migrations/`
directory and generate a baseline:

```bash [Terminal]
pnpm vitehub database generate --name baseline
```

Compare the generated SQL with the existing tables, columns, indexes, and
constraints. Once they match, add `IF NOT EXISTS` to each `CREATE` statement in
the `migration.sql` of the baseline folder. Keep the folder name and its
`snapshot.json` unchanged.

```diff [server/databases/default/migrations/20261109120000_baseline/migration.sql]
-CREATE TABLE `users` (
+CREATE TABLE IF NOT EXISTS `users` (
 	`id` integer PRIMARY KEY NOT NULL,
 	`name` text NOT NULL
 );
 --> statement-breakpoint
-CREATE UNIQUE INDEX `users_name_unique` ON `users` (`name`);
+CREATE UNIQUE INDEX IF NOT EXISTS `users_name_unique` ON `users` (`name`);
```

Apply the baseline with `pnpm vitehub database migrate`. On the existing database it
changes nothing and only records the baseline in Drizzle's
`__drizzle_migrations` table. On a new empty database, such as a teammate's
clone, CI, or a preview, it creates the schema. Do not replace the baseline
with a no-op such as `SELECT 1;`: a new database then gets no tables, and the
next migration fails.

Now change the Definition's schema and run `pnpm vitehub database generate` again.
The next migration folder must hold only the new change. Review it, apply
it with `pnpm vitehub database migrate`, and check the existing rows. Run the command
again to confirm that it does not apply the same migration twice. Keep the
migration folders in version control.

### Baseline an existing Cloudflare D1 database

For a Cloudflare binding deployment, Wrangler applies the SQL migrations.
Install its CLI in the app:

```bash [Terminal]
pnpm add -D wrangler
```

Wrangler's history is separate from NuxtHub's `_hub_migrations`. Before you
apply any new migration to an existing D1 database:

1. Back up the existing database. Confirm that `databaseId` and `databaseName`
   in the Definition identify that database.
2. Keep the Definition's schema identical to the deployed schema. Finish any
   pending NuxtHub migrations before the switch. Do not add schema changes yet.
3. Start with a new `server/databases/default/migrations/` directory, without copied
   NuxtHub SQL files. Run `pnpm vitehub database generate --name baseline` to capture
   the current schema in a migration folder with Drizzle's snapshot.
4. Compare the generated SQL with the existing database. Once every table,
   column, index, and constraint matches, add `IF NOT EXISTS` to each `CREATE`
   statement in the `migration.sql` of the baseline folder, as in the SQLite
   section. Keep the folder name and its `snapshot.json` unchanged. The
   baseline must not create existing tables or change data.
5. Remove `migrations_table: "_hub_migrations"` from the D1 entry of the
   project's Wrangler config. NuxtHub's templates set it, and Wrangler would
   then read NuxtHub's history instead of its own.
6. Run `pnpm nuxt build` to generate `.output/server/wrangler.json`. Check that
   its D1 resource identity and `migrations_dir` refer to the existing database
   and the copied migrations, and that it has no `migrations_table`. The build
   writes each migration folder there as one `NNNN_<name>.sql` file, because
   Wrangler reads flat files, and keeps the names in `d1-migrations.json` next
   to your migrations. Commit that file with the migrations. ViteHub writes
   the D1, KV, and R2 bindings, so you can remove them from the project's
   Wrangler config; if you keep one, it must name the same resource (see
   [Database hosts](/docs/database/hosts)). Then list the pending migrations:

```bash [Terminal]
pnpm wrangler d1 migrations list <database-name> --remote --config .output/server/wrangler.json
```

Only the baseline should be pending. If other migrations appear, stop and
reconcile the directory and Wrangler history before continuing. Record the
baseline in Wrangler's migration history by applying it:

```bash [Terminal]
pnpm wrangler d1 migrations apply <database-name> --remote --config .output/server/wrangler.json
```

Run `migrations list` again to confirm the baseline is recorded. Only then change
the Definition's schema and run `pnpm vitehub database generate` for subsequent
changes. Drizzle compares them with the retained baseline snapshot, so the next
migration contains only those changes. Review that SQL, rebuild, and apply it
with Wrangler. Keep the migration folders in version control.
The same baseline creates the schema in a new empty D1 database, such as a
preview database. Read [Database](/docs/database).

## Keep the cache

Cached handlers and functions come from Nitro, not from NuxtHub. In Nitro 3,
import `defineCachedHandler()` (formerly `cachedEventHandler()`) and
`defineCachedFunction()` from `nitro/cache`. NuxtHub `hub.cache` selected the
storage driver for Nitro's `cache` mount. In ViteHub, set `cache: true`.

| Host | Production store |
| --- | --- |
| `cloudflare` | Workers KV binding `CACHE` with an existing namespace ID |
| `vercel` | Vercel Runtime Cache |
| `deno` | Deno KV |
| `node` | `.vitehub/data/cache` |

- Development uses `.vitehub/data/cache`, or `<dataDir>/cache` when `dataDir` is set.
- Cloudflare needs `cache.namespaceId`, or an existing `CACHE` namespace with an id in `nitro.cloudflare.wrangler.kv_namespaces`, so the deployment always names a real namespace.
- The `netlify` host has no default cache store, so `cache: true` fails the build there.
- A `cache` mount you set in `nitro.kv` (`nitro.storage` in Nuxt) wins.

To share the app's KV store instead, on any host, set `cache: { driver: "kv" }`
with `kv` on. Cache keys get the `nitro-cache:` prefix.

To keep the cache namespace NuxtHub created on Cloudflare, pass its id:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  vitehub: {
    host: "cloudflare",
    cache: {
      driver: "cloudflare-kv-binding",
      binding: "CACHE",
      namespaceId: process.env.CLOUDFLARE_CACHE_NAMESPACE_ID,
    },
  },
})
```

## Deploy

ViteHub uses NuxtHub's Cloudflare binding names: `DB` for D1, `KV` for Workers
KV, and `BLOB` for R2. Also keep each resource's identity: set the D1
`databaseId` and `databaseName`, the KV `namespaceId` (or `namespaceName` for
provisioning), and the R2 `bucketName`. A binding name alone can point to a new
empty resource.

Set these options in `nuxt.config.ts`. Nuxt does not load a separate
`vite.config.ts`.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: {
    host: "cloudflare",
    database: true,
    kv: {
      driver: "cloudflare-kv-binding",
      binding: "KV",
      namespaceId: process.env.CLOUDFLARE_KV_NAMESPACE_ID,
    },
    blob: {
      driver: "cloudflare-r2",
      binding: "BLOB",
      bucketName: process.env.CLOUDFLARE_R2_BUCKET_NAME,
    },
  },
})
```

| Host | What changes |
| --- | --- |
| Cloudflare | Set `host: "cloudflare"`. Run `pnpm vitehub provision run --provider cloudflare` to resolve the D1 database ID. |
| Vercel | Set `host: "vercel"`. KV reads `KV_REST_API_URL` and `KV_REST_API_TOKEN`, then `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Blob uses OIDC with `BLOB_STORE_ID`, then `BLOB_READ_WRITE_TOKEN`. |
| Node | Set `host: "node"`. KV and Blob use the file system under `.vitehub/data/`. |

Netlify and Deno have their own hosts. See
[Frameworks and hosts](/docs/frameworks-hosts) for each feature's default
provider.

## Move local data

Stop the old application first. ViteHub does not read NuxtHub's `.data/`
folder.

- **Database**: copy the database file together with its `-wal` and `-shm`
  files, if they exist. The `-wal` file can hold committed rows that are not in
  `sqlite.db` yet. Then follow
  [Baseline an existing SQLite database](#baseline-an-existing-sqlite-database).

  ```bash [Terminal]
  mkdir -p .vitehub/data/database && cp .data/db/sqlite.db* .vitehub/data/database/
  ```

- **KV**: both use the same file layout. Copy the folder before the first
  ViteHub start:

  ```bash [Terminal]
  mkdir -p .vitehub/data && cp -R .data/kv .vitehub/data/kv
  ```

- **Blob**: the metadata files differ, so write each file through ViteHub.
  NuxtHub keeps each file at `.data/blob/<pathname>` and its content type in
  `<pathname>.$meta.json`. Start `pnpm nuxt dev` and put each file with its
  content type:

  ```bash [Terminal]
  pnpm vitehub blob put images/photo.png .data/blob/images/photo.png --content-type image/png
  ```

  The command does not set custom metadata. For blobs with `customMetadata`,
  call `blob.put()` with the same options from a one-off server route.

## Verify the migration

1. Before the switch, record sample database rows, KV values, and Blob bytes
   with their content types and custom metadata.
2. After the switch, call a route for each feature and compare those values.
   Move local data first, as [Move local data](#move-local-data) shows.
   Re-uploading blobs changes upload timestamps and may change URLs or ETags.
   Keep application records of those values if your application needs them.
3. Run `pnpm nuxt build`. A feature that the host cannot provide fails the build.
4. Run `pnpm vitehub inspect output --json` and confirm resource IDs and
   names, as well as bindings and environment variables.
5. Apply one schema change after the baseline. Confirm that it preserves the
   old rows and that a second migration run makes no further changes.
6. Restart the application and read the same data again.
7. Run [Vite Doctor](/docs/reference/doctor-rules#vhub0032). Rule `VHUB0032`
   reports NuxtHub leftovers, such as the module, the `hub` key, and `hub:*`
   and `@nuxthub/*` imports.

## Next steps

- Give an Agent the same data with the [KV](/docs/kv/agent-capability), [Blob](/docs/blob/agent-capability), and [Database](/docs/database/agent-capability) Capabilities.
- Read [Server primitives](/docs/getting-started/server-primitives) for Queue, Workflow, Schedule, Auth, and the other APIs that NuxtHub does not provide.

## Related guides

Read [ViteHub vs NuxtHub](/docs/compare/nuxthub) for the current scope and Nuxt
requirements before you migrate.
