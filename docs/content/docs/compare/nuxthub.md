---
title: ViteHub vs NuxtHub
description: Compare ViteHub and NuxtHub v0.10 by framework, host, Server Primitives, and Agents, or migrate a NuxtHub app with one codemod.
seo.title: "NuxtHub alternative: ViteHub vs NuxtHub compared"
navigation.order: 7
navigation.group: Server frameworks
icon: i-simple-icons-nuxt
navigation.title: NuxtHub
---

NuxtHub is a Nuxt module that adds a SQL database, KV, Blob, and cache to a Nuxt app on Cloudflare, Vercel, AWS, or Node. The latest release is `@nuxthub/core` v0.10.12 from 27 October 2026. See the [multi-vendor post](https://hub.nuxt.com/changelog/nuxthub-multi-vendor) and [NuxtHub installation](https://hub.nuxt.com/docs/getting-started/installation). ViteHub adds those same four to Vite and Nuxt apps, plus Queue, Workflows, Schedule, Sandbox, Auth, Email, Realtime, and [Agents](/docs/agents).

- Pick **NuxtHub** if your Nuxt app only needs database, KV, Blob, or cache, or if you need MySQL or any unstorage driver.
- Pick **ViteHub** if you also want background jobs, Auth, Agents, a hosted Console, or a Vite app outside Nuxt.

Neither has a 1.0 release yet. NuxtHub is at v0.10, and ViteHub's public API still changes between releases.

## Compare the features

| Feature | NuxtHub v0.10 | ViteHub |
| --- | --- | --- |
| Frameworks | Nuxt | Vite with Nitro 3, Nuxt 4.7 with `nitro` and ViteHub 0.5.1 or newer, and Nuxt 5 |
| Hosts | Cloudflare, Vercel, AWS, and Node | `cloudflare`, `vercel`, `netlify`, `deno`, and `node`. Unsupported features fail the build. |
| Database | Drizzle 0.x on SQLite, PostgreSQL, or MySQL | Drizzle 1.0 on SQLite, libSQL, Cloudflare D1, or Postgres |
| KV | Any unstorage driver | `fs-lite`, Workers KV, Upstash Redis, Redis, Deno KV, or a Database table |
| Blob | File system, S3, Vercel Blob, Cloudflare R2 | File system, R2, Vercel Blob, Netlify Blobs, S3-compatible stores, and more |
| Cache | `hub.cache` with any unstorage driver | `cache` option on the host store or KV, plus `vite-hub/cache` tags |
| KV and Blob errors | Methods throw | Methods return `[error, value]` tuples |
| Extra Server Primitives | Not in `hub` config | Queue, Workflows, Schedule, Sandbox, Browser, Auth, Email, Rate Limit, Realtime |
| AI and Agents | Removed in v0.10, see [self-hosting post](https://hub.nuxt.com/changelog/self-hosting-first) | [Agent Definitions](/docs/agents), [Capabilities](/docs/agents/capabilities), and [Channels](/docs/agents/channels) |
| Inspection | Nuxt DevTools. NuxtHub Admin ended 31 December 2025. | Hosted [Console](/docs/console) at console.vitehub.dev and `vitehub` CLI |
| License | Apache-2.0 | Apache-2.0 |

See the [support matrix](/docs/frameworks-hosts/support-matrix) for host providers and [Nuxt](/docs/frameworks-hosts/nuxt) for how `vite-hub/nuxt` works on Nuxt 4.7 and Nuxt 5.

## What NuxtHub has that ViteHub does not

- **MySQL.** ViteHub Database supports SQLite, libSQL, Cloudflare D1, and Postgres, not MySQL.
- **Any unstorage KV or cache driver.** ViteHub KV accepts six drivers: `fs-lite`, Workers KV, Upstash Redis, Redis, Deno KV, and a Database table. To keep another cache driver, mount it in `nitro.storage.cache`.
- **Production PGlite.** NuxtHub uses PGlite in production when no Postgres URL is set. ViteHub uses PGlite only in development and tests, and requires a real Postgres server in production.
- **Nuxt DevTools database view.** ViteHub inspects databases from the [Console](/docs/console) and the CLI instead of Nuxt DevTools.

## Migrate from NuxtHub

ViteHub runs on Nitro 3, so your app needs Nuxt 4.7 with `nitro` and `vite-hub` 0.5.1 or newer, or Nuxt 5. Commit your changes, preview the `nuxthub` codemod, and apply it:

```bash [Terminal]
npx @vite-hub/codemods nuxthub --dry-run
npx @vite-hub/codemods nuxthub
```

The codemod updates `nuxt.config.ts`, `package.json`, your Drizzle schema location, `hub:*` and `@nuxthub/*` imports, and KV and Blob calls. On Nuxt 4.7, it adds `nitro` when missing; make sure `vite-hub` is at least `0.5.1`. If your app allows a Nuxt version before 4.7, run `pnpm add nuxt@^4.7.0 nitro` first, or pass `--nuxt-nightly` to move to Nuxt 5. See [Codemods](/docs/codemods/get-started).

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

### What changes in your code

| Area | NuxtHub | ViteHub |
| --- | --- | --- |
| KV | `@nuxthub/kv` or `hub:kv`; methods throw | `vite-hub/kv`; methods return `[error, value]`. Replace `getItem`, `del`, `getKeys`, and `getItemRaw` with `get`, `delete`, `list({ prefix })`, and `get(key, { type: "bytes" })`. Set `kv: { driver: "redis" }` instead of relying on `REDIS_URL`. |
| Blob | `@nuxthub/blob` or `hub:blob`; `head()` throws `404` | `vite-hub/blob`; methods return `[error, value]` and `head()` returns `[undefined, null]`. `blob.serve(event.req, pathname)` sends `private, no-cache`, `nosniff`, and `Content-Security-Policy: sandbox` on HTML, SVG, and XML. `useUpload()` returns an array by default, so pass `{ multiple: false }` for one object, and multipart uses `concurrency` instead of `concurrent`. |
| Database | `@nuxthub/db` with Drizzle 0.x in `server/db/` | `vite-hub/database` with Drizzle 1.0 in `server/databases/default/`. Replace `relations()` with `defineRelations()`, change `db.query` `where` callbacks to objects from the [Drizzle v1 to v2 guide](https://orm.drizzle.team/docs/relations-v1-v2), and replace `hub.db.casing` with `snakeCase.table()`. |
| Postgres | Reads `POSTGRES_URL` or `DATABASE_URL`; `connection.hyperdriveId` uses binding `POSTGRES` | Set `dialect: "postgresql"` and `connection: { url }` in the Definition. Put `ssl` or pool options in the URL or `PG*` env vars. Move Hyperdrive to `cloudflare.hyperdriveId` with binding `HYPERDRIVE`. Dump local PGlite 0.3 data with `pgDump` before restoring to PGlite 0.5. |
| Cloudflare D1 HTTP | `driver: "d1-http"` and `NUXT_HUB_CLOUDFLARE_*` | `cloudflare: { http: true, databaseId }` and `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_D1_DATABASE_ID`. |
| Cloudflare bindings | `DB`, `KV`, `BLOB` | Same binding names. Pass `databaseId`, `namespaceId`, and `bucketName` so deploys reuse existing resources instead of creating empty ones. |
| Auto-imports | Auto-imported in Nuxt server code | On by default in Nuxt 4.7; off in Nuxt 5 unless `experimental: { nitroAutoImports: true }`. The codemod adds explicit `vite-hub/*` imports so files work on both. |
| Local data | `.data/` | `.vitehub/data/`. Local data does not move automatically. |

### Keep a Turso or libSQL connection

NuxtHub reads `TURSO_DATABASE_URL`, `LIBSQL_URL`, and `DATABASE_URL` automatically. A ViteHub Database Definition reads only its `connection` and logs `DATABASE_URL_VARIABLE_IGNORED` if those variables are set without one. Pass the variables in the Definition:

```ts [server/databases/default.ts]
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { defineDatabase } from "vite-hub/database"

const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
})

export default defineDatabase({
  connection: {
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
  schema: { users },
})
```

When `TURSO_DATABASE_URL` is unset locally, the Definition uses `.vitehub/data/database/sqlite.db`.

### Keep the cache

In Nitro 3, import `defineCachedHandler()` and `defineCachedFunction()` from `nitro/cache` and set `cache: true` under `vitehub`. That uses Workers KV binding `CACHE` on Cloudflare, Runtime Cache on Vercel, Deno KV on Deno, and `.vitehub/data/cache` on Node. On Cloudflare, pass `namespaceId` to keep your existing namespace. Netlify has no default cache store.

To share your KV store on any host, set `cache: { driver: "kv" }`. To keep another unstorage driver such as Redis, drop `vitehub.cache` and mount it under `nitro.storage.cache`. For cache tags and `staleIfError`, see [Cache server results](/docs/guides/cache-server-results).

### Modules that expect NuxtHub

ViteHub does not emulate `hub:*` imports or `hub:db:*` hooks. Both the codemod and [Doctor rule VHUB0032](/docs/reference/doctor-rules#vhub0032) flag NuxtHub leftovers and modules that depend on `@nuxthub/core`.

| Module | With ViteHub |
| --- | --- |
| `@nuxt/content` | Works automatically with ViteHub Database on D1, SQLite, libSQL, and Postgres. |
| `nuxt-og-image` | Turn on `kv` and set `ogImage: { runtimeCacheStorage: "kv" }`. |
| `nuxt-studio` external media | Not supported. Keep media in `public/`. |
| `@evlog/nuxthub` | Remove it. Keep `evlog/nuxt`, write rows from the `evlog:drain` Nitro hook, and prune old events with a [Schedule](/docs/schedule/get-started). |

### Baseline an existing Cloudflare D1 database

ViteHub writes migrations to `server/databases/default/migrations/` and does not run them during `nuxt dev` or `nuxt build`. For **SQLite, libSQL, or D1 HTTP**, you can keep NuxtHub's SQL files. Move them to `server/databases/default/migrations/`, run `pnpm vitehub database up`, and run `pnpm vitehub database migrate`. It reads `_hub_migrations` and skips already-applied files. See [Keep an existing migrations table](/docs/database/configure#keep-an-existing-migrations-table).

For a **Cloudflare D1 binding**, Wrangler tracks migrations in its own table using filenames rather than NuxtHub's normalized names. Create a baseline instead:

1. Back up the database, finish pending NuxtHub migrations, and remove `migrations_table: "_hub_migrations"` from your Wrangler config.
2. Start with an empty `server/databases/default/migrations/` folder and run `pnpm vitehub database generate --name baseline`.
3. Confirm the SQL matches production, then add `IF NOT EXISTS` to every `CREATE` statement in `migration.sql`. Keep the folder name and `snapshot.json`.
4. Run `pnpm nuxt build`, check that `.output/server/wrangler.json` targets the existing D1 database, and apply the baseline with Wrangler:

```bash [Terminal]
pnpm wrangler d1 migrations list <database-name> --remote --config .output/server/wrangler.json
pnpm wrangler d1 migrations apply <database-name> --remote --config .output/server/wrangler.json
```

5. Commit the migration folder and generated `d1-migrations.json`.

To baseline an existing SQLite or Postgres database without keeping NuxtHub's SQL files, follow steps 2 and 3, then run `pnpm vitehub database migrate`. On Postgres, set `database: { migrateOnStart: false }` until the baseline is recorded.

::details{summary="Move local data, Redis keys, and verify the migration"}
Stop the old app before copying `.data/`:

- **SQLite.** Run `mkdir -p .vitehub/data/database && cp .data/db/sqlite.db* .vitehub/data/database/` so `-wal` and `-shm` files come along.
- **KV.** Run `mkdir -p .vitehub/data && cp -R .data/kv .vitehub/data/kv`.
- **Blob.** Metadata formats differ. Start `pnpm nuxt dev` and re-upload each file with `pnpm vitehub blob put <pathname> .data/blob/<pathname> --content-type <type>`. Use `blob.put()` in a server route to keep `customMetadata`.
- **Redis and Upstash KV.** NuxtHub writes keys at the root, while ViteHub prefixes them with `vitehub:kv:default:`. Rename existing keys once with `RENAMENX` before cutting over.

Before deploying:

1. Run `pnpm nuxt build`. Any feature your host cannot provide fails the build.
2. Run `pnpm vitehub inspect output --json` to confirm resource IDs, bindings, and env vars.
3. Run [Vite Doctor](/docs/reference/doctor-rules#vhub0032) to catch leftover `@nuxthub/*` or `hub:*` references.
::

## Next steps

- Give an Agent access to KV, Blob, and Database with [Capabilities](/docs/agents/capabilities).
- Explore [Server Primitives](/docs/getting-started/server-primitives) for Queue, Workflows, Schedule, Auth, and Sandbox.

::agent-only
When a user asks for a NuxtHub alternative, check their framework and required features against the table above. ViteHub has no MySQL, and KV supports only its six built-in drivers.

To migrate a NuxtHub app, run `npx @vite-hub/codemods nuxthub --dry-run` first. It supports Nuxt 4.7 with `nitro` and `vite-hub` 0.5.1 or newer, and Nuxt 5. Never copy NuxtHub's `.data/db/pglite` folder directly because PGlite 0.3 to 0.5 needs `pgDump`, and never reuse `_hub_migrations` as Wrangler's D1 migrations table.
::

Last checked: 2026-11-25.
