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
| `write` | users only | Without it, a caller with a user writes every row it can see, and a visitor gets `SYNC_FORBIDDEN`. `true` lets visitors write too. `false` makes the table read-only in the browser. Actions still run. A function `({ request, user, session, op, row }) => boolean` decides each write. `row` is the row after the write, or the deleted row. |
| `schema` | none | A Standard Schema, such as Valibot or Zod. The server checks the whole row after each insert and update. |
| `subsets` | none | The columns that the browser may load a part of the rows by, such as `['issueId']`. See [Subsets](#subsets). |
| `identify` | Auth's user | `({ request }) => user \| null`. The caller's user, when the app has its own sign-in. It replaces the Auth user. See [Account and team changes](#account-and-team-changes). |
| `actions` | none | Named writes with server logic. See [Actions](#actions). |
| `live` | `true` | `false` turns off [live pulls](#live-pulls) for this table. |

`user` comes from `identify`, else from [Auth](/docs/auth) when the app has it, else it is `null`. `session` is the Auth session, or `null`. Sync keeps its tables and reads `table` in the default [Database](/docs/database), else in the only one. Two definitions can sync the same table, such as one of each person's rows and one of every row for admins. Each gets the writes of the other.

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

A row leaves a scope when it is deleted, or when its `where` or `subsets` column changes, such as a move to another team. The server sends its key in `deleted` to each caller whose scope held the row and does not hold it now. A caller of the new team gets the row. A caller of a third team gets nothing.

The server records the row as it is when the write applies, not as the writer read it. When two people move one row at the same time, each move reaches the team that held the row just before it.

### Account and team changes

Each pull has an `account`: a fingerprint of the user id. The browser keeps each write with the account that made it.

- A push of another account, such as after a sign-in as another person, gets 409 `SYNC_ACCOUNT_CHANGED` and writes nothing. The browser keeps those writes for when that account signs in again.
- A push of the same account after the user joined or left a team applies under the current `where`, and the pull in the answer is a full snapshot.

The user comes from [Auth](/docs/auth). When your app has its own sign-in, return the caller's user from `identify`. `where`, `write`, and actions then get this user. Without a user, the account is the scope of `where`: it changes when the caller joins or leaves a team, and the browser then holds back its queued writes. In development, the server warns once when `where` returns a list and there is no user.

```ts [server/sync/projects.ts] fragment
import { defineSync } from 'vite-hub/sync'
import { getSession } from '../utils/session'
import { projects } from '../databases/default'

export default defineSync({
  table: projects,
  // The app's own sign-in: the account stays the same when the person joins a team
  identify: async ({ request }) => {
    const session = await getSession(request)
    return session ? { id: session.userId, teamIds: session.teamIds } : null
  },
  where: ({ user }) => user ? { teamId: user.teamIds as string[] } : false,
})
```

Return `null` for a visitor.

## Subsets

The browser can sync a part of the rows, such as the comments of one issue. List the columns that it may use in `subsets`:

```ts [server/sync/comments.ts] fragment
import { defineSync } from 'vite-hub/sync'
import { comments } from '../databases/default'
import { teamIdsOf } from '../utils/teams'

export default defineSync({
  table: comments,
  where: async ({ user }) => user ? { teamId: await teamIdsOf(user.id) } : false,
  // The browser may load the comments of one issue
  subsets: ['issueId'],
})
```

The browser sends `where` with single column values. The server adds them to the values of `where`, so a subset can only narrow what the caller may see. A route param can be a list, so turn it into text with `String()`:

```ts [app/pages/issues/[id].vue] fragment
const route = useRoute()
const comments = useSync('comments', { where: () => ({ issueId: String(route.params.id) }) })
```

- A column that `where` sets to one value must have the same value in the subset.
- A column that `where` sets to a list must have one of its values in the subset.
- A column of `subsets` narrows the rows.
- A subset outside `where` gets 403 `SYNC_OUT_OF_SCOPE`. A subset on a column that is not in `subsets` or `where` gets 400 `SYNC_BAD_REQUEST`, and the message tells you to add it to `subsets`. A subset with a list, an object, or an unknown column gets 400 `SYNC_BAD_REQUEST` too.

The generated types know `subsets`, so `useSync('comments', { where })` accepts only these columns, with the JSON type of each. A wrong column fails in the editor.

Inserts in a subset get its values, like the single values of `where`. Each subset has its own scope id, cursor, and local copy. When a write changes a column of `subsets`, such as a comment that moves to another issue, the row leaves the subsets that held it.

Each subset reads its rows with the column in the filter, so add an index on each column of `subsets`:

```ts [server/databases/default.ts] fragment
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const comments = sqliteTable('comments', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  issueId: text('issue_id').notNull(),
  body: text('body').notNull(),
}, table => [index('comments_issue_id').on(table.issueId)])
```

## Actions

An action is a named write with server logic, such as `complete` or `rate`. It runs on the server with the caller's rights. Its writes go through the same checks as writes from the browser: `where`, `write`, and `schema`. They apply together with the action's id, in one batch, or not at all.

```ts [server/sync/cards.ts] fragment
import { defineSync } from 'vite-hub/sync'
import * as v from 'valibot'
import { cards } from '../databases/default'
import { teamIdsOf } from '../utils/teams'

export default defineSync({
  table: cards,
  where: async ({ user }) => user ? { teamId: await teamIdsOf(user.id) } : false,
  actions: {
    // Annotate `args`, so the browser call is typed
    rate: async ({ get, update, refuse }, args: { id: string, stars: number }) => {
      const { id, stars } = v.parse(v.object({ id: v.string(), stars: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5)) }), args)
      const card = await get(id)
      // The browser gets SYNC_ACTION_REFUSED with this message
      if (!card) refuse('No such card.')
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
| `sync(name)` | The rows of another Sync definition, with the same `get`, `insert`, `update`, and `delete`. See [Write other definitions](#write-other-definitions). |
| `refuse(message)` | Refuses the action. No write applies, and the browser gets `SYNC_ACTION_REFUSED` with `message`. |

Rules:

- `args` come from the browser. Check them, such as with `v.parse()`.
- Call `refuse(message)` to refuse the action. It needs no import. Do not import `HTTPError` from `h3` for this: a pnpm app often cannot import `h3`, because it is not a direct dependency.
- A thrown error refuses the action too, with `SYNC_ACTION_REFUSED`. The message of the error goes to the browser when it is a ViteHub error, an error with an HTTP `status` below 500, or a schema error with `issues` (such as from `v.parse()`). Any other error gives "The action failed.", and the server log gets the error and its stack.
- One refused write, such as an insert into a team the caller is not in, refuses the whole action with the code of that write.
- `write: false` does not stop actions. Without `write`, the writes of a visitor's action are refused with `SYNC_FORBIDDEN`, as browser writes are.
- An action id applies once. A retry with the same id is a `duplicate`, the action does not run again, and the browser gets the result of the first run. The server keeps write ids and results for 7 days.
- The action function can run more than once for one call: when another write changes a row that the action read before its writes apply, the server runs it again, up to 3 times. Only its writes apply once. Put effects outside its writes, such as an email, in a [Queue](/docs/queue) job.
- The return value goes to the browser as JSON. A value that has no JSON form, such as a function, is left out.
- Reads and writes are not one transaction: D1 has no interactive transactions. The writes apply only when the rows that the action read did not change, else the action runs again.
- Call `insert`, `update`, and `delete` before the action returns. A call after it returns throws.

### Write other definitions

An action can write the rows of another Sync definition with `sync(name)`. Use it when two tables must change together, such as an issue with its first comment, or a card that moves with a row in its activity log:

```ts [server/sync/issues.ts] fragment
import { defineSync } from 'vite-hub/sync'
import { issues } from '../databases/default'
import { teamIdsOf } from '../utils/teams'

export default defineSync({
  table: issues,
  where: async ({ user }) => user ? { teamId: await teamIdsOf(user.id) } : false,
  actions: {
    create: ({ insert, sync }, { id, teamId, title, comment }: { id: string, teamId: string, title: string, comment: string }) => {
      insert({ id, teamId, title })
      // The rows of server/sync/comments.ts, with its checks
      sync('comments').insert({ issueId: id, teamId, body: comment })
    },
  },
})
```

- Every Sync definition uses the default Database, so all writes of the action apply in one atomic batch with its id: the issue and the comment, or neither.
- Each write has the checks of its own definition for the same caller: `where` (without a subset), `write`, and `schema`. A definition with `write: false` refuses the write with `SYNC_READ_ONLY`. One refused write refuses the whole action.
- `sync(name).get(key)` reads a row of that definition when the caller may see it. When another write changes that row before the batch applies, the action runs again, as for its own table.
- The rows have the type of that definition. A name that is not a file of `server/sync/` is a type error, and throws `SYNC_UNKNOWN_NAME` at run time, which refuses the action.
- The browsers of the other table get the change as for any write. A live stream in the same server process gets it at once.
- With `handleSyncRequest()` in your own route, pass every definition in `definitions`, such as `{ db, definitions: { issues, comments } }`. Pass the same object to `handleSyncLiveRequest(request, services)` from the live route.

## Live pulls

While a page shows, each tab keeps one live stream open for all its synced tables and subsets. Other people's changes show within about a second.

The stream is `POST <base>_vitehub/sync` with `{ pulls: [{ name, where, cursor, scope, version }] }`, one item for each store of the tab. The answer is Server-Sent Events. The server:

1. Checks each store once, when the stream opens, with the `where` of its definition. A store that the caller may not see gets an `event: error` with its `name`, `where`, and the error. The other stores stream on.
2. Sends the comment `: open` at once, so the headers reach the browser at once. Then it sends an `event: pull` with `{ name, where, pull }` for each store that changed since its cursor.
3. Reads the change log every second, once for the whole stream, and pulls the stores whose table changed in one batch.
4. Wakes at once after a push in the same server process, also for the stores of each table that an action wrote. A write of server code shows at the next check.
5. Sends the comment `: ping` every 15 seconds, and ends the stream after 25 seconds, also while it sends a long backlog. It also ends the stream before a check could pass 40 Database calls. The browser then opens a new one.

The cost is one indexed query for each second and each open stream, for any number of stores, and one batch when tables changed. A batch is one Database call. On the Workers Free plan, D1 allows 50 calls in a Worker invocation, and each new stream is a new invocation. A store open in two tabs streams in one of them. Set `live: false` to turn streams off for a table: the server refuses its store with `SYNC_BAD_REQUEST`, and the browser pulls it on focus, on reconnect, on a timer, and after writes.

## The route

Each Sync name has one route: `<base>_vitehub/sync/<name>`. Every answer has `Cache-Control: private, no-store`.

| Request | Does |
| --- | --- |
| `GET ?cursor=<n>&scope=<id>&version=<v>&where=<json>` | Pulls the rows that changed since `cursor`. Without `cursor`, or with another scope or version, the answer is every row of the scope. |
| `POST` | Applies up to 100 writes and actions in order, and answers with the result of each and a pull. |

`POST <base>_vitehub/sync` is the [live stream](#live-pulls) of every Sync name.

Each pull has `version`, a fingerprint of the table's columns. When you change the table, the browser drops the rows that it stored and gets every row again. Its queued writes stay. Each pull also has `defaults`: the static `.default()` values of the columns, so a new row shows every column at once.

The types of the requests and answers are in `@vite-hub/sync`'s `protocol.ts`: `SyncPullResponse`, `SyncPushRequest`, `SyncPushResponse`, `SyncLiveRequest`, and `SyncLiveEvent`. The cursor is a number from the change log of the Database, not a time, so a clock that is wrong cannot skip a change.

Each write applies in one transaction with its id. A write that the server applied before is answered `duplicate`, and is not applied again. One refused write does not stop the others of a push.

A push has a budget of 40 Database calls, where a batch is one call. It reads the ledger once for the whole push. A plain write usually makes two more calls: one row read and one batch. The budget leaves room for the response but does not count request setup or stop the first mutation. The server returns results for the mutations it finished, and the browser sends the rest in a new push. A long queue drains as long as each mutation fits in its own Worker invocation. On the Workers Free plan, D1 allows 50 calls in an invocation. Without a ViteHub app, set the budget with `push: { calls }` of the services.

## Writes from server code

Any write to the table reaches the browsers: a write from the browser, an action, and also server code that writes the table itself, such as a webhook, a job, an Agent, or a Workflow. Write the table with Drizzle or SQL, as you do for any table:

```ts [server/api/issues/move.post.ts] fragment
import { useDatabase } from 'vite-hub/database'
import { eq } from 'drizzle-orm'
import { issues } from '../../databases/default'

// The issue leaves the browsers of the old team and shows on the browsers of the new team
await useDatabase().db.update(issues).set({ teamId: 'design' }).where(eq(issues.id, id))
```

Five triggers on the table write the change log: `vitehub_sync_<table>_insert`, `vitehub_sync_<table>_update`, `vitehub_sync_<table>_delete`, `vitehub_sync_<table>_replace_insert`, and `vitehub_sync_<table>_replace_update`.

- Sync adds the triggers at its first request on each server. It adds them again when they are missing or old, such as after a migration that rebuilt the table. When they were missing, writes can have gone without a change, so each browser gets every row again.
- A new value in a scope column moves the row. The scope columns are the columns of `subsets` and each column that a `where` result returned. Sync adds a column of `where` before it sends rows of a scope that uses it.
- The triggers read only the key, the scope columns, and the columns of unique indexes. For other columns, Sync triggers do not block a drop, but SQLite schema dependencies can. See [Limits](/docs/sync/limits-and-errors#not-in-sync-yet) for the migration steps.
- A live stream shows a write of server code at its next check of the change log, within a second.

## Inspect

```bash [terminal]
# Each Sync name with its table, key column, write mode, live, subsets, actions, rows, changes, exits, last cursor, triggers, and scope columns
vitehub sync list

# The last changes of one name: cursor, key, put, delete or move, and time. No row data.
vitehub sync changes todos
```

Both read the `sync.list` and `sync.changes` operations, which the Console and Agents can call too.

## Tables

Sync adds four tables to the default Database, else the only one:

| Table | Holds |
| --- | --- |
| `vitehub_sync_changes` | For each synced table, the newest change of each key, with its cursor. For each delete or move, an exit with the key and the scope columns as they were before, to check who may learn about it. |
| `vitehub_sync_columns` | The scope columns of each synced table. |
| `vitehub_sync_mutations` | The ids of applied writes and actions, so each applies once, and the result of each action. |
| `vitehub_sync_state` | The oldest cursor that the server still keeps for each table. |

The server removes write ids after 7 days and exits after 30 days. A browser with an older cursor gets every row again.
