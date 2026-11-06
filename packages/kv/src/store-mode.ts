import { kvErrorDiagnostics } from "./error-diagnostics.ts"

import type { KVStorage, KVStoreOptions, ReadonlyKVStorage } from "./types.ts"

/**
 * Returns the handle that `kv.store(name, options)` gives. An unknown mode throws, so a typo never gives a writable handle.
 * The read-only handle has only the read methods; write methods are absent, not stubbed.
 */
export function kvStoreWithMode(storage: KVStorage, options: KVStoreOptions | undefined): KVStorage | ReadonlyKVStorage {
  const mode = options?.mode === undefined ? "write" : options.mode
  if (mode !== "read" && mode !== "write") throw kvErrorDiagnostics.KV_INVALID_STORE_MODE({ mode: JSON.stringify(mode) })
  if (mode === "write") return storage
  // KV handle methods read only their store name, not `this`.
  return { get: storage.get, has: storage.has, keys: storage.keys, list: storage.list }
}
