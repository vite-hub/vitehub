import { isRuntimeDiagnostic, toResultError } from "@vite-hub/runtime"

import type { Result, ResultError } from "@vite-hub/runtime"

import type { KVErrorCode, KVListOptions, KVListPage, KVOperation, KVPageOptions, KVSetOptions } from "./types.ts"
import { kvConfigErrorCodes, kvErrorDiagnostics } from "./error-diagnostics.ts"
import { ttlSeconds } from "./runtime/ttl.ts"

export function kvClearOptionsError(options: unknown): ResultError<"KV_INVALID_CLEAR_OPTIONS"> | undefined {
  if (options === undefined) return
  if (typeof options !== "object" || options === null || Array.isArray(options)
    || Object.keys(options).some(key => key !== "prefix")
    || ("prefix" in options && options.prefix !== undefined && typeof options.prefix !== "string")) {
    return kvErrorDiagnostics.KV_INVALID_CLEAR_OPTIONS()
  }
}

function hasCode<TCode extends KVErrorCode>(error: { code: string }, codes: readonly TCode[]): error is { code: TCode } {
  return codes.some(code => code === error.code)
}

/**
 * Runs one KV operation and returns `[error, data]`.
 * A KV error with one of `codes` is returned with Runtime's public serializer. A config error is thrown.
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
    if (kvErrorDiagnostics.is(cause) && kvConfigErrorCodes.has(cause.code)) throw cause
    if (isRuntimeDiagnostic(cause) && hasCode(cause, codes)) return [toResultError(cause), undefined]
    return [kvErrorDiagnostics.KV_OPERATION_FAILED({ cause, operation, store }), undefined]
  }
}

export { kvStoreWithMode } from "./store-mode.ts"

export function kvStoreNotFoundError(store: string): ResultError<"KV_STORE_NOT_FOUND"> {
  return kvErrorDiagnostics.KV_STORE_NOT_FOUND({ store })
}

export function kvUnsupportedOperationError(operation: KVOperation, store: string): ResultError<"KV_UNSUPPORTED_OPERATION"> {
  return kvErrorDiagnostics.KV_UNSUPPORTED_OPERATION({ operation, store })
}

export function kvInvalidLimitError(): ResultError<"KV_INVALID_LIMIT"> {
  return kvErrorDiagnostics.KV_INVALID_LIMIT()
}

/** True when `list()` got a `limit` that is not a positive integer. Without a `limit`, `list()` reads every key. */
export function kvListLimitInvalid(options: KVListOptions): boolean {
  return options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0)
}

const listAllPageSize = 1000

/** One page with `limit`. Without it, every key from `cursor` on, in one page without a cursor. */
export async function listKVKeys(listKeys: (options: KVPageOptions) => Promise<KVListPage>, options: KVListOptions): Promise<KVListPage> {
  if (options.limit !== undefined) return listKeys({ ...options, limit: options.limit })
  const keys: string[] = []
  let cursor = options.cursor
  do {
    const page = await listKeys({ cursor, limit: listAllPageSize, prefix: options.prefix })
    keys.push(...page.keys)
    cursor = page.cursor
  } while (cursor)
  return { keys }
}

/** Codes that a Cloudflare KV store returns for a key above the host limit. */
export const kvKeyLimitCodes: readonly ["KV_KEY_TOO_LONG"] = ["KV_KEY_TOO_LONG"]

/** Codes that a Cloudflare KV store returns for a write above the host limits. */
export const kvWriteLimitCodes: readonly ["KV_KEY_TOO_LONG", "KV_VALUE_TOO_LARGE"] = ["KV_KEY_TOO_LONG", "KV_VALUE_TOO_LARGE"]

/** The codes that `set()` and `setMany()` return: the write limits and an invalid option or `ttl`. */
export const kvSetCodes: readonly ["KV_KEY_TOO_LONG", "KV_VALUE_TOO_LARGE", "KV_INVALID_OPTION", "KV_INVALID_TTL"] = [...kvWriteLimitCodes, "KV_INVALID_OPTION", "KV_INVALID_TTL"]

/**
 * The `ttl` of a write in seconds, or `undefined` when the caller sets none.
 * Throws `KV_INVALID_OPTION` for any option other than `ttl`, and `KV_INVALID_TTL` for a `ttl` that is not a positive time.
 */
export function kvSetTTL(operation: "set" | "setIfAbsent" | "setMany", options: KVSetOptions | undefined): number | undefined {
  if (options === undefined) return
  for (const option of Object.keys(options)) {
    if (option !== "ttl") throw kvErrorDiagnostics.KV_INVALID_OPTION({ operation, option })
  }
  if (options.ttl === undefined) return
  const ttl = ttlSeconds(options.ttl)
  if (ttl === undefined) throw kvErrorDiagnostics.KV_INVALID_TTL()
  return ttl
}
