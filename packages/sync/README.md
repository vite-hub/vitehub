# @vite-hub/sync

`@vite-hub/sync` gives the browser a local copy of a table. The browser reads and writes the copy at once, also offline and across reloads. The server stays the authority for every row: it decides which rows each caller sees, applies each write once and in order, and refuses writes outside the caller's rows.

## The server

Put one definition in `server/sync/<name>.ts`. In a ViteHub app, the folder turns Sync on, and the Database with it.

```ts fragment
// server/sync/todos.ts
import { defineSync } from "vite-hub/sync"
import { todos } from "../database/schema"

export default defineSync({
  table: todos,
  where: ({ user }) => user ? { ownerId: user.id } : false,
})
```

| Option | Does |
| --- | --- |
| `table` | A Drizzle SQLite table with one `text()` primary key column. Clients make new keys with `crypto.randomUUID()`. |
| `where` | Required. Returns the column values that every row of the caller has, such as `{ ownerId: user.id }`, `{}` for every row, or `false` to refuse the caller. It gets `{ request, user, session }`; `user` and `session` come from ViteHub Auth, else they are `null`. |
| `write` | `true` (default), `false` for a read-only table, or a function of `{ request, user, session, op, row }` that returns a boolean. |
| `schema` | A Standard Schema that checks the whole row after each insert and update. |
| `database` | The Database name. Default `default`. |

`defineSync()` throws `SYNC_UNSUPPORTED_TABLE` for a Postgres table, an integer key, or a composite key, and `SYNC_INVALID_DEFINITION` for other wrong options.

`where` does three things:

- Reads get only the rows with these values.
- Inserts get these values. An insert with another value is refused with `SYNC_OUT_OF_SCOPE`.
- Updates cannot change these columns (`SYNC_OUT_OF_SCOPE`), and change only rows of the caller (`SYNC_NOT_FOUND`).

## The route

Each definition has one route, `syncRoute(name)`: `/api/_vitehub/sync/<name>`. `protocol.ts` has the types of every request and answer.

- `GET ?cursor=<n>&scope=<id>` pulls the changes since `cursor`. Without `cursor`, with another `scope`, or with a cursor that is older than the oldest kept change, the answer is a full snapshot with `reset: true`. A pull sends at most 500 changes, then `more: true`.
- `POST` with `{ scope, cursor, mutations }` applies at most `syncPushLimit` (100) mutations in order and answers `{ results, pull }`. Each result is `applied`, `duplicate`, or `rejected` with a `SYNC_*` error.

What the server guarantees:

- The cursor is the `seq` of the change log, never a clock time. A full snapshot reads the newest `seq` and the rows in one atomic batch.
- Each mutation applies in one atomic batch that starts with its id in the ledger. A retried mutation, such as after a lost answer, is a `duplicate` and writes nothing.
- A push made for another scope, such as before a sign-in as another user, gets 409 `SYNC_SCOPE_CHANGED` and writes nothing.
- The change log keeps a copy of each deleted row. A pull sends a deleted key only to callers whose `where` matches that row, so keys do not leak to other callers.
- Unknown columns and a changed primary key are refused with `SYNC_INVALID`.
- A pull reads the changed rows with a join, so the number of query parameters stays the same for any number of keys, below the D1 limit of 100.
- `POST` needs a JSON body of at most 1 MB from the app's own origin. Every answer has `Cache-Control: private, no-store`.

Without a ViteHub app, call `handleSyncRequest(name, definition, request, { db, identify })` from your own route. `db` is a Drizzle SQLite Database with `batch()`: libSQL or D1.

## Writes from server code

When server code changes the table directly, record the change so that clients get it on their next pull. Pass the keys of inserted and updated rows, and the deleted rows as they were before the delete:

```ts fragment
import { recordSyncChanges } from "vite-hub/sync"

await db.insert(todos).values(todo)
const [error] = await recordSyncChanges("todos", { put: [todo.id] })

const [deleted] = await db.delete(todos).where(eq(todos.id, id)).returning()
await recordSyncChanges("todos", { delete: [deleted] })
```

## The Database

`@vite-hub/sync/database` has three tables as `syncSchema`, and the same tables as SQL in `syncTables`. A ViteHub app adds them to the default Database; apply them with `vitehub database generate` and `vitehub database migrate`.

| Table | Holds |
| --- | --- |
| `vitehub_sync_changes` | One entry for each changed key: `seq`, `name`, `key`, `op` (`put` or `delete`), the deleted row for a `delete`, and the time. |
| `vitehub_sync_mutations` | The ids of applied mutations, for 7 days. |
| `vitehub_sync_state` | The `floor` of each name: the highest `seq` that compaction removed. |

At most once an hour for each name, a push removes mutation ids older than 7 days and `delete` changes older than 30 days, and raises the floor. A client with an older cursor gets a full snapshot.

## Inspect

`vitehub sync list` shows each definition with its table, key, write mode, row count, change count, floor, and last `seq`. `vitehub sync changes <name>` shows the newest changes: `seq`, `op`, key, and time, without row data. MCP and the Console run the same `sync.list` and `sync.changes` operations.

## The client

`@vite-hub/sync/client` has `createSync(name)`, a store without dependencies that keeps rows and queued writes in IndexedDB. `@vite-hub/sync/vue` has `useSync(name)`, which Nuxt auto-imports. See the Sync docs.

## Limits

- SQLite only: libSQL, D1, and the local default Database. Postgres comes later.
- The server does not push changes. Clients pull on start, on focus, when they come online, on an interval, and after each write.
- The last write wins for each column, in the order that the server applies them.
- `where` filters by equal column values only.
