import { createStorage, normalizeKey } from "unstorage"
import type { Driver, StorageValue, TransactionOptions } from "unstorage"

import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { mapWithLimit } from "./batch.ts"
import { normalizeKVListPrefix } from "./list-prefix.ts"

/** The batch methods behind `kv.getMany()` and `kv.setMany()`. */
export interface KVBatchStorage {
  /** One value or `null` per key, in the order of `keys`. */
  getMany(keys: readonly string[], options?: TransactionOptions): Promise<unknown[]>
  setMany(entries: readonly { key: string, value: StorageValue | undefined }[], options?: TransactionOptions): Promise<void>
}

function isRawType(type: unknown): boolean {
  return type === "bytes" || type === "blob" || type === "stream"
}

const removeBatchSize = 100

/** Gives `clear(prefix)` the text-prefix meaning of `list({ prefix })`, and adds the batch methods. */
export function createKVStorage(driver: Driver & { validateBatch?: (items: Parameters<NonNullable<Driver["setItems"]>>[0], removals: string[], options?: TransactionOptions) => void | Promise<void> }) {
  const storage = createStorage({ driver })
  const clear = storage.clear
  storage.clear = async (base, options = {}) => {
    const prefix = normalizeKVListPrefix(base)
    if (!prefix) return clear("", options)
    if (driver.clear) return driver.clear(prefix, options)
    const keys = (await storage.getKeys("", options)).filter(key => key.startsWith(prefix))
    for (let offset = 0; offset < keys.length; offset += removeBatchSize) {
      await Promise.all(keys.slice(offset, offset + removeBatchSize).map(key => storage.removeItem(key, options)))
    }
  }
  const batch: KVBatchStorage = {
    async getMany(keys, options = {}) {
      if (!Array.isArray(keys)) throw kvErrorDiagnostics.KV_INVALID_BATCH({ operation: "getMany" })
      if (keys.length === 0) return []
      if (!driver.getItems || isRawType(options.type)) return mapWithLimit(keys, key => storage.getItem(key, options))
      const entries = await storage.getItems(keys, options)
      if (entries.length !== keys.length) throw kvErrorDiagnostics.KV_PROVIDER_INVALID_RESPONSE({ problem: "The batch read returned another number of values than keys." })
      return entries.map(entry => entry.value)
    },
    async setMany(entries, options) {
      if (!Array.isArray(entries)) throw kvErrorDiagnostics.KV_INVALID_BATCH({ operation: "setMany" })
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
      if (driver.validateBatch) {
        await driver.validateBatch([], removals, options)
        const validateBatch = driver.validateBatch
        const validation = createStorage({ driver: { ...driver, setItems: items => validateBatch(items, removals, options) } })
        await validation.setItems(writes, options)
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
