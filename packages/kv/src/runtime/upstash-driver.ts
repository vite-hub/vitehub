import createDriver from "unstorage/drivers/upstash"

import type { ResolvedUpstashKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"
import { createRedisKeyLister, redisDeleteIfEqualsScript, redisIncrementResult, redisIncrementScript, redisTTLSeconds } from "./redis-shared.ts"

interface UpstashClient {
  eval: (script: string, keys: string[], args: string[]) => Promise<number>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This models the caller-typed Upstash read command used by the unstorage adapter.
  getdel: <T = unknown>(key: string) => Promise<T | null>
  scan: (cursor: string, options: { count: number; match: string }) => Promise<[number | string, string[]]>
  set: (key: string, value: string, options: { ex?: number; nx: true }) => Promise<"OK" | null>
}

export default function createUpstashKVDriver(options: ResolvedUpstashKVStoreConfig): KVRuntimeDriver {
  // Let unstorage decode reads so typed text reads and GETDEL preserve the stored text, including "null".
  // SAFETY: The unstorage Upstash driver exposes getInstance and this adapter installs listKeys before returning.
  const driver = createDriver({ lib: () => import("@upstash/redis"), ...options, automaticDeserialization: false }) as KVRuntimeDriver & { getInstance: () => Promise<UpstashClient> }
  const lister = createRedisKeyLister("Upstash KV", async (cursor, match, count) => {
    const [next, keys] = await (await driver.getInstance()).scan(cursor, { count, match })
    return [String(next), keys]
  })
  const dispose = driver.dispose
  driver.dispose = async () => {
    try { await lister.dispose() }
    finally { await dispose?.call(driver) }
  }

  driver.getAndDeleteItem = async key => (await driver.getInstance()).getdel(key)
  driver.incrementItem = async (key, ttl) => redisIncrementResult(await (await driver.getInstance()).eval(redisIncrementScript, [key], [String(redisTTLSeconds(ttl))]))
  driver.deleteIfEqualsItem = async (key, expected) => Number(await (await driver.getInstance()).eval(redisDeleteIfEqualsScript, [key], [expected])) === 1

  driver.setIfAbsentItem = async (key, value, ttl) => {
    const options = ttl === undefined ? { nx: true as const } : { ex: redisTTLSeconds(ttl), nx: true as const }
    return await (await driver.getInstance()).set(key, value, options) === "OK"
  }
  driver.listKeys = lister.listKeys
  return driver
}
