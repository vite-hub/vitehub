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
| `where` | Required. Returns the column values that every row of the caller has, such as `{ ownerId: user.id }`, `{}` for every row, or `false` to refuse the caller. It gets `{ request, user, session }`; `user` comes from `identify`, else from ViteHub Auth, else it is `null`. |
| `write` | Without it, only a caller with a user writes (`SYNC_FORBIDDEN` for visitors). `true` lets visitors write too, `false` makes the table read-only in the browser, and a function of `{ request, user, session, op, row }` decides for each write. |
| `identify` | `({ request }) => user \| null` for apps with their own sign-in. It replaces the ViteHub Auth user. The account of queued writes is `user.id`. |
| `schema` | A Standard Schema that checks the whole row after each insert and update. |
| `actions` | Named writes with server logic, such as `{ complete: async ({ get, update }, { id }: { id: string }) => update(id, { done: true }) }`. The browser calls them as `store.actions.complete({ id })`. `sync("comments")` in an action writes another definition, and `local.sync("comments")` in an optimistic function changes its open stores. |
| `live` | `true` (default) lets browsers keep a live stream open. `false` leaves only pulls. |

Sync uses the default Database, else the only one. `defineSync()` throws `SYNC_UNSUPPORTED_TABLE` for a Postgres table, an integer key, a composite key, or a `blob({ mode: "buffer" })` column, and `SYNC_INVALID_DEFINITION` for other wrong options.

A value of `where` is one value, or a list that matches any of its values, such as the teams of the caller: `{ teamId: teamIds }`. `where` does three things:

- Reads get only the rows with these values.
- Inserts get the single values. A list column must be set to one of its values. Another value is refused with `SYNC_OUT_OF_SCOPE`.
- Updates cannot change a single-value column, and can change a list column only to another value of the list, which moves the row, such as to another team. Updates change only rows of the caller (`SYNC_NOT_FOUND`).

## The route

Each definition has one route, `syncRoute(name)`: `/api/_vitehub/sync/<name>`. `protocol.ts` has the types of every request and answer.

- `GET ?cursor=<n>&scope=<id>&version=<v>&where=<json>` pulls the changes since `cursor`. Without `cursor`, with another `scope` or `version`, or with a cursor that is older than the oldest kept change, the answer is a full snapshot with `reset: true`. A pull sends at most 500 changes, then `more: true`. Each pull has `account`, `version`, and `defaults`.
- `GET ?live&...` with the same fields streams pulls as Server-Sent Events: an `event: pull` with `id: <cursor>` for each change that the caller can see. The server checks the change log each second, a push in the same process wakes the stream at once, and the stream ends after 25 seconds.
- `POST` with `{ account, scope, version, cursor, where, mutations }` applies at most `syncPushLimit` (100) mutations in order and answers `{ results, pull }`. Each result is `applied` (with the `result` of an action), `duplicate`, or `rejected` with a `SYNC_*` error.

`where` in a pull or a push is a subset: single column values, such as `{ issueId }`, that narrow the scope. A subset outside the caller's `where` gets 403 `SYNC_OUT_OF_SCOPE`.

What the server guarantees:

- The cursor is the `seq` of the change log, never a clock time. A full snapshot reads the newest `seq` and the rows in one atomic batch.
- Each mutation applies in one atomic batch that starts with its id in the ledger. A retried mutation, such as after a lost answer, is a `duplicate` and writes nothing. A duplicate of an action has the `result` of its first run.
- A push made for another account, such as before a sign-in as another user, gets 409 `SYNC_ACCOUNT_CHANGED` and writes nothing. The account is a fingerprint of the user id, so a push of the same user after a team change applies under the current `where`.
- The change log keeps the key and the scope columns of each row that left a scope, because it was deleted or moved. A pull sends the key in `deleted` only to callers whose `where` matched that row and does not match the row now, so keys do not leak to other callers.
- An action applies all its writes, with the same checks as browser writes, in one batch with its ledger entry, or none of them. This includes its writes to other definitions with `sync(name)`: each one has the `where`, `write`, and `schema` of its own definition for the same caller. Every definition uses the one default Database, so one batch holds them all.
- Unknown columns and a changed primary key are refused with `SYNC_INVALID`.
- A pull reads the changed rows with a join, and a list in `where` is one `json_each()` parameter, so the number of query parameters stays below the D1 limit of 100 for any number of keys or teams.
- `POST` needs a JSON body of at most 1 MB from the app's own origin. Every answer has `Cache-Control: private, no-store`.

Without a ViteHub app, call `handleSyncRequest(name, definition, request, { db, identify, definitions })` from your own route. `definitions` has the other definitions by name, for `sync(name)` in actions. `db` is a Drizzle SQLite Database with `batch()`: libSQL or D1.

## Change capture

Three SQLite triggers on each synced table write the change log: `vitehub_sync_<table>_insert`, `_update`, and `_delete`. So every write reaches the browsers, also a write of server code, a job, or plain SQL that does not go through Sync. `src/capture.ts` has them.

- After an insert or an update, the `put` of the key is the newest change. After a delete, an exit `delete` keeps the key and the scope columns of the old row. After an update that changes a scope column, an exit `move` keeps the old values. A new key is a delete of the old key.
- The scope columns are the rows of `vitehub_sync_columns`: the columns of `subsets` and each column that a `where` result returned. A pull or a push adds the columns of its scope before it answers, so no browser holds rows before a move of their columns is recorded.
- The triggers name only the key and the scope columns that the table has, as `pragma_table_info()` lists them. A migration can drop any other column, and a column that the code has before its migration stays out until the table has it.
- Each server process checks the triggers at its first request for each table and new scope column, and compares them with `sqlite_master`. It replaces old triggers in one batch that fails when another process registered a column at the same time. When the triggers were missing on a table that has a change log, such as after a migration rebuilt the table, it raises the floor, so every client gets a full snapshot.
- The change log is kept by table, not by Sync name, so two definitions of one table see each other's writes.

## The Database

`@vite-hub/sync/database` has four tables as `syncSchema`, and the same tables as SQL in `syncTables`. A ViteHub app adds them to the default Database; apply them with `vitehub database generate` and `vitehub database migrate`.

| Table | Holds |
| --- | --- |
| `vitehub_sync_changes` | `seq`, `table_name`, `key`, `op`, `row`, and the time of the Database. One `put` for each changed key, the newest. One exit (`delete` or `move`) for each row that left a scope, with the key and the scope columns as they were before, by SQL column name. |
| `vitehub_sync_columns` | `table_name` and `column`: the scope columns of each table, by SQL name. |
| `vitehub_sync_mutations` | The ids of applied mutations, for 7 days. |
| `vitehub_sync_state` | The `floor` of each table: the lowest cursor that a pull continues from. Compaction and a new install of missing triggers raise it. |

At most once an hour for each name, a push removes its mutation ids older than 7 days and the exits of its table older than 30 days, and raises the floor. A client with an older cursor gets a full snapshot.

## Inspect

`vitehub sync list` shows each definition with its table, key, write mode, live streams, action names, row count, change count, exit count, floor, last `seq`, whether the table has its triggers, and its scope columns. `vitehub sync changes <name>` shows the newest changes: `seq`, `op` (`put`, `delete`, or `move`), key, and time, without row data. MCP and the Console run the same `sync.list` and `sync.changes` operations.

## The client

`@vite-hub/sync/client` has `createSync(name)`, a store without dependencies that keeps rows and queued writes in IndexedDB. `@vite-hub/sync/vue` has `useSync(name)`, which Nuxt auto-imports. See the Sync docs.

## Limits

- SQLite only: libSQL, D1, and the local default Database. Postgres comes later.
- The last write wins for each column, in the order that the server applies them. An action reads and writes in two steps, not in one transaction (D1 has no interactive transactions).
- `where` filters by equal column values, or lists of values, only.
- A migration that drops a scope column must drop the triggers of the table and the row of the column in `vitehub_sync_columns` first. See the Sync docs.
