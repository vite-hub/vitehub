---
title: Comments operations limits and errors
description: "Message, mention, and attachment limits of comments operations, how threads get their numbers, and each COMMENTS error code."
navigation.title: Operations limits and errors
navigation.order: 24
icon: i-lucide-circle-alert
---

## Limits

| Limit | Value |
| --- | --- |
| Message length | 10,000 characters. |
| Mentions per message | 20. |
| Attachments per message | 10. Each file is at most 5 MB of `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `application/pdf`, or `text/plain`. |
| Thread `metadata` | 50 keys of up to 64 characters. Values are strings of up to 4,000 characters, numbers, booleans, or `null`. |
| Selector, quote | 2,048 and 2,000 characters. |
| Threads per `list` | 200 by default, 500 at most. Page with `before`. |
| Suggestions per `users` | 10, for a query of at least 2 characters. |
| Page subject id | 500 characters. An app path without `//`, `\`, whitespace, `?`, or `#`. |

## Numbering

Each scope has a counter in `vitehub_comment_counters`, advanced with one `UPDATE … SET next = next + 1 … RETURNING`. No two threads share a number, and numbers are never reused after a delete, so `?comment=3` always names one thread. A scope with threads from before the counter starts after its highest number. As a backstop, a unique index on `(scope, n)` refuses duplicates. The creator then tries the next number, up to 12 times, then gets `COMMENTS_R0011`.

A thread and its first message are written together: with `batch()` on libSQL and D1, in a transaction on Postgres. Other drivers write the message first and remove it if the thread fails, so a failure leaves nothing visible. Deleting a thread deletes its messages in the same batch.

## Errors

| Code | Status | Meaning |
| --- | --- | --- |
| `COMMENTS_R0002` | 404 | The thread is missing, or you may not read it. |
| `COMMENTS_R0003` | 404 | The message is not in the thread. |
| `COMMENTS_R0004` | 403 | Only the author can edit a message. |
| `COMMENTS_R0005` | 400 | The text is empty. |
| `COMMENTS_R0006` | 403 | `server/comments.ts` has no `authorize`, and the default policy refused a signed-in person that neither GitHub nor the Console checked. Add `authorize`. The overlay API returns `COMMENTS_POLICY_MISSING` here. |
| `COMMENTS_R0007` | 400 | A mention is not a real person, is not named in the text, or `canMention` refuses it. |
| `COMMENTS_R0008` | 400 | The subject kind is not defined. |
| `COMMENTS_R0009` | 403 | `authorize` returned false. |
| `COMMENTS_R0010` | 503 | The comments runtime is not installed. |
| `COMMENTS_R0011` | 409 | The scope's numbers stayed busy. Try again. |
| `COMMENTS_R0012` | 401 | Writing needs a signed-in user, or a guest name when the policy lets anonymous people write. |
| `COMMENTS_R0013` | 0 | The browser transport got no answer. |
| `COMMENTS_R0014` | 501 | `comments.upload` cannot store the file: the app has no Blob store and no `storeAttachment`. |
| `COMMENTS_R0015` | client | The paged list kept changing. Refresh again. The old cache stays. |
| `COMMENTS_R0016` | 409 | The thread is resolved and takes no replies. Reopen it, or pass `allowResolved` to `comments.reply()`. |
| `COMMENTS_R0017` | 400, 413, 415 | The file is empty, not Base64, over 5 MB, or of a type Comments does not attach. |
| `COMMENTS_R0018` | 400 | The `metadata`, page context, `revision`, attachment keys, or text are over the limits. |
| `COMMENTS_R0019` | 503 | The Database has old comment tables, or none. On a ViteHub Database, run the migration in [Upgrade to one model](/docs/comments/configure#upgrade-to-one-model). For the live-site tables, use the SQL of `commentsMigrationSql({ from: "live" })`. Otherwise run `vitehub database generate` and `vitehub database migrate`. |
| `COMMENTS_R0020` | 404 | No thread the caller may read has this attachment key, or the file is gone. |
| `COMMENTS_R0021` | 501 | `storeAttachment` is set, but `readAttachment` is missing, so files cannot be read back. |
| `COMMENTS_R0022` | 409 | Another thread of the scope already uses this `requestId`, and the caller did not start it, started it on another subject, or may not read it. Send a new `requestId` for a new comment. |
| `COMMENTS_B0001` | build | The app has `server/comments.ts` and sets `database: false`. |
| `COMMENTS_B0002` | build | `server/comments.ts` does not default-export `defineComments()`. |
| `COMMENTS_B0003` | build | The app adds `comments()` next to `vitehub()`. Remove `comments()` and set `vitehub({ comments: true })`, or add `server/comments.ts`. |

An input that does not match the schema fails with `INTERNAL_R0022`, which names the fields.
