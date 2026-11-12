import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

/** One KV store as the build resolves it, without credentials. */
export interface KVDurabilityStore {
  /** The folder of a file store. */
  base?: string
  /** The Database of a `database` store. Default: `default`. */
  database?: string
  driver: string
}

/** What the build passes to `kvDurability()`. */
export interface KVDurabilityInput {
  stores: Record<string, KVDurabilityStore>
}

const sharedStores: Record<string, string> = {
  "cloudflare-kv-binding": "A Cloudflare KV namespace that every Worker reads.",
  "deno-kv": "Deno KV, which Deno Deploy shares between isolates.",
  "redis": "Redis.",
  "upstash": "Upstash Redis over HTTP.",
}

function classify(store: KVDurabilityStore, context: DurabilityContext): Omit<Durability, "name" | "primitive"> {
  const shared = sharedStores[store.driver]
  if (shared) return { store: store.driver, scope: "shared", reason: shared }
  if (store.driver === "database") {
    const name = store.database ?? "default"
    const database = context.find("database", name)
    if (!database) return { store: "database", scope: "process", reason: `The ${name} Database is off.`, fix: "Turn on the Database, or use a Redis store." }
    return {
      store: `database (${database.store})`,
      scope: database.scope,
      reason: `Rows in the ${name} Database. ${database.reason}`,
      ...(database.fix ? { fix: database.fix } : {}),
    }
  }
  if (store.driver === "memory") return { store: "memory", scope: "process", reason: "Values live in the memory of this process.", fix: 'Set `kv: { driver: "redis" }` and supply REDIS_URL to every instance, or use a Postgres Default Database.' }
  return {
    store: store.driver,
    scope: "host",
    reason: `Files in ${store.base ?? "the KV folder"} on this host.`,
    fix: 'Set `kv: { driver: "redis" }` and supply REDIS_URL to every instance, or select a shared Database store.',
  }
}

/** The durability of each KV store, from its driver. A `database` store follows the Database that holds its rows. */
export function kvDurability(input: KVDurabilityInput, context: DurabilityContext): Durability[] {
  return Object.entries(input.stores).map(([name, store]) => ({
    primitive: "kv",
    ...(name === "default" ? {} : { name }),
    ...classify(store, context),
  }))
}
