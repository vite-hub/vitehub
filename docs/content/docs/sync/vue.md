---
title: Sync in Vue
description: Read and write a synced table in Vue with useSync(), load subsets, call actions, show pending rows and live changes, and use the store without Vue.
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
| `queued` | The number of writes of the signed-in account that the server did not confirm yet. |
| `failures` | Refused writes, oldest first. Each has `key`, `mutation`, and `error`. |
| `persisted` | `true` when the rows and the queue are in IndexedDB. |
| `live` | `true` while this tab holds the live stream. See [Live changes](#live-changes). |

| Method | Does |
| --- | --- |
| `get(key)` | The row with this key, or `undefined`. |
| `pending(key)` | `true` while a write that waits changes this row. |
| `insert(value)` | Adds a row. It makes the key with `crypto.randomUUID()`, unless `value` has one, and adds the defaults of the table and the `where` values. |
| `update(key, patch)` | Changes the columns in `patch`. The other columns stay as the server has them. |
| `delete(key)` | Deletes the row. |
| `actions.<name>(args)` | Calls a server action. See [Actions](#actions). |
| `refresh()` | Pulls now and sends the queue. |
| `retry(failure)` | Sends a refused write again, on top of the latest rows. |
| `dismiss(failure)` | Drops a refused write. |

| Option | Default | Does |
| --- | --- | --- |
| `where` | none | A subset of the rows, such as `{ issueId }`. A plain object, a ref, or a getter. See [Subsets](#subsets). |
| `actions` | none | Optimistic functions of actions, by name. See [Actions](#actions). |
| `interval` | `30000` | Milliseconds between pulls while the page shows. While the live stream is open, it pulls every 5 minutes at most. `false` turns it off. |
| `persist` | `true` | `false` keeps the rows and the queue in memory only. |
| `baseURL` | the app base | The base of the app, when it is not at the root. |
| `fetch` | `fetch` | The function that sends the requests. |

The first `useSync()` of a name and subset sets the options. Later calls share that store. Optimistic functions of later calls are added when the store does not have one with that name.

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

Writes that you make in one tick go out in one push. When you change a row again before its last update was sent, the two updates become one, and the later value wins. A text field that saves on each key press sends one update, not one per key.

## Pending rows

`pending(key)` is `true` while a write or an optimistic action that waits changes the row. Use it to show that a change is not on the server yet:

```vue [app/components/TodoRow.vue] fragment
<script setup lang="ts">
const props = defineProps<{ id: string }>()
const todos = useSync('todos')
</script>

<template>
  <li :class="{ 'opacity-60': todos.pending(props.id) }">
    {{ todos.get(props.id)?.title }}
  </li>
</template>
```

## Subsets

A large table, such as the comments of every issue, does not have to come to the browser at once. Pass `where` to load only a subset. A getter or a ref works, so the subset follows a prop or a route:

```vue [app/components/IssueComments.vue] fragment
<script setup lang="ts">
const props = defineProps<{ issueId: string }>()
const comments = useSync('comments', { where: () => ({ issueId: props.issueId }) })
</script>

<template>
  <p v-for="comment in comments.rows" :key="comment.id">{{ comment.body }}</p>
  <button @click="comments.insert({ body: 'Thanks' })">Reply</button>
</template>
```

- Each subset is its own store, with its own rows and queue in IndexedDB. When the issue changes, `useSync()` moves to the store of the new issue. The old store stops when no component uses it.
- A subset that the browser saw before shows at once, before its pull. Going back to an issue is local.
- `insert()` adds the subset values, so the new comment has `issueId` at once.
- The server adds the subset to `where` of the definition. A subset can only narrow what the caller may see. A subset outside `where` gets `SYNC_OUT_OF_SCOPE`.
- Each value of a subset is one value of a column: a string, a number, a boolean, or `null`. An `undefined` value is left out.

## Actions

An action is a named write with server logic, such as `complete` or `rate`. Define it in the Sync definition. Annotate `args`, so the browser call has the type:

```ts [server/sync/todos.ts] fragment
import { createError } from 'h3'

export default defineSync({
  table: todos,
  where: ({ user }) => user ? { ownerId: user.id } : false,
  actions: {
    complete: async ({ get, update }, { id }: { id: string }) => {
      const todo = await get(id)
      if (!todo) throw createError({ status: 404, message: 'This todo is gone.' })
      update(id, { done: true })
      return { done: true }
    },
  },
})
```

The [Server API](/docs/sync/server-api) tells what an action gets and how its writes apply.

Call it in the browser. It waits in the same queue as row writes, in order with them, and survives offline time and a reload. Await it for the value that the server action returned:

```ts [app/components/TodoRow.vue] fragment
const todos = useSync('todos')

const result = await todos.actions.complete({ id })
```

Without more, the rows change when the server answers, since the answer has the rows that the action wrote. To show the change at once, give an optimistic function. It changes a local copy as the server action will:

```ts [app/components/TodoRow.vue] fragment
const todos = useSync('todos', {
  actions: {
    complete: (local, { id }) => local.update(id, { done: true }),
  },
})
```

- `local` has `get`, `insert`, `update`, and `delete`, over the rows with the writes that wait.
- The function runs again each time the rows change, until the server answers. Keep it pure: no requests, no random values, no clock.
- An `insert()` without a key gets a key from the id of the call, so it keeps that key each time the function runs. To make the server use the same key, make the id in the browser and pass it in `args`: `todos.actions.add({ id: crypto.randomUUID(), title })`.
- When the server refuses the action, the optimistic change goes away, and the call throws a `SyncError` with the code `SYNC_ACTION_REFUSED`. Its message is the message of an error with a status below 500, such as the `createError()` above. Other errors give "The action failed." The action goes to `failures`, and `retry()` calls it again.
- An error in the optimistic function shows in the console. The action still goes to the server.

## Live changes

The rows of other people show within about a second. One tab of the app keeps a live stream open to the Sync route while it shows and is online. The other tabs get the changes from that tab. You do not have to turn anything on.

- `live` is `true` in the tab that holds the stream. When that tab hides, another tab that shows takes over.
- While the stream is open, the interval pull runs every 5 minutes at most. The client still pulls when the page shows again and when the network comes back.
- The server ends a stream after about 25 seconds, and the client opens a new one at once. After a failure, it waits 1 second, doubling to 30 seconds.
- A definition with `live: false` has no stream. The client then pulls as before: on start, when the page shows, every `interval`, and after each write.

## Accounts and sign-out

Each write belongs to the account that was signed in when it was made: the user of ViteHub Auth, or the scope without Auth. When another person signs in on the device, the old writes wait in IndexedDB. They do not show in `rows`, do not count in `queued`, and are never sent with the other person's session. When the first person signs in again, they go out.

Rows stay in the browser after a sign-out too. Call `clearSync()` when a person signs out, so the next person on the device does not see them. It empties every synced table and subset in every tab, and drops the writes that wait, also those of other accounts:

```ts [app/composables/sign-out.ts] fragment
import { clearSync } from 'vite-hub/sync/client'

export async function signOutEverywhere() {
  await clearSync()
  await signOut()
}
```

If you forget it, the next person still never gets the old rows from the server, and old writes are never sent with their session. But the old rows show until the first pull.

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

`retry()` sends the same change on top of the row as it is now, so it keeps the changes that other people made since. For an action, it calls the action again.

## Without Vue

`createSync()` is the same store without a framework. `getState()` returns the same object until something changes, so it works with `useSyncExternalStore` in React and with stores in other frameworks:

```ts [app/todos.ts] fragment
import { createSync } from 'vite-hub/sync/client'

const todos = createSync('todos', {
  actions: { complete: (local, { id }) => local.update(id, { done: true }) },
})
const stop = todos.subscribe(() => render(todos.getState().rows))
todos.insert({ title: 'Milk' })
todos.actions.complete({ id: 'a' })

// A subset is its own store.
const comments = createSync('comments', { where: { issueId: 'i1' } })

// When the view goes away
stop()
todos.destroy()
comments.destroy()
```

On the server, `createSync()` makes no request and starts no timer. Its writes and actions throw, since they belong in the browser.
