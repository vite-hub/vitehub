export const blobDatabaseSources: unique symbol = Symbol.for("vitehub.workspace.blobDatabaseSources")

/** The Blob store and Database names of a Blob + Database Store. `undefined` when the app passed an object. */
export interface BlobDatabaseSources {
  blob: string | undefined
  database: string | undefined
}

export function readBlobDatabaseSources(store: unknown): BlobDatabaseSources | undefined {
  if (typeof store !== "object" || store === null) return undefined
  const read: unknown = Reflect.get(store, blobDatabaseSources)
  return typeof read === "function" ? Reflect.apply(read, store, []) : undefined
}
