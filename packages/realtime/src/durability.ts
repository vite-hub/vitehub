import type { Durability } from "@vite-hub/runtime/durability"

/** What the build passes to `realtimeDurability()`: the room authority that the build resolved. */
export interface RealtimeDurabilityInput {
  authority: string
}

/** The durability of Realtime rooms. The `memory` authority keeps each room in one process. */
export function realtimeDurability(input: RealtimeDurabilityInput): Durability[] {
  if (input.authority === "cloudflare") {
    return [{ primitive: "realtime", store: "cloudflare", scope: "shared", reason: "One Durable Object owns each room." }]
  }
  return [{
    primitive: "realtime",
    store: "memory",
    scope: "process",
    reason: "Rooms live in the memory of this process. Clients on other instances do not see each other.",
    fix: "Run one instance, or send every Realtime connection to the same instance.",
  }]
}
