import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

export { hasRuntimeType, isRuntimeObject } from "@vite-hub/runtime/internal/runtime-type"

export function isRuntimeRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && hasRuntimeType(value, "object")
}

export function isRuntimeNumber(value: unknown): value is number {
  return hasRuntimeType(value, "number")
}

export function isRuntimeString(value: unknown): value is string {
  return hasRuntimeType(value, "string")
}
