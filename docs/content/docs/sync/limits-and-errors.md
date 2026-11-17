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

See the [Sync diagnostic catalog](/docs/sync/diagnostics) for causes and fixes.
