// The device storage in IndexedDB, with no dependency. One database holds the copies of one account: `meta` has one
// record with the account, the version, and the generation, and `entries` has one record for each key. Each change is
// one transaction, and a write checks the generation inside its transaction.
import type { DeviceChannel, DeviceMessage, DeviceMeta, DeviceStorage, StoredEntry } from "./storage.ts"

const databaseName = "vitehub-device"
// The version of the database format. A database of another format starts empty.
const format = 2
const metaKey = "device"
// The entries by age, with their size: `[storedAt, bytes]`. The size cap reads it without the values.
const ageIndex = "age"
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
      database.createObjectStore("entries", { keyPath: "key" }).createIndex(ageIndex, ["storedAt", "bytes"])
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

/** Deletes the oldest entries, of every tab, until the entries hold at most `maxBytes`. Runs inside the write. */
function evict(entries: IDBObjectStore, maxBytes: number): void {
  const rows: { key: IDBValidKey, bytes: number }[] = []
  let total = 0
  const cursor = entries.index(ageIndex).openKeyCursor()
  cursor.onsuccess = () => {
    const row = cursor.result
    if (row) {
      // SAFETY: the key of the age index is `[storedAt, bytes]`.
      const [, bytes] = row.key as [number, number]
      rows.push({ key: row.primaryKey, bytes })
      total += bytes
      return row.continue()
    }
    for (const { key, bytes } of rows) {
      if (total <= maxBytes) return
      entries.delete(key)
      total -= bytes
    }
  }
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
    async write(meta, { puts, deletes, maxBytes }) {
      const transaction = database.transaction(["meta", "entries"], "readwrite")
      const entries = transaction.objectStore("entries")
      const current = transaction.objectStore("meta").get(metaKey)
      let found: DeviceMeta | undefined
      current.onsuccess = () => {
        found = current.result as DeviceMeta | undefined
        if (found?.generation !== meta.generation || found.account !== meta.account || found.version !== meta.version) return
        for (const key of deletes) entries.delete(key)
        for (const entry of puts) entries.put(entry)
        if (puts.length) evict(entries, maxBytes)
      }
      await done(transaction)
      return found
    },
    async clear(generation) {
      const transaction = database.transaction(["meta", "entries"], "readwrite")
      transaction.objectStore("entries").clear()
      const metas = transaction.objectStore("meta")
      const current = metas.get(metaKey)
      let next: DeviceMeta | undefined
      current.onsuccess = () => {
        const found = current.result as DeviceMeta | undefined
        if (!found) return
        next = { ...found, generation }
        metas.put(next, metaKey)
      }
      await done(transaction)
      return next
    },
    close: () => database.close(),
  }
}

function isMeta(value: unknown): value is DeviceMeta {
  if (!value || typeof value !== "object") return false
  const account: unknown = Reflect.get(value, "account")
  return (account === null || typeof account === "string") && typeof Reflect.get(value, "version") === "string" && typeof Reflect.get(value, "generation") === "string"
}

function isDeviceMessage(value: unknown): value is DeviceMessage {
  if (!value || typeof value !== "object") return false
  const meta: unknown = Reflect.get(value, "meta")
  if (meta !== undefined && !isMeta(meta)) return false
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
