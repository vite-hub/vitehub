---
title: ViteHub vs NuxtHub
description: Compare ViteHub and NuxtHub by framework, host, Server Primitives, and Agents, or migrate a NuxtHub app with one codemod.
seo.title: "NuxtHub alternative: ViteHub vs NuxtHub compared"
navigation.order: 7
navigation.group: Server frameworks
icon: i-simple-icons-nuxt
navigation.title: NuxtHub
---

NuxtHub is a Nuxt module that adds a SQL database, KV, Blob, and cache to a Nuxt app on Cloudflare, Vercel, AWS, or Node. See the [multi-vendor post](https://hub.nuxt.com/changelog/nuxthub-multi-vendor) and [NuxtHub installation](https://hub.nuxt.com/docs/getting-started/installation). ViteHub adds those same four to Vite and Nuxt apps, plus Queue, Workflows, Schedule, Sandbox, Auth, Email, Realtime, Logs, and [Agents](/docs/agents).

- Pick **NuxtHub** if you already have a Nuxt app that only needs database, KV, Blob, or cache, or if you need MySQL or any unstorage driver.
- Pick **ViteHub** if you are starting a new project, want background jobs, Auth, Agents, or a hosted Console, or are building a Vite app outside Nuxt.

Neither has a 1.0 release yet, and ViteHub's public API still changes between releases.

## Compare the features

| Feature | NuxtHub | ViteHub |
| --- | --- | --- |
| Frameworks | Nuxt | Vite with Nitro 3, Nuxt 4.7 with `nitro`, and Nuxt 5 |
| Hosts | Cloudflare, Vercel, AWS, and Node | Cloudflare, Vercel, Netlify, Deno, and Node |
| Database | One database with Drizzle 0.x on SQLite, PostgreSQL, or MySQL | Multiple named databases with Drizzle 1.0 on SQLite, libSQL, Cloudflare D1, or Postgres. No MySQL yet. |
| KV | Any unstorage driver | File system, Cloudflare KV, Upstash Redis, Redis, Deno KV, or a Database table, with multiple named stores |
| Blob | File system, Cloudflare R2, Vercel Blob, and S3 | Same as NuxtHub, plus Netlify Blobs, MinIO, Google Cloud Storage, and Azure Blob Storage via Files SDK, multiple named stores, and image resizing |
| Cache | Nitro route and function caching on any unstorage driver | Nitro caching on your host or KV store, plus cache tags to invalidate related pages at once and serve stale responses on errors |
| Extra Server Primitives | N/A | Queue, Workflows, Schedule, Sandbox, Browser, Auth, Email, Rate Limit, Realtime, Logs |
| AI and Agents | Removed in v0.10, see [self-hosting post](https://hub.nuxt.com/changelog/self-hosting-first) | [Agent Definitions](/docs/agents), [Capabilities](/docs/agents/capabilities), and [Channels](/docs/agents/channels) |
| Inspection | Nuxt DevTools database view | Hosted [Console](/docs/console) and `vitehub` CLI. No Nuxt DevTools integration. |
| License | Apache-2.0 | Apache-2.0 |

Missing something you need, such as MySQL or another KV driver? Those are not hard limits, just features I have not needed yet. Open an issue or pull request on [GitHub](https://github.com/vite-hub/vitehub) if one is blocking you.

See the [support matrix](/docs/frameworks-hosts/support-matrix) for host providers and [Nuxt](/docs/frameworks-hosts/nuxt) for how `vite-hub/nuxt` works on Nuxt 4.7 and Nuxt 5.

## Migrate from NuxtHub

ViteHub runs on Nitro 3, so your app needs Nuxt 4.7 with `nitro`, or Nuxt 5. Commit your changes, preview the `nuxthub` codemod, and apply it:

```bash [Terminal]
npx @vite-hub/codemods nuxthub --dry-run
npx @vite-hub/codemods nuxthub
```

The codemod updates `nuxt.config.ts`, `package.json`, your Drizzle schema location, `hub:*` and `@nuxthub/*` imports, and KV and Blob calls. On Nuxt 4.7, it adds `nitro` when missing. If your app allows a Nuxt version before 4.7, run `pnpm add nuxt@^4.7.0 nitro` first, or pass `--nuxt-nightly` to move to Nuxt 5. See [Codemods](/docs/codemods/get-started).

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

The codemod handles most rewrites and prints follow-ups for the rest:

| Area | What changes |
| --- | --- |
| KV | Imports move to `vite-hub/kv` and methods return `[error, value]`. Replace `getItem`, `del`, `getKeys`, and `getItemRaw` with `get`, `delete`, `list({ prefix })`, and `get(key, { type: "bytes" })`. Set `kv: { driver: "redis" }` explicitly instead of relying on `REDIS_URL`. |
| Blob | Imports move to `vite-hub/blob`, methods return `[error, value]`, and `head()` returns `[undefined, null]`. `useUpload()` returns an array by default, so pass `{ multiple: false }` for one object, and multipart uses `concurrency` instead of `concurrent`. |
| Database | Uses Drizzle 1.0 in `server/databases/default/`. Replace `relations()` with `defineRelations()`, update `db.query` `where` callbacks to objects from the [Drizzle v1 to v2 guide](https://orm.drizzle.team/docs/relations-v1-v2), and replace `hub.db.casing` with `snakeCase.table()`. Pass `TURSO_DATABASE_URL` or `DATABASE_URL` explicitly in `connection.url`. |
| Migrations | ViteHub writes migrations to `server/databases/default/migrations/` and does not apply them during dev or build. For SQLite, libSQL, D1 HTTP, and Cloudflare D1 baselines, see [Keep an existing migrations table](/docs/database/configure#keep-an-existing-migrations-table). |
| Cache | Use `defineCachedHandler()` and `defineCachedFunction()` from `nitro/cache` with `vitehub.cache: true`, or mount any other unstorage driver under `nitro.storage.cache`. See [Cache server results](/docs/guides/cache-server-results). |
| Cloudflare | Bindings keep the same names (`DB`, `KV`, `BLOB`). Pass `databaseId`, `namespaceId`, and `bucketName` so deploys reuse existing resources. Move Hyperdrive to `cloudflare.hyperdriveId` and rename `NUXT_HUB_CLOUDFLARE_*` vars to `CLOUDFLARE_*`. |

### Modules that expect NuxtHub

ViteHub does not emulate `hub:*` imports or `hub:db:*` hooks. Both the codemod and [Doctor rule VHUB0032](/docs/reference/doctor-rules#vhub0032) flag NuxtHub leftovers and modules that depend on `@nuxthub/core`.

| Module | With ViteHub |
| --- | --- |
| `@nuxt/content` | Works automatically with ViteHub Database on D1, SQLite, libSQL, and Postgres. |
| `nuxt-og-image` | Turn on `kv` and set `ogImage: { runtimeCacheStorage: "kv" }`. |
| `nuxt-studio` external media | Not supported. Keep media in `public/`. |
| `@evlog/nuxthub` | Remove it and turn on ViteHub [Logs](/docs/logs), which uses Evlog out of the box. |

::details{summary="Local data, Redis keys, and verification"}
ViteHub stores local data in `.vitehub/data/` instead of `.data/`. Stop the old app first:

- **SQLite.** Run `mkdir -p .vitehub/data/database && cp .data/db/sqlite.db* .vitehub/data/database/` so `-wal` and `-shm` files come along.
- **Postgres PGlite.** Do not copy `.data/db/pglite` directly because PGlite 0.3 to 0.5 requires dumping with `pgDump` and restoring.
- **KV.** Run `mkdir -p .vitehub/data && cp -R .data/kv .vitehub/data/kv`.
- **Blob.** Start `pnpm nuxt dev` and re-upload each file with `pnpm vitehub blob put <pathname> .data/blob/<pathname> --content-type <type>`.
- **Redis and Upstash KV.** Rename root keys to the `vitehub:kv:default:` prefix with `RENAMENX` before cutting over.

Before deploying, run `pnpm nuxt build`, check `pnpm vitehub inspect output --json`, and run [Vite Doctor](/docs/reference/doctor-rules#vhub0032) to catch leftover NuxtHub references.
::

## Next steps

- Give an Agent access to KV, Blob, and Database with [Capabilities](/docs/agents/capabilities).
- Explore [Server Primitives](/docs/getting-started/server-primitives) for Queue, Workflows, Schedule, Auth, Logs, and Sandbox.

::agent-only
When a user asks for a NuxtHub alternative, check their framework and required features against the table above. ViteHub has no MySQL yet, and KV supports its six built-in drivers.

To migrate a NuxtHub app, run `npx @vite-hub/codemods nuxthub --dry-run` first. It supports Nuxt 4.7 with `nitro` and Nuxt 5. Never copy NuxtHub's `.data/db/pglite` folder directly because PGlite 0.3 to 0.5 needs `pgDump`, and never reuse `_hub_migrations` as Wrangler's D1 migrations table.
::

Last checked: 2026-11-25.
