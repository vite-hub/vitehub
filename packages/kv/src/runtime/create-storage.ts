import { createStorage, normalizeKey } from "unstorage"
import type { Driver } from "unstorage"

/** Gives single-store KV prefixes the same meaning for clear() and getKeys(). */
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
  return storage
}
