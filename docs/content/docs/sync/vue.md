---
title: Sync in Vue
description: Read and write a synced table in Vue with useSync(), handle refused writes, sign out, and use the store without Vue.
navigation.title: Vue
navigation.order: 8
icon: i-lucide-panels-top-left
---

## `useSync()`

`useSync(name)` returns a reactive object, so `todos.rows` works in a template and `todos.rows.length` in a script. Nuxt imports it for you. In a Vue app without Nuxt, import it from `vite-hub/sync/vue`:

```vue [app/components/TodoList.vue] fragment
<script setup lang="ts">
import { useSync } from 'vite-hub/sync/vue'

const todos = useSync('todos')
</script>

<template>
  <p v-if="todos.status === 'loading'">Loading</p>
  <li v-for="todo in todos.rows" :key="todo.id">{{ todo.title }}</li>
</template>
```

Components that use one name share one store. It stops when the last of them unmounts. The rows have the type of the table, from the file `server/sync/<name>.ts`.

| Field | What it holds |
| --- | --- |
| `rows` | The rows from the server, with the writes that wait applied on top. New rows come last. |
| `status` | `idle` on the server and until the stored rows are read, so a server-rendered page hydrates without a mismatch. Then `loading` until the first pull, and `ready`. `offline` when the network failed, `error` when the server refused the caller or failed. |
| `error` | The error of the last pull or push, with its `code`. `null` after a success. |
| `queued` | The number of writes that the server did not confirm yet. |
| `failures` | Refused writes, oldest first. Each has `key`, `mutation`, and `error`. |
| `persisted` | `true` when the rows and the queue are in IndexedDB. |

| Action | Does |
| --- | --- |
| `get(key)` | The row with this key, or `undefined`. |
| `insert(value)` | Adds a row. It makes the key with `crypto.randomUUID()`, unless `value` has one, and adds the `where` values. |
| `update(key, patch)` | Changes the columns in `patch`. The other columns stay as the server has them. |
| `delete(key)` | Deletes the row. |
| `refresh()` | Pulls now and sends the queue. |
| `retry(failure)` | Sends a refused write again, on top of the latest rows. |
| `dismiss(failure)` | Drops a refused write. |

| Option | Default | Does |
| --- | --- | --- |
| `interval` | `30000` | Milliseconds between pulls while the page shows. `false` turns it off. |
| `persist` | `true` | `false` keeps the rows and the queue in memory only. |
| `baseURL` | the app base | The base of the app, when it is not at the root. |
| `fetch` | `fetch` | The function that sends the requests. |

The first `useSync()` of a name sets the options. Later calls share that store.

## Wait for the server

A write changes `rows` at once. You do not have to wait. To know that the server stored it, await the write. It gives the row as the server stored it, and throws a `SyncError` when the server refused it:

```ts [app/composables/rename.ts] fragment
import { SyncError } from 'vite-hub/sync/client'

const todos = useSync('todos')

try {
  await todos.update(id, { title })
}
catch (error) {
  if (error instanceof SyncError && error.code === 'SYNC_INVALID') showIssues(error.issues)
}
```

`SyncError` comes from `vite-hub/sync/client`. A write that waits for the network does not throw. It stays in the queue until it is sent.

## Refused writes

A refused write leaves `rows`, so the row shows what the server has. The write goes to `failures`. Show them, and let the person try again or drop them:

```vue [app/components/SyncFailures.vue] fragment
<script setup lang="ts">
const todos = useSync('todos')
</script>

<template>
  <div v-for="failure in todos.failures" :key="failure.mutation.id" role="alert">
    {{ failure.error.message }}
    <button @click="todos.retry(failure)">Try again</button>
    <button @click="todos.dismiss(failure)">Discard</button>
  </div>
</template>
```

`retry()` sends the same change on top of the row as it is now, so it keeps the changes that other people made since. A write made for another person, with the code `SYNC_SCOPE_CHANGED`, is never sent. `retry()` keeps it in `failures`.

## Sign out

The rows stay in the browser after a sign-out. Call `clearSync()` when a person signs out, so the next person on the device does not see them. It empties every synced table in every tab, and drops the writes that wait:

```ts [app/composables/sign-out.ts] fragment
import { clearSync } from 'vite-hub/sync/client'

export async function signOutEverywhere() {
  await clearSync()
  await signOut()
}
```

If you forget it, the next person still never gets the old rows from the server, and old writes are never sent with their session. But the old rows show until the first pull.

## Without Vue

`createSync()` is the same store without a framework. `getState()` returns the same object until something changes, so it works with `useSyncExternalStore` in React and with stores in other frameworks:

```ts [app/todos.ts] fragment
import { createSync } from 'vite-hub/sync/client'

const todos = createSync('todos')
const stop = todos.subscribe(() => render(todos.getState().rows))
todos.insert({ title: 'Milk' })

// When the view goes away
stop()
todos.destroy()
```

On the server, `createSync()` makes no request and starts no timer. Its writes throw, since they belong in the browser.
