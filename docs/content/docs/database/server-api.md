---
title: Database server API
description: Query a discovered database from server code with a typed Drizzle client.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineDatabase` from `@vite-hub/database` | Declare a Database Definition. |
| `useDatabase` from `@vite-hub/database/drizzle` | Select a generated Drizzle database and its schema by name. |
| `hubDb` from `@vite-hub/database/vite` | Register database discovery, generated schema, and Provider Output. |
| `@vite-hub/database/config` | Resolve database config values and discovery config. |
| `@vite-hub/database/cli` | Use the package-owned database CLI contribution. |
| `@vite-hub/database/nuxt` | Use the narrow Nuxt D1 host-resource bridge. |

All Database Definition, integration, connection, Cloudflare D1, Drizzle, and runtime config types are exported from `@vite-hub/database`.

## Use it at runtime

Call `useDatabase()` from server code with the discovered database name. Use `default` for a Default Database. It returns the Drizzle client as `db` and the Definition schema as `schema`.

```ts [server/api/notes.get.ts]
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('default')
  return db.select().from(schema.notes)
})
```

The ViteHub Vite Integration resolves `@vite-hub/database/drizzle` for server code and Provider Output. Do not run files that import it with plain `node`. Run them through your Vite-built server or Provider Output.

### Use Named Databases

Use Named Databases when the app needs more than one independent database. Name a database for a real data or deployment split, not for a source-code folder.

```ts [src/analytics.database.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const events = sqliteTable('events', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
})

export default defineDatabase({
  name: 'analytics',
  schema: { events },
})
```

```ts [server/api/events.get.ts]
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('analytics')
  return db.select().from(schema.events)
})
```
