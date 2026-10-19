import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"

/** Marks a provider session cursor that ViteHub stored, so an invalidated cursor is not resumed. */
export const providerSessionCursorRecordKey = "__vitehubProviderSessionCursor"

export interface ProviderSessionCursorRecord {
  [providerSessionCursorRecordKey]: "invalidated" | "ready"
  value?: unknown
}

export function isProviderSessionCursorRecord(value: unknown): value is ProviderSessionCursorRecord {
  return isRuntimeRecord(value)
    && (value[providerSessionCursorRecordKey] === "invalidated" || value[providerSessionCursorRecordKey] === "ready")
}

/** Returns the native thread ID in a provider runtime resume cursor, or undefined for an opaque cursor. */
export function providerNativeThreadId(cursor: unknown): string | undefined {
  const value = isProviderSessionCursorRecord(cursor) ? cursor.value : cursor
  if (!isRuntimeRecord(value) || !isRuntimeRecord(value.providerThread)) return undefined
  const ref = value.providerThread.nativeThreadRef
  return isRuntimeRecord(ref) && hasRuntimeType(ref.nativeId, "string") ? ref.nativeId : undefined
}
