import type { Durability } from "@vite-hub/runtime/durability"

/** What the build passes to `blobDurability()`: each store's driver and folder, without credentials. */
export interface BlobDurabilityInput {
  stores: Record<string, { base?: string, driver: string }>
}

/** The durability of each Blob store. Only the `fs` driver keeps objects on this host. Every other driver is a remote object store. */
export function blobDurability(input: BlobDurabilityInput): Durability[] {
  return Object.entries(input.stores).map(([name, store]): Durability => {
    const named = name === "default" ? {} : { name }
    if (store.driver !== "fs") return { primitive: "blob", ...named, store: store.driver, scope: "shared", reason: `The ${store.driver} object store.` }
    return {
      primitive: "blob",
      ...named,
      store: "fs",
      scope: "host",
      reason: `Files in ${store.base ?? "the Blob folder"} on this host.`,
      fix: "Use an object store, such as `blob: { driver: \"s3\" }` with an S3 bucket, R2, or MinIO.",
    }
  })
}
