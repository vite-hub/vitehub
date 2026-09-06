import { ViteHubError } from "@vite-hub/runtime"

import type { KVErrorDetails, KVOperation, KVResult } from "./types.ts"
import { kvErrorDiagnostics } from "./error-diagnostics.ts"

export function unknownKVStoreError(name: string): Error {
  return kvErrorDiagnostics.KV_R0015({ message: `[vitehub] Unknown KV store "${name}".` })
}

export function unsupportedCloudflareKVGetAndDeleteError(): Error {
  return kvErrorDiagnostics.KV_R0016({ message: "[vitehub] Cloudflare KV does not support atomic operations. Use Upstash." })
}

export function unsupportedCloudflareKVIncrementError(): Error {
  return kvErrorDiagnostics.KV_R0017({ message: "[vitehub] Cloudflare KV does not support atomic operations. Use Upstash." })
}

export function invalidKVListLimitError(): Error {
  return kvErrorDiagnostics.KV_R0018({ message: "`limit` must be a positive integer." })
}

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
