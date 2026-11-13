import { createStorage, hasDotSegment, normalizeBaseKey } from "unstorage"
import type { Driver } from "unstorage"

const removeBatchSize = 100

/** Gives single-store KV prefixes the same meaning for clear() and getKeys(). */
export function createKVStorage(driver: Driver) {
  const storage = createStorage({ driver })
  const clear = storage.clear
  storage.clear = async (base, options = {}) => {
    const prefix = normalizeBaseKey(base)
    if (!prefix) return clear(base, options)
    if (hasDotSegment(prefix)) throw new Error(`[unstorage] Invalid base: ${JSON.stringify(base)}`)
    // unstorage clear(base) selects mounted stores, not keys in the root store, so give the base to the driver.
    // Every KV driver deletes only the keys that start with `prefix`. It ends with ":", so "a" never clears "ab".
    if (driver.clear) return driver.clear(prefix, options)
    const keys = await storage.getKeys(base, options)
    for (let offset = 0; offset < keys.length; offset += removeBatchSize) {
      await Promise.all(keys.slice(offset, offset + removeBatchSize).map(key => storage.removeItem(key, options)))
    }
  }
  return storage
}
