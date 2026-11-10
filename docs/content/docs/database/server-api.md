---
title: Database server API
description: Query a database from server code with a typed Drizzle client and handle errors.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineDatabase` from `@vite-hub/database` | Declare a Database Definition. |
| `useDatabase` from `@vite-hub/database/drizzle` | Get a Drizzle database and its schema by name. |
| `chunkParameters` from `@vite-hub/database/drizzle` | Split values so each statement stays under the D1 parameter limit. |
| `hubDb` from `@vite-hub/database/vite` | Add database discovery, the generated schema, and Nitro host bindings. |
| `@vite-hub/database/config` | Resolve config values and discovery config. |
| `@vite-hub/database/cli` | The `vitehub db` CLI commands. |

`@vite-hub/database` exports all Definition, option, connection, D1, Drizzle, and runtime config types.

## Use it at runtime

Call `useDatabase()` in server code with the database name, or `default` for the default database. It returns the Drizzle client as `db` and your tables as `schema`. For a name with no Definition it returns `undefined`, so destructuring fails with a `TypeError`. Check the names with `vitehub inspect definitions --kind database`. This route reads the `notes` table of the default Database:

```ts [src/database.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    notes: sqliteTable('notes', {
      id: integer('id').primaryKey({ autoIncrement: true }),
      title: text('title').notNull(),
    }),
    files: sqliteTable('files', {
      id: text('id').primaryKey(),
      ownerId: text('owner_id').notNull(),
    }),
  },
})
```

```ts [server/api/notes.get.ts]
import { defineEventHandler } from 'h3'
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('default')
  return db.select().from(schema.notes)
})
```

ViteHub resolves `@vite-hub/database/drizzle` only in server code that Nitro builds. Do not run files that import it with plain `node`. Run your Nitro server output.

### Use Named Databases

Use named databases when the app needs more than one separate database. Split for a real data or deployment reason, not to mirror a source folder.

The following Named Database example is an alternative to the Default Database above. Remove `src/database.ts`, `server/api/notes.get.ts`, and `server/utils/files.ts` (shown below) before using it. An app cannot combine Default and Named Database Definitions.

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
import { defineEventHandler } from 'h3'
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('analytics')
  return db.select().from(schema.events)
})
```

### Stay under the bound parameter limit

D1 binds at most 100 parameters per statement. A longer `inArray()` list or a multi-row insert rejects with [`DATABASE_D1_TOO_MANY_PARAMETERS`](/docs/database/limits-and-errors#database_d1_too_many_parameters) on D1, and in a Cloudflare dev server on local SQLite. `chunkParameters(values, options)` splits the values into arrays that each fit one statement. This example uses the `files` table of the Default Database above:

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
| `per` | `1` | Parameters that one value binds. A Drizzle table counts its columns, for inserts that bind at most one parameter per column. |
| `reserved` | `0` | Other parameters in the same statement. |
| `limit` | `100` | Most parameters per statement. 100 is the D1 limit, the lowest of the supported drivers. |

The helper trusts your counts. It does not read row contents or SQL defaults. An SQL expression can bind several parameters in one column: a one-column row with `` sql`${first} || ${second}` `` binds two, so use `{ per: 2 }`, not the table. Pick a `per` that covers the most a whole row can bind, SQL defaults included.

Each array has at most `(limit - reserved) / per` values. When one value does not fit, it throws a `RangeError`. Chunks are separate statements, so wrap them in `db.batch()` or a transaction when they must apply together.

## See database work on each request

With the evlog Nitro module, added through `vitehub({ observability })` or by hand, each request's wide event gets a `database` field:

```json
{ "path": "/api/notes", "status": 200, "database": { "calls": 9, "ms": 480, "maxConcurrent": 1 } }
```

| Field | Meaning |
| --- | --- |
| `calls` | Calls to a database. A batch is one call. |
| `ms` | Milliseconds with at least one call running: how long the request waited for its databases. |
| `maxConcurrent` | The most calls running at once. `1` means each call waited for the one before. |

`calls: 9`, `maxConcurrent: 1`, and a high `ms` mean the calls ran one after another. Run independent queries together, with `Promise.all()` or `db.batch()`, to cut the wait.

It counts every database and driver: a D1 binding, D1 over HTTP, libSQL, and Postgres. A request with no call gets no `database` field. A sub-request through the app, such as a server-rendered page's `$fetch('/api/…')`, gets its own event. Only queries through `db` count. Calls made directly on `db.$client`, the raw driver client, do not count, and neither do calls after the response, in `waitUntil()`. Without evlog, nothing is measured.
