---
title: Comments server API
description: The comments operations, their inputs, and the browser transport.
navigation.title: Operations server API
navigation.order: 23
icon: i-lucide-server
---

## Operations

All operations belong to the Console section `comments`. Run them from the Console RPC, the CLI (`vitehub comments <command>`), MCP, or an agent with `operations({ include: ['comments.*'] })`.

| Operation | Kind | Input | Result |
| --- | --- | --- | --- |
| `comments.list` | read | `{ subject?, subjectKind?, page?, status?, mine?, mentions?, revision?, limit?, before? }` | `CommentThread[]`, newest first. |
| `comments.get` | read | `{ id }` or `{ scope, n }` | The thread, or `null` when it does not exist or you may not read it. |
| `comments.create` | write | `{ subject, anchor, body, mentions?, attachments?, metadata?, revision? }` | The new thread. |
| `comments.reply` | write | `{ threadId, body, mentions?, attachments? }` | The thread. |
| `comments.edit` | write | `{ threadId, messageId, body, mentions? }` | The thread. Only the author. |
| `comments.delete` | destructive | `{ threadId, messageId? }` | The thread, or `null` when it is gone. |
| `comments.resolve` | write | `{ threadId }` | The thread. |
| `comments.reopen` | write | `{ threadId }` | The thread. |
| `comments.users` | read | `{ query, limit?, threadId?, subject? }` | Up to 10 `{ id, name, image }` to mention. A `query` under 2 characters gives `[]`, and it needs the right to `write`. |
| `comments.upload` | write | `{ name, type, data, subject? }`, `data` in Base64 | `{ key, name, type, size }`. Not an MCP tool. |
| `comments.attachment` | read | `{ key }` | `{ key, name, type, size, inline, data }`, `data` in Base64, for a caller who may read a thread that lists the key. Not an MCP tool. |
| `comments.session` | read | `{ subject? }` | `{ user, canRead, canWrite }`, for a comment UI. |

See [Attach files](/docs/comments/configure#attach-files). The overlay API serves the same actions over HTTP: see [HTTP routes](/docs/comments/server-api#http-routes).

A `page` subject id is an app path: one `/`, then no second `/` or `\`, no whitespace, `?`, or `#`, and at most 500 characters.

### Paging

`list` returns an array, newest first (by `updatedAt`, then `id`), at most `limit` threads (default 200, at most 500). For the next page pass the last thread of the page as `before`: `{ before: { updatedAt, id } }`. A page shorter than `limit` is the last one, because `list` keeps asking for threads until it has `limit` that you may read or the threads end. `mentions` is filtered in the database, so it does not count against `limit`.

Without `messageId`, `delete` removes the whole thread. Deleting the first message also removes the thread. Times are milliseconds since the epoch.

An anchor is one of `page`, `element`, `text`, `area`, and `image`. Offsets are thousandths of the element box, and an area stays inside it. The server checks the shape and rejects the rest with `INTERNAL_R0022`.

## Browser transport

```ts
import { createCommentsClient } from 'vite-hub/comments/client'
import { createRpcTransport } from 'vite-hub/comments/rpc'

const client = createCommentsClient({ transport: createRpcTransport({ base: '/portal' }) })
```

`createRpcTransport({ base?, fetch? })` implements `CommentsTransport` over `POST /_vitehub/rpc/__call` with the session cookie. It needs Console access to the Comments section. It has no `subscribe`, so the client refreshes when the window gets focus. A failure throws `CommentsRpcError` with `code`, `message`, `fix`, and `status`.

For people without Console access, such as guests and readers of a share link, use [`createRestTransport()`](/docs/comments/server-api#rest-transport) from `vite-hub/comments/client`. It calls the same actions through the Comments API, with the same policy, and adds `upload` and `attachmentUrl(key)`.

Without an explicit `limit`, the client loads every page. For a multi-page refresh, it requires two matching scans before replacing its cache, so a thread updated across a cursor is included with its current contents. After three scans without agreement, refresh fails with `COMMENTS_R0015` and keeps the previous cache. An explicit `limit` makes a single request.

## From the CLI

```bash [Terminal]
pnpm vitehub comments list --status open
pnpm vitehub comments get --scope site --n 3
pnpm vitehub comments resolve --thread-id thread_123
```

## Imports

| Import | Holds |
| --- | --- |
| `vite-hub/comments` | `defineComments()`, `defineCommentSubject()`, and the types. |
| `vite-hub/comments/client` | Anchors and the client. |
| `vite-hub/comments/rpc` | `createRpcTransport()`. |
| `vite-hub/comments/database` | `commentsSchema` for SQLite, libSQL, and D1, and `migrateComments()`. |
| `vite-hub/comments/database/postgres` | `commentsPostgresSchema`. |
| `vite-hub/comments/server` | `installComments()` and `createCommentsStore()`, for apps that wire the runtime themselves. |
