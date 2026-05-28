---
title: DB
description: Define Drizzle databases from database definition files and use generated ViteHub runtime imports.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-database
frameworks: [vite]
---

`@vitehub/db` discovers database definitions, generates Drizzle Kit artifacts, and exposes a small runtime surface for Vite server code.

Register `hubDb()` in Vite, then define databases in files:

- Default database: `server/databases/config.ts`
- Named databases: `server/databases/<name>/config.ts`
- Vite default: `src/database.ts`
- Vite named: `src/<name>.database.ts`

Use either one default database or all named databases. Do not mix the default definition with named definitions.

```ts [server/databases/config.ts]
import { defineDatabase } from '@vitehub/db'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
})

export default defineDatabase({
  tables: { notes },
})
```

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubDb } from '@vitehub/db/vite'

export default defineConfig({
  plugins: [hubDb()],
})
```

Run `vitehub db generate` to refresh `.vitehub/db/schema/*.ts` and `.vitehub/db/drizzle.config.ts`, then run Drizzle Kit through ViteHub.

## Runtime

Default database definitions expose `db` and `schema` aliases:

```ts
import { db, schema } from '@vitehub/db/drizzle'
```

Named definitions use the registry:

```ts
import { databases } from '@vitehub/db/drizzle'

await databases.analytics.db
  .insert(databases.analytics.schema.analyticsEvents)
  .values({ name: 'page-view' })
```
