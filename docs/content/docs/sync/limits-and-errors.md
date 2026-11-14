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
| Writes in one push | 100 |
| Changes in one pull | 500. `more` is `true` when the server has more. Pull again with the new `cursor`. |
| Write ids that the server keeps | 7 days |
| Deletes that the server keeps | 30 days. An older cursor gets every row again. |

## Not in v1

- **Postgres.** Sync works with SQLite: libSQL, Cloudflare D1, and the local default Database.
- **Server push.** The server does not tell a caller about a change. The caller pulls again.
- **Conflicts.** The last write wins for each column, in the order that the server got them. There is no merge of text.
- **Queries.** A pull gets every row of the scope. There is no paging or filter beyond `where`.
- **Console section.** Use `vitehub sync list` and `vitehub sync changes`.

## Errors

A refused pull or push answers with the ViteHub error body and a `SYNC_*` code. A refused write in a push has the status `rejected` and its own `error`. The other writes of the push still apply.

### SYNC_UNAUTHORIZED

`where` returned `false` and the caller has no user. Sign the person in, then pull again.

### SYNC_FORBIDDEN

`where` returned `false` for a signed-in user, or a push came from another origin. Check `where`, or show the page only to people who may use it.

### SYNC_SCOPE_CHANGED

The writes were made for another scope, such as before a sign-in as another person. The server wrote nothing. Pull again without a cursor, and do not send the writes of the old scope.

### SYNC_READ_ONLY

The definition has `write: false`, or its `write` function returned `false` for this write.

### SYNC_INVALID

The row did not pass `schema`, or the write has a column that the table does not have. `issues` tells each problem. Fix the value, then write again.

### SYNC_NOT_FOUND

An update found no row with this key in the caller's scope. Another person may have deleted it.

### SYNC_KEY_EXISTS

An insert used a key that a row already has. Make a new key with `crypto.randomUUID()`.

### SYNC_OUT_OF_SCOPE

A write set a `where` column to another value, such as `ownerId` of another person. Leave the scope columns out: the server writes them.

### SYNC_TOO_MANY_MUTATIONS

A push had more than 100 writes. Send them in parts of 100 or fewer.

### SYNC_BAD_REQUEST

The request is not a valid pull or push. Sending it again gives the same answer.
