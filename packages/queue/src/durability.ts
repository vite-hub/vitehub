import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

/** What the build passes to `queueDurability()`. */
export interface QueueDurabilityInput {
  /** The folder of the `local` provider. */
  base?: string
  /** The Database of the `postgres` provider. */
  database?: string
  provider: string
}

const hostedProviders: Record<string, string> = {
  cloudflare: "Cloudflare Queues deliver each job once.",
  vercel: "Vercel Queues deliver each job once.",
}

/** The durability of Queue jobs, from the provider. */
export function queueDurability(input: QueueDurabilityInput, context: DurabilityContext): Durability[] {
  const hosted = hostedProviders[input.provider]
  if (hosted) return [{ primitive: "queue", store: input.provider, scope: "shared", reason: hosted }]
  if (input.provider === "postgres") {
    if (context.env.QUEUE_POSTGRES_URL?.trim()) return [{ primitive: "queue", store: "postgres", scope: "shared", reason: "Jobs in Postgres at QUEUE_POSTGRES_URL." }]
    const name = input.database ?? "default"
    const database = context.find("database", name)
    return [database
      ? { primitive: "queue", store: "postgres", scope: database.scope, reason: `Jobs in the ${name} Database. ${database.reason}`, ...(database.fix ? { fix: database.fix } : {}) }
      : { primitive: "queue", store: "postgres", scope: "process", reason: `The ${name} Database is off, so the Queue has no connection.`, fix: "Set QUEUE_POSTGRES_URL, or turn on a Postgres Default Database." }]
  }
  return [{
    primitive: "queue",
    store: input.provider,
    scope: "host",
    reason: `Job files in ${input.base ?? ".vitehub/data/queue"}. One server process must own this folder.`,
    fix: "Use the `postgres` provider with a Postgres Default Database.",
  }]
}
