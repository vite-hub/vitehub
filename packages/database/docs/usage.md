---
title: DB usage
description: Use default and named database definitions with generated Drizzle artifacts.
navigation.title: Usage
navigation.order: 2
icon: i-lucide-book-open
frameworks: [vite]
---

## Definition Modes

ViteHub supports one of two modes:

- One default database at `server/databases/config.ts` or `src/database.ts`
- All named databases at `server/databases/<name>/config.ts` or `src/<name>.database.ts`

The modes are exclusive. If a project has any named database definition, every database should be named.

## Named Databases

```ts [server/databases/analytics/config.ts]
import { defineDatabase } from '@vitehub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const analyticsEvents = sqliteTable('analytics_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})

export default defineDatabase({
  connection: {
    authToken: process.env.TURSO_AUTH_TOKEN,
    url: process.env.TURSO_ANALYTICS_DATABASE_URL,
  },
  tables: { analyticsEvents },
})
```

```ts
import { databases } from '@vitehub/database/drizzle'

await databases.analytics.db
  .insert(databases.analytics.schema.analyticsEvents)
  .values({ name: 'page-view' })
```

## Generated Files

ViteHub writes generated artifacts under `.vitehub/database`:

- `.vitehub/database/schema/<name>.ts`
- `.vitehub/database/drizzle.config.ts`

These files are inspectable build artifacts. Drizzle table primitives stay in the definition file as the authored source.

## CLI

```bash
vitehub db generate
vitehub db migrate
```

The CLI is contributed through the ViteHub package CLI model from the Vite config. Disable DB CLI features with:

```ts [vite.config.ts]
export default defineConfig({
  db: {
    cli: {
      migrate: false,
    },
  },
})
```
