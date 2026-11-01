import { kv } from "@vite-hub/kv"
import { normalizeKey } from "unstorage"
import type { Driver, TransactionOptions } from "unstorage"

import type { Result } from "@vite-hub/runtime"

export interface KVCacheDriverOptions {
  /** Key prefix inside the default KV store, so cache entries stay apart from the app's keys. */
  base?: string
}

async function unwrap<T>(pending: Promise<Result<T, string>>): Promise<T> {
  const [error, value] = await pending
  if (error) throw error
  return value
}

/** Unstorage driver over the app's default KV store, for Nitro's `cache` mount. */
export default function createKVCacheDriver(options: KVCacheDriverOptions = {}): Driver<KVCacheDriverOptions> {
  const prefix = `${normalizeKey(options.base ?? "nitro-cache")}:`
  const key = (name: string | undefined) => prefix + normalizeKey(name)
  return {
    name: "vitehub-kv",
    options,
    hasItem: name => unwrap(kv.has(key(name))),
    getItem: name => unwrap(kv.get(key(name))),
    setItem: (name, value, opts: TransactionOptions) => unwrap(kv.set(key(name), value, opts)),
    removeItem: name => unwrap(kv.del(key(name))),
    async getKeys(base) {
      return (await unwrap(kv.keys(key(base)))).map(name => name.slice(prefix.length))
    },
    clear: base => unwrap(kv.clear(key(base))),
  }
}
