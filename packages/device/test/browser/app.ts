// The page of the browser tests: a Vue app with one stored read of `/api/projects`, which the test answers when it
// wants. The test drives it through `window.deviceTest`.
import { createApp, defineComponent, effectScope, h, watch } from "vue"

import { clearDevice, inspectDevice, openDevice, setDeviceAccount } from "../../src/index.ts"
import { useStoredData } from "../../src/vue.ts"

interface MountOptions {
  version?: string
  /** Names this account after the app mounts. */
  account?: string | null
  maxAge?: number
}

const deviceTest = {
  clearDevice,
  inspectDevice,
  setDeviceAccount,
  /** How long `openDevice()` took, in milliseconds. */
  openMs: 0,
  /** The text of the first render, read in the same task as `app.mount()`. */
  firstRender: "",
  text: () => document.querySelector("#projects")?.textContent ?? "",
  async mount(options: MountOptions = {}) {
    const start = performance.now()
    await openDevice({ version: options.version })
    deviceTest.openMs = performance.now() - start
    const app = createApp(defineComponent({
      setup() {
        const projects = useStoredData("projects", ({ signal }) => fetch("/api/projects", { signal }).then(response => response.json() as Promise<string[]>), { default: () => [], maxAge: options.maxAge })
        return () => h("p", { id: "projects" }, `${projects.data.value.join(",") || "empty"} ${projects.status.value}${projects.storedAt.value ? " stored" : ""}`)
      },
    }))
    app.mount("#app")
    deviceTest.firstRender = deviceTest.text()
    if (options.account !== undefined) await setDeviceAccount(options.account)
  },
  /** Stores `value` as the answer of `key`, and resolves when the read has it. */
  store(key: string, value: unknown): Promise<void> {
    return new Promise((resolve) => {
      const scope = effectScope()
      scope.run(() => {
        const read = useStoredData(key, async () => value)
        watch(read.status, (status) => {
          if (status !== "success") return
          scope.stop()
          resolve()
        })
      })
    })
  },
  /** The keys in IndexedDB, read with the browser API, not with the device. */
  storedKeys: () => readEntries(entries => entries.getAllKeys(), keys => keys.map(String).sort(), [] as string[]),
  /** The first characters of the JSON of `key` in IndexedDB, read with the browser API. */
  storedPrefix: (key: string) => readEntries(entries => entries.get(key), (entry: { json: string } | undefined) => entry?.json.slice(0, 4), undefined),
}

function readEntries<T, R>(request: (entries: IDBObjectStore) => IDBRequest<T>, map: (result: T) => R, empty: R): Promise<R> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("vitehub-device")
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const database = open.result
      if (!database.objectStoreNames.contains("entries")) {
        database.close()
        return resolve(empty)
      }
      const read = request(database.transaction("entries").objectStore("entries"))
      read.onsuccess = () => {
        database.close()
        resolve(map(read.result))
      }
    }
  })
}

Object.assign(window, { deviceTest })
