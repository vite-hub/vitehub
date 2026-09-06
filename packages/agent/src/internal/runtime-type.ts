type RuntimeTypeMap = { bigint: bigint; boolean: boolean; function: CallableFunction; number: number; object: object | null; string: string; symbol: symbol; undefined: undefined }
export function hasRuntimeType<T extends keyof RuntimeTypeMap>(value: unknown, expected: T): value is RuntimeTypeMap[T] {
  if (expected === 'undefined') return value === undefined
  if (expected === 'object' && value === null) return true
  if (value === null || value === undefined) return false
  if (expected === 'function') return typeof value === 'function'
  if (expected === 'object') return typeof value === 'object'
  return typeof value === expected
}
export function isCallableMember<T>(value: T): value is Extract<T, CallableFunction> { return hasRuntimeType(value, 'function') }
export function isRuntimeRecord(value: unknown): value is Record<PropertyKey, unknown> { return value !== null && hasRuntimeType(value, 'object') }
export function isRuntimeObject(value: unknown): value is object { return value !== null && typeof value === 'object' }
export function asUnknownBoundary(value: unknown): unknown { return value }
