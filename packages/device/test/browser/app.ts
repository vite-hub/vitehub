import { createApp, defineComponent, effectScope, h, watch } from "vue"

import { clearDevice, inspectDevice, openDevice, setDeviceAccount } from "../../src/index.ts"
import { openIndexedDB } from "../../src/indexeddb.ts"
import { useStoredData } from "../../src/vue.ts"

interface MountOptions {
  version?: string
  account?: string | null
  maxAge?: number
}

const deviceTest = {
  clearDevice,
  inspectDevice,
  setDeviceAccount,
  openMs: 0,
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
  async resetDisk(account: string, expected: string | undefined): Promise<string | undefined> {
    const storage = await openIndexedDB()
    const found = await storage.reset({ account, version: "", generation: "reset-by-test" }, expected)
    storage.close()
    return found?.generation
  },
  async diskGeneration(): Promise<string | undefined> {
    const storage = await openIndexedDB()
    const { meta } = await storage.read()
    storage.close()
    return meta?.generation
  },
  storedKeys: () => readEntries(entries => entries.getAllKeys(), keys => keys.map(String).sort(), [] as string[]),
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
