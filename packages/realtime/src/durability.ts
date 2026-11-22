import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

/** What the build passes to `realtimeDurability()`: the Realtime driver that the build resolved. */
export interface RealtimeDurabilityInput {
  /** `cloudflare`, `memory`, `postgres`, `redis`, or `auto` / `node` when the server picks it at boot. */
  driver: string
}

const shared: Record<string, string> = {
  cloudflare: "One Durable Object owns each room.",
  postgres: "Postgres carries room updates between instances.",
  redis: "Redis carries room updates between instances.",
}

function resolveDriver(input: RealtimeDurabilityInput, context: DurabilityContext): { driver: string, source?: string } {
  if (input.driver !== "auto" && input.driver !== "node") return { driver: input.driver }
  if (context.env.REDIS_URL?.trim()) return { driver: "redis", source: "REDIS_URL" }
  if (context.env.REALTIME_POSTGRES_URL?.trim()) return { driver: "postgres", source: "REALTIME_POSTGRES_URL" }
  if (context.find("database")?.store === "postgres") return { driver: "postgres", source: "the Default Database" }
  return { driver: "memory" }
}

/** The durability of Realtime rooms, from the driver that the server uses at boot. */
export function realtimeDurability(input: RealtimeDurabilityInput, context: DurabilityContext): Durability[] {
  const { driver, source } = resolveDriver(input, context)
  const reason = shared[driver]
  if (reason) return [{ primitive: "realtime", store: driver, scope: "shared", reason: source ? `${reason.slice(0, -1)}, from ${source}.` : reason }]
  return [{
    primitive: "realtime",
    store: "memory",
    scope: "process",
    reason: "Rooms live in the memory of this process. Clients on other instances do not see each other.",
    fix: "Set REDIS_URL, or use a Postgres Default Database, so instances share rooms. Or send every Realtime connection to one instance.",
  }]
}
