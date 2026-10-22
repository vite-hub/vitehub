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
| `hubDb` from `@vite-hub/database/vite` | Register database discovery, generated schema, and Nitro host bindings. |
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

The ViteHub Vite Integration resolves `@vite-hub/database/drizzle` for server code that Nitro builds. Do not run files that import it with plain `node`. Run them through your Nitro server output.

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

## See database work on each request

When the app registers the evlog Nitro module, through `vitehub({ observability })` or by itself, each request's wide event gets a `database` field:

```json
{ "path": "/api/notes", "status": 200, "database": { "calls": 9, "ms": 480, "maxConcurrent": 1 } }
```

| Field | Meaning |
| --- | --- |
| `calls` | Calls to a database. A batch is one call. |
| `ms` | Milliseconds with at least one call in flight: how long the request waited for its databases. |
| `maxConcurrent` | The most calls in flight at the same time. `1` means each call waited for the one before it. |

A request with `calls: 9`, `maxConcurrent: 1` and a high `ms` makes its database calls one after another. Run independent queries together, with `Promise.all()` or `db.batch()`, to cut the wait.

It counts every database of the app and every driver: a D1 binding, D1 over HTTP, libSQL, and Postgres. A request that makes no call gets no `database` field. A sub-request through the app, such as a server-rendered page's `$fetch('/api/…')`, gets its own event. It counts queries made through `db`. `db.$client` stays the app's own driver client, so a call made directly on it is not counted. Calls that run after the response, in `waitUntil()`, are not counted. Without evlog, nothing is measured.
