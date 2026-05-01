---
title: DB
description: Use one default Drizzle database and optional named databases from Vite server code, with Cloudflare D1 bindings or hosted libSQL connections.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-database
frameworks: [vite]
---

`@vitehub/db` gives Vite apps a default Drizzle database plus optional named databases behind one runtime import.

Use DB when route code needs joins, relations, transactional writes, or multiple durable datasets that should keep different schema and migration boundaries.

::code-group
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubDb } from '@vitehub/db/vite'

export default defineConfig({
  plugins: [hubDb()],
  db: {
    connection: {
      authToken: process.env.TURSO_AUTH_TOKEN,
      url: process.env.TURSO_DATABASE_URL,
    },
    databases: {
      analytics: {
        connection: {
          authToken: process.env.TURSO_AUTH_TOKEN,
          url: process.env.TURSO_ANALYTICS_DATABASE_URL,
        },
        cloudflare: {
          databaseName: 'vitehub-playground-analytics',
          databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,
        },
      },
    },
  },
})
```

```ts [src/server.db.ts]
import { databases, db, schema } from '@vitehub/db/drizzle'

await db.insert(schema.notes).values({ title: 'hello' })
await databases.analytics.db.insert(databases.analytics.schema.analyticsEvents).values({ name: 'page-view' })
```
::

## Default And Named Databases

ViteHub resolves database config in two layers:

1. Top-level `db.connection`, `db.drizzle`, and `db.cloudflare` configure the default database.
2. `db.databases.<name>` adds named databases with their own connection, schema, migration, and Cloudflare binding config.

The runtime surface stays small:

- `db` and `schema` alias `databases.default`.
- `databases.default` is the canonical default entry.
- `databases.<name>` exposes `{ db, schema }` for each named database.

## Default Conventions

Without overrides, ViteHub uses these defaults:

| Database | Local URL | Schema discovery | Migrations dir | Cloudflare binding |
| --- | --- | --- | --- | --- |
| `default` | `file:.data/db/sqlite.db` | `src/db/schema.ts` and `src/db/schema/*` | `src/db/migrations` | `DB` |
| `analytics` | `file:.data/db/analytics.sqlite.db` | `src/db/analytics/schema.ts` and `src/db/analytics/schema/*` | `src/db/analytics/migrations` | `DB_ANALYTICS` |

If a named entry sets Cloudflare D1 metadata and omits `connection.url`, ViteHub treats it as D1-only.

## Provider Behavior

Cloudflare and Vercel do not share the same database runtime rules:

- Cloudflare hosted output can resolve an active D1 binding first, then fall back to a remote libSQL URL when one is configured.
- Vercel hosted output requires a remote libSQL URL for every database that must run there.
- Local Vite runtime can use file-based SQLite paths for the default or named databases.

## Next Steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Runtime API
  description: Review the config contract and the `db`, `schema`, and `databases` exports.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Cloudflare D1
  description: Configure bindings, generated `wrangler.json` output, and D1-only entries.
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Use hosted libSQL URLs and understand the hosted URL requirement for Vercel output.
  to: ./providers/vercel
  ---
  :::
::
