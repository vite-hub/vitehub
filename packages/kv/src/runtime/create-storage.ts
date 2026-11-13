import { createStorage, normalizeKey } from "unstorage"
import type { Driver, StorageValue, TransactionOptions } from "unstorage"

import { mapWithLimit } from "./batch.ts"

/** The batch methods behind `kv.getMany()` and `kv.setMany()`. */
export interface KVBatchStorage {
  /** One value or `null` per key, in the order of `keys`. */
  getMany(keys: readonly string[], options?: TransactionOptions): Promise<unknown[]>
  setMany(entries: readonly { key: string, value: StorageValue | undefined }[], options?: TransactionOptions): Promise<void>
}

function isRawType(type: unknown): boolean {
  return type === "bytes" || type === "blob" || type === "stream"
}

/** Gives single-store KV prefixes the same meaning for clear() and getKeys(), and adds the batch methods. */
export function createKVStorage(driver: Driver) {
  const storage = createStorage({ driver })
  const clear = storage.clear
  storage.clear = async (base, options) => {
    if (!normalizeKey(base)) return clear(base, options)
    // unstorage clear(base) selects mounted stores, not keys in the root store.
    for (const key of await storage.getKeys(base, options)) {
      await storage.removeItem(key, options)
    }
  }
  const batch: KVBatchStorage = {
    async getMany(keys, options = {}) {
      if (!Array.isArray(keys)) throw new TypeError("kv.getMany() needs an array of keys.")
      if (keys.length === 0) return []
      // unstorage reads `bytes`, `blob`, and `stream` values one key at a time, without a limit, so this limits them.
      if (!driver.getItems || isRawType(options.type)) return mapWithLimit(keys, key => storage.getItem(key, options))
      const entries = await storage.getItems(keys, options)
      if (entries.length !== keys.length) throw new Error("The KV driver returned another number of values than keys.")
      return entries.map(entry => entry.value)
    },
    async setMany(entries, options) {
      if (!Array.isArray(entries)) throw new TypeError("kv.setMany() needs an array of { key, value } entries.")
      // Like set() calls in order, the last entry of a key wins. `undefined` deletes the key, as set() does.
      const latest = new Map<string, StorageValue | undefined>()
      for (const { key, value } of entries) {
        const normalized = normalizeKey(key)
        latest.delete(normalized)
        latest.set(normalized, value)
      }
      const writes: { key: string, value: StorageValue }[] = []
      const removals: string[] = []
      for (const [key, value] of latest) {
        if (value === undefined) removals.push(key)
        else writes.push({ key, value })
      }
      await Promise.all([
        writes.length === 0
          ? undefined
          : driver.setItems
            ? storage.setItems(writes, options)
            : mapWithLimit(writes, entry => storage.setItem(entry.key, entry.value, options)),
        mapWithLimit(removals, key => storage.removeItem(key, options)),
      ])
    },
  }
  return Object.assign(storage, batch)
}
