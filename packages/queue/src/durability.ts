import type { Durability } from "@vite-hub/runtime/durability"

/** What the build passes to `queueDurability()`. */
export interface QueueDurabilityInput {
  base?: string
  provider: string
}

/** The durability of Queue jobs. The `local` provider keeps jobs in files that one server process owns. */
export function queueDurability(input: QueueDurabilityInput): Durability[] {
  if (input.provider !== "local") {
    return [{ primitive: "queue", store: input.provider, scope: "shared", reason: `${input.provider === "cloudflare" ? "Cloudflare" : "Vercel"} Queues deliver each job once.` }]
  }
  return [{
    primitive: "queue",
    store: "local",
    scope: "host",
    reason: `Job files in ${input.base ?? ".vitehub/data/queue"}. One server process must own this folder.`,
    fix: "Run one instance. Queue has no shared provider for Node yet.",
  }]
}
