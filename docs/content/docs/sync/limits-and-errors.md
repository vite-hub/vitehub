---
title: Sync limits and errors
description: What Sync does not do yet, its fixed limits, and the SYNC error codes that a pull, a push, a live stream, or one write can get.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limits

| Limit | Value |
| --- | --- |
| Writes in one push | 100. The client sends a longer queue in parts. |
| Changes in one pull | 500. The client pulls again until it has all. |
| Values in a `where` list | No fixed limit. A list is one SQL parameter, also on D1. |
| Live stream | The server sends `: open` at once, checks the change log every second, sends `: ping` every 15 seconds, and ends the stream after 25 seconds. A push in the same server process wakes the stream at once. The browser opens a new one at once. |
| Live streams per browser | One per synced table or subset, in a tab that shows. |
| Pull while the page shows | Every 30 seconds. Set `interval` in `useSync()`. Every 5 minutes at most while the live stream is open. |
| Retry after a network or server error | 1 second, doubling to 30 seconds, with a random part. At once when the network comes back. |
| Write ids and action results that the server keeps | 7 days. A retry after that applies the write again. |
| Deletes and moves that the server keeps | 30 days. An older cursor gets every row again. |

## Not in Sync yet

- **Relations.** A row of one definition does not load the rows that it points to in another definition. Use one `useSync()` for each table, with a subset where it helps.
- **Postgres.** Sync works with SQLite: libSQL, Cloudflare D1, and the local default Database.
- **Conflicts.** The last write wins for each column, in the order that the server got them. There is no conflict check beyond that.
- **Text merge.** Two people who edit one text field at the same time do not merge: the last write wins. There are no CRDT text fields.
- **Transactions in actions.** An action reads and then writes. The two steps are not one transaction, because D1 has no interactive transactions. When another write changes a row that the action read, the server runs the action function again, up to 3 times. Only its writes apply once, so put effects outside them, such as an email, in a [Queue](/docs/queue) job.
- **Dropping a scope column.** The triggers read the scope columns: the columns of `subsets` and each column that a `where` result returned. A migration that drops one of them fails with `error in trigger vitehub_sync_<table>_... after drop column`. Put these statements before the drop in the same migration, here for the column `team_id` of the table `issues`, and remove the column from `where` and `subsets`. Sync adds the triggers again at its next request, and each browser gets every row again.

  ```sql
  DROP TRIGGER IF EXISTS vitehub_sync_issues_insert;
  DROP TRIGGER IF EXISTS vitehub_sync_issues_update;
  DROP TRIGGER IF EXISTS vitehub_sync_issues_delete;
  DROP TRIGGER IF EXISTS vitehub_sync_issues_replace_insert;
  DROP TRIGGER IF EXISTS vitehub_sync_issues_replace_update;
  DELETE FROM vitehub_sync_columns WHERE table_name = 'issues' AND "column" = 'team_id';
  ```
- **Unique indexes on expressions.** `INSERT OR REPLACE` removes a row that has the same value in a unique column, and the triggers send that to the old scope. A unique index on an expression, such as `lower(email)`, has no column name, so a row that it replaces stays in the old scope. Use an upsert, such as Drizzle's `onConflictDoUpdate()`.
- **Queries.** The browser gets every row of its scope or subset. There is no paging or filter beyond `where` and subsets.
- **Offline files.** Sync keeps rows, not files. Use [Blob](/docs/blob) for files.
- **An app shell offline.** Sync keeps data. Loading the page itself offline needs a service worker, which Sync does not add.
- **One connection for all tabs.** Each tab has its own store. One tab holds the live stream, and the other tabs read the changes from IndexedDB. There is no SharedWorker.
- **Server-side rendering.** On the server, `rows` is empty and `status` is `idle`. The rows show after the page loads in the browser.
- **Console section.** Use `vitehub sync list` and `vitehub sync changes`.

## Browser storage

The rows and the queue are in the IndexedDB database `vitehub-sync`, with one copy for each synced table and subset. When IndexedDB does not open, such as in some private windows, they stay in memory and `persisted` is `false`: a reload then loses the writes that wait. Clear them on sign-out, so the next person on the device does not see the rows, and the writes of other accounts go away. ViteHub Auth in Nuxt does this for you. See [Accounts and sign-out](/docs/sync/vue#accounts-and-sign-out).

When the table of a definition changes, such as after a deploy that adds a column, the client drops the rows that it stored for that definition and pulls them again. The writes that wait stay and go out.

## Errors

A pull, push, or live stream error shows in `error` and `status`. A refused write or action shows in `failures` and rejects its `SyncWrite`. Each error has a `code`.

### SYNC_UNAUTHORIZED

`where` returned `false` and the caller has no user. The client keeps its queue, and the writes are not failures. Sign the person in, then call `refresh()`. A live stream that gets this code ends, and the next pull shows it.

### SYNC_FORBIDDEN

`where` returned `false` for a signed-in user, `write` refused the write, or a visitor wrote to a definition without `write`. Without `write`, only a caller with a user writes: sign the person in, or set `write: true` to let visitors write. Check `where`, or show the page only to people who may use it.

### SYNC_ACCOUNT_CHANGED

The push had writes of another account, such as after a sign-in as another person in another tab. The server wrote nothing. The client keeps the writes in IndexedDB, pulls the rows of the new account, and sends the writes when their account signs in again. They are not in `rows`, `queued`, or `failures` meanwhile. `clearSync()` drops them. A push of the same account after a team change is not refused: it applies under the current `where`.

### SYNC_READ_ONLY

The definition has `write: false`, so the browser cannot insert, update, or delete rows. Actions still run. A `write` function that returns `false` gives `SYNC_FORBIDDEN`.

### SYNC_INVALID

The row did not pass `schema`, the write has a column that the table does not have, or the action name is unknown. `issues` tells each problem. Fix the value, then write again or call `retry()`.

### SYNC_NOT_FOUND

An update found no row with this key in the caller's scope. Another person may have deleted it.

### SYNC_KEY_EXISTS

An insert used a key that a row already has. Let the client make the key.

### SYNC_OUT_OF_SCOPE

A write set a `where` column to a value that `where` does not allow, such as `ownerId` of another person or a team that the caller is not in. Leave the single values of `where` out: the client and the server write them. For a column with a list in `where`, such as `teamId`, use one of its values. A pull or a live stream gets 403 with this code when its subset is outside `where`, and the store shows it as `error`.

### SYNC_ACTION_REFUSED

An action called `refuse(message)` or threw, so none of its writes applied. After `refuse(message)`, the message is `message`. After a thrown error, the message is the message of the error when it is a ViteHub error, an error with an HTTP status below 500, or a schema error with `issues`. Else it is "The action failed.", and the server log has the error. The optimistic change of the action goes away. Change the arguments, then `retry()` the failure, or `dismiss()` it.

### SYNC_TOO_MANY_MUTATIONS

A push had more than 100 writes. The client splits its queue, so only your own requests to the route get this.

### SYNC_BAD_REQUEST

The request is not a valid pull or push, its subset is not single column values, its subset uses a column that is not in `subsets` or `where`, or it asks for a live stream of a definition with `live: false`. For a subset column, add it to `subsets` in `server/sync/<name>.ts`. The writes of a refused push go to `failures`, since sending them again gives the same answer. After a live request gets this code, the client stops the live stream and only pulls.

### SYNC_NETWORK

The client got no answer. `status` is `offline`, and the client tries again later. Only the browser makes this code.

### SYNC_CLEARED

`clearSync()` dropped the write before the server confirmed it. Only the browser makes this code.

### SYNC_SERVER_ERROR

The server answered with a status of 500 or more. The client tries again later. Read the server log. Only the browser makes this code.
