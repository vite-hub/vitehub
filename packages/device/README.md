# @vite-hub/device

Stored reads for the browser. A screen shows the last server answer at once from the device, then asks the server again. The copies belong to the signed-in account: another account or a sign-out deletes them. ViteHub apps import it as `vite-hub/device` and `vite-hub/device/vue`.

## Install

```sh
pnpm add @vite-hub/device
```

It has no dependency on Sync or Auth, and it needs no server code.

## Nuxt

With `vite-hub/nuxt` in `modules`, the ViteHub module finds the package and does the setup:

- A client plugin opens the device. On a page that the server rendered, it opens it when hydration ends, so the first render matches the server HTML. Without server HTML, such as with `ssr: false`, it opens it before the app mounts.
- With ViteHub Auth, the plugin names the account of `useUserSession()`, and `signOut()` waits until the copies are gone.
- `useStoredData`, `useStoredFetch`, `setDeviceAccount`, `clearDevice`, and `inspectDevice` are auto-imported.

`vitehub: { device: { version: '2' } }` sets the version of `openDevice()`. `device: { account: false }` leaves the account to the app. `device: false` turns it off.

## Use

In a Vue app with Vite, open the device before the app mounts, so the first render reads the stored copies:

```ts
// src/main.ts
import { createApp } from 'vue'
import { openDevice } from '@vite-hub/device'
import App from './App.vue'

await openDevice({ version: '1' })
createApp(App).mount('#app')
```

Without ViteHub Auth in Nuxt, read the session with `useStoredFetch()` and give it `account`, so each answer names who is signed in and is stored under that account. The device stores the answers of other reads only when their loader calls start after the naming:

```ts
// src/composables/useSession.ts
import { useStoredFetch } from '@vite-hub/device/vue'

export const useSession = () => useStoredFetch<{ user: { id: string } | null }>('/api/session', {
  account: session => session.user?.id ?? null,
})
```

When the app knows the account another way, such as from the HTML or an auth client, call `setDeviceAccount(id)` instead, before `mount()` if it can, so each read calls its loader once.

Read JSON from a route with `useStoredFetch()`. It has the shape of Nuxt `useFetch()`, for GET only, and the URL is the key of the stored copy:

```vue
<script setup lang="ts">
import { useStoredFetch } from '@vite-hub/device/vue'

const { data: projects, status, storedAt } = useStoredFetch<{ id: string, name: string }[]>('/api/projects', { default: () => [] })
</script>

<template>
  <p v-if="storedAt">Saved {{ storedAt.toLocaleString() }}. Checking for changes.</p>
  <p v-else-if="status === 'error'">Could not load the projects.</p>
  <ul>
    <li v-for="project in projects" :key="project.id">{{ project.name }}</li>
  </ul>
</template>
```

On a reload, `projects` has the stored copy in the first render, `status` is `pending`, and `storedAt` is the time of the copy. When the server answers, `projects` has the answer, `status` is `success`, and `storedAt` is `undefined`. When the request fails, or answers with a status that is not 2xx, the stored copy stays and `error` has the failure. The device never stores an error answer.

For anything else, such as a POST or a client SDK, use `useStoredData(key, loader)`. It has the shape of Nuxt `useAsyncData()`. The loader must throw on an error answer, or the device stores the error body:

```ts
// src/composables/useProject.ts
import { useStoredData } from '@vite-hub/device/vue'

export const useProject = (id: string) => useStoredData(`project:${id}`, async ({ signal }) => {
  const response = await fetch(`/api/projects/${id}`, { signal })
  if (!response.ok) throw new Error(`The project answered ${response.status}.`)
  return await response.json() as { id: string, name: string }
})
```

## API

| Export | Does |
| --- | --- |
| `openDevice({ version? })` | Reads the stored copies into memory. Await it before `app.mount()`. It never fails: without IndexedDB, or when IndexedDB takes more than 1 second, the page keeps copies in memory. When `version` is not the version of the stored copies, it deletes them. |
| `setDeviceAccount(id \| null)` | Names the signed-in account. The device stores only the answers of loader calls that start after it, so each read that runs calls its loader again. Another account, or `null`, deletes every copy in every tab. Returns `[error, undefined]`, with `DEVICE_STORAGE_FAILED` when IndexedDB failed to delete the copies. |
| `clearDevice()` | Deletes every copy in this tab and in every other tab of the app. The account stays. Returns `[error, undefined]`. |
| `inspectDevice()` | `{ account, persisted, storage, entries: [{ key, storedAt, bytes }] }`. `storage` is `indexeddb` or `memory`. |
| `useStoredData(key, loader, options?)` | From `@vite-hub/device/vue`. Options: `default`, `maxAge`, and `account` for the read that says who is signed in. Returns `{ data, status, error, refresh, storedAt }`. The key can be a string, a ref, or a getter. Reads of one key share one state and one loader call. `refresh()` aborts the older call, and so does the unmount of the last component of a read. |
| `useStoredFetch(url, options?)` | From `@vite-hub/device/vue`. `useStoredData()` with a GET request for JSON. The key is the path and the query sorted by name, such as `/api/projects?team=t1`, with the origin only for another origin. Options: the options of `useStoredData()`, and `query`, where a `null` or `undefined` value is left out. A status that is not 2xx goes to `error` as `DEVICE_FETCH_FAILED` and is never stored. |

| Option | Default | Does |
| --- | --- | --- |
| `default` | `() => undefined` | The value when the device has no copy. |
| `maxAge` | 7 days | A stored copy that is older does not show, and the disk deletes it at the next `openDevice()` or write. In milliseconds. |

## Rules

- **One account.** The device holds the copies of one account. The account comes from your session: give the session read the `account` option, or call `setDeviceAccount()` each time the app learns who is signed in, and `setDeviceAccount(null)` on a sign-out. An app without accounts can name a fixed account, such as `'public'`.
- **One rule for what is stored.** The device stores an answer only when its loader call started after the page named its account, and nothing made the answers old since then: another account, a sign-out, `clearDevice()`, or a change of the disk by another tab. Any other answer shows in its read and goes nowhere else, not to the disk and not to a new read of the key. A page that never names an account stores nothing. The one exception is the read with the `account` option: its answer says who is signed in, so it names that account and is stored under it, also though its call started before.
- **Naming starts the reads again.** When the page names its account, each read that runs calls its loader again, and the answer on the screen stays until the new one. A stored copy of another account goes back to the default at once.
- **Old answers never show.** After another account, a sign-out, or `clearDevice()`, in this tab or in another tab, every read shows its default and calls its loader again, also a read whose loader answered. The read with `account` keeps the answer that named the account, and does not call its loader again for that naming. The answer of a loader call that started before the change does not show and does not go to the disk.
- **Plain data.** The device keeps the answer as JSON. Return objects, arrays, strings, numbers, booleans, and null from the loader.
- **Server rendering.** On the server, `useStoredData()` and `useStoredFetch()` read no storage and call no loader: `data` is the default and `status` is `idle`. In an app that the server renders, call `openDevice()` after the app mounts. The Nuxt plugin does it when hydration ends. A read in a component that renders before `openDevice()` renders the default and `idle`, as the server did, and calls the loader when the component mounts. The stored copy shows when the device opens, if the loader has not answered yet.
- **Tabs.** `clearDevice()` and a change of account reach every tab through a BroadcastChannel. The values of a read do not move between tabs: each tab asks its own loader. Each start-over of the disk gets a new generation, and a write applies only when the disk still has the generation of the tab. A new generation from another tab, also for the same account, is a reset in this tab: every read shows its default and calls its loader again. So a tab that missed a message, such as a suspended tab, cannot fill the disk again. Its write fails, and the tab drops what it had.

## Limits

- **IndexedDB is not confidential.** Anyone who can use the browser profile, browser extensions, and malware on the computer can read the stored copies. Do not store secrets, tokens, or data that must not stay on the device.
- **A shared computer shows the last account's copy until the server answers.** When the next person opens the app, the first render shows the copies of the last account. They go away when the session read answers, or the app calls `setDeviceAccount()`, with the new account. Call `setDeviceAccount(null)` on a sign-out, so the copies go then.
- **The server still checks every request.** A stored copy only changes what the screen shows first. It gives no access, and the loader asks the server each time.
- **5 MB.** The device keeps at most 5 MB of JSON for all tabs together, and deletes the oldest copies first, also copies of other tabs. The disk picks them from what it holds, in the same transaction as the write. It does not keep a single answer that is larger. `openDevice()` read 5 MB in 8 to 15 ms in headless Chromium.
- **1 second.** `openDevice()` waits at most 1 second for IndexedDB. A page that waited longer keeps its copies in memory.
- **Private windows and sandboxed frames.** When IndexedDB fails, the copies stay in memory and `inspectDevice()` says `storage: "memory"`.

## Errors

`setDeviceAccount()` and `clearDevice()` return `DEVICE_STORAGE_FAILED`. `useStoredFetch()` puts `DEVICE_FETCH_FAILED` in `error` for an answer that is not 2xx. Wrong input throws `DEVICE_INVALID_ACCOUNT`, `DEVICE_INVALID_KEY`, `DEVICE_INVALID_MAX_AGE`, or `DEVICE_ALREADY_OPEN`. The device prints `DEVICE_NOT_OPEN`, `DEVICE_VALUE_NOT_JSON`, `DEVICE_VALUE_TOO_LARGE`, and `DEVICE_STORAGE_FAILED` in the browser console when it cannot keep a copy. Each code has a page at `https://vitehub.dev/docs/device/diagnostics/<code>`.
