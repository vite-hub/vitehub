import { ViteHubError } from "@vite-hub/runtime"

import type { KVErrorDetails, KVOperation, KVResult } from "./types.ts"

export function kvError(
  operation: KVOperation,
  store: string,
  cause: unknown,
): ViteHubError<"KV_OPERATION_FAILED", KVErrorDetails> {
  return new ViteHubError("KV_OPERATION_FAILED", "KV storage operation failed.", {
    cause,
    details: { operation, store },
  })
}

export async function kvResult<TResult>(
  operation: KVOperation,
  store: string,
  run: () => Promise<TResult>,
): Promise<KVResult<TResult>> {
  try {
    return [null, await run()]
  }
  catch (cause) {
    return [kvError(operation, store, cause), undefined]
  }
}
