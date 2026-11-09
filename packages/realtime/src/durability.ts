import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

/** What the build passes to `realtimeDurability()`: the room authority that the build resolved. */
export interface RealtimeDurabilityInput {
  /** `cloudflare`, `memory`, `postgres`, `redis`, or `auto` / `node` when the server picks it at boot. */
  authority: string
}

const shared: Record<string, string> = {
  cloudflare: "One Durable Object owns each room.",
  postgres: "Postgres carries room updates between instances.",
  redis: "Redis carries room updates between instances.",
}

/**
 * The authority that the server uses. An `auto` or `node` authority picks it at boot: `REDIS_URL`, then
 * `REALTIME_POSTGRES_URL`, then a Postgres Default Database, then memory.
 */
function resolveAuthority(input: RealtimeDurabilityInput, context: DurabilityContext): { authority: string, source?: string } {
  if (input.authority !== "auto" && input.authority !== "node") return { authority: input.authority }
  if (context.env.REDIS_URL?.trim()) return { authority: "redis", source: "REDIS_URL" }
  if (context.env.REALTIME_POSTGRES_URL?.trim()) return { authority: "postgres", source: "REALTIME_POSTGRES_URL" }
  if (context.find("database")?.store === "postgres") return { authority: "postgres", source: "the Default Database" }
  return { authority: "memory" }
}

/** The durability of Realtime rooms, from the authority that the server uses at boot. */
export function realtimeDurability(input: RealtimeDurabilityInput, context: DurabilityContext): Durability[] {
  const { authority, source } = resolveAuthority(input, context)
  const reason = shared[authority]
  if (reason) return [{ primitive: "realtime", store: authority, scope: "shared", reason: source ? `${reason.slice(0, -1)}, from ${source}.` : reason }]
  return [{
    primitive: "realtime",
    store: "memory",
    scope: "process",
    reason: "Rooms live in the memory of this process. Clients on other instances do not see each other.",
    fix: "Set REDIS_URL, or use a Postgres Default Database, so instances share rooms. Or send every Realtime connection to one instance.",
  }]
}
