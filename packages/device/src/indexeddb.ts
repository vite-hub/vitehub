// The device storage in IndexedDB, with no dependency. One database holds the copies of one account: `meta` has one
// record with the account and the version, and `entries` has one record for each key. Each change is one transaction.
import type { DeviceChannel, DeviceMessage, DeviceMeta, DeviceStorage, StoredEntry } from "./storage.ts"

const databaseName = "vitehub-device"
// The version of the database format. A database of another format starts empty.
const format = 1
const metaKey = "device"
const channelName = "vitehub-device"

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new DOMException("The IndexedDB transaction was aborted.", "AbortError"))
    transaction.onerror = () => reject(transaction.error ?? new DOMException("The IndexedDB transaction failed.", "UnknownError"))
  })
}

/**
 * Opens the IndexedDB storage. It rejects when the browser has no IndexedDB or refuses it, such as a sandboxed frame or
 * some private windows. `indexedDB.open()` can throw at once, and the promise turns that into a rejection.
 */
export function openIndexedDB(): Promise<DeviceStorage> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, format)
    request.onupgradeneeded = () => {
      const database = request.result
      for (const name of Array.from(database.objectStoreNames)) database.deleteObjectStore(name)
      database.createObjectStore("meta")
      database.createObjectStore("entries", { keyPath: "key" })
    }
    request.onsuccess = () => {
      const database = request.result
      // A newer format in another tab must not wait for this tab to close.
      database.onversionchange = () => database.close()
      resolve(indexedDBStorage(database))
    }
    request.onerror = () => reject(request.error)
  })
}

function indexedDBStorage(database: IDBDatabase): DeviceStorage {
  return {
    async read() {
      const transaction = database.transaction(["meta", "entries"], "readonly")
      const meta = transaction.objectStore("meta").get(metaKey)
      const entries = transaction.objectStore("entries").getAll()
      await done(transaction)
      return { meta: meta.result as DeviceMeta | undefined, entries: entries.result as StoredEntry[] }
    },
    async reset(meta) {
      const transaction = database.transaction(["meta", "entries"], "readwrite")
      transaction.objectStore("entries").clear()
      transaction.objectStore("meta").put(meta, metaKey)
      await done(transaction)
    },
    async write(meta, puts, deletes) {
      const transaction = database.transaction(["meta", "entries"], "readwrite")
      const entries = transaction.objectStore("entries")
      const current = transaction.objectStore("meta").get(metaKey)
      let applied = false
      current.onsuccess = () => {
        const stored = current.result as DeviceMeta | undefined
        if (stored?.account !== meta.account || stored.version !== meta.version) return
        applied = true
        for (const key of deletes) entries.delete(key)
        for (const entry of puts) entries.put(entry)
      }
      await done(transaction)
      return applied
    },
    async clear() {
      const transaction = database.transaction("entries", "readwrite")
      transaction.objectStore("entries").clear()
      await done(transaction)
    },
    close: () => database.close(),
  }
}

function isDeviceMessage(value: unknown): value is DeviceMessage {
  if (!value || typeof value !== "object") return false
  const type: unknown = Reflect.get(value, "type")
  if (type === "clear") return true
  const account: unknown = Reflect.get(value, "account")
  return type === "account" && (account === null || typeof account === "string") && typeof Reflect.get(value, "version") === "string"
}

/** The tabs of the browser, through a BroadcastChannel. Without one, each tab works alone. */
export function browserChannel(): DeviceChannel {
  if (typeof BroadcastChannel !== "function") return { post: () => undefined, receive: () => () => undefined }
  const channel = new BroadcastChannel(channelName)
  return {
    post: message => channel.postMessage(message),
    receive(listener) {
      const onMessage = (event: MessageEvent<unknown>) => {
        if (isDeviceMessage(event.data)) listener(event.data)
      }
      channel.addEventListener("message", onMessage)
      return () => channel.removeEventListener("message", onMessage)
    },
  }
}
