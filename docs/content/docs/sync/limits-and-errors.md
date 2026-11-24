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
| Push Database call budget | 40, where a batch is one call. The budget does not count request setup or stop the first mutation. The browser sends any mutations without results in its next push. On the Workers Free plan, D1 allows 50 calls in an invocation. |
| Changes in one pull | 500. The client pulls again until it has all. |
| Rows in one page of a full snapshot | 500, by key. The first pull, a new table version, or an old cursor gets every row in pages, so no answer holds the whole table. A reload goes on from the last stored page. |
| Values in a `where` list | No fixed limit. A list is one SQL parameter, also on D1. |
| Live stream | The server sends `: open` at once, checks the change log every second, sends `: ping` every 15 seconds, and ends the stream after 25 seconds. A push in the same server process wakes the stream at once. The browser opens a new one at once. |
| Database calls of one live stream | 40, where a batch is one call. A check makes at most 3. The server ends the stream before a check could pass 40, and the browser opens a new one, which is a new Worker invocation. On the Workers Free plan, D1 allows 50 calls in an invocation. |
| Live streams per browser | One for each tab that shows, for all the synced tables and subsets of the tab. A table or subset that two tabs show streams in one of them. |
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
- **Dropping a column.** Sync needs a primary key. Before dropping a scope column (used by `subsets` or returned by `where`) or a column in a unique index, drop the table's Sync triggers in the same migration. For a scope column, remove it from `where` and `subsets` and delete its row from `vitehub_sync_columns`, as shown for `issues.team_id` below. Separately, remove SQLite schema dependencies before `DROP COLUMN`: for example, drop any standalone index that references the column. If a table constraint still references it, you may need to rebuild the table. Sync adds its triggers again at its next request, and each browser gets every row again.

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
- **One connection for all tabs.** Each tab that shows has its own live stream. A table or subset that two tabs show streams in one of them, and the other tab reads its changes from IndexedDB. There is no SharedWorker.
- **Server-side rendering.** On the server, `rows` is empty and `status` is `idle`. The rows show after the page loads in the browser.
- **Console section.** Use `vitehub sync list` and `vitehub sync changes`.

## Browser storage

The rows and the queue are in the IndexedDB database `vitehub-sync`, with one copy for each synced table and subset. When IndexedDB does not open, such as in some private windows, they stay in memory and `persisted` is `false`: a reload then loses the writes that wait. Clear them on sign-out so the next person on the device does not see the rows. ViteHub Auth in Nuxt calls `clearSync({ keepWrites: true })` on sign-out, which clears cached rows and keeps queued writes for their account; call `clearSync()` without `keepWrites: true` to drop queued writes too. See [Accounts and sign-out](/docs/sync/vue#accounts-and-sign-out).

When the table of a definition changes, such as after a deploy that adds a column, the client drops the rows that it stored for that definition and pulls them again. The writes that wait stay and go out.

## Errors

A pull, push, or live stream error shows in `error` and `status`. A refused write or action shows in `failures` and rejects its `SyncWrite`. Each error has a `code`.

See the [Sync diagnostic codes](/docs/sync/diagnostics) for each error and its fix.
