---
title: Comments limits and errors
description: Size limits, numbering, and the errors that comments raise.
navigation.title: Operations limits and errors
navigation.order: 24
icon: i-lucide-circle-alert
---

## Limits

| Limit | Value |
| --- | --- |
| Message length | 10,000 characters. |
| Mentions per message | 20. |
| Attachments per message | None yet: only an empty list. |
| Selector, quote | 500 and 2,000 characters. |
| Threads per `list` | 200 by default, 500 at most. Page with `before`. |
| Suggestions per `users` | 10, for a query of at least 2 characters. |
| Page subject id | 500 characters, an app path without `//`, `\`, whitespace, `?`, or `#`. |

## Numbering

Each scope has a counter in `vitehub_comment_counters`. A creator advances it with one `UPDATE … SET next = next + 1 … RETURNING`, so two creators never share a number, and a number is never used twice, also after a delete: `?comment=3` keeps naming one thread. A scope with threads from before the counter starts after its highest number. A unique index on `(scope, n)` is the backstop: if it refuses a number, the creator takes the next one, up to 12 times, and then gets `COMMENTS_R0011`.

A thread and its first message are written together: with `batch()` on libSQL and D1, and in a transaction on Postgres. A driver with neither writes the message first and removes it if the thread fails, so a failure leaves nothing visible. Deleting a thread deletes its messages in the same batch.

## Errors

| Code | Status | Meaning |
| --- | --- | --- |
| `COMMENTS_R0002` | 404 | The thread does not exist, or you may not read it. |
| `COMMENTS_R0003` | 404 | The message does not exist in the thread. |
| `COMMENTS_R0004` | 403 | Only the author can edit a message. |
| `COMMENTS_R0005` | 400 | The text is empty. |
| `COMMENTS_R0006` | 403 | `server/comments.ts` has no `authorize`, so nobody can read or write. |
| `COMMENTS_R0007` | 400 | A mention is not a real person, or the text does not name them. |
| `COMMENTS_R0008` | 400 | The subject kind is not defined. |
| `COMMENTS_R0009` | 403 | `authorize` returned false. |
| `COMMENTS_R0010` | 503 | The comments runtime is not installed. |
| `COMMENTS_R0011` | 409 | The numbers of the scope stayed busy. Try again. |
| `COMMENTS_R0012` | 401 | Writing needs a signed-in user. |
| `COMMENTS_R0013` | 0 | The browser transport got no answer. |
| `COMMENTS_R0014` | 400 | The comment has attachments, which are not supported yet. |
| `COMMENTS_R0015` | client | The paged list kept changing. Refresh again; the previous cache is preserved. |
| `COMMENTS_B0001` | build | The app has `server/comments.ts` and sets `database: false`. |
| `COMMENTS_B0002` | build | `server/comments.ts` does not default-export `defineComments()`. |

An input that does not match the schema fails with `INTERNAL_R0022` and names the fields.
