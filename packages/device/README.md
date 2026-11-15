# @vite-hub/device

Stored reads for the browser. A screen shows the last server answer at once from the device, then asks the server again. The copies belong to the signed-in account: another account or a sign-out deletes them. ViteHub apps import it as `vite-hub/device` and `vite-hub/device/vue`.

## Install

```sh
pnpm add @vite-hub/device
```

It has no dependency on Sync or Auth, and it needs no server code.

## Use

Open the device before the app mounts, so the first render reads the stored copies:

```ts
// src/main.ts
import { createApp } from 'vue'
import { openDevice } from '@vite-hub/device'
import App from './App.vue'

await openDevice({ version: '1' })
createApp(App).mount('#app')
```

Name the account when the app learns who is signed in. Until then, answers stay in memory and nothing goes to the disk:

```ts
// src/session.ts
import { setDeviceAccount } from '@vite-hub/device'

const session = await fetch('/api/session').then(response => response.json() as Promise<{ user: { id: string } | null }>)
await setDeviceAccount(session.user?.id ?? null)
```

Read server data with `useStoredData()`. It has the shape of Nuxt `useAsyncData()`:

```vue
<script setup lang="ts">
import { useStoredData } from '@vite-hub/device/vue'

const { data: projects, status, storedAt } = useStoredData('projects', ({ signal }) =>
  fetch('/api/projects', { signal }).then(response => response.json() as Promise<{ id: string, name: string }[]>), { default: () => [] })
</script>

<template>
  <p v-if="storedAt">Saved {{ storedAt.toLocaleString() }}. Checking for changes.</p>
  <p v-else-if="status === 'error'">Could not load the projects.</p>
  <ul>
    <li v-for="project in projects" :key="project.id">{{ project.name }}</li>
  </ul>
</template>
```

On a reload, `projects` has the stored copy in the first render, `status` is `pending`, and `storedAt` is the time of the copy. When the loader answers, `projects` has the answer, `status` is `success`, and `storedAt` is `undefined`. When the loader fails, the stored copy stays and `error` has the failure.

## API

| Export | Does |
| --- | --- |
| `openDevice({ version? })` | Reads the stored copies into memory. Await it before `app.mount()`. It never fails: without IndexedDB, or when IndexedDB takes more than 1 second, the page keeps copies in memory. When `version` is not the version of the stored copies, it deletes them. |
| `setDeviceAccount(id \| null)` | Names the signed-in account. Another account, or `null`, deletes every copy in every tab. Returns `[error, undefined]`, with `DEVICE_STORAGE_FAILED` when IndexedDB failed to delete the copies. |
| `clearDevice()` | Deletes every copy in this tab and in every other tab of the app. The account stays. Returns `[error, undefined]`. |
| `inspectDevice()` | `{ account, persisted, storage, entries: [{ key, storedAt, bytes }] }`. `storage` is `indexeddb` or `memory`. |
| `useStoredData(key, loader, options?)` | From `@vite-hub/device/vue`. Returns `{ data, status, error, refresh, storedAt }`. The key can be a string, a ref, or a getter. Reads of one key share one state and one loader call. `refresh()` aborts the older call, and so does the unmount of the last component of a read. |

| Option | Default | Does |
| --- | --- | --- |
| `default` | `() => undefined` | The value when the device has no copy. |
| `maxAge` | 7 days | A stored copy that is older does not show, and the next `openDevice()` deletes it. In milliseconds. |

## Rules

- **One account.** The device holds the copies of one account. The account comes from your session, so call `setDeviceAccount()` each time the app learns who is signed in, and `setDeviceAccount(null)` on a sign-out. An app without accounts can name a fixed account, such as `'public'`.
- **Nothing before an account.** A page that never names an account writes nothing to the disk. The answers that it gets before it names one join the account that it names.
- **Old answers never show.** After another account, a sign-out, or `clearDevice()`, in this tab or in another tab, every read shows its default and calls its loader again, also a read whose loader answered. The answer of a loader call that started before the change does not show and does not go to the disk.
- **Plain data.** The device keeps the answer as JSON. Return objects, arrays, strings, numbers, booleans, and null from the loader.
- **Server rendering.** On the server, `useStoredData()` reads no storage and calls no loader: `data` is the default and `status` is `idle`. In an app that the server renders, call `openDevice()` after the app mounts. A read in a component that renders before `openDevice()` renders the default and `idle`, as the server did, and calls the loader when the component mounts. The stored copy shows when the device opens, if the loader has not answered yet.
- **Tabs.** `clearDevice()` and a change of account reach every tab through a BroadcastChannel. The values of a read do not move between tabs: each tab asks its own loader. Each start-over of the disk gets a new generation, and a write applies only when the disk still has the generation of the tab. So a tab that missed a message, such as a suspended tab, cannot fill the disk again. Its write fails, and the tab drops what it had.

## Limits

- **IndexedDB is not confidential.** Anyone who can use the browser profile, browser extensions, and malware on the computer can read the stored copies. Do not store secrets, tokens, or data that must not stay on the device.
- **A shared computer shows the last account's copy until the server answers.** When the next person opens the app, the first render shows the copies of the last account. They go away when the app calls `setDeviceAccount()` with the new account. Call `setDeviceAccount(null)` on a sign-out, so the copies go then.
- **The server still checks every request.** A stored copy only changes what the screen shows first. It gives no access, and the loader asks the server each time.
- **5 MB.** The device keeps at most 5 MB of JSON for all tabs together, and deletes the oldest copies first, also copies of other tabs. It does not keep a single answer that is larger. `openDevice()` read 5 MB in 8 to 15 ms in headless Chromium.
- **1 second.** `openDevice()` waits at most 1 second for IndexedDB. A page that waited longer keeps its copies in memory.
- **Private windows and sandboxed frames.** When IndexedDB fails, the copies stay in memory and `inspectDevice()` says `storage: "memory"`.

## Errors

`setDeviceAccount()` and `clearDevice()` return `DEVICE_STORAGE_FAILED`. Wrong input throws `DEVICE_INVALID_ACCOUNT`, `DEVICE_INVALID_KEY`, `DEVICE_INVALID_MAX_AGE`, or `DEVICE_ALREADY_OPEN`. The device prints `DEVICE_NOT_OPEN`, `DEVICE_VALUE_NOT_JSON`, `DEVICE_VALUE_TOO_LARGE`, and `DEVICE_STORAGE_FAILED` in the browser console when it cannot keep a copy. Each code has a page at `https://vitehub.dev/docs/device/diagnostics/<code>`.
