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

```ts [server/db/schema.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
})

export default defineDatabase({
  schema: { notes },
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

```ts [server/db/analytics.ts]
export default defineDatabase({
  name: 'analytics',
  schema,
})
```

Named databases should represent real ownership or operational boundaries, not just folders.

## Cloudflare D1 binding

Cloudflare uses D1 bindings. Keep binding names, database names, and database ids in integration config.

```ts [vite.config.ts]
export default defineConfig({
  db: {
    cloudflare: {
      binding: 'DB',
      databaseName: 'app',
      databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    },
  },
})
```

## libSQL on Vercel

Vercel deployments can use hosted libSQL-compatible database URLs.

```env [.env]
TURSO_DATABASE_URL=libsql://example.turso.io
TURSO_AUTH_TOKEN=<token>
```

```ts [vite.config.ts]
export default defineConfig({
  db: {
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
