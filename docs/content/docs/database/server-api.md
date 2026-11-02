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
| `chunkParameters` from `@vite-hub/database/drizzle` | Split values so each statement stays under the bound parameter limit of D1. |
| `hubDb` from `@vite-hub/database/vite` | Register database discovery, generated schema, and Nitro host bindings. |
| `@vite-hub/database/config` | Resolve database config values and discovery config. |
| `@vite-hub/database/cli` | Use the package-owned database CLI contribution. |
| `@vite-hub/database/nuxt` | Use the narrow Nuxt D1 host-resource bridge. |

All Database Definition, integration, connection, Cloudflare D1, Drizzle, and runtime config types are exported from `@vite-hub/database`.

## Use it at runtime

Call `useDatabase()` from server code with the discovered database name. Use `default` for a Default Database. It returns the Drizzle client as `db` and the Definition schema as `schema`. For a name that has no Database Definition it returns `undefined`, so destructuring the result fails with a `TypeError`. Check the names with `vitehub inspect definitions --kind database`.

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

### Stay under the bound parameter limit

Cloudflare D1 binds at most 100 parameters in one statement. A longer `inArray()` list or a multi-row insert fails on D1, even when it works on local SQLite. `chunkParameters(values, options)` splits the values into arrays that fit one statement each:

```ts [server/utils/files.ts]
import { and, eq, inArray } from 'drizzle-orm'
import { chunkParameters, useDatabase } from '@vite-hub/database/drizzle'

const { db, schema } = useDatabase('default')

export async function saveFiles(rows: (typeof schema.files.$inferInsert)[]) {
  // For rows of plain values, allow one parameter for each column of each row.
  for (const chunk of chunkParameters(rows, { per: schema.files })) await db.insert(schema.files).values(chunk)
}

export async function deleteFiles(ownerId: string, ids: string[]) {
  // `reserved` keeps room for the other parameter of the statement, `ownerId`.
  for (const chunk of chunkParameters(ids, { reserved: 1 })) {
    await db.delete(schema.files).where(and(eq(schema.files.ownerId, ownerId), inArray(schema.files.id, chunk)))
  }
}
```

| Option | Default | Use |
| --- | --- | --- |
| `per` | `1` | Bound parameters that one value takes. A Drizzle table counts its columns for inserts binding at most one parameter per column. |
| `reserved` | `0` | Other bound parameters in the same statement. |
| `limit` | `100` | The most bound parameters in one statement. 100 is the D1 limit and the lowest of the supported drivers. |

The helper uses the counts you supply; it does not inspect row contents or SQL defaults. SQL expressions can bind several parameters in one column. For example, a one-column row containing `` sql`${first} || ${second}` `` binds two parameters, so use `{ per: 2 }` instead of the table shorthand. Choose a numeric `per` that covers the maximum bindings of a whole row, including SQL defaults.

Each array has at most `(limit - reserved) / per` values. When one value does not fit, it throws a `RangeError`. The chunks are separate statements, so wrap them in `db.batch()` or a transaction when they must apply together.

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
