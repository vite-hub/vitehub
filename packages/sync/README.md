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
| `actions` | Named writes with server logic, such as `{ complete: async ({ get, update }, { id }: { id: string }) => update(id, { done: true }) }`. The browser calls them as `store.actions.complete({ id })`. |
| `live` | `true` (default) lets browsers keep a live stream open. `false` leaves only pulls. |
| `database` | The Database name. Default `default`. |

`defineSync()` throws `SYNC_UNSUPPORTED_TABLE` for a Postgres table, an integer key, or a composite key, and `SYNC_INVALID_DEFINITION` for other wrong options.

A value of `where` is one value, or a list that matches any of its values, such as the teams of the caller: `{ teamId: teamIds }`. `where` does three things:

- Reads get only the rows with these values.
- Inserts get the single values. A list column must be set to one of its values. Another value is refused with `SYNC_OUT_OF_SCOPE`.
- Updates cannot change a single-value column, and can change a list column only to another value of the list, which moves the row, such as to another team. Updates change only rows of the caller (`SYNC_NOT_FOUND`).

## The route

Each definition has one route, `syncRoute(name)`: `/api/_vitehub/sync/<name>`. `protocol.ts` has the types of every request and answer.

- `GET ?cursor=<n>&scope=<id>&version=<v>&where=<json>` pulls the changes since `cursor`. Without `cursor`, with another `scope` or `version`, or with a cursor that is older than the oldest kept change, the answer is a full snapshot with `reset: true`. A pull sends at most 500 changes, then `more: true`. Each pull has `account`, `version`, and `defaults`.
- `GET ?live&...` with the same fields streams pulls as Server-Sent Events: an `event: pull` with `id: <cursor>` for each change that the caller can see. The server checks the change log each second, a write in the same process wakes the stream at once, and the stream ends after 25 seconds.
- `POST` with `{ account, scope, version, cursor, where, mutations }` applies at most `syncPushLimit` (100) mutations in order and answers `{ results, pull }`. Each result is `applied` (with the `result` of an action), `duplicate`, or `rejected` with a `SYNC_*` error.

`where` in a pull or a push is a subset: single column values, such as `{ issueId }`, that narrow the scope. A subset outside the caller's `where` gets 403 `SYNC_OUT_OF_SCOPE`.

What the server guarantees:

- The cursor is the `seq` of the change log, never a clock time. A full snapshot reads the newest `seq` and the rows in one atomic batch.
- Each mutation applies in one atomic batch that starts with its id in the ledger. A retried mutation, such as after a lost answer, is a `duplicate` and writes nothing.
- A push made for another account, such as before a sign-in as another user, gets 409 `SYNC_SCOPE_CHANGED` and writes nothing. The account is a fingerprint of the user id, so a push of the same user after a team change applies under the current `where`.
- The change log keeps a copy of each row that left a scope, because it was deleted or moved. A pull sends the key in `deleted` only to callers whose `where` matched that row and does not match the row now, so keys do not leak to other callers.
- An action applies all its writes, with the same checks as browser writes, in one batch with its ledger entry, or none of them.
- Unknown columns and a changed primary key are refused with `SYNC_INVALID`.
- A pull reads the changed rows with a join, and a list in `where` is one `json_each()` parameter, so the number of query parameters stays below the D1 limit of 100 for any number of keys or teams.
- `POST` needs a JSON body of at most 1 MB from the app's own origin. Every answer has `Cache-Control: private, no-store`.

Without a ViteHub app, call `handleSyncRequest(name, definition, request, { db, identify })` from your own route. `db` is a Drizzle SQLite Database with `batch()`: libSQL or D1.

## Writes from server code

When server code changes the table directly, record the change so that clients get it on their next pull. Pass the keys of inserted and updated rows in `put`, the deleted rows as they were before the delete in `delete`, and the rows whose `where` column changed, as they were before, in `moved`:

```ts fragment
import { recordSyncChanges } from "vite-hub/sync"

await db.insert(todos).values(todo)
const [error] = await recordSyncChanges("todos", { put: [todo.id] })

const [deleted] = await db.delete(todos).where(eq(todos.id, id)).returning()
await recordSyncChanges("todos", { delete: [deleted] })

const [before] = await db.select().from(issues).where(eq(issues.id, id))
await db.update(issues).set({ teamId: "t2" }).where(eq(issues.id, id))
await recordSyncChanges("issues", { moved: [before] })
```

## The Database

`@vite-hub/sync/database` has three tables as `syncSchema`, and the same tables as SQL in `syncTables`. A ViteHub app adds them to the default Database; apply them with `vitehub database generate` and `vitehub database migrate`.

| Table | Holds |
| --- | --- |
| `vitehub_sync_changes` | `seq`, `name`, `key`, `op`, `row`, and the time. One `put` for each changed key, the newest. One exit (`delete` or `move`) for each row that left a scope, with the row as it was before. |
| `vitehub_sync_mutations` | The ids of applied mutations, for 7 days. |
| `vitehub_sync_state` | The `floor` of each name: the highest `seq` that compaction removed. |

At most once an hour for each name, a push removes mutation ids older than 7 days and exits older than 30 days, and raises the floor. A client with an older cursor gets a full snapshot.

## Inspect

`vitehub sync list` shows each definition with its table, key, write mode, live streams, action names, row count, change count, exit count, floor, and last `seq`. `vitehub sync changes <name>` shows the newest changes: `seq`, `op` (`put`, `delete`, or `move`), key, and time, without row data. MCP and the Console run the same `sync.list` and `sync.changes` operations.

## The client

`@vite-hub/sync/client` has `createSync(name)`, a store without dependencies that keeps rows and queued writes in IndexedDB. `@vite-hub/sync/vue` has `useSync(name)`, which Nuxt auto-imports. See the Sync docs.

## Limits

- SQLite only: libSQL, D1, and the local default Database. Postgres comes later.
- The last write wins for each column, in the order that the server applies them. An action reads and writes in two steps, not in one transaction (D1 has no interactive transactions).
- `where` filters by equal column values, or lists of values, only.
- A move is seen when the moved column is in the `where` of the caller that writes it, or when server code passes it in `moved`.
