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
| `db` and `schema` from `@nuxthub/db` | `useDatabase()` from `vite-hub/database/drizzle` | Drizzle in both. ViteHub supports SQLite, libSQL, and Cloudflare D1. |
| `hub.db: 'postgresql'` | `dialect: "postgresql"` | See [Postgres configuration](/docs/database/configure#define-a-postgres-database). The baseline steps below cover SQLite and D1. |
| `hub.db: 'mysql'` | Not supported | Keep NuxtHub or Drizzle for MySQL. |
| `hub.cache` | `cache` option | Mounts Nitro's `cache` storage on the preset's store. `cachedEventHandler` and `defineCachedFunction` still work. |
| `handleUpload`, multipart helpers, `useUpload`, `useMultipartUpload` | Same names on `blob` and in `vite-hub/blob/vue` | Methods return `[error, value]`. Multipart works with `fs`, `cloudflare-r2` (binding), and `vercel-blob`. |
| `hosting` auto-detection | `preset` | You select the host. |
| `.data/` | `.vitehub/data/` | Local data does not move by itself. |
| Auto-imported `kv`, `blob`, `db`, `schema` | Auto-imported in Nuxt server code | Added for each enabled feature when Nitro auto-imports are on. Explicit imports also work. |

NuxtHub v0.10 removed `hubAI()`, AutoRAG, Vectorize, and `hubBrowser()`.
ViteHub has no AI or Vectorize feature either. For browser work on Cloudflare,
see [Browser](/docs/browser).

## Replace the module

Use Nuxt 5. It is only in nightly builds for now: `pnpm add nuxt@npm:nuxt-nightly@5x`. Use pnpm 11.5 or newer; older versions can hang when they resolve this nightly alias. Remove `@nuxthub/core` and install ViteHub.

```bash [Terminal]
pnpm remove @nuxthub/core
pnpm add vite-hub
```

For Database, add the Database package and `drizzle-orm` as a direct
dependency, because your schema imports it. Add `drizzle-kit` for migration
commands.

```bash [Terminal]
pnpm add @vite-hub/database drizzle-orm
pnpm add -D drizzle-kit
```

Early NuxtHub v0.10 releases use `hub:db`, `hub:kv`, and `hub:blob` imports.
Replace them like the newer `@nuxthub/*` imports below.

Replace the NuxtHub module with `vite-hub/nuxt` and rename the `hub` key to
`vitehub`. Add a [deployment preset](/docs/frameworks-hosts#choose-a-preset).
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
+    preset: "cloudflare",
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

`get`, `set`, `has`, `del`, `keys`, and `clear` keep their names. NuxtHub also
has other unstorage methods. Check those calls against ViteHub's
[server API](/docs/kv/server-api) before you remove NuxtHub. `set` passes
options such as `ttl` to the store driver, so TTL support depends on the
driver. See [KV](/docs/kv) for named stores and paginated `list()`.

## Move Blob calls

Import `blob` from `vite-hub/blob`. `put`, `get`, `head`, `list`, `del`, and
`serve` keep their names, and `put` takes the same `contentType`, `prefix`,
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

ViteHub uses Drizzle, so your tables do not change. Move them from
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

NuxtHub writes SQL files to `server/db/migrations/<dialect>/` and records them
in the `_hub_migrations` table. ViteHub writes migrations next to the Database
Definition, in `server/databases/migrations/`. It applies them with drizzle-kit
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
pnpm vitehub db generate
pnpm vitehub db migrate
```

::warning
Do not run these commands as-is on an existing database. Back it up first, and
match its schema and migration history to the new runner. Reading the
generated SQL alone does not create a baseline.
::

`vitehub db generate --custom` creates a migration you write by hand. NuxtHub
applied migrations during `nuxt dev` and `nuxt build`, except at build time for
D1 binding deployments. ViteHub never applies app migrations during
development or builds. `vitehub db migrate` applies SQLite, libSQL, and D1
HTTP migrations.

### Baseline an existing SQLite database

Stop the old app and back up its database. NuxtHub's default local file is
`.data/db/sqlite.db`; ViteHub's is `.vitehub/data/database/sqlite.db`. Copy
the database while all connections are closed, or set `connection.url` in the
Definition to keep the old location. Keep SQLite's sidecar files when needed.

Keep the Definition's schema identical to the existing database, and finish
pending NuxtHub migrations first. Start a new `server/databases/migrations/`
directory and generate a baseline:

```bash [Terminal]
pnpm vitehub db generate --name baseline
```

Compare the generated SQL with the existing tables, columns, indexes, and
constraints. When they match, replace the whole baseline `.sql` file with
`SELECT 1;`. Keep its filename and the `meta/` files unchanged. Apply the
no-op baseline with `pnpm vitehub db migrate`. It is recorded in Drizzle's
`__drizzle_migrations` table, and your tables are not recreated.

Now change the Definition's schema and run `pnpm vitehub db generate` again.
The next SQL file must hold only the new change. Review it, apply it with
`pnpm vitehub db migrate`, and check the existing rows. Run the command again
to confirm it does not apply the migration twice. Commit the SQL and `meta/`
files. The no-op baseline does not create the schema for a new empty database.

### Baseline an existing Cloudflare D1 database

For a Cloudflare binding deployment, Wrangler applies the SQL migrations.
Install its CLI in the app:

```bash [Terminal]
pnpm add -D wrangler
```

Wrangler's history is separate from NuxtHub's `_hub_migrations`. Before you
apply any new migration to an existing D1 database:

1. Back up the database. Confirm that `databaseId` and `databaseName` in the
   Definition name that database.
2. Keep the Definition's schema identical to the deployed schema. Finish
   pending NuxtHub migrations first. Do not add schema changes yet.
3. Start a new `server/databases/migrations/` directory with no copied NuxtHub
   SQL files. Run `pnpm vitehub db generate --name baseline` to save the
   current schema in Drizzle's snapshot and journal.
4. Compare the generated SQL with the database. When every table, column,
   index, and constraint matches, replace the whole baseline `.sql` file with
   `SELECT 1;`. Keep its filename and the `meta/` files unchanged. The baseline
   must not create existing tables or change data.
5. Run `pnpm nuxt build` to generate `.output/server/wrangler.json`. Check that
   its D1 resource identity and `migrations_dir` point to the existing database
   and the new directory. ViteHub writes the D1 binding, so you can remove it
   from the project `wrangler.json`. If you keep it, it must name the same
   database (see [Database hosts](/docs/database/hosts)). Then list the pending
   migrations:

```bash [Terminal]
pnpm wrangler d1 migrations list <database-name> --remote --config .output/server/wrangler.json
```

Only the no-op baseline should be pending. If others appear, stop and fix the
directory and Wrangler history first. Apply the baseline to record it in
Wrangler's history:

```bash [Terminal]
pnpm wrangler d1 migrations apply <database-name> --remote --config .output/server/wrangler.json
```

Run `migrations list` again to confirm the baseline is recorded. Only then
change the Definition's schema and run `pnpm vitehub db generate`. Drizzle
compares against the baseline snapshot, so the next migration holds only your
changes. Review that SQL, rebuild, and apply it with Wrangler. Commit the
baseline SQL and `meta/` files. This baseline does not create the schema for a
new empty database. See [Database](/docs/database).

## Keep the cache

`cachedEventHandler()` and `defineCachedFunction()` come from Nitro, not
NuxtHub, so they still work. NuxtHub's `hub.cache` picked the driver for
Nitro's `cache` mount. In ViteHub, set `cache: true`.

| Preset | Production store |
| --- | --- |
| `cloudflare` | Workers KV binding `CACHE` with an existing namespace ID |
| `vercel` | Vercel Runtime Cache |
| `deno` | Deno KV |
| `node` | `.vitehub/data/cache` |

- Development uses `.vitehub/data/cache`, or `<dataDir>/cache` when `dataDir` is set.
- Cloudflare needs `cache.namespaceId`, or an existing `CACHE` namespace with an id in `nitro.cloudflare.wrangler.kv_namespaces`, so the deployment always names a real namespace.
- The `netlify` preset has no default cache store, so `cache: true` fails the build there.
- A `cache` mount you set in `nitro.kv` (`nitro.storage` in Nuxt) wins.

To share the app's KV store instead, on any preset, set `cache: { driver: "kv" }`
with `kv` on. Cache keys get the `nitro-cache:` prefix.

To keep the cache namespace NuxtHub created on Cloudflare, pass its id:

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
| Vercel | Set `preset: "vercel"`. KV reads `KV_REST_API_URL` and `KV_REST_API_TOKEN`, then `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Blob uses OIDC with `BLOB_STORE_ID`, then `BLOB_READ_WRITE_TOKEN`. |
| Node | Set `preset: "node"`. KV and Blob use the file system under `.vitehub/data/`. |

Netlify and Deno have their own presets. See
[Frameworks and hosts](/docs/frameworks-hosts) for each feature's default
provider.

## Verify the migration

1. Before the switch, record sample database rows, KV values, and Blob bytes
   with their content types and custom metadata.
2. After the switch, call a route for each feature and compare those values.
   Local data does not move by itself. KV uses `fs-lite` in both, but Blob uses
   different metadata files. Export Blob bytes and metadata through NuxtHub,
   then write them with ViteHub's `blob.put()`. Re-uploading changes upload
   timestamps and may change URLs or ETags. Save those values if your app needs
   them.
3. Run `pnpm nuxt build`. A feature the preset cannot provide fails the build.
4. Run `pnpm vitehub inspect provider-output --json` and confirm resource ids,
   names, bindings, and environment variables.
5. Apply one schema change after the baseline. Confirm it keeps the old rows
   and that a second migration run changes nothing.
6. Restart the app and read the same data again.

## Next steps

- Give an Agent the same data with the [KV](/docs/kv/agent-capability), [Blob](/docs/blob/agent-capability), and [Database](/docs/database/agent-capability) Capabilities.
- Read [Server primitives](/docs/getting-started/server-primitives) for Queue, Workflow, Schedule, Auth, and the other APIs that NuxtHub does not provide.

## Related guides

Read [ViteHub vs NuxtHub](/docs/compare/nuxthub) for the current scope and Nuxt
requirements before you migrate.
