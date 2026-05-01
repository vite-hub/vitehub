---
title: DB troubleshooting
description: Diagnose missing schema files, unconfigured database entries, hosted output failures, and Cloudflare D1 metadata issues.
navigation.title: Troubleshooting
navigation.order: 100
icon: i-lucide-wrench
frameworks: [vite]
---

Use this page by symptom. Each section gives the likely cause, the fix, and a quick verification step.

## `No Drizzle schema files found`

**Cause:** The Vite plugin is enabled, but the default database has no discovered schema files.

ViteHub looks for:

- `src/db/schema.ts`
- TypeScript or JavaScript files in `src/db/schema/`
- files listed in `db.drizzle.schemaPaths`

**Fix:** Add a default schema file or configure an explicit schema path:

```ts [src/db/schema.ts]
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
})
```

**Verify:** Restart Vite. The config error should be gone.

## `@vitehub/db/drizzle` requires `hubDb()`

**Cause:** Runtime code imported `@vitehub/db/drizzle`, but the Vite plugin did not register DB or DB was disabled with `db: false`.

**Fix:** Register the plugin:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubDb } from '@vitehub/db/vite'

export default defineConfig({
  plugins: [hubDb()],
})
```

**Verify:** Restart Vite, then call the route again. A database connection error means the runtime import is now wired.

## `Database "analytics" is not configured`

**Cause:** Route code uses `databases.analytics`, but `db.databases.analytics` is not configured.

**Fix:** Add the named database:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubDb()],
  db: {
    databases: {
      analytics: {},
    },
  },
})
```

**Verify:** Restart Vite. `databases.analytics` should expose `{ db, schema }`.

## `Database "analytics" requires a Cloudflare D1 binding or db.connection.url`

**Cause:** The database entry has no active D1 binding and no fallback libSQL URL.

This often happens when a named database is configured as D1-only and the route runs outside Cloudflare.

**Fix:** Run inside Cloudflare with the configured binding, or add a fallback URL:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubDb()],
  db: {
    databases: {
      analytics: {
        connection: {
          authToken: process.env.TURSO_AUTH_TOKEN,
          url: process.env.TURSO_ANALYTICS_DATABASE_URL,
        },
        cloudflare: {
          binding: 'DB_ANALYTICS',
          databaseName: 'vitehub-analytics',
          databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,
        },
      },
    },
  },
})
```

**Verify:** Restart the runtime with the environment variables available, then call the route again.

## Vercel output requires a remote libSQL URL

**Cause:** A database that should be bundled into Vercel output only has a local SQLite URL or Cloudflare D1 metadata.

Vercel cannot run Cloudflare D1 bindings or local `file:` SQLite paths.

**Fix:** Configure `connection.url` with a remote libSQL URL for every database that should run on Vercel:

```ts
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
    },
  },
}
```

**Verify:** Re-run `vite build`. The Vercel output error should be gone.

## Cloudflare output requires `databaseId` or a remote fallback URL

**Cause:** Cloudflare hosted output includes a database entry that has neither `cloudflare.databaseId` nor a remote libSQL fallback URL.

**Fix:** Add D1 metadata or a remote fallback:

```ts
db: {
  cloudflare: {
    binding: 'DB',
    databaseName: 'vitehub-notes',
    databaseId: process.env.VITEHUB_D1_DATABASE_ID,
  },
}
```

**Verify:** Re-run `vite build` with `VITEHUB_D1_DATABASE_ID` set.

## Cloudflare output requires `databaseName`

**Cause:** `cloudflare.databaseId` is set, but `cloudflare.databaseName` is missing.

Wrangler requires both values in generated `d1_databases` entries.

**Fix:** Add the database name next to the ID:

```ts
db: {
  cloudflare: {
    binding: 'DB',
    databaseName: 'vitehub-notes',
    databaseId: process.env.VITEHUB_D1_DATABASE_ID,
  },
}
```

**Verify:** Re-run `vite build` and inspect generated `wrangler.json`.
