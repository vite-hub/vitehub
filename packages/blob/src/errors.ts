import { ViteHubError } from "@vite-hub/runtime"

import type { BlobErrorCode, BlobErrorDetails, BlobOperation, BlobResult } from "./types.ts"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"

export function unknownBlobStoreError(name: string): Error {
  return blobErrorDiagnostics.BLOB_R0028({ message: `Unknown Blob store "${name}".` })
}

const blobErrorMessages: Record<BlobErrorCode, string> = {
  BLOB_CONFLICT: "Blob change conflicts with existing objects.",
  BLOB_NOT_FOUND: "Blob not found.",
  BLOB_OPERATION_FAILED: "Blob storage operation failed.",
}

export function blobError(
  code: BlobErrorCode,
  operation: BlobOperation,
  store: string,
  cause?: unknown,
): ViteHubError<typeof code, BlobErrorDetails> {
  const error = new ViteHubError(
    code,
    blobErrorMessages[code],
    {
      ...(cause === undefined ? {} : { cause }),
      details: { operation, store },
    },
  )
  // H3 reads `statusCode`, so a route that rethrows a missing object answers 404, not 500.
  return code === "BLOB_NOT_FOUND" ? Object.assign(error, { statusCode: 404 }) : error
}

export async function blobResult<TResult>(
  operation: BlobOperation,
  store: string,
  run: () => Promise<TResult>,
): Promise<BlobResult<TResult>> {
  try {
    return [null, await run()]
  }
  catch (cause) {
    return [blobError("BLOB_OPERATION_FAILED", operation, store, cause), undefined]
  }
}
