import { createDevice } from "../src/device.ts"

import type { Device, DeviceOptions } from "../src/device.ts"
import type { DeviceChannel, DeviceMessage, DeviceMeta, DeviceStorage, StoredEntry } from "../src/storage.ts"

export function createFakeDisk() {
  let meta: DeviceMeta | undefined
  const entries = new Map<string, StoredEntry>()
  let gate: Promise<void> | undefined
  const disk = {
    holdNextRead(): () => void {
      let release = () => undefined as void
      gate = new Promise(resolve => release = resolve)
      return release
    },
    failing: false,
    refuse: false,
    hang: false,
    get meta() {
      return meta && { ...meta }
    },
    get keys() {
      return [...entries.keys()].sort()
    },
    entry: (key: string) => entries.get(key),
    open(): Promise<DeviceStorage> {
      if (disk.hang) return new Promise(() => undefined)
      if (disk.refuse) return Promise.reject(new DOMException("The user denied permission to access the database.", "SecurityError"))
      const fail = async () => {
        if (disk.failing) throw new DOMException("The disk is full.", "QuotaExceededError")
      }
      const storage: DeviceStorage = {
        async read() {
          await fail()
          const snapshot = structuredClone({ meta, entries: [...entries.values()] })
          const held = gate
          gate = undefined
          await held
          return snapshot
        },
        async reset(next, expected) {
          await fail()
          const found = meta && { ...meta }
          if (found?.generation !== expected) return found
          entries.clear()
          meta = { ...next }
          return found
        },
        async write(expected, { puts, deletes, maxBytes, now }) {
          await fail()
          const found = meta && { ...meta }
          if (found?.generation !== expected.generation || found.account !== expected.account || found.version !== expected.version) return found
          for (const key of deletes) entries.delete(key)
          for (const entry of puts) entries.set(entry.key, structuredClone(entry))
          let total = 0
          for (const entry of entries.values()) {
            if (entry.expiresAt <= now) entries.delete(entry.key)
            else total += entry.bytes
          }
          for (const entry of [...entries.values()].sort((a, b) => a.storedAt - b.storedAt)) {
            if (total <= maxBytes) break
            entries.delete(entry.key)
            total -= entry.bytes
          }
          return found
        },
        async clear(generation) {
          await fail()
          entries.clear()
          if (meta) meta = { ...meta, generation }
          return meta && { ...meta }
        },
        close: () => undefined,
      }
      return Promise.resolve(storage)
    },
  }
  return disk
}

export function createFakeBrowser() {
  const tabs = new Set<{ listener: (message: DeviceMessage) => void }>()
  const browser = {
    drop: undefined as ((message: DeviceMessage) => boolean) | undefined,
    channel(): DeviceChannel {
      const tab = { listener: (_message: DeviceMessage) => undefined as void }
      return {
        post(message) {
          if (browser.drop?.(message)) return
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
  return browser
}

export type FakeDisk = ReturnType<typeof createFakeDisk>

export function openPage(disk: FakeDisk, browser = createFakeBrowser(), options: Partial<DeviceOptions> = {}): Device {
  return createDevice({ openStorage: () => disk.open(), channel: browser.channel(), openTimeout: 50, ...options })
}
