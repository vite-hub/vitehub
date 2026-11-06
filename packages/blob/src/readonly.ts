import { blobErrorDiagnostics } from "./error-diagnostics.ts"

import type { BlobStorage, BlobStoreOptions, ReadonlyBlobStorage } from "./types.ts"

/** Returns the mode of `blob.store()` options. An unknown mode throws, so a typo never gives a writable handle. */
export function blobStoreMode(options: BlobStoreOptions | undefined): "read" | "write" {
  const mode = options?.mode ?? "write"
  if (mode !== "read" && mode !== "write") {
    throw blobErrorDiagnostics.BLOB_R0038({ message: `Blob store mode must be "read" or "write", not ${JSON.stringify(mode)}.` })
  }
  return mode
}

/** Wraps a Blob handle in one that has only its read methods. Write methods are absent, not stubbed. */
export function readonlyBlobStorage(storage: BlobStorage): ReadonlyBlobStorage {
  return {
    media: {
      get: pathname => storage.media.get(pathname),
      list: options => storage.media.list(options),
      variants: pathname => storage.media.variants(pathname),
    },
    get: pathname => storage.get(pathname),
    head: pathname => storage.head(pathname),
    list: options => storage.list(options),
    serve: (event, pathname, options) => storage.serve(event, pathname, options),
    async sign(pathname, options) {
      if (options.method !== "GET") {
        throw blobErrorDiagnostics.BLOB_R0037({ message: "A read-only Blob handle signs GET requests only. Use blob.store(name) for a PUT request." })
      }
      return storage.sign(pathname, options)
    },
  }
}
