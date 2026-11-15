import { createDevice } from "../src/device.ts"

import type { Device, DeviceOptions } from "../src/device.ts"
import type { DeviceChannel, DeviceMessage, DeviceMeta, DeviceStorage, StoredEntry } from "../src/storage.ts"

/** A disk that outlives each fake page: what IndexedDB holds for one origin. Values are copied in and out. */
export function createFakeDisk() {
  let meta: DeviceMeta | undefined
  const entries = new Map<string, StoredEntry>()
  const disk = {
    /** Makes each call of the storage fail. */
    failing: false,
    /** Makes `openStorage()` reject, as a sandboxed frame or a private window does. */
    refuse: false,
    /** Makes `openStorage()` never answer, as a stuck IndexedDB does. */
    hang: false,
    get meta() {
      return meta && { ...meta }
    },
    get keys() {
      return [...entries.keys()].sort()
    },
    entry: (key: string) => entries.get(key),
    put(entry: StoredEntry, at: DeviceMeta) {
      meta = { ...at }
      entries.set(entry.key, { ...entry })
    },
    open(): Promise<DeviceStorage> {
      if (disk.hang) return new Promise(() => undefined)
      if (disk.refuse) return Promise.reject(new DOMException("The user denied permission to access the database.", "SecurityError"))
      const fail = async () => {
        if (disk.failing) throw new DOMException("The disk is full.", "QuotaExceededError")
      }
      const storage: DeviceStorage = {
        async read() {
          await fail()
          return structuredClone({ meta, entries: [...entries.values()] })
        },
        async reset(next) {
          await fail()
          entries.clear()
          meta = { ...next }
        },
        async write(expected, puts, deletes) {
          await fail()
          if (!meta || meta.account !== expected.account || meta.version !== expected.version) return false
          for (const key of deletes) entries.delete(key)
          for (const entry of puts) entries.set(entry.key, structuredClone(entry))
          return true
        },
        async clear() {
          await fail()
          entries.clear()
        },
        close: () => undefined,
      }
      return Promise.resolve(storage)
    },
  }
  return disk
}

/** The BroadcastChannel of one browser: a message reaches every other tab, as with a real channel. */
export function createFakeBrowser() {
  const tabs = new Set<{ listener: (message: DeviceMessage) => void }>()
  return {
    channel(): DeviceChannel {
      const tab = { listener: (_message: DeviceMessage) => undefined as void }
      return {
        post(message) {
          for (const other of tabs) if (other !== tab) other.listener(structuredClone(message))
        },
        receive(listener) {
          tab.listener = listener
          tabs.add(tab)
          return () => tabs.delete(tab)
        },
      }
    },
  }
}

export type FakeDisk = ReturnType<typeof createFakeDisk>

/** One page of the app: a device on the shared disk and channel. Open a second one for a reload or another tab. */
export function openPage(disk: FakeDisk, browser = createFakeBrowser(), options: Partial<DeviceOptions> = {}): Device {
  return createDevice({ openStorage: () => disk.open(), channel: browser.channel(), openTimeout: 50, ...options })
}
