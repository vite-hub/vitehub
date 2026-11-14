---
title: Sync server API
description: Every option of defineSync(), the route of a synced table, writes from server code, and the Sync CLI and operations.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code
---

## `defineSync()`

`server/sync/<name>.ts` default-exports `defineSync()`. The file name is the Sync name. A wrong definition throws when you define it.

| Option | Default | Does |
| --- | --- | --- |
| `table` | required | A Drizzle SQLite table with one primary key column of text type. |
| `where` | required | `({ request, user, session }) => values \| {} \| false`. The rows that the caller may see. See below. |
| `write` | `true` | `false` makes the table read-only in the browser. A function `({ request, user, session, op, row }) => boolean` decides each write. `row` is the row after the write, or the deleted row. |
| `schema` | none | A Standard Schema, such as Valibot or Zod. The server checks the whole row after each insert and update. |
| `database` | `"default"` | The [Database](/docs/database) that holds `table`. |

`user` and `session` come from [Auth](/docs/auth) when the app has it, else they are `null`.

### `where`

`where` is required, so no table is public by mistake. It returns column values, with the Drizzle property names:

- `{ ownerId: user.id }`: the caller sees the rows where `ownerId` is the user's id.
- `{}`: the caller sees every row.
- `false`: the caller may not sync. The answer is 401 `SYNC_UNAUTHORIZED` without a user, else 403 `SYNC_FORBIDDEN`.

The server uses the values for each request:

| Request | What the values do |
| --- | --- |
| Pull | Only rows with these values. A deleted row reaches only callers that could see it. |
| Insert | The server writes the values into the row. A different value from the browser is refused with `SYNC_OUT_OF_SCOPE`. |
| Update | The row must have the values, and the patch may not change them. |

```ts [server/sync/projects.ts] fragment
import { defineSync } from 'vite-hub/sync'
import * as v from 'valibot'
import { projects } from '../databases/default'

export default defineSync({
  table: projects,
  // Everyone in the team sees the team's projects
  where: ({ user }) => user ? { teamId: user.teamId } : false,
  // Only admins delete
  write: ({ user, op }) => op !== 'delete' || user?.role === 'admin',
  schema: v.object({ id: v.string(), teamId: v.string(), name: v.pipe(v.string(), v.minLength(1)) }),
})
```

The values also make the scope of the caller. Each pull has its `scope.id`. When the values change, such as after a sign-in as another person, the id changes. The server then refuses a push of the old scope with `SYNC_SCOPE_CHANGED`, and the next pull is every row of the new scope.

## The route

Each Sync name has one route: `<base>api/_vitehub/sync/<name>`. Every answer has `Cache-Control: private, no-store`.

| Request | Does |
| --- | --- |
| `GET ?cursor=<n>&scope=<id>` | Pulls the rows that changed since `cursor`. Without `cursor`, or with another scope, the answer is every row of the scope. |
| `POST` | Applies up to 100 writes in order, and answers with the result of each and a pull. |

The types of the requests and answers are in `@vite-hub/sync`'s `protocol.ts`: `SyncPullResponse`, `SyncPushRequest`, and `SyncPushResponse`. The cursor is a number from the change log of the Database, not a time, so a clock that is wrong cannot skip a change.

Each write applies in one transaction with its id. A write that the server applied before is answered `duplicate`, and is not applied again. One refused write does not stop the others of a push.

## Writes from server code

The browser sees a write that went through Sync. When server code writes the table itself, such as a webhook or a job, record the change, so that browsers pull it:

```ts [server/api/todos/import.post.ts] fragment
import { recordSyncChanges } from 'vite-hub/sync'

// After you wrote the rows with Drizzle
await recordSyncChanges('todos', { put: insertedIds, delete: deletedRows })
```

`put` takes keys. `delete` takes the deleted rows, so that only callers that could see a row learn that it was deleted.

## Inspect

```bash [terminal]
# Each Sync name with its table, key column, write mode, rows, changes, and last cursor
vitehub sync list

# The last changes of one name: cursor, key, put or delete, and time. No row data.
vitehub sync changes todos
```

Both read the `sync.list` and `sync.changes` operations, which the Console and Agents can call too.

## Tables

Sync adds three tables to the Database of each definition:

| Table | Holds |
| --- | --- |
| `vitehub_sync_changes` | The newest change of each key, with its cursor. A deleted row keeps its values, to check who may learn about it. |
| `vitehub_sync_mutations` | The ids of applied writes, so a write applies once. |
| `vitehub_sync_state` | The oldest cursor that the server still keeps for each name. |

The server removes write ids after 7 days and deletes after 30 days. A browser with an older cursor gets every row again.
