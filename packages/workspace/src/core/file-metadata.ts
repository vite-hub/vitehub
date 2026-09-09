import { workspaceError } from "./errors.ts"

// Validate without invoking getters or toJSON hooks that can change ownership.
function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This boundary validates JSON primitives without invoking user getters or serialization hooks.
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0)
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Only objects can enter descriptor traversal; functions and other non-JSON primitives are invalid.
  if (typeof value !== "object" || ancestors.has(value)) return false
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (!array && prototype !== Object.prototype && prototype !== null) return false
  ancestors.add(value)
  try {
    const keys = Reflect.ownKeys(value).filter(key => !array || key !== "length")
    if (array && keys.length !== value.length) return false
    return keys.every((key, index) => {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JSON keys must be strings; Reflect.ownKeys also returns symbols that must be rejected.
      if (typeof key !== "string" || (array && key !== String(index))) return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      return descriptor.enumerable && "value" in descriptor && isJsonValue(descriptor.value, ancestors)
    })
  }
  finally {
    ancestors.delete(value)
  }
}

export function assertJsonFileMetadata(path: string, metadata: Record<string, unknown> | undefined): void {
  if (metadata === undefined) return
  let valid = false
  try {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Reject non-object JavaScript inputs before recursively validating the metadata contract.
    valid = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) && isJsonValue(metadata, new Set())
  }
  catch { /* Deep or exotic objects are not a portable metadata representation. */ }
  if (!valid) throw workspaceError(`[vitehub] Invalid Workspace metadata for ${path}. File metadata must contain only JSON-safe plain objects, dense arrays, strings, booleans, null, and finite numbers other than negative zero.`)
}
