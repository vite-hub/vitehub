import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

export { hasRuntimeType }

export function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && hasRuntimeType(value, "object") && !Array.isArray(value)
}
