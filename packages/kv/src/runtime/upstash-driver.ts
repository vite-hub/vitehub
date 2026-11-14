import { normalizeKey } from "unstorage"
import createDriver from "unstorage/drivers/upstash"

import type { ResolvedUpstashKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { createPortableRedisKeyLister, escapeRedisGlob, redisDeleteIfEqualsScript, redisIncrementResult, redisIncrementScript, redisTTLSeconds } from "./redis-shared.ts"

interface UpstashClient {
  eval: (script: string, keys: string[], args: string[]) => Promise<number>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This models the caller-typed Upstash read command used by the unstorage adapter.
  getdel: <T = unknown>(key: string) => Promise<T | null>
  scan: (cursor: string, options: { count: number; match: string }) => Promise<[number | string, string[]]>
  set: (key: string, value: string, options?: { ex?: number; nx?: true }) => Promise<"OK" | null>
}

export default function createUpstashKVDriver(options: ResolvedUpstashKVStoreConfig): KVRuntimeDriver {
  const base = normalizeKey(options.base)
  // Internal invariant: resolveUpstashStore() always gets a non-empty prefix to keep clear() inside this store.
  if (!base) throw new TypeError("An Upstash KV store needs a non-empty `base`.")
  // Let unstorage decode reads so typed text reads and GETDEL preserve the stored text, including "null".
  // unstorage prefixes the keys of its own methods with `base`. The methods below prefix theirs.
  // SAFETY: The unstorage Upstash driver exposes getInstance and this adapter installs listKeys before returning.
  const driver = createDriver({ lib: () => import("@upstash/redis"), ...options, base, automaticDeserialization: false }) as KVRuntimeDriver & { getInstance: () => Promise<UpstashClient> }
  const client = () => driver.getInstance()
  const prefixed = (key: string) => `${base}:${key}`
  const unprefixed = (key: string) => key.startsWith(`${base}:`) ? key.slice(base.length + 1) : key

  // Like the Redis driver, no TTL or 0 keeps the key. Upstash takes whole seconds only.
  driver.setItem = async (key, value, setOptions?: { ttl?: unknown }) => {
    const ttl = setOptions?.ttl
    if (ttl !== undefined && ttl !== null && ttl !== 0 && typeof ttl !== "number") throw kvErrorDiagnostics.KV_INVALID_TTL()
    await (await client()).set(prefixed(key), value, typeof ttl === "number" && ttl !== 0 ? { ex: redisTTLSeconds(ttl) } : undefined)
  }
  driver.getAndDeleteItem = async key => (await client()).getdel(prefixed(key))
  driver.incrementItem = async (key, ttl) => redisIncrementResult(await (await client()).eval(redisIncrementScript, [prefixed(key)], [String(redisTTLSeconds(ttl))]))
  driver.deleteIfEqualsItem = async (key, expected) => Number(await (await client()).eval(redisDeleteIfEqualsScript, [prefixed(key)], [expected])) === 1
  driver.setIfAbsentItem = async (key, value, ttl) => {
    const setOptions = ttl === undefined ? { nx: true as const } : { ex: redisTTLSeconds(ttl), nx: true as const }
    return await (await client()).set(prefixed(key), value, setOptions) === "OK"
  }
  // The cursor holds all its state, so the next page works in another serverless invocation.
  driver.listKeys = createPortableRedisKeyLister("Upstash KV", async (cursor, match, count) => {
    const [next, keys] = await (await client()).scan(cursor, { count, match: `${escapeRedisGlob(base)}:${match}` })
    return [String(next), keys.map(unprefixed)]
  })
  // unstorage's Upstash driver has no dispose(), but KV storage and callers dispose every driver.
  const dispose = driver.dispose
  driver.dispose = async () => { await dispose?.call(driver) }
  return driver
}
