import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

/** What the build passes to `rateLimitDurability()`. */
export interface RateLimitDurabilityInput {
  provider: string
}

const memory: Durability = {
  primitive: "rate-limit",
  store: "memory",
  scope: "process",
  reason: "Counters live in the memory of this process. Each instance counts on its own.",
  fix: "Use a shared default KV store, such as Redis or a Postgres Default Database, with the `kv` provider.",
}

/**
 * The durability of Rate Limit counters, from the provider. The `kv` provider counts in the default KV store when that
 * store is a database, Redis, or Upstash store, and falls back to memory otherwise.
 */
export function rateLimitDurability(input: RateLimitDurabilityInput, context: DurabilityContext): Durability[] {
  if (input.provider === "cloudflare") {
    return [{ primitive: "rate-limit", store: "cloudflare", scope: "shared", reason: "Cloudflare Rate Limiting bindings count for every Worker." }]
  }
  if (input.provider !== "kv") return [memory]
  const kv = context.find("kv")
  if (!kv || !/^(?:database|redis|upstash)\b/.test(kv.store)) {
    return [{ ...memory, reason: `The default KV store is ${kv ? kv.store : "off"}, so counters live in the memory of this process.` }]
  }
  return [{
    primitive: "rate-limit",
    store: `kv (${kv.store})`,
    scope: kv.scope,
    reason: `Counters in the default KV store. ${kv.reason}`,
    ...(kv.fix ? { fix: kv.fix } : {}),
  }]
}
