import { invariant } from "@vite-hub/internal/invariant"
import { normalizeKey } from "unstorage"
import createDriver from "unstorage/drivers/upstash"

import type { ResolvedUpstashKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { chunks } from "./batch.ts"
import { createPortableRedisKeyLister, escapeRedisGlob, redisDeleteIfEqualsScript, redisIncrementResult, redisIncrementScript, redisTTLSeconds } from "./redis-shared.ts"

interface UpstashClient {
  del: (...keys: string[]) => Promise<number>
  eval: (script: string, keys: string[], args: string[]) => Promise<number>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This models the caller-typed Upstash read command used by the unstorage adapter.
  getdel: <T = unknown>(key: string) => Promise<T | null>
  mget: (...keys: string[]) => Promise<(string | null)[]>
  scan: (cursor: string, options: { count: number; match: string }) => Promise<[number | string, string[]]>
  set: (key: string, value: string, options?: { ex?: number; nx?: true }) => Promise<"OK" | null>
}

const keyBatchSize = 1000

export default function createUpstashKVDriver(options: ResolvedUpstashKVStoreConfig): KVRuntimeDriver {
  const base = normalizeKey(options.base)
  invariant(base, "resolveUpstashStore() gives an Upstash KV store a non-empty `base`, which keeps clear() inside the store")
  // SAFETY: The unstorage Upstash driver exposes getInstance and this adapter installs listKeys before returning.
  const driver = createDriver({ lib: () => import("@upstash/redis"), ...options, base, automaticDeserialization: false }) as KVRuntimeDriver & { getInstance: () => Promise<UpstashClient> }
  const client = () => driver.getInstance()
  const prefixed = (key: string) => `${base}:${key}`
  const unprefixed = (key: string) => key.startsWith(`${base}:`) ? key.slice(base.length + 1) : key

  driver.setItem = async (key, value, setOptions?: { ttl?: unknown }) => {
    const ttl = setOptions?.ttl
    if (ttl !== undefined && ttl !== null && ttl !== 0 && typeof ttl !== "number") throw kvErrorDiagnostics.KV_INVALID_TTL()
    await (await client()).set(prefixed(key), value, typeof ttl === "number" && ttl !== 0 ? { ex: redisTTLSeconds(ttl) } : undefined)
  }
  driver.getItems = async (items) => {
    const values: (string | null)[] = []
    for (const batch of chunks(items, keyBatchSize)) values.push(...await (await client()).mget(...batch.map(item => prefixed(item.key))))
    return items.map((item, index) => ({ key: item.key, value: values[index] ?? null }))
  }
  driver.clear = async (prefix) => {
    const keys: string[] = []
    let cursor = "0"
    do {
      const [next, page] = await (await client()).scan(cursor, { count: keyBatchSize, match: `${escapeRedisGlob(prefixed(prefix ?? ""))}*` })
      cursor = String(next)
      keys.push(...page)
    } while (cursor !== "0")
    for (const batch of chunks(keys, keyBatchSize)) await (await client()).del(...batch)
  }
  driver.getAndDeleteItem = async key => (await client()).getdel(prefixed(key))
  driver.incrementItem = async (key, ttl) => redisIncrementResult(await (await client()).eval(redisIncrementScript, [prefixed(key)], [String(redisTTLSeconds(ttl))]))
  driver.deleteIfEqualsItem = async (key, expected) => Number(await (await client()).eval(redisDeleteIfEqualsScript, [prefixed(key)], [expected])) === 1
  driver.setIfAbsentItem = async (key, value, ttl) => {
    const setOptions = ttl === undefined ? { nx: true as const } : { ex: redisTTLSeconds(ttl), nx: true as const }
    return await (await client()).set(prefixed(key), value, setOptions) === "OK"
  }
  driver.listKeys = createPortableRedisKeyLister("Upstash KV", async (cursor, match, count) => {
    const [next, keys] = await (await client()).scan(cursor, { count, match: `${escapeRedisGlob(base)}:${match}` })
    return [String(next), keys.map(unprefixed)]
  })
  return driver
}
