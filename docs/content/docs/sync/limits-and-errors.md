---
title: Sync limits and errors
description: What Sync v1 does not do, its fixed limits, and the SYNC error codes that a pull, a push, or one write can get.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limits

| Limit | Value |
| --- | --- |
| Writes in one push | 100. The client sends a longer queue in parts. |
| Changes in one pull | 500. The client pulls again until it has all. |
| Pull while the page shows | Every 30 seconds. Set `interval` in `useSync()`. |
| Retry after a network or server error | 1 second, doubling to 30 seconds, with a random part. At once when the network comes back. |
| Write ids that the server keeps | 7 days |
| Deletes that the server keeps | 30 days. An older cursor gets every row again. |

## Not in v1

- **Postgres.** Sync works with SQLite: libSQL, Cloudflare D1, and the local default Database.
- **Server push.** The client pulls when the page shows, when the network comes back, on a timer, and after each write. Another person's change can take up to `interval` to show.
- **Conflicts.** The last write wins for each column, in the order that the server got them. There is no merge of text.
- **Queries.** The browser gets every row of its scope. There is no paging or filter beyond `where`.
- **Server-side rendering.** On the server, `rows` is empty and `status` is `idle`. The rows show after the page loads in the browser.
- **Console section.** Use `vitehub sync list` and `vitehub sync changes`.

## Browser storage

The rows and the queue are in the IndexedDB database `vitehub-sync`. When IndexedDB does not open, such as in some private windows, they stay in memory and `persisted` is `false`: a reload then loses the writes that wait. Call `clearSync()` on sign-out, so the next person on the device does not see the rows.

## Errors

A pull or push error shows in `error` and `status`. A refused write shows in `failures` and rejects its `SyncWrite`. Each error has a `code`.

### SYNC_UNAUTHORIZED

`where` returned `false` and the caller has no user. The client keeps its queue. Sign the person in, then call `refresh()`.

### SYNC_FORBIDDEN

`where` returned `false` for a signed-in user. Check `where`, or show the page only to people who may use it.

### SYNC_SCOPE_CHANGED

The writes were made for another scope, such as before a sign-in as another person. They are never sent, and they show in `failures`. `retry()` keeps them there. Show them to the person, then `dismiss()` them.

### SYNC_READ_ONLY

The definition has `write: false`, or its `write` function returned `false` for this write.

### SYNC_INVALID

The row did not pass `schema`, or the write has a column that the table does not have. `issues` tells each problem. Fix the value, then write again or call `retry()`.

### SYNC_NOT_FOUND

An update found no row with this key in the caller's scope. Another person may have deleted it.

### SYNC_KEY_EXISTS

An insert used a key that a row already has. Let the client make the key.

### SYNC_OUT_OF_SCOPE

A write set a `where` column to another value, such as `ownerId` of another person. Leave the scope columns out: the server writes them.

### SYNC_TOO_MANY_MUTATIONS

A push had more than 100 writes. The client splits its queue, so only your own requests to the route get this.

### SYNC_BAD_REQUEST

The request is not a valid pull or push. The writes of a refused push go to `failures`, since sending them again gives the same answer.

### SYNC_NETWORK

The client got no answer. `status` is `offline`, and the client tries again later. Only the browser makes this code.

### SYNC_SERVER_ERROR

The server answered with a status of 500 or more. The client tries again later. Read the server log. Only the browser makes this code.
