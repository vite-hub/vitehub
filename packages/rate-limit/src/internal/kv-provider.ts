/** KV drivers with a shared atomic increment, as required by the KV Rate Limit driver. */
export function resolveKVRateLimitProvider(driver: string | undefined): "kv" | "memory" {
  return driver === "database" || driver === "redis" || driver === "upstash" ? "kv" : "memory"
}
