import { Redis } from "ioredis"
import { normalizeKey } from "unstorage"

import type { ResolvedRedisKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { chunks } from "./batch.ts"
import { createPortableRedisKeyLister, escapeRedisGlob, redisDeleteIfEqualsScript, redisIncrementResult, redisIncrementScript, redisTTLSeconds } from "./redis-shared.ts"

/** The URL of a store: `env:<NAME>` reads the variable now, so a build never holds the URL of its server. */
export function resolveRedisUrl(url: string, env: Record<string, string | undefined> = globalThis.process?.env ?? {}): string {
  if (!url.startsWith("env:")) return url
  const name = url.slice(4)
  const value = env[name]?.trim()
  if (!value) throw kvErrorDiagnostics.KV_MISSING_ENV({ driver: "redis", names: `\`${name}\`` })
  return value
}

/** Milliseconds for `SET PX`, which keeps fractional TTLs, as the other drivers do. */
function ttlMilliseconds(ttl: number): number {
  redisTTLSeconds(ttl)
  return Math.ceil(ttl * 1000)
}

/** The `PX` milliseconds of a write. Like other unstorage drivers, no TTL or 0 keeps the key. */
function writeTTL(options: { ttl?: unknown } | undefined): number | undefined {
  const ttl = options?.ttl
  if (ttl === undefined || ttl === null || ttl === 0) return
  if (typeof ttl === "number") return ttlMilliseconds(ttl)
  throw kvErrorDiagnostics.KV_INVALID_TTL()
}

/** Keys per `MGET`, so one reply stays a moderate size. */
const mgetBatchSize = 1000

/**
 * KV over a Redis server through TCP, with `ioredis`. Each atomic operation is one command or one script. This module
 * loads only for a Redis store, so other stores do not load `ioredis`.
 */
export default function createRedisKVDriver(options: ResolvedRedisKVStoreConfig): KVRuntimeDriver {
  const base = normalizeKey(options.base)
  // Internal invariant: resolveRedisStore() always supplies a non-empty prefix to keep clear() inside this store.
  if (!base) throw new TypeError("A Redis KV store needs a non-empty `base`.")
  // `maxRetriesPerRequest` fails a command after a few reconnect attempts, so a lost server returns an error.
  // `lazyConnect` opens the connection on the first command.
  const client = new Redis(resolveRedisUrl(options.url), { lazyConnect: true, maxRetriesPerRequest: 3 })
  const prefixed = (key: string) => `${base}:${key}`
  const unprefixed = (key: string) => key.startsWith(`${base}:`) ? key.slice(base.length + 1) : key
  const pattern = (match: string) => `${escapeRedisGlob(base)}:${match}`

  async function scanAll(prefix: string | undefined): Promise<string[]> {
    const keys: string[] = []
    let cursor = "0"
    do {
      const [next, page] = await client.scan(cursor, "MATCH", pattern(`${escapeRedisGlob(prefix ?? "")}*`), "COUNT", 1000)
      cursor = next
      for (const key of page) keys.push(key)
    } while (cursor !== "0")
    return keys
  }

  const listKeys = createPortableRedisKeyLister("Redis KV", async (cursor, match, count) => {
    const [next, keys] = await client.scan(cursor, "MATCH", pattern(match), "COUNT", count)
    return [next, keys.map(unprefixed)]
  })

  return {
    name: "vitehub-kv-redis",
    options,
    hasItem: async key => await client.exists(prefixed(key)) > 0,
    getItem: async key => await client.get(prefixed(key)),
    async getItems(items) {
      const values: (string | null)[] = []
      for (const batch of chunks(items, mgetBatchSize)) values.push(...await client.mget(...batch.map(item => prefixed(item.key))))
      return items.map((item, index) => ({ key: item.key, value: values[index] ?? null }))
    },
    async setItem(key, value, setOptions?: { ttl?: unknown }) {
      const ttl = writeTTL(setOptions)
      if (ttl === undefined) await client.set(prefixed(key), value)
      else await client.set(prefixed(key), value, "PX", ttl)
    },
    // One pipeline, so the writes cost one round trip. It is not a transaction.
    async setItems(items, setOptions?: { ttl?: unknown }) {
      const pipeline = client.pipeline()
      for (const item of items) {
        const ttl = writeTTL({ ...setOptions, ...item.options })
        if (ttl === undefined) pipeline.set(prefixed(item.key), item.value)
        else pipeline.set(prefixed(item.key), item.value, "PX", ttl)
      }
      for (const [error] of await pipeline.exec() ?? []) {
        if (error) throw error
      }
    },
    async removeItem(key) {
      await client.unlink(prefixed(key))
    },
    getKeys: async base => (await scanAll(base)).map(unprefixed),
    async clear(base) {
      const keys = await scanAll(base)
      for (let offset = 0; offset < keys.length; offset += 1000) {
        await client.unlink(...keys.slice(offset, offset + 1000))
      }
    },
    async setIfAbsentItem(key, value, ttl) {
      const result = ttl === undefined
        ? await client.set(prefixed(key), value, "NX")
        : await client.set(prefixed(key), value, "PX", ttlMilliseconds(ttl), "NX")
      return result === "OK"
    },
    // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This implements the caller-typed driver read, like getItem().
    async getAndDeleteItem<T = unknown>(key: string): Promise<T | null> {
      // SAFETY: The KV runtime decodes the stored text into the caller's type, as it does for getItem().
      return await client.getdel(prefixed(key)) as T | null
    },
    incrementItem: async (key, ttl) => redisIncrementResult(await client.eval(redisIncrementScript, 1, prefixed(key), redisTTLSeconds(ttl))),
    deleteIfEqualsItem: async (key, expected) => Number(await client.eval(redisDeleteIfEqualsScript, 1, prefixed(key), expected)) === 1,
    listKeys,
    async dispose() {
      client.disconnect()
    },
  }
}
