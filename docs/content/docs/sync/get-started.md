---
title: Serve a todo table with Sync
description: Serve a todo table with ViteHub Sync, write a row, and pull what changed since a cursor.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You need a ViteHub app from [Installation](/docs/getting-started/installation). Run the commands from its root.

::tutorial-step{title="Install Sync"}
## Install Sync

Install Sync and the Database packages that store the rows:

```bash [commands/install]
pnpm add @vite-hub/sync @vite-hub/database drizzle-orm
pnpm add -D drizzle-kit
```

::

::tutorial-step{title="Write the table"}
## Write the table

Sync needs a SQLite table with one text primary key. The caller makes the keys, such as with `crypto.randomUUID()`, so a new row has its key before the server sees it.

```ts [server/databases/default.ts] fragment
import { defineDatabase } from 'vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const todos = sqliteTable('todos', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().default(''),
  title: text('title').notNull(),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
})

export default defineDatabase({ schema: { todos } })
```

If your app already has `server/databases/default.ts`, add `todos` to its `schema`.

::

::tutorial-step{title="Sync the table"}
## Sync the table

Create `server/sync/todos.ts`. The file name is the Sync name. `where` returns the rows that the caller may see. `{}` is every row:

```ts [server/sync/todos.ts] fragment
import { defineSync } from 'vite-hub/sync'
import { todos } from '../databases/default'

export default defineSync({
  table: todos,
  where: () => ({}),
})
```

The folder `server/sync/` turns Sync and the Database on. Sync adds its own tables to the default Database. Write and apply the migration:

```bash [commands/migrate]
vitehub database generate
vitehub database migrate
```

::

::tutorial-step{title="Pull the rows"}
## Pull the rows

Start the dev server with `pnpm dev`. Then pull the table:

```bash [commands/pull]
curl http://localhost:3000/api/_vitehub/sync/todos
```

The answer has the rows, a `cursor`, and the `scope` of the caller. The table is empty, so `rows` is `[]`. Keep `scope.id` and `cursor` for the next steps.

::

::tutorial-step{title="Write a row"}
## Write a row

Push one insert. Put the `scope.id` and `cursor` of the pull into the body:

```bash [commands/push]
curl -X POST http://localhost:3000/api/_vitehub/sync/todos \
  -H 'content-type: application/json' \
  -d '{"scope":"<scope.id>","cursor":0,"mutations":[{"id":"write-1","op":"insert","value":{"id":"todo-1","title":"Buy milk"}}]}'
```

The result of the write is `applied`, and `pull.rows` has the new todo. Send the same command again: the result is `duplicate`, and the server does not write the row twice.

::

::tutorial-step{title="Inspect it"}
## Inspect it

List the synced tables, and the last changes of one:

```bash [commands/inspect]
vitehub sync list
vitehub sync changes todos
```

A change shows the key, `put` or `delete`, and the time. It does not show row data.

::

::tutorial-step{title="Give each person their rows"}
## Give each person their rows

Turn on [Auth](/docs/auth). Then return the rows of the signed-in person, and refuse a visitor:

```ts [auth/server/sync/todos.ts] fragment
import { defineSync } from 'vite-hub/sync'
import { todos } from '../databases/default'

export default defineSync({
  table: todos,
  where: ({ user }) => user ? { ownerId: user.id } : false,
})
```

Each person now sees only their own todos. A new todo gets `ownerId` from the server. A visitor gets 401 `SYNC_UNAUTHORIZED`.

::
