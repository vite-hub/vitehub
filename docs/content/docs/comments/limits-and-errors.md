---
title: Comments limits and errors
description: Size limits, numbering, and the errors that comments raise.
navigation.title: Limits and errors
navigation.order: 5
icon: i-lucide-circle-alert
---

## Limits

| Limit | Value |
| --- | --- |
| Message length | 10,000 characters. |
| Mentions per message | 20. |
| Attachments per message | 10 Blob keys. |
| Selector, quote | 500 and 2,000 characters. |
| Threads per `list` | 1,000. |

## Numbering

The number of a thread is `max(n) + 1` inside its scope. A unique index on `(scope, n)` guards it. When two people create a thread at the same moment, one insert loses, reads the number again, and tries again, up to 12 times. This works on SQLite, libSQL, D1, and Postgres without transactions. A creator that cannot get a number gets `COMMENTS_R0011`.

A thread and its first message are two statements. If the message fails, the thread is removed again.

## Errors

| Code | Status | Meaning |
| --- | --- | --- |
| `COMMENTS_R0002` | 404 | The thread does not exist. |
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
| `COMMENTS_B0001` | build | The app has `server/comments.ts` and no Database. |
| `COMMENTS_B0002` | build | `server/comments.ts` does not default-export `defineComments()`. |

An input that does not match the schema fails with `INTERNAL_R0022` and names the fields.
