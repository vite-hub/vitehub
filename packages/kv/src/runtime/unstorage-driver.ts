import { kv } from "@vite-hub/kv"
import { normalizeKey } from "unstorage"
import type { Driver, TransactionOptions } from "unstorage"

import type { Result } from "@vite-hub/runtime"

export interface KVStorageDriverOptions {
  /** The named KV store. Default: the default store. */
  store?: string
  /** Key prefix inside the store, so the mount's keys stay apart from the app's other keys. Default: no prefix. */
  base?: string
}

async function unwrap<T>(pending: Promise<Result<T, string>>): Promise<T> {
  const [error, value] = await pending
  if (error) throw error
  return value
}

/**
 * Unstorage driver over one KV store, for Nitro storage mounts such as `kv` and `cache`.
 * It resolves the store on each call, so a Cloudflare store uses the binding of the current request.
 */
export default function createKVStorageDriver(options: KVStorageDriverOptions = {}): Driver<KVStorageDriverOptions> {
  const base = normalizeKey(options.base)
  const prefix = base ? `${base}:` : ""
  const key = (name: string | undefined) => prefix + normalizeKey(name)
  const below = (name: string | undefined) => {
    const value = key(name)
    return value && !value.endsWith(":") ? `${value}:` : value
  }
  const store = () => options.store === undefined ? kv : kv.store(options.store)
  return {
    name: "vitehub-kv",
    options,
    hasItem: name => unwrap(store().has(key(name))),
    getItem: name => unwrap(store().get(key(name), { type: "text" })),
    getItemRaw: name => unwrap(store().get(key(name), { type: "bytes" })),
    setItem: (name, value, opts: TransactionOptions) => unwrap(store().set(key(name), value, typeof opts?.ttl === "number" ? { ttl: opts.ttl } : undefined)),
    removeItem: name => unwrap(store().delete(key(name))),
    async getKeys(keyBase) {
      return (await unwrap(store().list({ prefix: below(keyBase) }))).keys.map(name => name.slice(prefix.length))
    },
    clear: keyBase => unwrap(store().clear({ prefix: below(keyBase) })),
  }
}
