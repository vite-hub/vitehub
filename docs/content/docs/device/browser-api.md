---
title: Device browser API
description: Open the device, name its account, read with useStoredData() and useStoredFetch(), set up Nuxt, and the rules for tabs and server rendering.
navigation.title: Browser API
navigation.order: 4
icon: i-lucide-code
---

`vite-hub/device` has the functions of the device. `vite-hub/device/vue` has `useStoredData()` and `useStoredFetch()`. Both run in the browser. On the server, they store nothing. In Nuxt, the [ViteHub module](#nuxt) opens the device and auto-imports them.

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

`openDevice()` never fails. When the browser has no working IndexedDB, or IndexedDB takes more than 1 second, the page keeps its copies in memory. Call it once: a second call with another version throws `DEVICE_ALREADY_OPEN`. In Nuxt, the module calls it, and `vitehub: { device: { version } }` sets its version.

## `setDeviceAccount()`

Names the signed-in account. With ViteHub Auth in Nuxt, the [module](#nuxt) calls it for you. When a read says who is signed in, give it the `account` option of [`useStoredData()`](#usestoreddata) or [`useStoredFetch()`](#usestoredfetch) instead. Call `setDeviceAccount()` when your app learns the account another way, such as from the HTML or an auth client, and with `null` after a sign-out:

```ts [src/session.ts]
import { setDeviceAccount } from 'vite-hub/device'

export async function onSession(user: { id: string } | null) {
  const [error] = await setDeviceAccount(user?.id ?? null)
  if (error) console.warn(error.why, error.fix)
}
```

| Call | Result |
| --- | --- |
| The same account as the stored copies | The copies stay. Each read that runs calls its loader again, and its next answer goes to the disk. |
| Another account | Every copy goes, in every tab. A read that shows a copy of the other account, and every read after the page named an account, shows its default and calls its loader again. |
| `null` | Every copy goes, in every tab. The device stores nothing until the page names an account again. A read that shows a copy of the other account, and every read after the page named an account, shows its default and calls its loader again. |

The device stores an answer only when its loader call started after the page named its account, and nothing made the answers old since then. An answer that came before the page named its account stays on the screen until the new one, and the device never stores it. The one exception is the read with the `account` option: its answer says who is signed in, so it names that account and is stored under it, also though its call started before. If your app knows the account before it mounts, such as from the HTML, call `setDeviceAccount()` before `app.mount()`, so each read calls its loader once.

After `openDevice()`, the page names the account during the call. A read that starts on the next line can be stored. The promise resolves when IndexedDB follows, such as after it deleted the copies of another account, so you do not need to wait for it before your reads.

It returns `[error, undefined]`. `error` is `DEVICE_STORAGE_FAILED` when IndexedDB failed to delete the copies of the previous account. An empty string or another value throws `DEVICE_INVALID_ACCOUNT`.

## `clearDevice()`

Deletes every copy in this tab and in every other tab of the app. Every read shows its default and calls its loader again. The account stays, so the next answers are stored again. It returns `[error, undefined]`, with `DEVICE_STORAGE_FAILED` when IndexedDB failed.

## `inspectDevice()`

Gives the state of the device of this tab:

| Field | Holds |
| --- | --- |
| `account` | The account that the page named. Before that, the account of the copies from the last visit. `null` when there is none. |
| `persisted` | `true` when new copies go to IndexedDB. `false` before the page names an account, after `null`, in memory mode, and when another tab changed the disk while this tab named its account, such as a tab of another version. The next `setDeviceAccount()` call makes it `true` again. |
| `storage` | `indexeddb`, or `memory` when IndexedDB failed or `openDevice()` was not called. |
| `entries` | `{ key, storedAt, bytes }` for each copy, by key. `bytes` is the size of the JSON. |

## `useStoredData()`

```vue [src/components/ProjectPage.vue]
<script setup lang="ts">
import { useStoredData } from 'vite-hub/device/vue'

const props = defineProps<{ id: string }>()

const { data: project, status, error, refresh, storedAt } = useStoredData(
  () => `project:${props.id}`,
  async ({ signal }) => {
    const response = await fetch(`/api/projects/${props.id}`, { signal })
    // An error answer must throw, or the device stores it as the project.
    if (!response.ok) throw new Error(`The project answered ${response.status}.`)
    return await response.json() as { name: string }
  },
)
</script>
```

A loader that does not throw on an error answer returns the error body as data, and the device stores it. For a GET of JSON, [`useStoredFetch()`](#usestoredfetch) checks the status for you.

| Argument | Does |
| --- | --- |
| `key` | Names the stored copy. A string, a ref, or a getter. When it changes, the read moves to the new key, as if it started again. |
| `loader` | `({ signal }) => Promise<T>`. Calls the server. `signal` aborts when a newer call starts, when the last component of the read unmounts or moves to another key, when another account, a sign-out, or a clear makes the answer old, and when the page names its account. |

| Option | Default | Does |
| --- | --- | --- |
| `default` | `() => undefined` | The value when the device has no copy. |
| `maxAge` | 7 days | A stored copy that is older does not show, and the disk deletes it at the next `openDevice()` or write. In milliseconds. |
| `account` | none | For the read that says who is signed in, such as `/api/session`: returns the account of an answer, or `null` when nobody is signed in. Each answer names its account, as `setDeviceAccount()` does, and is stored under it, also though its call started before the naming. The read keeps its answer and does not call its loader again. A stored copy and a failed call name nothing. An answer whose call started before another account, a sign-out, or a clear names nothing, and the read calls its loader again. While it runs and the page named no account, a read that shows a stored copy waits for it, so its loader runs once. |

| Field | Holds |
| --- | --- |
| `data` | The stored copy, then the answer of the loader. Before both, the default. |
| `status` | `idle` on the server, and in the first render of a read that starts before `openDevice()`. `pending` while the loader runs, then `success` or `error`. |
| `error` | What the loader threw, as an `Error`. A stored copy stays in `data`. |
| `storedAt` | The time of the stored copy while `data` holds it. `undefined` once `data` is an answer of this page, or the default. |
| `refresh()` | Calls the loader again and aborts the older call. It never throws: a failure goes to `error`. |

Reads of one key share one state and one loader call, also in different components. The first read of a key always calls the loader, also when it shows a stored copy. The state of a key goes away when its last read unmounts, so the next read calls the loader again. The answer goes to the device when the loader returns, if the call started after the page named its account. The device keeps it as JSON, so return plain data: objects, arrays, strings, numbers, booleans, and null.

After another account or a sign-out in a page that named an account, after `clearDevice()`, and after any change of the disk by another tab, also for the same account, every read shows its default and calls its loader again, also a read whose loader answered. The answer of a loader call that started before the change does not show and does not go to the device. When a page names its first account, a read that shows a stored copy of another account goes back to the default, every other read keeps what it shows, and each read calls its loader again. The read with `account` whose answer named the account keeps it, and does not call its loader again for that naming.

## `useStoredFetch()`

A GET request for JSON with `useStoredData()`. The URL is the key of the stored copy.

```vue [src/components/TeamProjects.vue]
<script setup lang="ts">
import { useStoredFetch } from 'vite-hub/device/vue'

const props = defineProps<{ team: string }>()

const { data: projects, error } = useStoredFetch<{ id: string, name: string }[]>('/api/projects', {
  query: () => ({ team: props.team, archived: false }),
  default: () => [],
})
</script>
```

| Argument | Does |
| --- | --- |
| `url` | The URL to fetch. A string, a ref, or a getter. A path, such as `/api/projects`, or a URL on another origin. |
| `query` | Joins the query of the URL. A `null` or `undefined` value is left out. An object, a ref, or a getter. |

It takes the options of `useStoredData()`: `default`, `maxAge`, and `account`. It returns the same fields. The type argument names the JSON, such as `useStoredFetch<Project[]>()`, and with it, the `default` has the same type.

- **The key.** The path and the query, sorted by name, such as `/api/projects?archived=false&team=t1`. A URL on another origin keeps its origin in the key. The hash goes. A new URL or query is a new read, which aborts the request of the previous one.
- **The request.** `fetch(key, { signal, headers: { accept: 'application/json' } })`. The cookies of the page go with a request on the same origin, as with any `fetch()`.
- **Errors.** An answer that is not 2xx goes to `error` as `DEVICE_FETCH_FAILED`, with the status in its `why`. The device never stores it, and the stored copy stays in `data`. A read with `account` names nothing from it, so an error body such as `{ user: null }` does not delete the copies.
- **Not in `useStoredFetch()`.** Other methods, a body, a `transform`, and a `baseURL`. Use `useStoredData()` with your own loader.

## Nuxt

When the app installs `@vite-hub/device`, the `vite-hub/nuxt` module adds a client plugin and auto-imports `useStoredData()`, `useStoredFetch()`, `setDeviceAccount()`, `clearDevice()`, and `inspectDevice()`. The plugin calls `openDevice()`, so it is not auto-imported.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { device: { version: '2' } },
})
```

| Option | Default | Does |
| --- | --- | --- |
| `device` | on | `false` turns off the plugin and the auto-imports. |
| `device.version` | none | The `version` of `openDevice()`. Without it, a deploy keeps the copies. Change it when an answer changes shape. |
| `device.account` | on with Auth | `false`: the plugin does not name the account, and your app calls `setDeviceAccount()`. |

The plugin does this in the browser:

- **A page that the server rendered.** It calls `openDevice()` when hydration ends, so the first render matches the server HTML. The reads render the default and `idle`, as on the server, start their loaders when they mount, and show the stored copies when the device opens.
- **No server HTML**, such as with `ssr: false`. It awaits `openDevice()` before the app mounts, so the first render shows the stored copies.
- **With ViteHub Auth.** It watches `useUserSession()`. When the session is read, it calls `setDeviceAccount()` with the user id, or `null` without a user. A session read that failed names nobody, so a reload without a network keeps the copies. On `signOut()`, it calls `setDeviceAccount(null)`, and `signOut()` waits until the copies are gone before it opens the next page.

## Server rendering

On the server, `useStoredData()` reads no storage and calls no loader. `data` is the default and `status` is `idle`. The functions of `vite-hub/device` store nothing on the server, so no account or copy stays in server memory between requests.

In an app that the server renders, the first render in the browser must match the server. So call `openDevice()` after the app mounts, not before. In Nuxt, the module does it when hydration ends. A read in a component that renders before `openDevice()` renders the default and `idle`, as the server did, and calls the loader when the component mounts. The stored copy shows when the device opens, if the loader has not answered yet.
