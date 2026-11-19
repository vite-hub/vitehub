---
title: Build a todo list that works offline
description: Sync a todo table to the browser with ViteHub. Rows show right away, edits queue offline, and reloads keep your data.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Start with a Vue or Nuxt app from [Installation](/docs/getting-started/installation) and run commands from its root.

::tutorial-step{title="Install Sync"}
## Install Sync

Install Sync and the Database packages that store the rows:

```bash [commands/install]
pnpm add @vite-hub/sync @vite-hub/database drizzle-orm@1.0.0-rc.5
pnpm add -D drizzle-kit@1.0.0-rc.5
```

::

::tutorial-step{title="Write the table"}
## Write the table

Sync needs a SQLite table with one text primary key. The browser makes keys with `crypto.randomUUID()`, so a new row has its key before the server sees it.

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

Create `server/sync/todos.ts`. The file name is the Sync name. `where` returns the rows that the caller can see. `{}` matches every row. By default, a caller without a user cannot write, so `write: import.meta.dev` lets visitors write on the dev server only. A production build of this step is read-only:

```ts [server/sync/todos.ts] fragment
import { defineSync } from 'vite-hub/sync'
import { todos } from '../databases/default'

export default defineSync({
  table: todos,
  where: () => ({}),
  write: import.meta.dev,
})
```

The folder `server/sync/` turns on Sync and the Database. Sync adds its own tables to the default Database. Generate and apply the migration:

```bash [commands/migrate]
vitehub database generate
vitehub database migrate
```

::

::tutorial-step{title="Show the rows"}
## Show the rows

Nuxt auto-imports `useSync()`. In a Vue app without Nuxt, import it from `vite-hub/sync/vue`.

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

Start the dev server with `pnpm dev` and open `/todos`. Add a todo. It appears immediately and saves to the server in the background. Open `/todos` in a second browser too, and any todo you add in one shows up in the other within about a second.

::

::tutorial-step{title="Go offline"}
## Go offline

Open the browser's developer tools, select **Network**, and switch to **Offline**. Add two todos and check one off. The page updates immediately, and `todos.queued` reports `3`.

Reload the page while offline. Your todos stay on screen because the rows and queued writes live in IndexedDB.

Set the network back to **No throttling**. The client sends the 3 writes in order, and `todos.queued` drops to `0`. Open the page in a second tab to confirm it shows the same rows.

::

::tutorial-step{title="Inspect it"}
## Inspect it

List your synced tables and the latest changes for `todos`:

```bash [commands/inspect]
vitehub sync list
vitehub sync changes todos
```

Each entry prints the key, `put`, `delete`, or `move`, and the time. It does not show row data.

::

::tutorial-step{title="Give each person their rows"}
## Give each person their rows

Turn on [Auth](/docs/auth), then return only the signed-in user's rows, reject anonymous visitors, and remove `write`. Without `write`, only signed-in users can write:

```ts [auth/server/sync/todos.ts] fragment
import { defineSync } from 'vite-hub/sync'
import { todos } from '../databases/default'

export default defineSync({
  table: todos,
  where: ({ user }) => user ? { ownerId: user.id } : false,
})
```

Each user now sees only their own todos. The server sets `ownerId` on new todos, and the browser shows that value right away.

Clear the local rows at sign-out so the next person on the device cannot see them. ViteHub Auth does this automatically in Nuxt. In a Vue app without Nuxt, register `onSignOut(() => clearSync())` once. With custom auth, call `clearSync()` after sign-out succeeds. See [Vue](/docs/sync/vue#accounts-and-sign-out).

::

::tutorial-step{title="Share rows with a team"}
## Share rows with a team

To share todos across a team, add a `teamId` column to the table, track memberships in a `members` table, and return the caller's teams as an array:

```ts [teams/server/sync/todos.ts] fragment
import { defineSync } from 'vite-hub/sync'
import { useDatabase } from 'vite-hub/database'
import { eq } from 'drizzle-orm'
import { members, todos } from '../databases/default'

export default defineSync({
  table: todos,
  // A list, such as ['design', 'web']: the caller sees the todos of each team
  where: async ({ user }) => {
    if (!user) return false
    const teams = await useDatabase().db.select({ teamId: members.teamId }).from(members).where(eq(members.userId, user.id))
    return { teamId: teams.map(team => team.teamId) }
  },
})
```

If your app uses custom sign-in instead of Auth, return the user from `identify`, such as `identify: async ({ request }) => { const session = await getSession(request); return session ? { id: session.userId } : null }`. `where` receives that user, and joining a team does not hold back waiting writes.

New todos must specify their team: `todos.insert({ title, teamId: 'design' })`. Inserts for another team fail with `SYNC_OUT_OF_SCOPE`. Moving a todo to another team with `todos.update(id, { teamId: 'web' })` removes it from devices on the old team and syncs it to devices on the new team. See [Server API](/docs/sync/server-api#where).

::
