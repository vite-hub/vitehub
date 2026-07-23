import { ViteHubError } from "@vite-hub/runtime"

import type { BlobErrorDetails, BlobOperation, BlobResult } from "./types.ts"

export function blobError(
  code: "BLOB_NOT_FOUND" | "BLOB_OPERATION_FAILED",
  operation: BlobOperation,
  store: string,
  cause?: unknown,
): ViteHubError<typeof code, BlobErrorDetails> {
  return new ViteHubError(
    code,
    code === "BLOB_NOT_FOUND" ? "Blob not found." : "Blob storage operation failed.",
    {
      ...(cause === undefined ? {} : { cause }),
      details: { operation, store },
    },
  )
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
