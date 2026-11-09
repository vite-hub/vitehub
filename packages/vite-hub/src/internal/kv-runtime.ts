import { fileURLToPath } from "node:url"

import type { resolveKVViteConfig } from "@vite-hub/kv/vite"

type ResolvedKV = ReturnType<typeof resolveKVViteConfig>["kv"]

export const upstashDriverSpecifier = "@vite-hub/kv/runtime/upstash-driver"
export const disabledUpstashDriver = fileURLToPath(import.meta.resolve("vite-hub/_internal/kv/runtime/disabled-upstash"))
export const redisDriverSpecifier = "@vite-hub/kv/runtime/redis-driver"
export const disabledRedisDriver = fileURLToPath(import.meta.resolve("vite-hub/_internal/kv/runtime/disabled-redis"))

/**
 * The `#vitehub/kv/config` module when KV is off, with the exports of the one `@vite-hub/kv/vite` generates. The Console
 * and Agents bundle KV operations either way.
 */
export const disabledKVConfigModule = "export const hosting = undefined\nexport const kv = false\nexport const loadDatabases = undefined\nexport default { hosting, kv }\n"

export function hasUpstashStore(kv: ResolvedKV): boolean {
  if (!kv) return false
  return Object.values(kv.stores || { default: kv.store }).some(store => store.driver === "upstash")
}

/** An explicit `redis` store, or an inferred Node store, which uses Redis when `REDIS_URL` is set at runtime. */
export function hasRedisStore(kv: ResolvedKV): boolean {
  if (!kv) return false
  return Object.values(kv.stores || { default: kv.store }).some(store => store.driver === "redis" || ("inferred" in store && store.inferred === true))
}
