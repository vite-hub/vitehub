import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

/** What the build passes to `queueDurability()`. */
export interface QueueDurabilityInput {
  /** The folder of the `local` driver. */
  base?: string
  /** The Database of the `postgres` driver. */
  database?: string
  driver: string
}

const hostedDrivers: Record<string, string> = {
  cloudflare: "Cloudflare Queues deliver each job once.",
  vercel: "Vercel Queues deliver each job once.",
}

/** The durability of Queue jobs, from the driver. */
export function queueDurability(input: QueueDurabilityInput, context: DurabilityContext): Durability[] {
  const hosted = hostedDrivers[input.driver]
  if (hosted) return [{ primitive: "queue", store: input.driver, scope: "shared", reason: hosted }]
  if (input.driver === "postgres") {
    if (context.env.QUEUE_POSTGRES_URL?.trim()) return [{ primitive: "queue", store: "postgres", scope: "shared", reason: "Jobs in Postgres at QUEUE_POSTGRES_URL." }]
    const name = input.database ?? "default"
    const database = context.find("database", name)
    return [database
      ? { primitive: "queue", store: "postgres", scope: database.scope, reason: `Jobs in the ${name} Database. ${database.reason}`, ...(database.fix ? { fix: database.fix } : {}) }
      : { primitive: "queue", store: "postgres", scope: "process", reason: `The ${name} Database is off, so the Queue has no connection.`, fix: "Set QUEUE_POSTGRES_URL, or turn on a Postgres Default Database." }]
  }
  return [{
    primitive: "queue",
    store: input.driver,
    scope: "host",
    reason: `Job files in ${input.base ?? ".vitehub/data/queue"}. One server process must own this folder.`,
    fix: "Use the `postgres` driver with a Postgres Default Database.",
  }]
}
