---
title: Comments operations reference
description: "Each comments.* operation with its input and result, how to page through threads, the anchor shapes, and the browser transport."
navigation.title: Operations server API
navigation.order: 23
icon: i-lucide-server
---

## Operations

All operations belong to the Console section `comments`. Run them from the Console RPC, the CLI (`vitehub comments <command>`), MCP, or an agent with `operations({ include: ['comments.*'] })`.

| Operation | Kind | Input | Result |
| --- | --- | --- | --- |
| `comments.list` | read | `{ subject?, subjectKind?, page?, status?, mine?, mentions?, revision?, limit?, before? }` | `CommentThread[]`, newest first. |
| `comments.get` | read | `{ id }` or `{ scope, n }` | The thread, or `null` when it is missing or you may not read it. |
| `comments.create` | write | `{ subject, anchor, body, mentions?, attachments?, metadata?, revision?, requestId? }` | The new thread. A retry by the same author with the same `requestId` and subject returns the first thread. Another author or subject with that key gets `409` `COMMENTS_R0022`. |
| `comments.reply` | write | `{ threadId, body, mentions?, attachments? }` | The thread. |
| `comments.edit` | write | `{ threadId, messageId, body, mentions? }` | The thread. Author only. |
| `comments.delete` | destructive | `{ threadId, messageId? }` | The thread, or `null` when it is gone. |
| `comments.resolve` | write | `{ threadId }` | The thread. |
| `comments.reopen` | write | `{ threadId }` | The thread. |
| `comments.users` | read | `{ query, limit?, threadId?, subject? }` | Up to 10 `{ id, name, image }` to mention. A `query` under 2 characters gives `[]`. Needs the `write` right. |
| `comments.upload` | write | `{ name, type, data, subject? }`, `data` in Base64 | `{ key, name, type, size }`. Not an MCP tool. |
| `comments.attachment` | read | `{ key }` | `{ key, name, type, size, inline, data }`, `data` in Base64. The caller must be able to read a thread that lists the key. Not an MCP tool. |
| `comments.session` | read | `{ subject? }` | `{ user, canRead, canWrite }` for a comment UI. |

See [Attach files](/docs/comments/configure#attach-files). The overlay API serves the same actions over [HTTP routes](/docs/comments/server-api#http-routes).

A `page` subject id is an app path: one leading `/`, no second `/` or `\`, no whitespace, `?`, or `#`, and at most 500 characters.

### Paging

`list` returns up to `limit` threads (default 200, max 500), newest first by `updatedAt`, then `id`. For the next page, pass the last thread as `before`: `{ before: { updatedAt, id } }`. `list` reads until it has `limit` threads you may read, so a shorter page is the last one. The database filters `mentions`, so it does not count against `limit`.

`delete` removes the whole thread without `messageId`, or when the message is the first one. Times are milliseconds since the epoch.

An anchor is `page`, `element`, `text`, `area`, or `image`. Offsets are thousandths of the element box, and an area stays inside it. The server rejects other shapes with `INTERNAL_R0022`.

## Browser transport

```ts
import { createCommentsClient } from 'vite-hub/comments/client'
import { createRpcTransport } from 'vite-hub/comments/rpc'

const client = createCommentsClient({ transport: createRpcTransport({ base: '/portal' }) })
```

`createRpcTransport({ base?, fetch? })` implements `CommentsTransport` over `POST /_vitehub/rpc`, one birpc call for each request. It has no `subscribe`, so the client refreshes on window focus. A failure throws `CommentsRpcError` with `code`, `message`, `fix`, and `status`.

> [!WARNING]
> `createRpcTransport()` is for development only. A browser cannot sign Console calls, so it works only on a development server with `console: { auth: false }` or without the `console` option. In production, the app takes only [signed calls](/docs/development/console#sign-console-requests) on `/_vitehub/rpc`.

Your pages use [`createRestTransport()`](/docs/comments/server-api#rest-transport) from `vite-hub/comments/client`. It calls the same actions and policy through the Comments API, for signed-in users, guests, and share link readers, and adds `upload` and `attachmentUrl(key)`.

Without `limit`, the client loads every page. A multi-page refresh replaces the cache only after two scans match, so a thread updated mid-scan shows its current contents. After three scans that do not match, refresh fails with `COMMENTS_R0015` and keeps the old cache. With `limit`, the client makes one request.

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
| `vite-hub/comments/rpc` | `createRpcTransport()`, for development only. |
| `vite-hub/comments/database` | `commentsSchema` for SQLite, libSQL, and D1, and `migrateComments()`. |
| `vite-hub/comments/database/postgres` | `commentsPostgresSchema`. |
| `vite-hub/comments/server` | `installComments()` and `createCommentsStore()`, for apps that wire the runtime by hand. |
