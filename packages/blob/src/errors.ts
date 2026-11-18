import { createError } from "nitro/h3"

import type { Result, ResultError } from "@vite-hub/runtime"
import type { HTTPError } from "h3"
import type { Diagnostic } from "nostics"

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
  // A Result error keeps `name` equal to its code, so it cannot be an H3 `HTTPError`. A route maps the code to a status.
  return code === "BLOB_NOT_FOUND" ? Object.assign(error, { statusCode: 404 }) : error
}

/** A Blob HTTP error: an H3 `HTTPError` that also has the diagnostic fields of its cause. */
export type BlobHttpError = HTTPError & Pick<Diagnostic, "code" | "docs" | "fix" | "why">

/**
 * Turns a thrown client error, such as an invalid pathname, into an H3 `HTTPError`. H3 marks any other thrown error
 * as unhandled, and Nitro then answers 500 without the message. The result keeps `code`, `why`, `fix`, and `docs`, on
 * the error and in the JSON body.
 */
export function blobHttpError(status: number, cause: Diagnostic): BlobHttpError {
  const { code, docs, fix, message, why } = cause
  return Object.assign(createError({ body: { code, docs, fix }, cause, message, status }), { code, docs, fix, why })
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
