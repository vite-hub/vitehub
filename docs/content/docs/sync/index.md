---
title: Sync
layout: landing
navigation.title: Overview
description: Serve a table to the browser with a scope for each caller and an atomic change log. The server stays the authority for every row.
navigation.order: 1
icon: i-lucide-refresh-cw
---

::product-hero{tagline="Say which rows a person may see. Sync serves them, applies writes once and in order, and tells each caller what changed." hosts="Node, Docker, Cloudflare, Vercel, Netlify"}
  :::code-tree
  ```ts [server/sync/todos.ts] fragment
  import { defineSync } from 'vite-hub/sync'
  import { todos } from '../databases/default'

  // One file is one synced table, at /api/_vitehub/sync/todos
  export default defineSync({
    table: todos,
    where: ({ user }) => user ? { ownerId: user.id } : false,
  })
  ```

  ```bash [terminal]
  # The synced tables, and the last changes of one
  vitehub sync list
  vitehub sync changes todos
  ```
  :::
::

## What you get

| Part | What it does |
| --- | --- |
| One route | Each `server/sync/<name>.ts` gets `GET` to pull and `POST` to push at `/api/_vitehub/sync/<name>`. |
| Scope | `where` returns the rows that the caller may see. The server filters reads with it, writes its values into inserts, and refuses writes that change them. |
| Change log | Each write and its change apply in one transaction in the Database. A pull gets the rows that changed since its cursor. |
| Once only | Each write has an id. When a caller sends a write again, the server does not apply it twice. |
| Order | The writes of one push apply in the order that they were sent. |
| Inspection | `vitehub sync list` and `vitehub sync changes <name>`, and the `sync.list` and `sync.changes` operations. |

## Sync, Database, or Realtime

Does each person work on their own rows, and must the page work offline? Then use Sync. Does only server code read and write the table? Then use [Database](/docs/database). Do people send short messages or show who is online in a room? Then use [Realtime](/docs/realtime).

## Next

- [Get started](/docs/sync/get-started): serve a todo table and pull it.
- [Server API](/docs/sync/server-api): every option of `defineSync()`, the route, and the CLI.
- [Limits and errors](/docs/sync/limits-and-errors): what v1 does not do, and the `SYNC_*` codes.
