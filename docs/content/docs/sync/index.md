---
title: Sync
layout: landing
navigation.title: Overview
description: Keep a local copy of a table in the browser. Writes show at once, work offline, and the server stays the authority for every row.
navigation.order: 1
icon: i-lucide-refresh-cw
---

::product-hero{tagline="Say which rows a person may see. The browser keeps a copy of them, writes at once, and syncs when the network is there." hosts="Node, Docker, Cloudflare, Vercel, Netlify"}
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

  ```vue [app/pages/todos.vue] fragment
  <script setup lang="ts">
  const todos = useSync('todos')
  const title = ref('')
  </script>

  <!-- Rows show at once, also offline and after a reload -->
  <template>
    <form @submit.prevent="todos.insert({ title }); title = ''">
      <input v-model="title">
    </form>
    <ul>
      <li v-for="todo in todos.rows" :key="todo.id">
        <input type="checkbox" :checked="todo.done" @change="todos.update(todo.id, { done: !todo.done })">
        {{ todo.title }}
      </li>
    </ul>
    <p v-if="todos.queued">{{ todos.queued }} changes wait for the network</p>
  </template>
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
| Local copy | The browser keeps the rows in IndexedDB. A reload shows them at once, then pulls what changed. |
| Writes at once | `insert`, `update`, and `delete` change `rows` at once. Each write goes to a queue in IndexedDB before it is sent, so it survives offline time, a reload, and a crash. |
| Order | One push at a time, with the writes in the order you made them. Two updates of one row apply in that order. |
| Scope | `where` returns the rows that the caller may see. The server filters reads with it, writes its values into inserts, and refuses writes that change them. |
| Account guard | Each write keeps the scope that it was made for. After a sign-in as another person, old writes are never sent: they show in `failures`. |
| Once only | Each write has an id. When an answer is lost and the client sends the write again, the server does not apply it twice. |
| Fresh rows | The client pulls on start, when the page shows again, when the network comes back, every 30 seconds while the page shows, and after each write. Other tabs see a change at once. |
| Inspection | `vitehub sync list` and `vitehub sync changes <name>`, and the `sync.list` and `sync.changes` operations. |

The client needs no framework. Vue gets `useSync()`, and other frameworks use the same store through `createSync()`.

## Sync, Database, or Realtime

Does each person work on their own rows, and must the page work offline? Then use Sync. Does only server code read and write the table? Then use [Database](/docs/database). Do people send short messages or show who is online in a room? Then use [Realtime](/docs/realtime).

## Next

- [Get started](/docs/sync/get-started): a todo list that works offline.
- [Server API](/docs/sync/server-api): every option of `defineSync()`, the route, and the CLI.
- [Limits and errors](/docs/sync/limits-and-errors): what v1 does not do, and the `SYNC_*` codes.
- [Vue](/docs/sync/vue): `useSync()`, failures, and sign-out.
