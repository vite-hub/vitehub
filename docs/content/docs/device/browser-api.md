---
title: Device browser API
description: openDevice(), setDeviceAccount(), clearDevice(), inspectDevice(), and useStoredData() with every option, the status values, and the rules for accounts, tabs, and server rendering.
navigation.title: Browser API
navigation.order: 4
icon: i-lucide-code
---

`vite-hub/device` has the functions of the device. `vite-hub/device/vue` has `useStoredData()`. Both run in the browser. On the server, they store nothing.

## `openDevice()`

Reads the stored copies into memory. Await it before `app.mount()`, so the first render of `useStoredData()` reads them:

```ts [src/main.ts]
import { createApp } from 'vue'
import { openDevice } from 'vite-hub/device'
import App from './App.vue'

await openDevice({ version: import.meta.env.VITE_DATA_VERSION ?? '1' })
createApp(App).mount('#app')
```

| Option | Default | Does |
| --- | --- | --- |
| `version` | `''` | The version of the stored data. When the stored copies have another version, the device deletes them. |

`openDevice()` never fails. When the browser has no working IndexedDB, or IndexedDB takes more than 1 second, the page keeps its copies in memory. Call it once: a second call with another version throws `DEVICE_ALREADY_OPEN`.

## `setDeviceAccount()`

Names the signed-in account. Call it each time your app learns who is signed in, and with `null` after a sign-out:

```ts [src/session.ts]
import { setDeviceAccount } from 'vite-hub/device'

export async function onSession(user: { id: string } | null) {
  const [error] = await setDeviceAccount(user?.id ?? null)
  if (error) console.warn(error.why, error.fix)
}
```

| Call | Result |
| --- | --- |
| The same account as the stored copies | The copies stay. New answers go to the disk. |
| Another account | Every copy goes, in every tab. Answers that this page got before it named an account stay, because they came with the new session. |
| `null` | Every copy goes, in every tab. The device writes nothing until the page names an account again. |

It returns `[error, undefined]`. `error` is `DEVICE_STORAGE_FAILED` when IndexedDB failed to delete the copies of the previous account. An empty string or another value throws `DEVICE_INVALID_ACCOUNT`.

## `clearDevice()`

Deletes every copy in this tab and in every other tab of the app. The account stays, so the next answers are stored again. It returns `[error, undefined]`, with `DEVICE_STORAGE_FAILED` when IndexedDB failed.

## `inspectDevice()`

Gives the state of the device of this tab:

| Field | Holds |
| --- | --- |
| `account` | The account that the page named. Before that, the account of the copies from the last visit. `null` when there is none. |
| `persisted` | `true` when new copies go to IndexedDB. `false` before the page names an account, after `null`, and in memory mode. |
| `storage` | `indexeddb`, or `memory` when IndexedDB failed or `openDevice()` was not called. |
| `entries` | `{ key, storedAt, bytes }` for each copy, by key. `bytes` is the size of the JSON. |

## `useStoredData()`

```vue [src/components/ProjectPage.vue]
<script setup lang="ts">
import { useStoredData } from 'vite-hub/device/vue'

const props = defineProps<{ id: string }>()

const { data: project, status, error, refresh, storedAt } = useStoredData(
  () => `project:${props.id}`,
  ({ signal }) => fetch(`/api/projects/${props.id}`, { signal }).then(response => response.json() as Promise<{ name: string }>),
)
</script>
```

| Argument | Does |
| --- | --- |
| `key` | Names the stored copy. A string, a ref, or a getter. When it changes, the read moves to the new key, as if it started again. |
| `loader` | `({ signal }) => Promise<T>`. Calls the server. `signal` aborts when a newer `refresh()` starts. |

| Option | Default | Does |
| --- | --- | --- |
| `default` | `() => undefined` | The value when the device has no copy. |
| `maxAge` | 7 days | A stored copy that is older does not show, and the next `openDevice()` deletes it. In milliseconds. |

| Field | Holds |
| --- | --- |
| `data` | The stored copy, then the answer of the loader. Before both, the default. |
| `status` | `idle` on the server, and in the first render of a read that starts before `openDevice()`. `pending` while the loader runs, then `success` or `error`. |
| `error` | What the loader threw, as an `Error`. A stored copy stays in `data`. |
| `storedAt` | The time of the stored copy while `data` holds it. `undefined` once `data` is an answer of this page, or the default. |
| `refresh()` | Calls the loader again and aborts the older call. It never throws: a failure goes to `error`. |

Reads of one key share one state and one loader call, also in different components. The first read of a key always calls the loader, also when it shows a stored copy. The state of a key goes away when its last read unmounts, so the next read calls the loader again. The answer goes to the device when the loader returns. The device keeps it as JSON, so return plain data: objects, arrays, strings, numbers, booleans, and null.

When the device deletes copies, because of another account, `null`, `clearDevice()`, or another tab, a read that shows a stored copy goes back to its default. A read that has an answer of this page keeps it.

## Server rendering

On the server, `useStoredData()` reads no storage and calls no loader. `data` is the default and `status` is `idle`. The functions of `vite-hub/device` store nothing on the server, so no account or copy stays in server memory between requests.

In an app that the server renders, the first render in the browser must match the server. So call `openDevice()` after the app mounts, not before. A read in a component that renders before `openDevice()` renders the default and `idle`, as the server did, and calls the loader when the component mounts. The stored copy shows when the device opens, if the loader has not answered yet.
