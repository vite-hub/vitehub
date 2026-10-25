---
title: Comments server API
description: The comments operations, their inputs, and the browser transport.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-server
---

## Operations

All operations belong to the Console section `comments`. Run them from the Console RPC, the CLI (`vitehub comments <command>`), MCP, or an agent with `operations({ include: ['comments.*'] })`.

| Operation | Kind | Input | Result |
| --- | --- | --- | --- |
| `comments.list` | read | `{ subject?, page?, status?, mine?, mentions? }` | `CommentThread[]`, ordered by number. |
| `comments.get` | read | `{ id }` or `{ scope, n }` | The thread, or `null`. |
| `comments.create` | write | `{ subject, anchor, body, mentions?, attachments? }` | The new thread. |
| `comments.reply` | write | `{ threadId, body, mentions?, attachments? }` | The thread. |
| `comments.edit` | write | `{ threadId, messageId, body, mentions? }` | The thread. Only the author. |
| `comments.delete` | destructive | `{ threadId, messageId? }` | The thread, or `null` when it is gone. |
| `comments.resolve` | write | `{ threadId }` | The thread. |
| `comments.reopen` | write | `{ threadId }` | The thread. |
| `comments.users` | read | `{ query, limit? }` | `CommentUser[]` to mention. |

Without `messageId`, `delete` removes the whole thread. Deleting the first message also removes the thread. Times are milliseconds since the epoch.

An anchor is one of `page`, `element`, `text`, `area`, and `image`. Offsets are thousandths of the element box, and an area stays inside it. The server checks the shape and rejects the rest with `INTERNAL_R0022`.

## Browser transport

```ts
import { createCommentsClient } from 'vite-hub/comments/client'
import { createRpcTransport } from 'vite-hub/comments/rpc'

const client = createCommentsClient({ transport: createRpcTransport({ base: '/portal' }) })
```

`createRpcTransport({ base?, fetch? })` implements `CommentsTransport` over `POST /_vitehub/rpc/__call` with the session cookie. It has no `subscribe`, so the client refreshes when the window gets focus. A failure throws `CommentsRpcError` with `code`, `message`, `fix`, and `status`.

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
| `vite-hub/comments/database` | `commentsSchema` for SQLite, libSQL, and D1. |
| `vite-hub/comments/database/postgres` | `commentsPostgresSchema`. |
| `vite-hub/comments/server` | `installComments()` and `createCommentsStore()`, for apps that wire the runtime themselves. |
