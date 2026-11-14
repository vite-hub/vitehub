---
title: Build a todo list that works offline
description: Sync a todo table to the browser with ViteHub. Rows show at once, writes wait offline, and a reload keeps them.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You need a ViteHub app with Vue or Nuxt from [Installation](/docs/getting-started/installation). Run the commands from its root.

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

Sync needs a SQLite table with one text primary key. The browser makes the keys with `crypto.randomUUID()`, so a new row has its key before the server sees it.

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

::tutorial-step{title="Show the rows"}
## Show the rows

Nuxt imports `useSync()` for you. In a Vue app without Nuxt, import it from `vite-hub/sync/vue`.

```vue [app/pages/todos.vue] fragment
<script setup lang="ts">
const todos = useSync('todos')
const title = ref('')

function add() {
  todos.insert({ title: title.value })
  title.value = ''
}
</script>

<template>
  <form @submit.prevent="add">
    <input v-model="title" aria-label="New todo">
    <button>Add</button>
  </form>
  <ul>
    <li v-for="todo in todos.rows" :key="todo.id">
      <label>
        <input type="checkbox" :checked="todo.done" @change="todos.update(todo.id, { done: !todo.done })">
        {{ todo.title }}
      </label>
      <button @click="todos.delete(todo.id)">Delete</button>
    </li>
  </ul>
  <p v-if="todos.queued">{{ todos.queued }} changes wait for the network</p>
</template>
```

Start the dev server with `pnpm dev` and open `/todos`. Add a todo. It shows at once, and the server stores it a moment later.

::

::tutorial-step{title="Go offline"}
## Go offline

Open the browser's developer tools, go to **Network**, and set it to **Offline**. Add two todos and tick one. The page shows them, and `todos.queued` counts 3.

Reload the page while you are still offline. The todos are still there: the rows and the queued writes are in IndexedDB.

Set the network back to **No throttling**. The client sends the 3 writes in order, and `todos.queued` goes to 0. Open the page in a second tab: it shows the same rows.

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

Each person now sees only their own todos. A new todo gets `ownerId` from the server, and the browser shows it with that value at once. Call `clearSync()` when a person signs out, so the next person on the device does not see the rows. See [Vue](/docs/sync/vue#sign-out).

::
