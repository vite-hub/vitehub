import type { Result, ResultError } from "@vite-hub/runtime"

import type { BlobErrorCode, BlobOperation } from "./types.ts"
import { blobErrorDiagnostics, blobErrors } from "./error-diagnostics.ts"

/** Names the unknown store and the keys of `stores`, so the reader sees the correct name. */
export function unknownBlobStoreMessage(name: string, stores: object): string {
  return `Unknown Blob store "${name}". Configured stores: ${Object.keys(stores).map(key => JSON.stringify(key)).join(", ")}.`
}

export function unknownBlobStoreError(name: string, stores: object): Error {
  return blobErrorDiagnostics.BLOB_R0028({ message: unknownBlobStoreMessage(name, stores) })
}

const blobResultCodes: ReadonlySet<unknown> = new Set(Object.keys(blobErrors))

/** A Result error of the Blob catalog, such as `BLOB_INVALID_CURSOR` from a driver. The Result wrappers return it unchanged. */
export function isBlobResultError(value: unknown): value is ResultError<BlobErrorCode> {
  return value instanceof Error && blobResultCodes.has(Reflect.get(value, "code"))
}

export function blobError(
  code: Exclude<BlobErrorCode, "BLOB_INVALID_CURSOR" | "BLOB_PATHNAME_TOO_LONG">,
  operation: BlobOperation,
  store: string,
  options: { cause?: unknown, detail?: string } = {},
): ResultError<BlobErrorCode> {
  const error: ResultError<BlobErrorCode> = blobErrors[code]({ ...options, operation, store })
  // H3 reads `statusCode`, so a route that rethrows a missing object answers 404, not 500.
  return code === "BLOB_NOT_FOUND" ? Object.assign(error, { statusCode: 404 }) : error
}

export async function blobResult<TResult>(
  operation: BlobOperation,
  store: string,
  run: () => Promise<TResult>,
): Promise<Result<TResult, BlobErrorCode>> {
  try {
    return [undefined, await run()]
  }
  catch (cause) {
    if (isBlobResultError(cause)) return [cause, undefined]
    return [blobError("BLOB_OPERATION_FAILED", operation, store, { cause }), undefined]
  }
}
