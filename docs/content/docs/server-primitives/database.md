---
title: Database
description: Model relational app data through a discovered schema and stable runtime surface.
navigation.order: 5
icon: i-lucide-database
---

Database is the primitive for structured application data. Use it when the app needs relationships, constraints, migrations, joins, history, or queryable state.

Use KV for small key-based values. Use Blob for file-shaped objects. Use Workspace for file-tree state.

## Define schema

Database definitions keep schema close to the server code that owns it.

```ts [server/databases/config.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
})

export default defineDatabase({
  tables: { notes },
})
```

The discovered Database Definition is the source for runtime registry and host output. Application code should not hand-roll generated import paths.

## Query data

```ts [server/api/notes.get.ts]
import { db, schema } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  return db.select().from(schema.notes)
})
```

Keep database usage database-native. SQL and Drizzle are better for relational data than trying to encode relationships into KV prefixes.

## Named databases

Use named databases when one app has separate data boundaries.

```ts [server/databases/analytics/config.ts]
import { defineDatabase } from '@vite-hub/database'
import { events } from './schema'

export default defineDatabase({
  tables: { events },
})
```

Named databases should represent real ownership or operational boundaries, not just folders.

## Cloudflare D1 binding

Cloudflare uses D1 bindings. For discovered Database Definitions, keep binding names, database names, and database ids with the definition that owns the database.

```ts [server/databases/config.ts]
export default defineDatabase({
  cloudflare: {
    binding: 'DB',
    databaseName: 'app',
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
  },
  tables: {
    notes,
  },
})
```

## Nuxt D1 host wiring

Nuxt apps can declare one D1 database resource for framework-owned consumers. The Database Nuxt bridge configures Nuxt Content internally and merges the same resource into Cloudflare `d1_databases`.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vite-hub/database/nuxt', '@nuxt/content'],
  database: {
    driver: 'd1',
    databaseName: 'app-content',
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
  },
})
```

Do not also hand-author normal Nuxt Content D1 config or duplicate the binding under `nitro.cloudflare.wrangler.d1_databases`.

## libSQL on Vercel

Vercel deployments can use hosted libSQL-compatible database URLs.

```env [.env]
TURSO_DATABASE_URL=libsql://example.turso.io
TURSO_AUTH_TOKEN=<token>
```

```ts [vite.config.ts]
export default defineConfig({
  database: {
    connection: {
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    },
  },
})
```

## Using Database from an agent

The Database Capability exposes guarded model-facing database tools. It is not the same as giving the model your raw app database client.

Read [Capabilities](/docs/agents/capabilities) for data mode, schema mode, write approvals, and the single-statement SQL guardrail.
