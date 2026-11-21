---
title: Sync
layout: landing
navigation.title: Overview
description: Keep a local copy of a table in the browser. Writes show at once and work offline, and the server stays the authority for every row.
navigation.order: 1
icon: i-lucide-refresh-cw
---

::product-hero{tagline="Say which rows a person may see. The browser keeps a copy of them, writes at once, and syncs when the network is there." hosts="Node, Docker, Cloudflare, Vercel, Netlify"}
  :::code-tree
  ```ts [server/sync/todos.ts] fragment
  import { defineSync } from 'vite-hub/sync'
  import { todos } from '../databases/default'

  // One file is one synced table, at /_vitehub/sync/todos
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
| Local copy | The browser caches rows in IndexedDB. Reloading renders cached rows right away, then pulls what changed. |
| Writes at once | `insert`, `update`, and `delete` update `rows` immediately. Each write goes to a queue in IndexedDB before it is sent, so it survives offline time, a reload, and a crash. |
| Order | Sync sends one push at a time in the order you made the edits, so sequential updates to a row apply in order. |
| Scope | `where` returns the rows that the caller can see, such as `{ ownerId: user.id }` or the caller's teams, `{ teamId: ['design', 'web'] }`. The server filters reads with it, writes its values into inserts, and refuses writes outside it. |
| Moved rows | A deleted row or a row moved to another team leaves devices on the old team and syncs only to the new team. |
| Subsets | `useSync('comments', { where: { issueId } })` syncs a part of the rows, with its own local copy, on the columns that `subsets` lists. A second visit shows it from the device. |
| Actions | Named writes with server logic, such as `cards.actions.rate({ id, stars })`, share the same queue and change log as row writes. Call `refuse(message)` to reject one. |
| Live | Each tab keeps one live stream open for all synced tables so changes from others arrive within about a second. |
| Account guard | Each write records the account that made it. If another person signs in, old writes wait until their account signs back in. Apps with custom auth return the user from `identify`. |
| Once only | Each write has an ID. When a response is lost and the client sends the write again, the server does not apply it twice. |
| Fresh rows | Alongside the live stream, the client pulls on start, when the page shows again, when the network comes back, and after each write. Other tabs update at once. When the table changes, the browser drops cached rows and keeps queued writes. |
| Inspection | Inspect tables and changes via `vitehub sync list`, `vitehub sync changes <name>`, and the `sync.list` and `sync.changes` operations. |

The client needs no framework. Vue uses `useSync()`, and other frameworks use the same store through `createSync()`.

## Sync, Database, or Realtime

Use Sync when each person or team works on their own rows in the browser. Use [Database](/docs/database) when only server code reads and writes the table. Use [Realtime](/docs/realtime) when people send short messages or show who is online in a room.

## Next

- [Get started](/docs/sync/get-started) builds an offline-ready todo list.
- [Server API](/docs/sync/server-api) covers `defineSync()`, team scopes, subsets, actions, live pulls, and CLI commands.
- [Limits and errors](/docs/sync/limits-and-errors) lists what Sync does not do and the `SYNC_*` codes.
- [Vue](/docs/sync/vue) covers `useSync()`, error handling, and sign-out.
