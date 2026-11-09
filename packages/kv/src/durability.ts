import type { Durability } from "@vite-hub/runtime/durability"

/** What the build passes to `kvDurability()`: each store's driver and folder, without credentials. */
export interface KVDurabilityInput {
  stores: Record<string, { base?: string, driver: string }>
}

const sharedStores: Record<string, string> = {
  "cloudflare-kv-binding": "A Cloudflare KV namespace that every Worker reads.",
  "deno-kv": "Deno KV, which Deno Deploy shares between isolates.",
  "upstash": "Upstash Redis over HTTP.",
}

/** The durability of each KV store. `fs-lite` keeps the data in files on this host. */
export function kvDurability(input: KVDurabilityInput): Durability[] {
  return Object.entries(input.stores).map(([name, store]): Durability => {
    const named = name === "default" ? {} : { name }
    const shared = sharedStores[store.driver]
    if (shared) return { primitive: "kv", ...named, store: store.driver, scope: "shared", reason: shared }
    return {
      primitive: "kv",
      ...named,
      store: store.driver,
      scope: "host",
      reason: `Files in ${store.base ?? "the KV folder"} on this host.`,
      fix: "Use Upstash Redis: set KV_REST_API_URL and KV_REST_API_TOKEN when you build, or set the store driver to \"upstash\".",
    }
  })
}
