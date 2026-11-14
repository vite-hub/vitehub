---
title: Sync server API
description: Every option of defineSync(), team scopes, subsets, actions, live pulls, writes from server code, and the Sync CLI and operations.
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
| `write` | `true` | `false` makes the table read-only in the browser. Actions still run. A function `({ request, user, session, op, row }) => boolean` decides each write. `row` is the row after the write, or the deleted row. |
| `schema` | none | A Standard Schema, such as Valibot or Zod. The server checks the whole row after each insert and update. |
| `actions` | none | Named writes with server logic. See [Actions](#actions). |
| `live` | `true` | `false` turns off [live pulls](#live-pulls) for this table. |
| `database` | `"default"` | The [Database](/docs/database) that holds `table`. |

`user` and `session` come from [Auth](/docs/auth) when the app has it, else they are `null`.

### `where`

`where` is required, so no table is public by mistake. It returns column values, with the Drizzle property names:

- `{ ownerId: user.id }`: the caller sees the rows where `ownerId` is the user's id.
- `{ teamId: ['design', 'web'] }`: a list. The caller sees the rows of each of its teams.
- `{}`: the caller sees every row.
- `false`: the caller may not sync. The answer is 401 `SYNC_UNAUTHORIZED` without a user, else 403 `SYNC_FORBIDDEN`.

The server uses the values for each request:

| Request | One value, such as `ownerId` | A list, such as `teamId` |
| --- | --- | --- |
| Pull | Only rows with this value. | Only rows with one of the values. An empty list matches no row. |
| Insert | The server writes the value into the row. Another value is refused with `SYNC_OUT_OF_SCOPE`. | The browser must set one of the values. No value or another value is refused with `SYNC_OUT_OF_SCOPE`. |
| Update | The value cannot change. | The value can change to another value of the list. This moves the row, such as to another team. |

```ts [server/sync/projects.ts] fragment
import { defineSync } from 'vite-hub/sync'
import { useDatabase } from 'vite-hub/database'
import { eq } from 'drizzle-orm'
import * as v from 'valibot'
import { members, projects } from '../databases/default'

export default defineSync({
  table: projects,
  // Everyone sees the projects of each team that they are in
  where: async ({ user }) => {
    if (!user) return false
    const teams = await useDatabase().db.select({ teamId: members.teamId }).from(members).where(eq(members.userId, user.id))
    return { teamId: teams.map(team => team.teamId) }
  },
  // Only admins delete
  write: ({ user, op }) => op !== 'delete' || user?.role === 'admin',
  schema: v.object({ id: v.string(), teamId: v.string(), name: v.pipe(v.string(), v.minLength(1)) }),
})
```

A list is one SQL parameter, so a user can be in more than 100 teams, also on Cloudflare D1.

### Moved rows

A row leaves a scope when it is deleted, or when its `where` column changes, such as a move to another team. The server sends its key in `deleted` to each caller whose scope held the row and does not hold it now. A caller of the new team gets the row. A caller of a third team gets nothing.

### Account and team changes

Each pull has an `account`: a fingerprint of the user id with Auth, else of the scope. The browser keeps each write with the account that made it.

- A push of another account, such as after a sign-in as another person, gets 409 `SYNC_SCOPE_CHANGED` and writes nothing. The browser keeps those writes for when that account signs in again.
- A push of the same account after the user joined or left a team applies under the current `where`, and the pull in the answer is a full snapshot.

## Subsets

The browser can sync a part of the rows, such as the comments of one issue. It sends `where` with single column values. The server adds them to the values of `where`, so a subset can only narrow what the caller may see:

```ts [app/pages/issues/[id].vue] fragment
const comments = useSync('comments', { where: () => ({ issueId: route.params.id }) })
```

- A column that `where` sets to one value must have the same value in the subset.
- A column that `where` sets to a list must have one of its values in the subset.
- Another column narrows the rows.
- A subset outside `where` gets 403 `SYNC_OUT_OF_SCOPE`. A subset with a list, an object, or an unknown column gets 400 `SYNC_BAD_REQUEST`.

Inserts in a subset get its values, like the single values of `where`. Each subset has its own scope id, cursor, and local copy.

## Actions

An action is a named write with server logic, such as `complete` or `rate`. It runs on the server with the caller's rights. Its writes go through the same checks as writes from the browser: `where`, `write`, and `schema`. They apply together with the action's id, in one batch, or not at all.

```ts [server/sync/cards.ts] fragment
import { defineSync } from 'vite-hub/sync'
import { createError } from 'h3'
import * as v from 'valibot'
import { cards } from '../databases/default'
import { teamIdsOf } from '../utils/teams'

export default defineSync({
  table: cards,
  where: async ({ user }) => user ? { teamId: await teamIdsOf(user.id) } : false,
  actions: {
    // Annotate `args`, so the browser call is typed
    rate: async ({ get, update }, args: { id: string, stars: number }) => {
      const { id, stars } = v.parse(v.object({ id: v.string(), stars: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5)) }), args)
      const card = await get(id)
      // A status below 500 sends the message to the browser
      if (!card) throw createError({ statusCode: 404, message: 'No such card.' })
      update(id, { stars: card.stars + stars, ratings: card.ratings + 1 })
      return { average: (card.stars + stars) / (card.ratings + 1) }
    },
  },
})
```

The browser calls it as `cards.actions.rate({ id, stars: 4 })`, and gets the return value. See [Vue](/docs/sync/vue).

The context of an action:

| Field | Does |
| --- | --- |
| `request`, `user`, `session` | The caller, as in `where`. |
| `get(key)` | The row with this key, when the caller may see it. It reads the table before the action's writes. |
| `insert(value)` | Adds a row and returns its key. Without a key in `value`, it makes one with `crypto.randomUUID()`. Pass the key in `args` when the browser shows the row at once, so both use the same key. |
| `update(key, patch)` | Changes a row. |
| `delete(key)` | Deletes a row. |

Rules:

- `args` come from the browser. Check them, such as with `v.parse()`.
- Throw to refuse the action. The browser gets `SYNC_ACTION_REFUSED`. The message of the error goes to the browser when it is a ViteHub error, an error with an HTTP `status` below 500, or a schema error with `issues` (such as from `v.parse()`). Any other error gives "The action failed.", and the server log gets the error and its stack.
- One refused write, such as an insert into a team the caller is not in, refuses the whole action with the code of that write.
- `write: false` does not stop actions.
- An action id applies once. A retry with the same id is a `duplicate`, and the action does not run again.
- The return value goes to the browser as JSON. A value that has no JSON form, such as a function, is left out.
- Reads and writes are not one transaction: D1 has no interactive transactions. When two callers change one row at the same time, the last write wins.
- Call `insert`, `update`, and `delete` before the action returns. A call after it returns throws.

## Live pulls

While a page shows, one tab of the browser keeps a live stream open. Other people's changes show within about a second.

The stream is `GET <route>?live&cursor&scope&version&where`, as Server-Sent Events. The server:

1. Checks who the caller is once, when the stream opens. A refused caller gets 401 or 403 before the stream starts.
2. Sends an `event: pull` with `id: <cursor>` when the stream opens, if anything changed since the cursor.
3. Reads the newest cursor of the change log every second, and sends a pull when it moved and the change is in the caller's scope.
4. Wakes at once after a push or `recordSyncChanges()` in the same server process.
5. Sends `: ping` every 15 seconds, and ends the stream after 25 seconds. The browser then opens a new one.

The cost is one indexed query for each second and each open stream. Only one tab of each browser opens a stream. Set `live: false` to turn streams off for a table: the browser then pulls on focus, on reconnect, on a timer, and after writes.

## The route

Each Sync name has one route: `<base>api/_vitehub/sync/<name>`. Every answer has `Cache-Control: private, no-store`.

| Request | Does |
| --- | --- |
| `GET ?cursor=<n>&scope=<id>&version=<v>&where=<json>` | Pulls the rows that changed since `cursor`. Without `cursor`, or with another scope or version, the answer is every row of the scope. |
| `GET ?live&...` | A [live stream](#live-pulls) of pulls. |
| `POST` | Applies up to 100 writes and actions in order, and answers with the result of each and a pull. |

Each pull has `version`, a fingerprint of the table's columns. When you change the table, the browser drops the rows that it stored and gets every row again. Its queued writes stay. Each pull also has `defaults`: the static `.default()` values of the columns, so a new row shows every column at once.

The types of the requests and answers are in `@vite-hub/sync`'s `protocol.ts`: `SyncPullResponse`, `SyncPushRequest`, `SyncPushResponse`, and `SyncLiveEvent`. The cursor is a number from the change log of the Database, not a time, so a clock that is wrong cannot skip a change.

Each write applies in one transaction with its id. A write that the server applied before is answered `duplicate`, and is not applied again. One refused write does not stop the others of a push.

## Writes from server code

The browser sees a write that went through Sync. When server code writes the table itself, such as a webhook or a job, record the change, so that browsers pull it:

```ts [server/api/todos/import.post.ts] fragment
import { recordSyncChanges } from 'vite-hub/sync'

// After you wrote the rows with Drizzle
const [error] = await recordSyncChanges('todos', { put: insertedIds, delete: deletedRows })
```

| Field | Takes |
| --- | --- |
| `put` | Keys of rows that you inserted or changed. |
| `delete` | The deleted rows, as they were before the delete, so that only callers that could see a row learn that it was deleted. |
| `moved` | Rows whose `where` column you changed, such as a move to another team, as they were before the change. |

```ts [server/api/issues/move.post.ts] fragment
import { recordSyncChanges } from 'vite-hub/sync'
import { eq } from 'drizzle-orm'

const [before] = await db.select().from(issues).where(eq(issues.id, id))
await db.update(issues).set({ teamId: 'design' }).where(eq(issues.id, id))
const [error] = await recordSyncChanges('issues', { moved: [before] })
```

It returns `[error, { recorded }]`, and wakes the live streams of this server process at once.

## Inspect

```bash [terminal]
# Each Sync name with its table, key column, write mode, live, actions, rows, changes, exits, and last cursor
vitehub sync list

# The last changes of one name: cursor, key, put, delete or move, and time. No row data.
vitehub sync changes todos
```

Both read the `sync.list` and `sync.changes` operations, which the Console and Agents can call too.

## Tables

Sync adds three tables to the Database of each definition:

| Table | Holds |
| --- | --- |
| `vitehub_sync_changes` | The newest change of each key, with its cursor. For each delete or move, an exit with the row as it was before, to check who may learn about it. |
| `vitehub_sync_mutations` | The ids of applied writes and actions, so each applies once. |
| `vitehub_sync_state` | The oldest cursor that the server still keeps for each name. |

The server removes write ids after 7 days and exits after 30 days. A browser with an older cursor gets every row again.
