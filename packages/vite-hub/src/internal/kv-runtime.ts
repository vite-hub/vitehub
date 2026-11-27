import { ownModule } from "@vite-hub/internal/build/paths"
import type { resolveKVViteConfig } from "@vite-hub/kv/vite"

type ResolvedKV = ReturnType<typeof resolveKVViteConfig>["kv"]

export const upstashDriverSpecifier = "@vite-hub/kv/runtime/upstash-driver"
export const disabledUpstashDriver = ownModule(import.meta.url, "internal/disabled-upstash-driver")
export const redisDriverSpecifier = "@vite-hub/kv/runtime/redis-driver"
export const disabledRedisDriver = ownModule(import.meta.url, "internal/disabled-redis-driver")

/**
 * The `#vitehub/kv/config` module when KV is off, with the exports of the one `@vite-hub/kv/vite` generates. The Console
 * and Agents bundle KV operations either way.
 */
export const disabledKVConfigModule = "export const hosting = undefined\nexport const kv = false\nexport const loadDatabases = undefined\nexport default { hosting, kv }\n"

export function hasUpstashStore(kv: ResolvedKV): boolean {
  if (!kv) return false
  return Object.values(kv.stores || { default: kv.store }).some(store => store.driver === "upstash")
}

/** Redis is selected explicitly at build time. */
export function hasRedisStore(kv: ResolvedKV): boolean {
  if (!kv) return false
  return Object.values(kv.stores || { default: kv.store }).some(store => store.driver === "redis")
}
