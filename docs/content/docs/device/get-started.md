---
title: Show a project list at once on a reload
description: Keep the last answer of a server read in the browser with ViteHub Device, so a reload shows it before the server answers.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You build a project list that shows the last projects at once on a reload, then the new ones when the server answers. You need a Vue app with Vite, and a route that returns the projects, such as `GET /api/projects`.

::tutorial-step{title="Install Device"}
## Install Device

```bash [commands/install]
pnpm add @vite-hub/device
```

::

::tutorial-step{title="Open the device"}
## Open the device

Await `openDevice()` before the app mounts. It reads the stored answers into memory, so the first render can show them:

```ts [src/main.ts]
import { createApp } from 'vue'
import { openDevice } from 'vite-hub/device'
import App from './App.vue'

await openDevice({ version: '1' })
createApp(App).mount('#app')
```

- `version` names the shape of your data. Change it when an answer changes shape, and the device deletes the old copies.
- `openDevice()` never fails. Without IndexedDB, the copies stay in memory.

::

::tutorial-step{title="Name the account"}
## Name the account

The device keeps the copies of one account. Tell it who is signed in, each time your app learns it:

```ts [src/session.ts]
import { setDeviceAccount } from 'vite-hub/device'

const session = await fetch('/api/session').then(response => response.json() as Promise<{ user: { id: string } | null }>)
await setDeviceAccount(session.user?.id ?? null)
```

Until the page names an account, the answers stay in memory and nothing goes to the disk. Another account, or `null` after a sign-out, deletes every copy.

::

::tutorial-step{title="Read the projects"}
## Read the projects

Create `src/components/ProjectList.vue`:

```vue [src/components/ProjectList.vue]
<script setup lang="ts">
import { useStoredData } from 'vite-hub/device/vue'

interface Project {
  id: string
  name: string
}

const { data: projects, status, storedAt } = useStoredData('projects', ({ signal }) =>
  fetch('/api/projects', { signal }).then(response => response.json() as Promise<Project[]>), { default: () => [] })
</script>

<template>
  <p v-if="storedAt">Saved {{ storedAt.toLocaleString() }}. Checking for changes.</p>
  <p v-else-if="status === 'error'">Could not load the projects.</p>
  <ul>
    <li v-for="project in projects" :key="project.id">{{ project.name }}</li>
  </ul>
</template>
```

- `'projects'` is the key of the stored copy. Give each read its own key, such as `` `project:${id}` `` for one project.
- The loader gets a `signal`. Pass it to `fetch`, so a newer `refresh()` stops the older request.
- `storedAt` is the time of the stored copy while the screen shows it, and `undefined` after the loader answers.

::

::tutorial-step{title="Reload the page"}
## Reload the page

Open the page and wait for the list. Reload it. The list shows at once, with "Saved" above it. When the server answers, the new list replaces it and the "Saved" line goes away.

To see what the device holds, log `inspectDevice()` from your app:

```ts [src/debug.ts]
import { inspectDevice } from 'vite-hub/device'

console.log(inspectDevice())
```

It gives the account that you named, `persisted: true`, `storage: 'indexeddb'`, and one entry for `projects` with its time and size in bytes.

::

## In production

The stored copy is a copy in the browser, not a cache on the server. Each read still calls your route, and your route still checks the session. On a shared computer, the next person sees the copy of the last account until your app names the new account, so call `setDeviceAccount(null)` on a sign-out.

## Next

- [Browser API](/docs/device/browser-api): every function and option.
- [Limits and errors](/docs/device/limits-and-errors): what the device does not do, and the `DEVICE_*` codes.
