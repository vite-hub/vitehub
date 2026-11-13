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
  const prefix = `${normalizeKey(options.base ?? "nitro-cache") || "nitro-cache"}:`
  const key = (name: string | undefined) => prefix + normalizeKey(name)
  return {
    name: "vitehub-kv",
    options,
    hasItem: name => unwrap(kv.has(key(name))),
    // Return the stored text: Nitro's storage parses driver values itself, and parsing twice turns a cached '"123"' into 123.
    getItem: name => unwrap(kv.get(key(name), { type: "text" })),
    // Raw entries are stored as base64 text; reading them as text would decode the bytes as UTF-8 and mangle them.
    getItemRaw: name => unwrap(kv.get(key(name), { type: "bytes" })),
    // Nitro sends `{ ttl }` or no options. KV accepts no other option.
    setItem: (name, value, opts: TransactionOptions) => unwrap(kv.set(key(name), value, typeof opts?.ttl === "number" ? { ttl: opts.ttl } : undefined)),
    removeItem: name => unwrap(kv.delete(key(name))),
    async getKeys(base) {
      return (await unwrap(kv.keys(key(base)))).map(name => name.slice(prefix.length))
    },
    clear: base => unwrap(kv.clear(key(base))),
  }
}
