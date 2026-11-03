---
title: Migrate from NuxtHub
description: Move a Nuxt application from NuxtHub KV, Blob, and Database to ViteHub, and see which NuxtHub features have no ViteHub equivalent.
navigation.order: 6
navigation.group: Develop and deploy
icon: i-lucide-arrow-right-left
---

Use this page to move a Nuxt application from NuxtHub (`@nuxthub/core` v0.10) to
ViteHub. For KV and Blob, the change is mostly imports and error handling.
Database needs more care because ViteHub tracks migrations in a different table.
The baseline steps below cover SQLite and Cloudflare D1.

After the move, the same KV, Blob, and Database APIs are also available to
[Agents](/docs/agents) through [Capabilities](/docs/agents/capabilities).

## Compare the features

| NuxtHub | ViteHub | Notes |
| --- | --- | --- |
| `kv` from `@nuxthub/kv` | `kv` from `vite-hub/kv` | Same method names. Methods return `[error, value]`. |
| `blob` from `@nuxthub/blob` | `blob` from `vite-hub/blob` | Same core methods. Methods return `[error, value]`. |
| `db` and `schema` from `@nuxthub/db` | `useDatabase()` from `vite-hub/database/drizzle` | Drizzle in both. ViteHub supports SQLite, libSQL, and Cloudflare D1. |
| `hub.db: 'postgresql'` | `dialect: "postgresql"` | See [Postgres configuration](/docs/database/configure#define-a-postgres-database). The baseline steps below cover SQLite and D1. |
| `hub.db: 'mysql'` | Not supported | Keep NuxtHub or Drizzle for MySQL. |
| `hub.cache` | `cache` option | Mounts Nitro's `cache` storage on the preset's store. `cachedEventHandler` and `defineCachedFunction` keep working. |
| `handleUpload`, multipart helpers, `useUpload`, `useMultipartUpload` | Same names on `blob` and in `vite-hub/blob/vue` | Methods return `[error, value]`. Multipart works with `fs`, `cloudflare-r2` (binding), and `vercel-blob`. |
| `hosting` auto-detection | `preset` | You must select the host. |
| `.data/` | `.vitehub/data/` | Local development data does not move automatically. |
| Auto-imported `kv`, `blob`, `db`, `schema` | Auto-imported in Nuxt server code | The module adds them for each enabled feature when Nitro auto-imports are on. Explicit imports also work. |

NuxtHub v0.10 removed `hubAI()`, AutoRAG, Vectorize, and `hubBrowser()`.
ViteHub has no AI or Vectorize feature either. For browser work on Cloudflare,
read [Browser](/docs/browser).

## Replace the module

Use Nuxt 4.5.2 or newer. Remove `@nuxthub/core` and install ViteHub.

```bash [Terminal]
pnpm remove @nuxthub/core
pnpm add vite-hub
```

For Database, add the Database package and keep or add `drizzle-orm` as a
direct dependency because your schema imports it. Add `drizzle-kit` for the
migration commands.

```bash [Terminal]
pnpm add @vite-hub/database drizzle-orm
pnpm add -D drizzle-kit
```

Early NuxtHub v0.10 releases use `hub:db`, `hub:kv`, and `hub:blob` imports.
Replace those imports in the same way as the newer `@nuxthub/*` imports below.

Replace the NuxtHub module with `vite-hub/nuxt`, and rename the `hub` key to
`vitehub`. Add a [deployment preset](/docs/frameworks-hosts#choose-a-preset).
Each feature is off until you enable it.

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
+    preset: "cloudflare",
+    database: true,
+    kv: true,
+    blob: true,
+  },
 })
```

Read [Nuxt](/docs/frameworks-hosts/nuxt) for the other module behavior.

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

`get`, `set`, `has`, `del`, `keys`, and `clear` keep their names. NuxtHub also
exposes unstorage methods outside this list. Check those calls against
ViteHub's [server API](/docs/kv/server-api) before removing NuxtHub. `set` passes
its options, such as `ttl`, to the store driver, so TTL support depends on the
driver. Read [KV](/docs/kv) for named stores and paginated
`list()`.

## Move Blob calls

Import `blob` from `vite-hub/blob`. `put`, `get`, `head`, `list`, `del`, and
`serve` keep their names, and `put` accepts the same `contentType`, `prefix`,
`addRandomSuffix`, and `customMetadata` options. Each method returns an
`[error, value]` tuple.

```diff [server/routes/files/[...pathname].get.ts]
+import { blob } from "vite-hub/blob"
+
 export default defineEventHandler(async (event) => {
   const { pathname } = getRouterParams(event)
-  return blob.serve(event, pathname)
+  const [error, stream] = await blob.serve(event, pathname)
+  if (error?.code === "BLOB_NOT_FOUND") {
+    throw createError({ statusCode: 404, statusMessage: "File not found" })
+  }
+  if (error) throw error
+  return stream
 })
```

`blob.handleUpload()` and `blob.handleMultipartUpload()` keep their names and
return `[error, value]`. `handleUpload()` takes `formKey`, `multiple`, `ensure`,
and `put` options. The multipart route uses an `[action]/[...pathname]` route,
and the composables send ViteHub's request format. In Nuxt,
`useUpload()` and `useMultipartUpload()` are auto-imported when `blob` is
enabled, as in NuxtHub. Read [Upload files](/docs/blob/server-api#upload-files)
and [Multipart uploads](/docs/blob/server-api#multipart-uploads).

Check the client return values as well as the imports. ViteHub's `useUpload()`
returns an array by default. Set `{ multiple: false }` when the caller expects
one uploaded object. Multipart options use `concurrency` instead of NuxtHub's
`concurrent`. Update the multipart client and server together because their
request and response formats differ.

Multipart uploads work with the `fs`, `cloudflare-r2` (binding), and
`vercel-blob` drivers. Direct `PUT` uploads with `blob.sign()` on Cloudflare
also require `accountId`, `accessKeyId`, `secretAccessKey`, and `bucketName`
at runtime; an R2 binding alone cannot sign requests. To serve files without a
route of your own, set `blob: { serve: true }`.

## Move the database

ViteHub uses Drizzle, so your table definitions do not change. Move them from
`server/db/schema.ts` into a Database Definition at
`server/databases/config.ts`.

```ts [server/databases/config.ts]
import { defineDatabase } from "vite-hub/database"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export default defineDatabase({
  cloudflare: {
    binding: "DB",
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    databaseName: process.env.CLOUDFLARE_D1_DATABASE_NAME,
  },
  schema: {
    users: sqliteTable("users", {
      id: integer("id").primaryKey(),
      name: text("name").notNull(),
    }),
  },
})
```

Replace the `@nuxthub/db` import with `useDatabase()`. Queries do not change.

```diff [server/api/users.get.ts]
-import { db, schema } from "@nuxthub/db"
+import { useDatabase } from "vite-hub/database/drizzle"

 export default defineEventHandler(async () => {
+  const { db, schema } = useDatabase("default")
   return await db.select().from(schema.users)
 })
```

### Migrations

NuxtHub generates SQL files in `server/db/migrations/<dialect>/` and records them in the
`_hub_migrations` table. ViteHub generates migrations next to the Database
Definition, in `server/databases/migrations/`. It applies them with drizzle-kit
for SQLite and libSQL, and with Wrangler for Cloudflare D1. These runners use
different history tables by default. Do not set Wrangler's history table to
`_hub_migrations` to skip the baseline. NuxtHub's runner records normalized
migration names, while Wrangler records filenames. The same table name does
not make those records compatible.

Inventory schema files, migration directories, and post-migration queries from
Nuxt layers and custom NuxtHub configuration too. Moving only the application's
`server/db/schema.ts` does not include those contributions.

For a new empty SQLite or libSQL database, generate and apply migrations:

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db migrate
```

Do not run these commands unchanged against an existing database. Back it up
first and reconcile its schema and migration history with the new migration
runner. Reading the generated SQL alone does not establish a baseline.
`vitehub db generate --custom` creates a migration you can write by hand.
NuxtHub normally applied migrations during `nuxt dev` and `nuxt build`, but
disabled build-time application for D1 binding deployments. ViteHub does not
apply application migrations during development or builds.
`vitehub db migrate` applies SQLite, libSQL, and D1 HTTP migrations.

### Baseline an existing SQLite database

Stop the old application and back up its database before the switch. NuxtHub's
default local file is `.data/db/sqlite.db`. ViteHub's default is
`.vitehub/data/database/sqlite.db`. Copy the database to the new location while
all database connections are closed, or set `connection.url` in the Definition
to keep the existing location. Preserve SQLite's sidecar files when needed.

Keep the Definition's schema identical to the existing database. Finish pending
NuxtHub migrations first. Start with a new `server/databases/migrations/`
directory and generate a baseline:

```bash [Terminal]
pnpm vitehub db generate --name baseline
```

Compare the generated SQL with the existing tables, columns, indexes, and
constraints. Once they match, replace the entire baseline `.sql` file with
`SELECT 1;`. Keep its filename and the generated `meta/` files unchanged.
Apply the no-op baseline with `pnpm vitehub db migrate`. This records it in
Drizzle's `__drizzle_migrations` table without recreating your tables.

Now change the Definition's schema and run `pnpm vitehub db generate` again.
The next SQL file must contain only the new change. Review it, apply it with
`pnpm vitehub db migrate`, and check the existing rows. Run the command again
to confirm that it does not apply the same migration twice. Keep the SQL and
`meta/` files in version control. The no-op baseline does not create the schema
for a new empty database.

### Baseline an existing Cloudflare D1 database

For a Cloudflare binding deployment, Wrangler applies the SQL migrations.
Install its CLI in the application:

```bash [Terminal]
pnpm add -D wrangler
```

Wrangler's history is separate from NuxtHub's `_hub_migrations`. Before applying
any new migration to an existing D1 database:

1. Back up the existing database. Confirm that `databaseId` and `databaseName`
   in the Definition identify that database.
2. Keep the Definition's schema identical to the deployed schema. Finish any
   pending NuxtHub migrations before the switch. Do not add schema changes yet.
3. Start with a new `server/databases/migrations/` directory, without copied
   NuxtHub SQL files. Run `pnpm vitehub db generate --name baseline` to capture
   the current schema in Drizzle's snapshot and journal.
4. Compare the generated SQL with the existing database. Once every table,
   column, index, and constraint matches, replace the entire generated baseline
   `.sql` file with `SELECT 1;`. Keep its filename and the generated `meta/`
   files unchanged. The baseline must not create existing tables or change data.
5. Run `pnpm nuxt build` to generate `.output/server/wrangler.json`. Check that
   its D1 resource identity and `migrations_dir` refer to the existing database
   and the new directory. ViteHub writes the D1 binding, so you can remove it
   from the project's `wrangler.json`; if you keep it, it must name the same
   database (see [Database hosts](/docs/database/hosts)). Then list the pending
   migrations:

```bash [Terminal]
pnpm wrangler d1 migrations list <database-name> --remote --config .output/server/wrangler.json
```

Only the no-op baseline should be pending. If other migrations appear, stop and
reconcile the directory and Wrangler history before continuing. Record the
baseline in Wrangler's migration history by applying it:

```bash [Terminal]
pnpm wrangler d1 migrations apply <database-name> --remote --config .output/server/wrangler.json
```

Run `migrations list` again to confirm the baseline is recorded. Only then change
the Definition's schema and run `pnpm vitehub db generate` for subsequent
changes. Drizzle compares them with the retained baseline snapshot, so the next
migration contains only those changes. Review that SQL, rebuild, and apply it
with Wrangler. Keep the baseline SQL and `meta/` files in version control.
This no-op baseline is for the existing database; it does not create the schema
for a new empty database. Read [Database](/docs/database).

## Keep the cache

`cachedEventHandler()` and `defineCachedFunction()` come from Nitro, not from
NuxtHub, so they keep working. NuxtHub `hub.cache` selected the storage driver
for Nitro's `cache` mount. In ViteHub, set `cache: true`.

| Preset | Production store |
| --- | --- |
| `cloudflare` | Workers KV binding `CACHE` with an existing namespace ID |
| `vercel` | Vercel Runtime Cache |
| `deno` | Deno KV |
| `node` | `.vitehub/data/cache` |

Development uses `.vitehub/data/cache`, or `<dataDir>/cache` when `dataDir` is
set. Cloudflare requires `cache.namespaceId`, or an existing `CACHE` namespace
with an ID in `nitro.cloudflare.wrangler.kv_namespaces`, so the generated
deployment always names a real namespace. The `netlify` preset has no
default cache store, so `cache: true` fails the build there. A `cache` mount
that you set in `nitro.storage` takes precedence.

To share the app's KV store instead, on any preset, set
`cache: { driver: "kv" }` with `kv` enabled. Cache keys get the `nitro-cache:`
prefix.

To keep the cache namespace that NuxtHub created on Cloudflare, pass its ID:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  vitehub: {
    preset: "cloudflare",
    cache: {
      driver: "cloudflare-kv-binding",
      binding: "CACHE",
      namespaceId: process.env.CLOUDFLARE_CACHE_NAMESPACE_ID,
    },
  },
})
```

## Deploy

ViteHub uses the same Cloudflare binding names as NuxtHub: `DB` for D1, `KV` for
Workers KV, and `BLOB` for R2. Keep each existing resource's identity as well as
its binding: set the D1 `databaseId` and `databaseName`, the KV `namespaceId`
(or `namespaceName` for provisioning), and the R2 `bucketName`. Binding names
alone can point at a new empty resource.

Set these options in `nuxt.config.ts`. Nuxt does not load a separate
`vite.config.ts`.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: {
    preset: "cloudflare",
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
| Cloudflare | Set `preset: "cloudflare"`. Run `pnpm vitehub provision run --provider cloudflare` to resolve the D1 database ID. |
| Vercel | Set `preset: "vercel"`. KV reads `KV_REST_API_URL` and `KV_REST_API_TOKEN`, then `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Blob reads `BLOB_READ_WRITE_TOKEN`. |
| Node | Set `preset: "node"`. KV and Blob use the file system under `.vitehub/data/`. |

Netlify and Deno have their own presets. Read
[Frameworks and hosts](/docs/frameworks-hosts) for the default provider of each
feature.

## Verify the migration

1. Before the switch, record representative database rows, KV values, and Blob
   bytes with their content types and custom metadata.
2. After the switch, call a route for each feature and compare those values.
   Local data does not move automatically. KV uses `fs-lite` in both systems,
   but Blob uses different metadata files. Export Blob bytes and metadata
   through NuxtHub, then write them through ViteHub's `blob.put()`. Re-uploading
   changes upload timestamps and may change URLs or ETags. Keep application
   records of those values if your application needs them.
3. Run `pnpm nuxt build`. A feature that the preset cannot provide fails the build.
4. Run `pnpm vitehub inspect provider-output --json` and confirm resource IDs and
   names, as well as bindings and environment variables.
5. Apply one schema change after the baseline. Confirm that it preserves the
   old rows and that a second migration run makes no further changes.
6. Restart the application and read the same data again.

## Next steps

- Give an Agent the same data with the [KV](/docs/kv/agent-capability), [Blob](/docs/blob/agent-capability), and [Database](/docs/database/agent-capability) Capabilities.
- Read [Server primitives](/docs/getting-started/server-primitives) for Queue, Workflow, Schedule, Auth, and the other APIs that NuxtHub does not provide.

## Related guides

Read [ViteHub vs NuxtHub](/docs/compare/nuxthub) for the current scope and Nuxt
compatibility requirements before choosing a migration.
