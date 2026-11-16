---
title: Show a project list at once on a reload
description: Keep the last answer of a server read in the browser with ViteHub Device, so a reload shows it before the server answers.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You build a project list that shows the last projects at once on a reload, then the new ones when the server answers. You need a Nuxt app, or a Vue app with Vite, and a route that returns the projects as JSON, such as `GET /api/projects`.

::tutorial-step{title="Install Device"}
## Install Device

```bash [commands/install]
pnpm add @vite-hub/device
```

::

::tutorial-step{title="Open the device"}
## Open the device

The device reads the stored answers into memory, so a render can show them.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
The ViteHub module opens the device for you when `@vite-hub/device` is installed. On a page that the server rendered, it opens the device after hydration, so hydration does not wait for it. With `ssr: false`, it opens the device before the app mounts.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { device: { version: '1' } },
})
```

`useStoredData()`, `useStoredFetch()`, `setDeviceAccount()`, `clearDevice()`, and `inspectDevice()` are auto-imported.
::::

::::tabs-item{label="Nitro"}
Await `openDevice()` before the app mounts, so the first render can show the stored answers:

```ts [src/main.ts]
import { createApp } from 'vue'
import { openDevice } from 'vite-hub/device'
import App from './App.vue'

await openDevice({ version: '1' })
createApp(App).mount('#app')
```

With server rendering, also await `openDevice()` before `app.mount()`. A component that hydrates server HTML renders what the server rendered first, then shows the stored answers when it mounts.
::::

::::tabs-item{label="Vite"}
Await `openDevice()` before the app mounts, so the first render can show the stored answers:

```ts [src/main.ts]
import { createApp } from 'vue'
import { openDevice } from 'vite-hub/device'
import App from './App.vue'

await openDevice({ version: '1' })
createApp(App).mount('#app')
```

With server rendering, also await `openDevice()` before `app.mount()`. A component that hydrates server HTML renders what the server rendered first, then shows the stored answers when it mounts.
::::
:::

- `version` names the shape of your data. Change it when an answer changes shape, and the device deletes the old copies. Without it, a new build keeps the copies.
- Opening never fails. Without IndexedDB, the copies stay in memory.

::

::tutorial-step{title="Name the account"}
## Name the account

The device keeps the copies of one account.

With [ViteHub Auth](/docs/auth) in Nuxt, there is nothing to write. The module names the account of `useUserSession()`, and `signOut()` waits until the copies are gone before it opens the next page.

Without it, read the session with `useStoredFetch()` and give it `account`, so each answer names who is signed in:

```ts [src/composables/useSession.ts]
import { useStoredFetch } from 'vite-hub/device/vue'

export function useSession() {
  return useStoredFetch<{ user: { id: string } | null }>('/api/session', {
    account: session => session.user?.id ?? null,
  })
}
```

Call `useSession()` in `App.vue`. The answer of the session read is stored under its account, and the next visit shows it at once. The other reads store only the answers of requests that start after the session answered. A read that started before shows its answer, and asks again. Another account, or `null` after a sign-out, deletes every copy. A stored copy of the session names nothing, and an answer that is not 2xx names nothing either: only a session that the server sent does.

If your app knows the account another way, such as from the HTML or an auth client, call `setDeviceAccount(id)` instead.

::

::tutorial-step{title="Read the projects"}
## Read the projects

Create `ProjectList.vue` in your components folder:

```vue [components/ProjectList.vue]
<script setup lang="ts">
import { useStoredFetch } from 'vite-hub/device/vue'

interface Project {
  id: string
  name: string
}

const { data: projects, status, storedAt } = useStoredFetch<Project[]>('/api/projects', { default: () => [] })
</script>

<template>
  <p v-if="storedAt">Saved {{ storedAt.toLocaleString() }}. Checking for changes.</p>
  <p v-else-if="status === 'error'">Could not load the projects.</p>
  <ul>
    <li v-for="project in projects" :key="project.id">{{ project.name }}</li>
  </ul>
</template>
```

- `useStoredFetch()` sends a GET request and reads the JSON. The URL is the key of the stored copy, so each URL and query has its own copy. In Nuxt, you can leave out the import.
- An answer that is not 2xx goes to `error` with `DEVICE_FETCH_FAILED`. The device does not store it, and the stored copy stays on the screen.
- `storedAt` is the time of the stored copy while the screen shows it, and `undefined` after the server answers.

For a request that is not a GET of JSON, use `useStoredData()` with your own loader. See the [Browser API](/docs/device/browser-api#usestoreddata).

::

::tutorial-step{title="Reload the page"}
## Reload the page

Open the page and wait for the list. Reload it. Without server rendering, the list shows in the first render, with "Saved" above it. With server rendering, the page shows the server HTML first, and the list shows right after hydration. When the server answers, the new list replaces it and the "Saved" line goes away.

To see what the device holds, log `inspectDevice()` from your app:

```ts [src/debug.ts]
import { inspectDevice } from 'vite-hub/device'

console.log(inspectDevice())
```

It gives the account that you named, `persisted: true`, `storage: 'indexeddb'`, and one entry for `/api/projects` with its time and size in bytes.

::

## In production

The stored copy is a copy in the browser, not a cache on the server. Each read still calls your route, and your route still checks the session. On a shared computer, the next person sees the copy of the last account until your app names the new account, so call `setDeviceAccount(null)` on a sign-out. ViteHub Auth in Nuxt does it for you.

## Next

- [Browser API](/docs/device/browser-api): every function and option.
- [Limits and errors](/docs/device/limits-and-errors): what the device does not do, and the `DEVICE_*` codes.
