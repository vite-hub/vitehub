import { fileURLToPath } from "node:url"

import type { resolveKVViteConfig } from "@vite-hub/kv/vite"

type ResolvedKV = ReturnType<typeof resolveKVViteConfig>["kv"]

export const upstashDriverSpecifier = "@vite-hub/kv/runtime/upstash-driver"
export const disabledUpstashDriver = fileURLToPath(import.meta.resolve("vite-hub/_internal/kv/runtime/disabled-upstash"))

/** The `#vitehub/kv/config` module when KV is off. The Console and Agents bundle KV operations either way. */
export const disabledKVConfigModule = "export const kv = false\nexport default { kv }\n"

export function hasUpstashStore(kv: ResolvedKV): boolean {
  if (!kv) return false
  return Object.values(kv.stores || { default: kv.store }).some(store => store.driver === "upstash")
}
