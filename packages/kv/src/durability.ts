import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

/** One KV store as the build resolves it, without credentials. */
export interface KVDurabilityStore {
  /** The folder of a file store. */
  base?: string
  /** The Database of a `database` store. Default: `default`. */
  database?: string
  driver: string
  /** The build inferred the store, so `REDIS_URL` can replace it at boot. */
  inferred?: boolean
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
  // An inferred store uses Redis when REDIS_URL is set at boot.
  if (store.inferred && context.env.REDIS_URL?.trim()) return { store: "redis", scope: "shared", reason: "Redis at REDIS_URL." }
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
  if (store.driver === "memory") return { store: "memory", scope: "process", reason: "Values live in the memory of this process.", fix: "Set REDIS_URL, or use a Postgres Default Database." }
  return {
    store: store.driver,
    scope: "host",
    reason: `Files in ${store.base ?? "the KV folder"} on this host.`,
    fix: store.inferred
      ? "Set REDIS_URL, or define the Default Database with `dialect: \"postgresql\"`."
      : "Use Upstash Redis: set KV_REST_API_URL and KV_REST_API_TOKEN when you build, or set the store driver to \"upstash\".",
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
