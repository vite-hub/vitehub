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
| `defineDatabase` from `vite-hub/database` | Declare a Database Definition. |
| `useDatabase` from `vite-hub/database` | Select a generated Drizzle database and its schema, by name or the only one. |
| `useDatabaseBinding` from `vite-hub/database` | Get the D1 binding or request session of a database. |
| `chunkParameters` from `vite-hub/database` | Split values so each statement stays under the D1 parameter limit. |
| `ensureMigrations` from `vite-hub/database` | Apply the pending migrations once in this process, from a task, a test, or a plugin. |
| `hubDatabase` from `@vite-hub/database/vite` | Add database discovery, the generated schema, and Nitro host bindings. |
| `@vite-hub/database/config` | Resolve config values and discovery config. |
| `@vite-hub/database/cli` | The `vitehub database` CLI commands. |

`vite-hub/database` exports all Definition, option, connection, D1, Drizzle, and runtime config types.

## Use it at runtime

Call `useDatabase()` from server code with the discovered database name. Use `default` for a Default Database. It returns the Drizzle client as `db` and the Definition schema as `schema`, and the relations of `db.query` as `relations`. Without a name, it returns the Default Database, or the only Database when the app has one Named Database.

| Call | App Databases | Result |
| --- | --- | --- |
| `useDatabase()` | A Default Database, or one Named Database | That Database |
| `useDatabase()` | Several Named Databases | Throws [`DATABASE_NAME_REQUIRED`](/docs/database/limits-and-errors#database_name_required) |
| `useDatabase(name)` | A Definition with this name | That Database |
| `useDatabase(name)` or `useDatabase()` | No Definition with this name, or no Database | Throws [`DATABASE_NOT_FOUND`](/docs/database/limits-and-errors#database_not_found) |

Both errors list the Database names. The generated types reject the same calls before the app runs. Check the names with `vitehub inspect definitions --kind database`.

This route reads the `notes` table of the Default Database. The `files` table is for [the parameter limit](#stay-under-the-bound-parameter-limit) below:

```ts [src/database.ts]
import { defineDatabase } from 'vite-hub/database'
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
      name: text('name').notNull(),
    }),
  },
})
```

```ts [server/api/notes.get.ts]
import { defineEventHandler } from 'h3'
import { useDatabase } from 'vite-hub/database'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('default')
  return db.select().from(schema.notes)
})
```

`db`, `schema`, and `useDatabase()` read the Databases that the ViteHub Vite Integration generates for server code that Nitro builds. Run them through your Nitro server output. In plain `node`, outside Vite, they find no Database.

### Use Named Databases

Use named databases when the app needs more than one separate database. Split for a real data or deployment reason, not to mirror a source folder.

The following Named Database example is an alternative to the Default Database above. Remove `src/database.ts`, `server/api/notes.get.ts`, and `server/utils/files.ts` (shown below) before using it. An app cannot combine Default and Named Database Definitions.

```ts [src/analytics.database.ts]
import { defineDatabase } from 'vite-hub/database'
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
import { useDatabase } from 'vite-hub/database'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('analytics')
  return db.select().from(schema.events)
})
```

### Pass the D1 binding to other code

Some code takes a Cloudflare D1 binding instead of a Drizzle client, such as the [D1 Agent Invocation store](/docs/agents/invocation-storage#store-invocations-in-cloudflare-d1). `useDatabaseBinding(name)` returns the D1 binding of a database, or the D1 session of the request when `cloudflare.readReplication` is on. Call it for each operation, inside the request or the task that uses it, because the binding belongs to the running Worker. It is the same value as `db.$client`, so its calls do not appear in the [request database stats](#see-database-work-on-each-request).

The return type, `DatabaseD1Binding`, exposes `prepare()` and `batch()`, which both bindings and sessions support. It fits consumers of these operations, including the D1 Agent Invocation store. It is not the full Cloudflare `D1Database` type: sessions have no `exec()`, `withSession()`, or `dump()`.

It throws `DATABASE_NO_D1_BINDING` when the database does not run on a D1 binding, such as local SQLite during `vite dev` or D1 over HTTP.

### Stay under the bound parameter limit

D1 binds at most 100 parameters per statement. A longer `inArray()` list or a multi-row insert rejects with [`DATABASE_D1_TOO_MANY_PARAMETERS`](/docs/database/limits-and-errors#database_d1_too_many_parameters) on D1, and in a Cloudflare dev server on local SQLite. `chunkParameters(values, options)` splits the values into arrays that each fit one statement. This example uses the `files` table of the Default Database above:

```ts [server/utils/files.ts]
import { and, eq, inArray } from 'drizzle-orm'
import { chunkParameters, useDatabase } from 'vite-hub/database'

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

## Apply migrations from server code

`ensureMigrations(name?)` applies the pending migrations of the Database `name`, or of every Database without a name. It uses the same code as [migrate on start](/docs/database/configure#migrate-when-the-server-starts): the same migrations table, the same data loss check, and the Postgres advisory lock. Use it where the start plugin does not run first: a Nitro task, a Nitro plugin, an app test, or a build with `migrateOnStart: false`.

```ts [server/tasks/db/migrate.ts]
import { ensureMigrations } from 'vite-hub/database'
import { defineTask } from 'nitro/task'

export default defineTask({
  meta: { description: 'Apply the pending migrations' },
  async run() {
    await ensureMigrations()
    return { result: 'ok' }
  },
})
```

A process runs the migrations of a Database once. Calls during that run, and calls after it succeeds, wait for the same run and apply nothing. The start plugin shares this run, so a call after the start does no work. When a run fails, the call rejects and the process forgets the run, so the next call tries again. A new run waits for the run before it, so Definitions that share a SQLite file apply each migration once. Several processes on one Postgres database apply each migration once: one process takes the lock and the others wait, then find nothing pending.

The build writes the migrations into the server output, and the server reads them at the first call. A Cloudflare or Vercel build ships none, and a call rejects with `DATABASE_MIGRATE_ON_START_UNSUPPORTED`: migrate those from the deployment with `vitehub database migrate` or Wrangler. Remote libSQL and D1 over HTTP reject with the same error. In app tests with `vite-hub/test`, a SQLite Database is an in-memory copy that already has its migrations, so the call skips it.

A Nitro plugin that calls `ensureMigrations()` also runs in the prerender server during the build. Check `import.meta.prerender` first if the build must not migrate the runtime database.

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

It counts every database and driver: a D1 binding, D1 over HTTP, libSQL, and Postgres, also on local PGlite. A request with no call gets no `database` field. A sub-request through the app, such as a server-rendered page's `$fetch('/api/…')`, gets its own event. Only queries through `db` count. Calls made directly on `db.$client`, the raw driver client, do not count, and neither do calls after the response, in `waitUntil()`. Without evlog, nothing is measured.
