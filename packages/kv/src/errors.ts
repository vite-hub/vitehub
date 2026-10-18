import { Diagnostic } from "nostics"

import type { Result, ResultError } from "@vite-hub/runtime"

import type { KVErrorCode, KVOperation } from "./types.ts"
import { kvConfigErrorCodes, kvErrorDiagnostics } from "./error-diagnostics.ts"

function hasCode<TCode extends KVErrorCode>(error: Diagnostic, codes: readonly TCode[]): error is ResultError<TCode> {
  return codes.some(code => code === error.code)
}

/**
 * Runs one KV operation and returns `[error, data]`.
 * A KV error with one of `codes` is returned as it is. A config error is thrown.
 * Any other failure becomes `KV_OPERATION_FAILED` with the failure in `cause`.
 */
export async function kvResult<TData, TCode extends KVErrorCode = never>(
  operation: KVOperation,
  store: string,
  run: () => Promise<TData>,
  codes: readonly TCode[] = [],
): Promise<Result<TData, TCode | "KV_OPERATION_FAILED">> {
  try {
    return [undefined, await run()]
  }
  catch (cause) {
    if (cause instanceof Diagnostic && kvConfigErrorCodes.has(cause.code)) throw cause
    if (cause instanceof Diagnostic && hasCode(cause, codes)) return [cause, undefined]
    return [kvErrorDiagnostics.KV_OPERATION_FAILED({ cause, operation, store }), undefined]
  }
}

// The generated Cloudflare KV runtime imports these helpers from the package build.
export function kvStoreNotFoundError(store: string): ResultError<"KV_STORE_NOT_FOUND"> {
  return kvErrorDiagnostics.KV_STORE_NOT_FOUND({ store })
}

export function kvUnsupportedOperationError(operation: KVOperation, store: string): ResultError<"KV_UNSUPPORTED_OPERATION"> {
  return kvErrorDiagnostics.KV_UNSUPPORTED_OPERATION({ operation, store })
}

export function kvInvalidLimitError(): ResultError<"KV_INVALID_LIMIT"> {
  return kvErrorDiagnostics.KV_INVALID_LIMIT()
}
